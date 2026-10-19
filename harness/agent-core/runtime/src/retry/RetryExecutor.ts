import type { CancellationAttribution } from "../run/index.js";
import {
  cancellationAttribution,
  exactCancellationRequest,
} from "./RetryDependencies.js";
import type {
  RetryAttemptContext,
  RetryAttemptExecutionResult,
  RetryExecutionInput,
  RetryExecutionResult,
  RetryExecutorDependencies,
} from "./RetryExecution.js";
import type {
  RetryBudgetExhausted,
  RetryExhausted,
  RetryOperationProgress,
} from "./RetryExhaustion.js";
import type {
  RetryClassification,
  RetryDelay,
  RetryFailure,
} from "./RetryFailure.js";
import type {
  RetryAttemptFinishedEvent,
  RetryAttemptStartedEvent,
  RetryCancelledEvent,
  RetryEvent,
  RetryExhaustedEvent,
  RetryScheduledEvent,
} from "./RetryEvent.js";
import { snapshotRetryEvent } from "./RetryEvent.js";
import type { RetryAttempt, RetryOperation } from "./RetryOperation.js";
import { snapshotRetryOperation } from "./RetryOperation.js";
import type { RetryPolicy } from "./RetryPolicy.js";
import { snapshotRetryPolicy } from "./RetryPolicy.js";
import { RetryInvocationInvalidatedError } from "./RetryWaitControl.js";
import { ExecutionFlowPath } from "@agent-anything/observability/execution-flow";
import { RETRY_EXECUTION_FLOW } from "./RetryExecutionFlow.js";
import { canonicalEncode } from "@agent-anything/canonical-action/subject";
import { RetryCheckpointError, type RetryCheckpoint, type RetryCheckpointPort } from "./RetryCheckpoint.js";

export class RetryExecutor {
  constructor(private readonly dependencies: RetryExecutorDependencies) {
    validateDependencies(dependencies);
  }

  async execute<TResult, TError, TCategory extends string>(
    input: RetryExecutionInput<TError, TCategory>,
    executeAttempt: (context: RetryAttemptContext) => Promise<RetryAttemptExecutionResult<TResult, TError>>,
    checkpoint?: RetryCheckpointPort<TResult, TError, TCategory>,
  ): Promise<RetryExecutionResult<TResult, RetryFailure<TCategory>, TError>> {
    const flow = new ExecutionFlowPath(RETRY_EXECUTION_FLOW, input.executionFlow ?? {}, input.operation.runId, []);
    try {
      let retained: RetryCheckpoint<TResult, TError, TCategory> | null;
      try {
        retained = checkpoint?.read() ?? null;
        if (retained) validateCheckpoint(retained, input);
      } catch (cause) { throw new RetryCheckpointError(input.operation.operationId, {cause}); }
      for (const event of retained?.events ?? []) await input.events.emit(event);
      if (retained?.outcome) {
        flow.advance("settled", {outcome: retained.outcome.kind, restored: true});
        flow.close(retained.outcome.kind === "succeeded" ? "returned" : retained.outcome.kind === "cancelled" ? "cancelled" : "failed");
        return retained.outcome;
      }
      let current: RetryCheckpoint<TResult, TError, TCategory> = retained ?? {
        operation: snapshotRetryOperation(input.operation), budgetId: input.budgetId,
        policy: snapshotRetryPolicy(input.policy), priorProgress: snapshotProgress(input.priorProgress),
        totalRetryDelayMs: input.priorProgress.totalRetryDelayMs,
        attempt: null, attemptResult: null, attemptFinishedAt: null, deadlineObserved: false, events: [], delay: null, outcome: null,
      };
      const save = async (changes: Partial<typeof current>) => {
        const next = {...current, ...changes};
        try { await checkpoint?.commit(next); }
        catch (cause) { throw new RetryCheckpointError(input.operation.operationId, {cause}); }
        current = next;
      };
      if (checkpoint && !retained) await save({});
      const durableInput = {...input, events: {emit: async (event: RetryEvent) => {
        const key = retryEventIdentity(event);
        let recorded = current.events.find(item => retryEventIdentity(item) === key);
        if (!recorded) {
          recorded = snapshotRetryEvent(event, input.operation.runId);
          await save({events: [...current.events, recorded]});
        }
        await input.events.emit(recorded);
      }}};
      const result = await this.executeWithFlow(durableInput, executeAttempt, flow,
        {retained, save, reconcile: checkpoint?.reconcile.bind(checkpoint)});
      await save({outcome: result});
      flow.advance("settled", {outcome: result.kind}).output(flow.material("Retry execution result", "settled", result, input.operation.owner === "approvals_reviewer" ? "execution" : "provider"));
      flow.close(result.kind === "succeeded" ? "returned" : result.kind === "cancelled" ? "cancelled" : "failed");
      return result;
    } catch (error) { flow.close(error instanceof RetryInvocationInvalidatedError ? "interrupted" : "failed"); throw error; }
  }

