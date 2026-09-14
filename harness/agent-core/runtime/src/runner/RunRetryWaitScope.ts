import type { CancellationContext, PendingRunSubject, RunStatus } from "../run/index.js";
import { cancellationAttribution } from "../retry/RetryDependencies.js";
import type { RetryWaitControl, RetryWaitOutcome, RetryWaitRequest } from "../retry/RetryWaitControl.js";
import { ExecutionFlowPath, type ExecutionFlowContext } from "@agent-anything/observability/execution-flow";
import { RETRY_WAIT_EXECUTION_FLOW } from "./RetryWaitExecutionFlow.js";

type PendingRetry = Extract<PendingRunSubject, { readonly kind: "retry_wait" }>;

export interface RunRetryWaitScopeInput {
  readonly executionFlow?: ExecutionFlowContext;
  readonly runId: string;
  readonly invocationId: string;
  readonly branchId: string;
  readonly deadlineAt: string;
  readonly cancellation: CancellationContext;
  readonly now: () => string;
  readonly snapshot: () => { readonly status: RunStatus; readonly revision: number };
  readonly isCurrent: () => boolean;
  readonly open: (pending: PendingRetry) => void;
  readonly close: (pending: PendingRetry, outcome: RetryWaitOutcome["kind"] | "arming_failed") => void;
  readonly ready: (pending: PendingRetry) => void;
}

/** One live invocation, one exact registration per delay; never a second Retry loop. */
export class RunRetryWaitScope implements RetryWaitControl {
  private generation = 0;
  private disposed = false;
  private wake: (() => void) | null = null;
  private active: PendingRetry | null = null;

  constructor(private readonly input: RunRetryWaitScopeInput) {}

  notifyStateChanged(): void { this.wake?.(); }
  dispose(): void { this.disposed = true; this.wake?.(); }
  get isWaiting(): boolean { return this.active !== null; }

