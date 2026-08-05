import type { Agent } from "@agent-anything/agent-core/agent";
import type { RunInput } from "@agent-anything/agent-core/input";
import {
  snapshotApprovalDecisionSubmission,
  type ApprovalDecisionSubmission,
  type ApprovalSubmissionReceipt,
} from "@agent-anything/permission";
import type {
  RuntimeEvent,
  RuntimeEventPublisher,
} from "@agent-anything/observability/events";
import { toRunCancellationSummary, type RunCancellationRequestInput, type RunResult } from "@agent-anything/agent-runtime/run";
import type {
  RunConfig,
  RunHandle,
  Runner,
} from "@agent-anything/agent-runtime/runner";
import {
  createHostRunProjection,
  createHostTerminalRunProjection,
  type HostCancellationProjection,
  type HostRunProjection,
  type HostRunProjectionListener,
  type HostRunProjectionListenerFailure,
  type HostTerminalRunProjection,
} from "./HostRunProjection.js";
import { createHostRunProjectionStore } from "./HostRunProjectionReducer.js";
import type { UserApprovalReviewBridge } from "./UserApprovalReviewBridge.js";

export type HostSessionId = string;

export interface HostRunStartInput<TOutput = unknown> {
  readonly sessionId: HostSessionId;
  readonly agent: Agent<TOutput>;
  readonly runInput: RunInput;
  readonly runConfig: RunConfig;
  readonly userApprovalReviewBridge: UserApprovalReviewBridge | null;
}

export interface HostRunResult<TOutput = unknown> {
  readonly kind: "run_result";
  readonly sessionId: HostSessionId;
  readonly taskId: string;
  readonly runId: string;
  readonly runResult: RunResult<TOutput>;
  readonly terminal: HostTerminalRunProjection;
}

export type HostRunCancellationInput = RunCancellationRequestInput;

export type HostRunCancellationReceipt =
  | {
      readonly status: "accepted";
      readonly cancellation: HostCancellationProjection;
    }
  | {
      readonly status: "already_requested";
      readonly cancellation: HostCancellationProjection;
    }
  | {
      readonly status: "run_settled";
      readonly cancellation: HostCancellationProjection | null;
    };

export interface HostActiveRun<TOutput = unknown> {
  readonly sessionId: HostSessionId;
  readonly runId: string;
  getProjection(): HostRunProjection;
  subscribe(listener: HostRunProjectionListener): () => void;
  submitApprovalDecision(input: ApprovalDecisionSubmission): ApprovalSubmissionReceipt;
  cancel(input: HostRunCancellationInput): HostRunCancellationReceipt;
  readonly result: Promise<HostRunResult<TOutput>>;
}

export interface HostRuntime {
  start<TOutput>(input: HostRunStartInput<TOutput>): HostActiveRun<TOutput>;
  getRun(runId: string): HostActiveRun | null;
  listRuns(): readonly HostRunRegistryEntry[];
  releaseRun(runId: string): HostRunReleaseReceipt;
}

export interface HostRunRegistryEntry {
  readonly runId: string;
  readonly sessionId: HostSessionId;
  readonly lifecycle: "active" | "settled";
}

export type HostRunReleaseReceipt =
  | { readonly status: "released"; readonly runId: string }
  | { readonly status: "run_active"; readonly runId: string }
  | { readonly status: "not_found"; readonly runId: string };

interface HostRunRegistration<TOutput> {
  readonly activeRun: HostActiveRun<TOutput>;
  release(): void;
}

export interface CreateHostRuntimeInput {
  readonly runner: Runner;
  readonly terminalRetentionLimit?: number;
  readonly now?: () => string;
  readonly onProjectionListenerFailure?: (
    failure: HostRunProjectionListenerFailure,
  ) => void;
}

type HostInvocationState = "active" | "settled";