  private async executeWithFlow<TResult, TError, TCategory extends string>(
    input: RetryExecutionInput<TError, TCategory>,
    executeAttempt: (
      context: RetryAttemptContext,
    ) => Promise<RetryAttemptExecutionResult<TResult, TError>>,
    flow: ExecutionFlowPath,
    persistence: {
      readonly retained: RetryCheckpoint<TResult, TError, TCategory> | null;
      readonly save: (changes: Partial<RetryCheckpoint<TResult, TError, TCategory>>) => Promise<void>;
      readonly reconcile: RetryCheckpointPort<TResult, TError, TCategory>["reconcile"] | undefined;
    },
  ): Promise<RetryExecutionResult<TResult, RetryFailure<TCategory>, TError>> {
    const operation = snapshotRetryOperation(input.operation);
    const policy = snapshotRetryPolicy(input.policy);
    const materialClass = operation.owner === "approvals_reviewer" ? "execution" : "provider";
    const retryInputRef = flow.material("Retry operation and policy", "received", {operation, policy, budgetId: input.budgetId, priorProgress: input.priorProgress}, materialClass);
    const progress = snapshotProgress(input.priorProgress);
    assertNonEmpty(input.budgetId, "RetryExecutionInput.budgetId");
    if (input.cancellation.runId !== operation.runId) {
      throw new TypeError("Retry cancellation runId must match RetryOperation.runId.");
    }
    if (!input.classifier || typeof input.classifier.classify !== "function") {
      throw new TypeError("RetryExecutionInput.classifier must provide classify().");
    }
    if (!input.events || typeof input.events.emit !== "function") {
      throw new TypeError("RetryExecutionInput.events must provide emit().");
    }
    if (typeof executeAttempt !== "function") {
      throw new TypeError("RetryExecutor requires executeAttempt().");
    }

    const maxBudgetAttempts = policy.maxRetries + 1;
    const recovery = policy.exhaustion?.kind === "retry_after_delay" ? policy.exhaustion : null;
    if (recovery !== null && operation.owner !== "provider_request" && operation.owner !== "response_stream") {
      throw new TypeError("Additional network recovery is only available to Provider request owners.");
    }
    const maximumAttempts = maxBudgetAttempts + (recovery?.maxAdditionalAttempts ?? 0);
    const attemptIds = new Set<string>();
    let resumed = persistence.retained;
    let budgetAttemptNumber = resumed?.attempt?.budgetAttemptNumber ?? 1;
    let completedAttempts = resumed?.attempt ? resumed.attempt.attemptNumber - 1 : progress.completedAttempts;
    let totalRetryDelayMs = resumed?.totalRetryDelayMs ?? progress.totalRetryDelayMs;
    let lastFailure: RetryFailure<TCategory> | null = null;

    while (true) {
      if (!resumed?.attempt && input.cancellation.signal.aborted) {
        const attribution = cancellationAttribution(
          input.cancellation,
          this.dependencies.clock,
        );
        await emit(input, retryCancelledEvent(
          operation,
          input.budgetId,
          "before_attempt",
          null,
          null,
          attribution,
          nowIso(this.dependencies),
        ));
        return { kind: "cancelled", attribution };
      }

      if (!resumed?.attempt && deadlineElapsed(operation, this.dependencies)) {
        return this.deadlineExhausted(
          input,
          operation,
          completedAttempts,
          totalRetryDelayMs,
          lastFailure,
        );
      }

      const attemptNumber = progress.completedAttempts + budgetAttemptNumber;
      const attempt = resumed?.attempt ?? createAttempt(
        operation,
        input.budgetId,
        attemptNumber,
        budgetAttemptNumber,
        maximumAttempts,
        this.dependencies,
      );
      if (attemptIds.has(attempt.attemptId)) {
        throw new TypeError(`Retry attempt id ${attempt.attemptId} is duplicated.`);
      }
      attemptIds.add(attempt.attemptId);
      const attemptStep = flow.advance("attempt", {attemptId: attempt.attemptId, operationId: operation.operationId, attemptNumber, budgetAttemptNumber, initialMaximum: maxBudgetAttempts, maximumAttempts, deadlineAt: operation.deadlineAt ?? null}, [retryInputRef, {owner: "retry",kind:"attempt",id:attempt.attemptId,revision:null}]);
      attemptStep.check("cancellation", "passed");
      attemptStep.check("deadline", "passed");

      const interruption = this.dependencies.interruptions.create(
        operation,
        input.cancellation,
      );
      let attemptResult: RetryAttemptExecutionResult<TResult, TError>;
      try {
        const context = Object.freeze({
          executionFlow: flow.callContext,
          attempt,
          signal: interruption.signal,
          cancellation: input.cancellation,
          get deadlineReason() {
            return interruption.deadlineReason;
          },
        });
        if (resumed?.attempt) {
          attemptResult = resumed.attemptResult ?? await persistence.reconcile!(context);
        } else {
          await persistence.save({attempt, attemptResult: null, attemptFinishedAt: null, deadlineObserved: false, delay: null, totalRetryDelayMs});
          await emit(input, retryAttemptStartedEvent(operation, attempt));
          attemptResult = await executeAttempt(context);
        }
        if (!resumed?.attemptResult) await persistence.save({attemptResult, attemptFinishedAt: nowIso(this.dependencies),
          deadlineObserved: interruption.signal.aborted && interruption.deadlineReason?.operationId === operation.operationId &&
            interruption.deadlineReason?.deadlineAt === operation.deadlineAt});
      } finally {
        interruption.dispose();
      }

      completedAttempts = attemptNumber;
      const attemptResultRef = flow.material("Retry attempt result", "returned", attemptResult, materialClass);
      attemptStep.output(attemptResultRef);
      const finishedAt = resumed?.attemptFinishedAt ? new Date(resumed.attemptFinishedAt) : now(this.dependencies);
      const durationMs = Math.max(0, finishedAt.getTime() - Date.parse(attempt.startedAt));

      if (attemptResult.kind === "succeeded") {
        await emit(input, retryAttemptFinishedEvent(
          operation,
          attempt,
          durationMs,
          "succeeded",
          "return_to_owner",
          finishedAt.toISOString(),
        ));
        return { kind: "succeeded", value: attemptResult.value };
      }

      if (attemptResult.kind === "cancelled") {
        assertCancellationAttribution(attemptResult.attribution, input, operation);
        await emit(input, retryAttemptFinishedEvent(
          operation,
          attempt,
          durationMs,
          "cancelled",
          "cancelled",
          finishedAt.toISOString(),
        ));
        await emit(input, retryCancelledEvent(
          operation,
          input.budgetId,
          "attempt",
          attempt.attemptId,
          attempt.attemptNumber,
          attemptResult.attribution,
          nowIso(this.dependencies),
        ));
        return { kind: "cancelled", attribution: attemptResult.attribution };
      }

      const classification = input.classifier.classify(attemptResult.error);
      const classificationStep = flow.advance("classify", {}, [attemptResultRef]);
      classificationStep.check("failure_classification", "passed", {disposition: classification.disposition});
      const failure = snapshotClassification(classification);
      classificationStep.output(flow.material("Retry failure classification", "classified", failure, materialClass));
      lastFailure = failure;

      if (classification.disposition === "deadline_exceeded") {
        const deadlineReason = interruption.deadlineReason;
        if (
          !resumed?.deadlineObserved && (!interruption.signal.aborted ||
          deadlineReason === null ||
          deadlineReason.operationId !== operation.operationId ||
          deadlineReason.deadlineAt !== operation.deadlineAt)
        ) {
          throw new TypeError(
            "deadline_exceeded classification requires the active operation deadline.",
          );
        }
        await emit(input, retryAttemptFinishedEvent(
          operation,
          attempt,
          durationMs,
          "failed",
          "deadline_exhausted",
          finishedAt.toISOString(),
          failure,
        ));
        return this.deadlineExhausted(
          input,
          operation,
          completedAttempts,
          totalRetryDelayMs,
          failure,
        );
      }

      if (input.cancellation.signal.aborted) {
        exactCancellationRequest(input.cancellation);
        await emit(input, retryAttemptFinishedEvent(
          operation,
          attempt,
          durationMs,
          "failed",
          "return_to_owner",
          finishedAt.toISOString(),
          failure,
        ));
        return { kind: "failed", failure, error: attemptResult.error };
      }

      if (
        classification.disposition === "non_retryable" ||
        !policy.retryableCategories.includes(failure.category)
      ) {
        await emit(input, retryAttemptFinishedEvent(
          operation,
          attempt,
          durationMs,
          "failed",
          "return_to_owner",
          finishedAt.toISOString(),
          failure,
        ));
        return { kind: "failed", failure, error: attemptResult.error };
      }

      if (deadlineElapsed(operation, this.dependencies)) {
        await emit(input, retryAttemptFinishedEvent(
          operation,
          attempt,
          durationMs,
          "failed",
          "deadline_exhausted",
          finishedAt.toISOString(),
          failure,
        ));
        return this.deadlineExhausted(
          input,
          operation,
          completedAttempts,
          totalRetryDelayMs,
          failure,
        );
      }

      const budgetStep = flow.advance("budget", {completedAttempts, maximumAttempts});
      budgetStep.check("initial_allowance", budgetAttemptNumber < maxBudgetAttempts ? "passed" : "not_satisfied", {maxBudgetAttempts, budgetAttemptNumber});
      budgetStep.check("recovery_allowance", recovery === null ? "not_applicable" : budgetAttemptNumber < maximumAttempts ? "passed" : "not_satisfied", {additionalAttempts: recovery?.maxAdditionalAttempts ?? 0});
      if (budgetAttemptNumber >= maximumAttempts) {
        await emit(input, retryAttemptFinishedEvent(
          operation,
          attempt,
          durationMs,
          "failed",
          "budget_exhausted",
          finishedAt.toISOString(),
          failure,
        ));
        return {
          kind: "budget_exhausted",
          exhaustion: budgetExhausted(
            operation,
            input.budgetId,
            completedAttempts,
            totalRetryDelayMs,
            failure,
            nowIso(this.dependencies),
          ),
        };
      }

      const delay = resumed?.delay ? {kind: "delay" as const, value: resumed.delay}
        : recovery !== null && budgetAttemptNumber >= maxBudgetAttempts
        ? { kind: "delay" as const, value: createDelay(recovery.delayMs, "delayed_recovery", now(this.dependencies)) }
        : resolveDelay(
        policy,
        budgetAttemptNumber,
        failure,
        this.dependencies,
      );
      if (delay.kind === "server_delay_exceeds_limit") {
        await emit(input, retryAttemptFinishedEvent(
          operation,
          attempt,
          durationMs,
          "failed",
          "return_to_owner",
          finishedAt.toISOString(),
          failure,
        ));
        return { kind: "failed", failure, error: attemptResult.error };
      }
      if (
        operation.deadlineAt !== undefined &&
        Date.parse(delay.value.nextAttemptAt) >= Date.parse(operation.deadlineAt)
      ) {
        await emit(input, retryAttemptFinishedEvent(
          operation,
          attempt,
          durationMs,
          "failed",
          "deadline_exhausted",
          finishedAt.toISOString(),
          failure,
        ));
        return this.deadlineExhausted(
          input,
          operation,
          completedAttempts,
          totalRetryDelayMs,
          failure,
        );
      }

      await persistence.save({delay: delay.value});
      await emit(input, retryAttemptFinishedEvent(
        operation,
        attempt,
        durationMs,
        "failed",
        "retry_scheduled",
        finishedAt.toISOString(),
        failure,
      ));
      await emit(input, retryScheduledEvent(
        operation,
        attempt,
        delay.value,
        failure,
        nowIso(this.dependencies),
      ));

      const remainingDelayMs = Math.max(0, Date.parse(delay.value.nextAttemptAt) - now(this.dependencies).getTime());
      const arm = (disposal?: AbortSignal) => this.dependencies.wait.wait(remainingDelayMs, input.cancellation, disposal);
      flow.advance("wait", {delayMs: delay.value.delayMs, nextAttemptAt: delay.value.nextAttemptAt, controlled: input.waitControl !== undefined});
      const waitResult = input.waitControl === undefined
        ? await arm()
        : await input.waitControl.wait({ operation, precedingAttempt: attempt, policy, delay: delay.value, executionFlow: flow.callContext }, arm);
      if (waitResult.kind === "invalidated" || waitResult.kind === "disposed") throw new RetryInvocationInvalidatedError();
      if (waitResult.kind === "deadline_exceeded") {
        return this.deadlineExhausted(input, operation, completedAttempts, totalRetryDelayMs, lastFailure);
      }
      if (waitResult.kind === "cancelled") {
        assertCancellationAttribution(waitResult.attribution, input, operation);
        await emit(input, retryCancelledEvent(
          operation,
          input.budgetId,
          "backoff",
          null,
          null,
          waitResult.attribution,
          nowIso(this.dependencies),
        ));
        return { kind: "cancelled", attribution: waitResult.attribution };
      }

      totalRetryDelayMs = safeAdd(
        totalRetryDelayMs,
        delay.value.delayMs,
        "Retry total delay",
      );
      budgetAttemptNumber += 1;
      resumed = null;
    }
  }

