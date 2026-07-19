import type { CancellationAttribution } from "@agent-anything/agent-core/run";
import {
  cancellationAttribution,
  exactCancellationRequest,
} from "./RetryDependencies.js";
import type {
  RetryAttemptExecutionResult,
  RetryBudgetExhausted,
  RetryExecutionInput,
  RetryExecutionResult,
  RetryExecutorDependencies,
  RetryExhausted,
  RetryOperationProgress,
} from "@agent-anything/agent-core/retry";
import type { RetryFailure, RetryDelay } from "@agent-anything/agent-core/retry";
import type {
  RetryAttemptFinishedEvent,
  RetryAttemptStartedEvent,
  RetryCancelledEvent,
  RetryEvent,
  RetryExhaustedEvent,
  RetryScheduledEvent,
} from "@agent-anything/agent-core/retry";
import { snapshotRetryEvent } from "@agent-anything/agent-core/retry";
import type { RetryAttempt, RetryOperation } from "@agent-anything/agent-core/retry";
import { snapshotRetryOperation } from "@agent-anything/agent-core/retry";
import type { RetryPolicy } from "@agent-anything/agent-core/retry";
import { snapshotRetryPolicy } from "@agent-anything/agent-core/retry";

export class RetryExecutor {
  constructor(private readonly dependencies: RetryExecutorDependencies) {
    validateDependencies(dependencies);
  }

  async execute<TResult, TError, TCategory extends string>(
    input: RetryExecutionInput<TError, TCategory>,
    executeAttempt: (
      context: import("@agent-anything/agent-core/retry").RetryAttemptContext,
    ) => Promise<RetryAttemptExecutionResult<TResult, TError>>,
  ): Promise<RetryExecutionResult<TResult, RetryFailure<TCategory>, TError>> {
    const operation = snapshotRetryOperation(input.operation);
    const policy = snapshotRetryPolicy(input.policy);
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
    const attemptIds = new Set<string>();
    let budgetAttemptNumber = 1;
    let completedAttempts = progress.completedAttempts;
    let totalRetryDelayMs = progress.totalRetryDelayMs;
    let lastFailure: RetryFailure<TCategory> | null = null;

    while (true) {
      if (input.cancellation.signal.aborted) {
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

      if (deadlineElapsed(operation, this.dependencies)) {
        return this.deadlineExhausted(
          input,
          operation,
          completedAttempts,
          totalRetryDelayMs,
          lastFailure,
        );
      }

      const attemptNumber = progress.completedAttempts + budgetAttemptNumber;
      const attempt = createAttempt(
        operation,
        input.budgetId,
        attemptNumber,
        budgetAttemptNumber,
        maxBudgetAttempts,
        this.dependencies,
      );
      if (attemptIds.has(attempt.attemptId)) {
        throw new TypeError(`Retry attempt id ${attempt.attemptId} is duplicated.`);
      }
      attemptIds.add(attempt.attemptId);

      const interruption = this.dependencies.interruptions.create(
        operation,
        input.cancellation,
      );
      let attemptResult: RetryAttemptExecutionResult<TResult, TError>;
      try {
        await emit(input, retryAttemptStartedEvent(operation, attempt));
        attemptResult = await executeAttempt(Object.freeze({
          attempt,
          signal: interruption.signal,
          cancellation: input.cancellation,
          get deadlineReason() {
            return interruption.deadlineReason;
          },
        }));
      } finally {
        interruption.dispose();
      }

      completedAttempts = attemptNumber;
      const finishedAt = now(this.dependencies);
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
      const failure = snapshotClassification(classification);
      lastFailure = failure;

      if (classification.disposition === "deadline_exceeded") {
        const deadlineReason = interruption.deadlineReason;
        if (
          !interruption.signal.aborted ||
          deadlineReason === null ||
          deadlineReason.operationId !== operation.operationId ||
          deadlineReason.deadlineAt !== operation.deadlineAt
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

      if (budgetAttemptNumber >= maxBudgetAttempts) {
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

      const delay = resolveDelay(
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

      const waitResult = await this.dependencies.wait.wait(
        delay.value.delayMs,
        input.cancellation,
      );
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
  classification: import("@agent-anything/agent-core/retry").RetryClassification<TCategory>,
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