export function createHostRuntime(input: CreateHostRuntimeInput): HostRuntime {
  if (!input.runner || typeof input.runner.start !== "function") {
    throw new TypeError("HostRuntime requires a Runner.");
  }
  const terminalRetentionLimit = input.terminalRetentionLimit ?? 32;
  if (!Number.isSafeInteger(terminalRetentionLimit) || terminalRetentionLimit < 0) {
    throw new TypeError("HostRuntime terminalRetentionLimit must be a non-negative integer.");
  }
  const now = input.now ?? (() => new Date().toISOString());
  const registry = new HostRunRegistry(terminalRetentionLimit);

  return Object.freeze({
    start<TOutput>(startInput: HostRunStartInput<TOutput>): HostActiveRun<TOutput> {
      const registration = startHostRun(
        input.runner,
        now,
        startInput,
        input.onProjectionListenerFailure,
      );
      registry.admit(registration);
      return registration.activeRun;
    },
    getRun: (runId: string) => registry.get(runId),
    listRuns: () => registry.list(),
    releaseRun: (runId: string) => registry.release(runId),
  });
}

function startHostRun<TOutput>(
  runner: Runner,
  now: () => string,
  input: HostRunStartInput<TOutput>,
  onListenerFailure: CreateHostRuntimeInput["onProjectionListenerFailure"],
): HostRunRegistration<TOutput> {
  assertStartInput(input);
  const sessionId = input.sessionId;
  const taskId = input.runInput.task.id;
  const startedAt = readNow(now);
  let hostSequence = 0;
  let invocationState: HostInvocationState = "active";
  let runId = "";
  let store: ReturnType<typeof createHostRunProjectionStore>;

  const nextSequence = (): number => {
    hostSequence += 1;
    return hostSequence;
  };
  const runtimeEventPublisher: RuntimeEventPublisher = Object.freeze({
    publish(event: RuntimeEvent) {
      if (invocationState !== "active") return;
      store.apply({
        kind: "runtime_event",
        runId,
        sequence: nextSequence(),
        occurredAt: event.occurredAt,
        event,
      });
    },
  });
  const handle: RunHandle<TOutput> = runner.start(
    input.agent,
    input.runInput,
    input.runConfig,
    { runtimeEventPublisher },
  );
  runId = handle.runId;
  store = createHostRunProjectionStore({
    initial: createHostRunProjection({
      sessionId,
      taskId,
      runId,
      startedAt,
      enforcement: input.runConfig.permissions.permissionProfile.enforcement,
    }),
    ...(onListenerFailure === undefined ? {} : { onListenerFailure }),
  });
  const userApprovalReviewBridge = input.userApprovalReviewBridge;
  const unsubscribeApprovalReview = userApprovalReviewBridge?.subscribe((review) => {
    if (review === null || invocationState !== "active") return;
    const reduction = store.apply({
      kind: "approval_review_available",
      runId,
      sequence: nextSequence(),
      occurredAt: review.request.createdAt,
      review,
    });
    if (reduction.status === "rejected") {
      throw new Error(`Host approval review projection was rejected: ${reduction.code}.`);
    }
  }) ?? (() => undefined);

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    unsubscribeApprovalReview();
  };
  const result = handle.wait().then<HostRunResult<TOutput>>(
    (runResult) => {
      assertRunResultIdentity(runResult, runId, taskId);
      const terminal = createHostTerminalRunProjection({
        runResult,
        completedAt: readNow(now),
      });
      const reduction = store.apply({
        kind: "terminal_result",
        runId,
        sequence: nextSequence(),
        occurredAt: terminal.completedAt,
        terminal,
      });
      if (reduction.status === "rejected") {
        throw new Error(`Host terminal projection was rejected: ${reduction.code}.`);
      }
      return Object.freeze({
        kind: "run_result" as const,
        sessionId,
        taskId,
        runId,
        runResult,
        terminal,
      });
    },
  ).finally(() => {
    invocationState = "settled";
    release();
  });

  const activeRun: HostActiveRun<TOutput> = Object.freeze({
    sessionId,
    runId,
    getProjection: () => store.getProjection(),
    subscribe: (listener: HostRunProjectionListener) => store.subscribe(listener),
    submitApprovalDecision(
      candidate: ApprovalDecisionSubmission,
    ): ApprovalSubmissionReceipt {
      const submissionId = readSubmissionId(candidate);
      let submission: ApprovalDecisionSubmission;
      try {
        submission = snapshotApprovalDecisionSubmission(candidate);
      } catch {
        return rejectedApprovalSubmission(submissionId, "approval_submission_invalid");
      }
      if (userApprovalReviewBridge === null || invocationState !== "active") {
        return rejectedApprovalSubmission(submission.submissionId, "approval_not_pending");
      }
      const projection = store.getProjection();
      const approval = projection.approval;
      if (
        projection.status !== "waiting_for_approval" ||
        approval === null ||
        submission.runId !== runId ||
        submission.requestId !== approval.requestId
      ) {
        return rejectedApprovalSubmission(submission.submissionId, "approval_not_pending");
      }
      if (submission.pendingVersion !== approval.pendingVersion) {
        return rejectedApprovalSubmission(submission.submissionId, "approval_version_mismatch");
      }

      const receipt = userApprovalReviewBridge.submitDecision(submission);
      if (receipt.status !== "accepted_for_resolution") return receipt;
      if (approval.phase === "submitted_for_resolution") return receipt;
      const reduction = store.apply({
        kind: "approval_submission_accepted",
        runId,
        sequence: nextSequence(),
        occurredAt: readNow(now),
        receipt,
      });
      if (reduction.status === "rejected") {
        throw new Error(`Host approval submission projection was rejected: ${reduction.code}.`);
      }
      return receipt;
    },
    cancel(cancellationInput: HostRunCancellationInput): HostRunCancellationReceipt {
      const currentCancellation = store.getProjection().cancellation;
      if (invocationState === "settled") {
        return Object.freeze({
          status: "run_settled" as const,
          cancellation: currentCancellation,
        });
      }
      const receipt = handle.cancel(cancellationInput);
      const cancellation = toRunCancellationSummary(receipt.request);
      if (receipt.status === "run_settled") {
        return Object.freeze({
          status: "run_settled" as const,
          cancellation: currentCancellation,
        });
      }
      if (receipt.status === "already_requested") {
        return Object.freeze({
          status: "already_requested" as const,
          cancellation,
        });
      }
      const reduction = store.apply({
        kind: "cancellation_accepted",
        runId,
        sequence: nextSequence(),
        occurredAt: cancellation.requestedAt,
        cancellation,
      });
      if (reduction.status === "rejected") {
        throw new Error(`Host cancellation projection was rejected: ${reduction.code}.`);
      }
      return Object.freeze({
        status: "accepted" as const,
        cancellation,
      });
    },
    result,
  });
  return Object.freeze({ activeRun, release });
}

