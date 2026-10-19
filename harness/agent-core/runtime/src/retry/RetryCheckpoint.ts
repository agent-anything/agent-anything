import type { RetryAttemptExecutionResult, RetryExecutionResult, RetryAttemptContext } from "./RetryExecution.js";
import type { RetryOperationProgress } from "./RetryExhaustion.js";
import type { RetryDelay, RetryFailure } from "./RetryFailure.js";
import type { RetryAttempt, RetryOperation } from "./RetryOperation.js";
import type { RetryPolicy } from "./RetryPolicy.js";
import type { RetryEvent } from "./RetryEvent.js";

export interface RetryCheckpoint<TResult, TError, TCategory extends string> {
  readonly operation: RetryOperation;
  readonly budgetId: string;
  readonly policy: RetryPolicy<TCategory>;
  readonly priorProgress: RetryOperationProgress;
  readonly totalRetryDelayMs: number;
  readonly attempt: RetryAttempt | null;
  readonly attemptResult: RetryAttemptExecutionResult<TResult, TError> | null;
  readonly attemptFinishedAt: string | null;
  readonly deadlineObserved: boolean;
  readonly events: readonly RetryEvent[];
  readonly delay: RetryDelay | null;
  readonly outcome: RetryExecutionResult<TResult, RetryFailure<TCategory>, TError> | null;
}

/** The execution owner provides serialization and reconciliation for its result type. */
export interface RetryCheckpointPort<TResult, TError, TCategory extends string> {
  read(): RetryCheckpoint<TResult, TError, TCategory> | null;
  commit(checkpoint: RetryCheckpoint<TResult, TError, TCategory>): Promise<void>;
  reconcile(context: RetryAttemptContext): Promise<RetryAttemptExecutionResult<TResult, TError>>;
}

export class RetryCheckpointError extends Error {
  constructor(readonly operationId: string, options?: ErrorOptions) {
    super("Retry progress was not confirmed; the owner must reconcile before advancing.", options);
    this.name = "RetryCheckpointError";
  }
}
