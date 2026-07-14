import type { CancellationAttribution, CancellationContext } from "../runner/RunCancellation.js";
import type { RetryClassifier, RetryFailure } from "./RetryFailure.js";
import type { RetryEventSink } from "./RetryEvent.js";
import type { RetryAttempt, RetryOperation, RetryOwner } from "./RetryOperation.js";
import type { RetryPolicy } from "./RetryPolicy.js";

export interface RetryExhausted<TFailure extends RetryFailure = RetryFailure> {
  readonly kind: "retry_exhausted";
  readonly owner: RetryOwner;
  readonly operationId: string;
  readonly reason: "retry_budget_exhausted" | "deadline_exceeded";
  readonly totalAttempts: number;
  readonly totalRetryDelayMs: number;
  readonly lastFailure: TFailure | null;
  readonly exhaustedAt: string;
}

export interface RetryBudgetExhausted<
  TFailure extends RetryFailure = RetryFailure,
> {
  readonly kind: "retry_budget_exhausted";
  readonly owner: RetryOwner;
  readonly operationId: string;
  readonly budgetId: string;
  readonly progress: RetryOperationProgress;
  readonly lastFailure: TFailure;
  readonly exhaustedAt: string;
}

export interface RetryExecutionInput<TError, TCategory extends string> {
  readonly operation: RetryOperation;
  readonly budgetId: string;
  readonly priorProgress: RetryOperationProgress;
  readonly policy: RetryPolicy<TCategory>;
  readonly classifier: RetryClassifier<TError, TCategory>;
  readonly cancellation: CancellationContext;
  readonly events: RetryEventSink;
}

export interface RetryOperationProgress {
  readonly completedAttempts: number;
  readonly totalRetryDelayMs: number;
}

export type RetryAttemptExecutionResult<TResult, TError> =
  | { readonly kind: "succeeded"; readonly value: TResult }
  | { readonly kind: "failed"; readonly error: TError }
  | {
      readonly kind: "cancelled";
      readonly attribution: CancellationAttribution;
    };

export interface RetryAttemptContext {
  readonly attempt: RetryAttempt;
  readonly signal: AbortSignal;
  readonly cancellation: CancellationContext;
  readonly deadlineReason: RetryDeadlineExceeded | null;
}

export interface RetryDeadlineExceeded {
  readonly kind: "retry_deadline_exceeded";
  readonly operationId: string;
  readonly deadlineAt: string;
}

export type RetryExecutionResult<
  TResult,
  TFailure extends RetryFailure = RetryFailure,
> =
  | { readonly kind: "succeeded"; readonly value: TResult }
  | { readonly kind: "failed"; readonly failure: TFailure }
  | {
      readonly kind: "budget_exhausted";
      readonly exhaustion: RetryBudgetExhausted<TFailure>;
    }
  | {
      readonly kind: "deadline_exhausted";
      readonly exhaustion: RetryExhausted<TFailure>;
    }
  | {
      readonly kind: "cancelled";
      readonly attribution: CancellationAttribution;
    };

export interface RetryClock {
  now(): Date;
}

export interface RetryIdGenerator {
  createAttemptId(operationId: string, attemptNumber: number): string;
}

export interface RetryRandomSource {
  nextUnit(): number;
}

export interface RetryWait {
  wait(
    delayMs: number,
    cancellation: CancellationContext,
  ): Promise<
    | { readonly kind: "elapsed" }
    | {
        readonly kind: "cancelled";
        readonly attribution: CancellationAttribution;
      }
  >;
}

export interface RetryAttemptInterruption {
  readonly signal: AbortSignal;
  readonly deadlineReason: RetryDeadlineExceeded | null;
  dispose(): void;
}

export interface RetryAttemptInterruptionFactory {
  create(
    operation: RetryOperation,
    cancellation: CancellationContext,
  ): RetryAttemptInterruption;
}

export interface RetryExecutorDependencies {
  readonly clock: RetryClock;
  readonly ids: RetryIdGenerator;
  readonly random: RetryRandomSource;
  readonly wait: RetryWait;
  readonly interruptions: RetryAttemptInterruptionFactory;
}