  private async deadlineExhausted<TError, TCategory extends string>(
    input: RetryExecutionInput<TError, TCategory>,
    operation: RetryOperation,
    totalAttempts: number,
    totalRetryDelayMs: number,
    lastFailure: RetryFailure<TCategory> | null,
  ): Promise<{
    readonly kind: "deadline_exhausted";
    readonly exhaustion: RetryExhausted<RetryFailure<TCategory>>;
  }> {
    const exhaustion = Object.freeze({
      kind: "retry_exhausted" as const,
      owner: operation.owner,
      operationId: operation.operationId,
      reason: "deadline_exceeded" as const,
      totalAttempts,
      totalRetryDelayMs,
      lastFailure,
      exhaustedAt: nowIso(this.dependencies),
    });
    await emit(input, retryExhaustedEvent(
      operation,
      input.budgetId,
      exhaustion,
    ));
    return { kind: "deadline_exhausted", exhaustion };
  }
}

function validateCheckpoint<TResult, TError, TCategory extends string>(
  saved: RetryCheckpoint<TResult, TError, TCategory>, input: RetryExecutionInput<TError, TCategory>,
): void {
  const binding = (value: Pick<typeof saved, "operation" | "budgetId" | "policy" | "priorProgress">) =>
    canonicalEncode("retry-checkpoint-binding.v1", {operation: value.operation, budgetId: value.budgetId,
      policy: value.policy, priorProgress: value.priorProgress});
  const left = binding(saved), right = binding(input);
  if (left.length !== right.length || left.some((value, index) => value !== right[index])) {
    throw new TypeError("Retained Retry binding does not match the original operation and budget.");
  }
  const attempt = saved.attempt;
  const maximum = input.policy.maxRetries + 1 + (input.policy.exhaustion?.kind === "retry_after_delay"
    ? input.policy.exhaustion.maxAdditionalAttempts : 0);
  if (!Array.isArray(saved.events) || typeof saved.deadlineObserved !== "boolean" ||
      (saved.attemptResult === null) !== (saved.attemptFinishedAt === null) ||
      saved.attemptFinishedAt !== null && !Number.isFinite(Date.parse(saved.attemptFinishedAt))) {
    throw new TypeError("Retained Retry result timing is invalid.");
  }
  const eventIds = new Set<string>();
  for (const event of saved.events) {
    snapshotRetryEvent(event, input.operation.runId);
    const id = retryEventIdentity(event);
    if (event.operationId !== input.operation.operationId || eventIds.has(id)) throw new TypeError("Retained Retry event identity is invalid.");
    eventIds.add(id);
  }
  if (!Number.isSafeInteger(saved.totalRetryDelayMs) || saved.totalRetryDelayMs < saved.priorProgress.totalRetryDelayMs ||
      (attempt === null && (saved.attemptResult !== null || saved.delay !== null)) ||
      (attempt !== null && (attempt.operationId !== input.operation.operationId || attempt.budgetId !== input.budgetId ||
        !Number.isSafeInteger(attempt.budgetAttemptNumber) || attempt.budgetAttemptNumber < 1 ||
        attempt.budgetAttemptNumber > maximum || attempt.maxBudgetAttempts !== maximum ||
        attempt.attemptNumber !== input.priorProgress.completedAttempts + attempt.budgetAttemptNumber)) ||
      (saved.delay !== null && (saved.attemptResult?.kind !== "failed" ||
        !Number.isFinite(Date.parse(saved.delay.nextAttemptAt))))) {
    throw new TypeError("Retained Retry progress is inconsistent.");
  }
}