  async wait(request: RetryWaitRequest, arm: Parameters<RetryWaitControl["wait"]>[1]): Promise<RetryWaitOutcome> {
    if (this.active !== null) throw new TypeError("Nested waits must not overlap in one execution branch.");
    if (request.operation.runId !== this.input.runId ||
        request.precedingAttempt.operationId !== request.operation.operationId ||
        (request.operation.subject.kind !== "approval_review" &&
          request.operation.subject.controllerRequestId !== this.input.invocationId)) {
      throw new TypeError("Retry wait does not belong to this invocation.");
    }
    const interrupted = this.interrupted();
    if (interrupted !== null) return interrupted;
    const generation = ++this.generation;
    const pending: PendingRetry = Object.freeze({
      kind: "retry_wait", required: true, branchId: this.input.branchId,
      openedInRunRevision: this.input.snapshot().revision,
      waitId: `${this.input.invocationId}:retry-wait:${generation}`, generation,
      invocationId: this.input.invocationId, operationId: request.operation.operationId,
      budgetId: request.precedingAttempt.budgetId, precedingAttemptId: request.precedingAttempt.attemptId,
      nextAttemptNumber: request.precedingAttempt.attemptNumber + 1,
      nextAttemptAt: request.delay.nextAttemptAt, deadlineAt: this.input.deadlineAt, policy: request.policy,
    });
    const flow = new ExecutionFlowPath(RETRY_WAIT_EXECUTION_FLOW, request.executionFlow ?? this.input.executionFlow ?? {}, this.input.runId, [{owner: "retry", kind: "attempt", id: pending.precedingAttemptId, revision: null}]);
    flow.advance("register", {waitId: pending.waitId, generation, operationId: pending.operationId, budgetId: pending.budgetId, branchId: pending.branchId, nextAttemptAt: pending.nextAttemptAt, deadlineAt: pending.deadlineAt, nextAttemptNumber: pending.nextAttemptNumber}).check("invocation_ownership", "passed", {invocationId: this.input.invocationId});
    let signal!: () => void;
    let change = new Promise<void>(resolve => { signal = resolve; });
    this.wake = () => signal();
    this.active = pending;
    let timerResult: RetryWaitOutcome | null = null;
    let timerError: unknown;
    let timerFailed = false;
    let outcome: RetryWaitOutcome["kind"] | "arming_failed" = "invalidated";
    const disposal = new AbortController();
    const onAbort = () => this.wake?.();
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const armDeadline = () => {
      const remaining = Date.parse(this.input.deadlineAt) - Date.parse(this.input.now());
      deadlineTimer = setTimeout(() => {
        if (Date.parse(this.input.now()) < Date.parse(this.input.deadlineAt)) armDeadline();
        else onAbort();
      }, Math.max(0, Math.min(remaining, 2_147_483_647)));
    };
    try {
      armDeadline();
      this.input.cancellation.signal.addEventListener("abort", onAbort, { once: true });
      // Receiver and identity exist before the pending commit and before arming.
      this.input.open(pending);
      const timerStep = flow.advance("timer", {status: this.input.snapshot().status, runRevision: this.input.snapshot().revision});
      void Promise.resolve().then(() => arm(disposal.signal)).then(result => {
        if (this.active !== pending || this.disposed) return;
        timerResult = result;
        timerStep.check("timer_delivery", result.kind === "elapsed" ? "passed" : "not_satisfied", {outcome: result.kind, waitId: pending.waitId, generation});
        if (result.kind === "elapsed") this.input.ready(pending);
        this.wake?.();
      }).catch(error => {
        if (this.active !== pending) return;
        timerFailed = true; timerError = error; this.wake?.();
      });
      let held = false;
      while (true) {
        const interruption = this.interrupted();
        if (timerResult !== null || interruption !== null || timerFailed) {
          if (!held || this.input.snapshot().status !== "suspended" || interruption !== null) {
            const admission = flow.advance("admission", {status: this.input.snapshot().status, runRevision: this.input.snapshot().revision});
            admission.check("interruption", interruption === null ? "passed" : "not_satisfied", {outcome: interruption?.kind ?? null});
            admission.check("suspension", this.input.snapshot().status === "suspended" ? "not_satisfied" : "passed");
            admission.check("current_basis", this.input.snapshot().status === "suspended" ? "not_evaluated" : this.input.isCurrent() ? "passed" : "not_satisfied");
            if (this.input.snapshot().status === "suspended" && interruption === null) { flow.advance("hold", {waitId: pending.waitId}); held = true; }
          }
        }
        if (interruption !== null) { outcome = interruption.kind; return interruption; }
        if (timerFailed) { outcome = "arming_failed"; throw timerError; }
        if (this.input.snapshot().status !== "suspended" && timerResult !== null) {
          outcome = (timerResult as RetryWaitOutcome).kind;
          return timerResult;
        }
        await change;
        change = new Promise<void>(resolve => { signal = resolve; });
      }
    } finally {
      disposal.abort();
      clearTimeout(deadlineTimer);
      this.input.cancellation.signal.removeEventListener("abort", onAbort);
      this.active = null;
      this.wake = null;
      this.input.close(pending, outcome);
      flow.advance("settle", {outcome, status: this.input.snapshot().status, revision: this.input.snapshot().revision});
      flow.close(outcome === "elapsed" ? "returned" : outcome === "cancelled" ? "cancelled" : outcome === "arming_failed" ? "failed" : "interrupted");
    }
  }

  private interrupted(): RetryWaitOutcome | null {
    if (this.input.cancellation.signal.aborted) return {
      kind: "cancelled", attribution: cancellationAttribution(this.input.cancellation, { now: () => new Date(this.input.now()) }),
    };
    if (Date.parse(this.input.now()) >= Date.parse(this.input.deadlineAt)) return { kind: "deadline_exceeded" };
    const status = this.input.snapshot().status;
    if (this.disposed || ["completed", "failed", "cancelled", "cancelling"].includes(status)) return { kind: "invalidated" };
    // Explicit suspension is a hold, not permission to retry or an implicit resume.
    if (status !== "suspended" && !this.input.isCurrent()) return { kind: "invalidated" };
    return null;
  }
}
