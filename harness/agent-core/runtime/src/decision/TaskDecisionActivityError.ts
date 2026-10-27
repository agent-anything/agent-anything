import type { ProviderFailure } from "@agent-anything/model-interaction";
import type { ModelFailure } from "./ModelFailure.js";

export type TaskDecisionActivityFailureCode =
  | "model_request_failed"
  | "model_output_invalid"
  | "model_output_limit_exhausted"
  | "model_protocol_recovery_exhausted"
  | "model_structured_output_retry_exhausted"
  | "model_context_capacity_exceeded"
  | "model_input_recovery_failed"
  | "provider_context_window_exceeded"
  | "provider_request_failed"
  | "provider_timeout"
  | "provider_retry_exhausted"
  | "provider_operation_deadline_exceeded"
  | "model_operation_deadline_exceeded"
  | "provider_cancellation_unconfirmed";

export type TaskDecisionActivityFailure =
  | { readonly kind: "model"; readonly failure: ModelFailure & { readonly code: TaskDecisionActivityFailureCode } }
  | { readonly kind: "provider"; readonly failure: ProviderFailure & { readonly code: TaskDecisionActivityFailureCode } };

export type DecisionActivityDeadline = Readonly<{
  operationId: string;
  owner: "provider_request" | "structured_output";
  deadlineAt: string;
  exhaustedAt: string;
}>;

export class TaskDecisionActivityError extends Error {
  constructor(
    readonly failure: TaskDecisionActivityFailure,
    readonly operationSettlement: "unsettled" | "settled_failure" = "unsettled",
    readonly deadline: DecisionActivityDeadline | null = null,
  ) {
    super(failure.failure.message);
    this.name = "TaskDecisionActivityError";
  }
}