function resolveDelay<TCategory extends string>(
  policy: RetryPolicy<TCategory>,
  retryNumber: number,
  failure: RetryFailure<TCategory>,
  dependencies: RetryExecutorDependencies,
):
  | { readonly kind: "delay"; readonly value: RetryDelay }
  | { readonly kind: "server_delay_exceeds_limit" } {
  const scheduledAt = now(dependencies);
  const trustedDelay = failure.retryAfterMs;
  if (
    policy.serverDelay.mode === "prefer_trusted" &&
    Number.isSafeInteger(trustedDelay) &&
    trustedDelay !== undefined &&
    trustedDelay >= 0
  ) {
    if (trustedDelay > policy.serverDelay.maxServerDelayMs) {
      return { kind: "server_delay_exceeds_limit" };
    }
    return {
      kind: "delay",
      value: createDelay(trustedDelay, "trusted_server_delay", scheduledAt),
    };
  }

  const randomUnit = dependencies.random.nextUnit();
  if (!Number.isFinite(randomUnit) || randomUnit < 0 || randomUnit >= 1) {
    throw new TypeError("RetryRandomSource.nextUnit() must return a value in [0, 1). ");
  }
  const rawDelay = policy.delay.baseDelayMs * (policy.delay.multiplier ** (retryNumber - 1));
  const boundedDelay = Math.min(rawDelay, policy.delay.maxDelayMs);
  const jitterFactor = 1 - policy.delay.jitterRatio + randomUnit * (2 * policy.delay.jitterRatio);
  const delayMs = Math.floor(Math.min(
    boundedDelay * jitterFactor,
    policy.delay.maxDelayMs,
  ));
  return {
    kind: "delay",
    value: createDelay(delayMs, "calculated_backoff", scheduledAt),
  };
}