interface HostRunRegistryRecord {
  readonly activeRun: HostActiveRun;
  readonly release: () => void;
  lifecycle: "active" | "settled";
}

class HostRunRegistry {
  private readonly records = new Map<string, HostRunRegistryRecord>();
  private readonly terminalOrder: string[] = [];

  constructor(private readonly terminalRetentionLimit: number) {}

  admit<TOutput>(registration: HostRunRegistration<TOutput>): void {
    const activeRun = registration.activeRun;
    if (this.records.has(activeRun.runId)) {
      activeRun.cancel({
        origin: "host",
        reasonCode: "host_requested",
        reason: "Duplicate Host Run identity.",
      });
      registration.release();
      throw new Error(`Host Run '${activeRun.runId}' is already registered.`);
    }
    const record: HostRunRegistryRecord = {
      activeRun,
      release: registration.release,
      lifecycle: "active",
    };
    this.records.set(activeRun.runId, record);
    void activeRun.result.then(
      () => this.markSettled(activeRun.runId),
      () => this.markSettled(activeRun.runId),
    );
  }

  get(runId: string): HostActiveRun | null {
    assertIdentity(runId, "runId");
    return this.records.get(runId)?.activeRun ?? null;
  }

  list(): readonly HostRunRegistryEntry[] {
    return Object.freeze([...this.records.values()].map((record) => Object.freeze({
      runId: record.activeRun.runId,
      sessionId: record.activeRun.sessionId,
      lifecycle: record.lifecycle,
    })));
  }

