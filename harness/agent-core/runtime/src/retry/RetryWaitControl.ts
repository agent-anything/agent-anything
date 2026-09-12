import type { RetryAttempt, RetryOperation } from "./RetryOperation.js";
import type { RetryDelay } from "./RetryFailure.js";
import type { RetryPolicy } from "./RetryPolicy.js";
import type { RetryWait } from "./RetryExecution.js";

export interface RetryWaitRequest {
  readonly executionFlow?: import("@agent-anything/observability/execution-flow").ExecutionFlowContext;
  readonly operation: RetryOperation;
  readonly precedingAttempt: RetryAttempt;
  readonly policy: RetryPolicy<string>;
  readonly delay: RetryDelay;
}

export type RetryWaitOutcome = Awaited<ReturnType<RetryWait["wait"]>>
  | { readonly kind: "deadline_exceeded" }
  | { readonly kind: "invalidated" };

/** Bound by the invocation owner; the timer has no Run mutation authority. */
export interface RetryWaitControl {
  wait(request: RetryWaitRequest, arm: (disposal: AbortSignal) => ReturnType<RetryWait["wait"]>): Promise<RetryWaitOutcome>;
}

export class RetryInvocationInvalidatedError extends Error {
  constructor() {
    super("The Retry invocation no longer has a current execution basis.");
    this.name = "RetryInvocationInvalidatedError";
  }
}