function createDelay(
  delayMs: number,
  source: RetryDelay["source"],
  scheduledAt: Date,
): RetryDelay {
  const nextAttemptAt = new Date(scheduledAt.getTime() + delayMs);
  if (!Number.isFinite(nextAttemptAt.getTime())) {
    throw new TypeError("Retry delay produces an invalid next attempt time.");
  }
  return Object.freeze({
    delayMs,
    source,
    scheduledAt: scheduledAt.toISOString(),
    nextAttemptAt: nextAttemptAt.toISOString(),
  });
}

function createAttempt(
  operation: RetryOperation,
  budgetId: string,
  attemptNumber: number,
  budgetAttemptNumber: number,
  maxBudgetAttempts: number,
  dependencies: RetryExecutorDependencies,
): RetryAttempt {
  const attemptId = dependencies.ids.createAttemptId(operation.operationId, attemptNumber);
  assertNonEmpty(attemptId, "RetryAttempt.attemptId");
  return Object.freeze({
    attemptId,
    operationId: operation.operationId,
    budgetId,
    attemptNumber,
    budgetAttemptNumber,
    retryNumber: budgetAttemptNumber - 1,
    maxBudgetAttempts,
    startedAt: nowIso(dependencies),
  });
}

function snapshotClassification<TCategory extends string>(
  classification: RetryClassification<TCategory>,
): RetryFailure<TCategory> {
  if (!classification || typeof classification !== "object") {
    throw new TypeError("RetryClassifier must return a classification.");
  }
  if (![
    "retryable",
    "non_retryable",
    "deadline_exceeded",
  ].includes(classification.disposition)) {
    throw new TypeError("Retry classification disposition is unsupported.");
  }
  assertNonEmpty(classification.reasonCode, "RetryClassification.reasonCode");
  const failure = classification.failure;
  if (!failure || typeof failure !== "object") {
    throw new TypeError("RetryClassification.failure must be an object.");
  }
  assertNonEmpty(failure.category, "RetryFailure.category");
  assertNonEmpty(failure.code, "RetryFailure.code");
  assertNonEmpty(failure.message, "RetryFailure.message");
  if (failure.requestId !== undefined) {
    assertNonEmpty(failure.requestId, "RetryFailure.requestId");
  }
  if (
    failure.statusCode !== undefined &&
    (!Number.isSafeInteger(failure.statusCode) || failure.statusCode < 100 || failure.statusCode > 599)
  ) {
    throw new TypeError("RetryFailure.statusCode must be an HTTP status code.");
  }
  const retryAfterMs = Number.isSafeInteger(failure.retryAfterMs) &&
      failure.retryAfterMs !== undefined && failure.retryAfterMs >= 0
    ? failure.retryAfterMs
    : undefined;
  return Object.freeze({
    category: failure.category,
    code: failure.code,
    message: failure.message,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(failure.requestId === undefined ? {} : { requestId: failure.requestId }),
    ...(failure.statusCode === undefined ? {} : { statusCode: failure.statusCode }),
  });
}