  release(runId: string): HostRunReleaseReceipt {
    assertIdentity(runId, "runId");
    const record = this.records.get(runId);
    if (record === undefined) {
      return Object.freeze({ status: "not_found" as const, runId });
    }
    if (record.lifecycle === "active") {
      return Object.freeze({ status: "run_active" as const, runId });
    }
    this.evict(runId, record);
    return Object.freeze({ status: "released" as const, runId });
  }

  private markSettled(runId: string): void {
    const record = this.records.get(runId);
    if (record === undefined || record.lifecycle === "settled") return;
    record.lifecycle = "settled";
    this.terminalOrder.push(runId);
    this.trimTerminalRecords();
  }

  private trimTerminalRecords(): void {
    while (this.terminalOrder.length > this.terminalRetentionLimit) {
      const runId = this.terminalOrder.shift();
      if (runId === undefined) return;
      const record = this.records.get(runId);
      if (record !== undefined && record.lifecycle === "settled") {
        this.evict(runId, record);
      }
    }
  }

  private evict(runId: string, record: HostRunRegistryRecord): void {
    this.records.delete(runId);
    const index = this.terminalOrder.indexOf(runId);
    if (index >= 0) this.terminalOrder.splice(index, 1);
    record.release();
  }
}

function assertStartInput<TOutput>(input: HostRunStartInput<TOutput>): void {
  if (input === null || typeof input !== "object") {
    throw new TypeError("HostRunStartInput must be an object.");
  }
  assertIdentity(input.sessionId, "sessionId");
  if (input.runInput === null || typeof input.runInput !== "object") {
    throw new TypeError("runInput must be an object.");
  }
  if (input.runInput.task === null || typeof input.runInput.task !== "object") {
    throw new TypeError("runInput.task must be an object.");
  }
  assertIdentity(input.runInput.task.id, "taskId");
  if (!input.runConfig || typeof input.runConfig !== "object") {
    throw new TypeError("runConfig must be an object.");
  }
  const enforcement = input.runConfig.permissions?.permissionProfile?.enforcement;
  if (enforcement !== "managed" && enforcement !== "external" && enforcement !== "disabled") {
    throw new TypeError("Run permission enforcement is invalid.");
  }
  assertUserApprovalBinding(input);
}

function assertUserApprovalBinding<TOutput>(input: HostRunStartInput<TOutput>): void {
  if (!Object.prototype.hasOwnProperty.call(input, "userApprovalReviewBridge")) {
    throw new TypeError(
      "Host Run must explicitly provide an approval review bridge or null.",
    );
  }
  const reviewer = input.runConfig.permissions.reviewer;
  const bridge = input.userApprovalReviewBridge;
  if (reviewer?.kind === "user") {
    if (bridge === null) {
      throw new TypeError("Host user reviewer requires an explicit approval review bridge.");
    }
    if (reviewer.reviewer !== bridge) {
      throw new TypeError("Host approval review bridge does not match the configured user reviewer.");
    }
    return;
  }
  if (bridge !== null) {
    throw new TypeError("Host Run without a user reviewer must not include an approval review bridge.");
  }
}

function assertRunResultIdentity<TOutput>(
  result: RunResult<TOutput>,
  runId: string,
  taskId: string,
): void {
  if (result.runId !== runId || result.taskId !== taskId) {
    throw new Error("Runner returned a result for a different Host Run.");
  }
}

function readNow(now: () => string): string {
  const value = now();
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError("HostRuntime clock must return a valid date-time string.");
  }
  return value;
}

function assertIdentity(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
}

function readSubmissionId(value: unknown): string {
  return typeof value === "object" && value !== null &&
      typeof (value as { submissionId?: unknown }).submissionId === "string"
    ? (value as { submissionId: string }).submissionId
    : "";
}

function rejectedApprovalSubmission(
  submissionId: string,
  code: Extract<ApprovalSubmissionReceipt, { status: "rejected" }>["code"],
): ApprovalSubmissionReceipt {
  return Object.freeze({ status: "rejected", submissionId, code });
}
