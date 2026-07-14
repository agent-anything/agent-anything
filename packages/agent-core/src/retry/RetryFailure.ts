import type { CancellationAttribution } from "../runner/RunCancellation.js";

export interface RetryFailure<TCategory extends string = string> {
  readonly category: TCategory;
  readonly code: string;
  readonly message: string;
  readonly retryAfterMs?: number;
  readonly requestId?: string;
  readonly statusCode?: number;
}

export interface RetryClassification<TCategory extends string> {
  readonly failure: RetryFailure<TCategory>;
  readonly disposition: "retryable" | "non_retryable" | "deadline_exceeded";
  readonly reasonCode: string;
}

export interface RetryClassifier<TError, TCategory extends string> {
  classify(error: TError): RetryClassification<TCategory>;
}

export type RetryStopReason =
  | "non_retryable"
  | "retry_budget_exhausted"
  | "deadline_exceeded"
  | "server_delay_exceeds_limit";

export type RetryDecision =
  | {
      readonly kind: "retry";
      readonly nextAttemptNumber: number;
      readonly delay: RetryDelay;
    }
  | {
      readonly kind: "stop";
      readonly reason: RetryStopReason;
    }
  | {
      readonly kind: "cancelled";
      readonly attribution: CancellationAttribution;
    };

export interface RetryDelay {
  readonly delayMs: number;
  readonly source: "calculated_backoff" | "trusted_server_delay";
  readonly scheduledAt: string;
  readonly nextAttemptAt: string;
}