function budgetExhausted<TCategory extends string>(
  operation: RetryOperation,
  budgetId: string,
  completedAttempts: number,
  totalRetryDelayMs: number,
  lastFailure: RetryFailure<TCategory>,
  exhaustedAt: string,
): RetryBudgetExhausted<RetryFailure<TCategory>> {
  return Object.freeze({
    kind: "retry_budget_exhausted",
    owner: operation.owner,
    operationId: operation.operationId,
    budgetId,
    progress: Object.freeze({ completedAttempts, totalRetryDelayMs }),
    lastFailure,
    exhaustedAt,
  });
}

function retryAttemptStartedEvent(
  operation: RetryOperation,
  attempt: RetryAttempt,
): RetryAttemptStartedEvent {
  return Object.freeze({
    ...eventBase(operation, attempt.startedAt),
    type: "retry_attempt_started",
    attemptId: attempt.attemptId,
    budgetId: attempt.budgetId,
    attemptNumber: attempt.attemptNumber,
    budgetAttemptNumber: attempt.budgetAttemptNumber,
    maxBudgetAttempts: attempt.maxBudgetAttempts,
  });
}

function retryAttemptFinishedEvent<TCategory extends string>(
  operation: RetryOperation,
  attempt: RetryAttempt,
  durationMs: number,
  outcome: RetryAttemptFinishedEvent["outcome"],
  next: RetryAttemptFinishedEvent["next"],
  occurredAt: string,
  failure?: RetryFailure<TCategory>,
): RetryAttemptFinishedEvent {
  return Object.freeze({
    ...eventBase(operation, occurredAt),
    type: "retry_attempt_finished",
    attemptId: attempt.attemptId,
    budgetId: attempt.budgetId,
    attemptNumber: attempt.attemptNumber,
    budgetAttemptNumber: attempt.budgetAttemptNumber,
    durationMs,
    outcome,
    ...(failure === undefined
      ? {}
      : {
          failureCategory: failure.category,
          failureCode: failure.code,
        }),
    next,
  });
}

