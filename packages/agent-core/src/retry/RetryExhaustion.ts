import type { RetryFailure } from "./RetryFailure.js";
import type { RetryOwner } from "./RetryOperation.js";

export type RetryExhaustionReason =
  | "retry_budget_exhausted"
  | "deadline_exceeded";

export interface RetryOperationProgress {
  readonly completedAttempts: number;
  readonly totalRetryDelayMs: number;
}

export interface RetryExhausted<TFailure extends RetryFailure = RetryFailure> {
  readonly kind: "retry_exhausted";
  readonly owner: RetryOwner;
  readonly operationId: string;
  readonly reason: RetryExhaustionReason;
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