function retryScheduledEvent<TCategory extends string>(
  operation: RetryOperation,
  attempt: RetryAttempt,
  delay: RetryDelay,
  failure: RetryFailure<TCategory>,
  occurredAt: string,
): RetryScheduledEvent {
  return Object.freeze({
    ...eventBase(operation, occurredAt),
    type: "retry_scheduled",
    afterAttemptId: attempt.attemptId,
    budgetId: attempt.budgetId,
    retryNumber: attempt.retryNumber + 1,
    nextAttemptNumber: attempt.attemptNumber + 1,
    nextBudgetAttemptNumber: attempt.budgetAttemptNumber + 1,
    delayMs: delay.delayMs,
    delaySource: delay.source,
    nextAttemptAt: delay.nextAttemptAt,
    failureCategory: failure.category,
    failureCode: failure.code,
  });
}

function retryCancelledEvent(
  operation: RetryOperation,
  budgetId: string,
  phase: RetryCancelledEvent["phase"],
  attemptId: string | null,
  attemptNumber: number | null,
  attribution: CancellationAttribution,
  occurredAt: string,
): RetryCancelledEvent {
  return Object.freeze({
    ...eventBase(operation, occurredAt),
    type: "retry_cancelled",
    phase,
    budgetId,
    attemptId,
    attemptNumber,
    attribution: Object.freeze({
      requestId: attribution.requestId,
      runId: attribution.runId,
      operation: attribution.operation,
      observedAt: attribution.observedAt,
    }),
  });
}

function retryExhaustedEvent<TFailure extends RetryFailure>(
  operation: RetryOperation,
  budgetId: string,
  exhaustion: RetryExhausted<TFailure>,
): RetryExhaustedEvent {
  return Object.freeze({
    ...eventBase(operation, exhaustion.exhaustedAt),
    type: "retry_exhausted",
    finalBudgetId: budgetId,
    reason: exhaustion.reason,
    totalAttempts: exhaustion.totalAttempts,
    totalRetryDelayMs: exhaustion.totalRetryDelayMs,
    lastFailureCategory: exhaustion.lastFailure?.category ?? null,
    lastFailureCode: exhaustion.lastFailure?.code ?? null,
  });
}

function eventBase(operation: RetryOperation, occurredAt: string) {
  return {
    runId: operation.runId,
    operationId: operation.operationId,
    owner: operation.owner,
    occurredAt,
  } as const;
}

function snapshotProgress(progress: RetryOperationProgress): RetryOperationProgress {
  if (!progress || typeof progress !== "object") {
    throw new TypeError("RetryOperationProgress must be an object.");
  }
  assertNonNegativeInteger(progress.completedAttempts, "completedAttempts");
  assertNonNegativeInteger(progress.totalRetryDelayMs, "totalRetryDelayMs");
  return Object.freeze({
    completedAttempts: progress.completedAttempts,
    totalRetryDelayMs: progress.totalRetryDelayMs,
  });
}

function assertCancellationAttribution<TError, TCategory extends string>(
  attribution: CancellationAttribution,
  input: RetryExecutionInput<TError, TCategory>,
  operation: RetryOperation,
): void {
  const request = exactCancellationRequest(input.cancellation);
  if (
    attribution.requestId !== request.id ||
    attribution.runId !== operation.runId ||
    !Number.isFinite(Date.parse(attribution.observedAt))
  ) {
    throw new TypeError("Retry cancellation attribution does not match the active request.");
  }
}

function deadlineElapsed(
  operation: RetryOperation,
  dependencies: RetryExecutorDependencies,
): boolean {
  return operation.deadlineAt !== undefined &&
    now(dependencies).getTime() >= Date.parse(operation.deadlineAt);
}

function now(dependencies: RetryExecutorDependencies): Date {
  const value = dependencies.clock.now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("RetryClock.now() must return a valid Date.");
  }
  return value;
}

function nowIso(dependencies: RetryExecutorDependencies): string {
  return now(dependencies).toISOString();
}

async function emit<TError, TCategory extends string>(
  input: RetryExecutionInput<TError, TCategory>,
  event: RetryEvent,
): Promise<void> {
  await input.events.emit(snapshotRetryEvent(event, event.runId));
}

function retryEventIdentity(event: RetryEvent): string {
  switch (event.type) {
    case "retry_attempt_started": case "retry_attempt_finished": return JSON.stringify([event.type, event.operationId, event.attemptId]);
    case "retry_scheduled": return JSON.stringify([event.type, event.operationId, event.afterAttemptId]);
    case "retry_cancelled": return JSON.stringify([event.type, event.operationId, event.budgetId, event.phase, event.attemptId]);
    case "retry_exhausted": return JSON.stringify([event.type, event.operationId, event.finalBudgetId]);
    case "retry_fallback_selected": return JSON.stringify([event.type, event.operationId, event.fallbackNumber]);
  }
}

function validateDependencies(dependencies: RetryExecutorDependencies): void {
  if (!dependencies || typeof dependencies !== "object") {
    throw new TypeError("RetryExecutor dependencies are required.");
  }
  if (!dependencies.clock || typeof dependencies.clock.now !== "function") {
    throw new TypeError("RetryExecutor requires a clock.");
  }
  if (!dependencies.ids || typeof dependencies.ids.createAttemptId !== "function") {
    throw new TypeError("RetryExecutor requires an id generator.");
  }
  if (!dependencies.random || typeof dependencies.random.nextUnit !== "function") {
    throw new TypeError("RetryExecutor requires a random source.");
  }
  if (!dependencies.wait || typeof dependencies.wait.wait !== "function") {
    throw new TypeError("RetryExecutor requires a wait dependency.");
  }
  if (!dependencies.interruptions || typeof dependencies.interruptions.create !== "function") {
    throw new TypeError("RetryExecutor requires an interruption factory.");
  }
}

function safeAdd(left: number, right: number, field: string): number {
  const value = left + right;
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${field} exceeds the safe integer range.`);
  }
  return value;
}

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer.`);
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
}
