export type RunResultStatus = "succeeded" | "blocked" | "failed" | "cancelled";
export type RunBlockedCode = "runtime_no_safe_path";
export type RunFailureCode =
  | "runtime_execution_failed"
  | "runtime_limit_exceeded"
  | "runtime_deadline_exceeded"
  | "context_projection_failed"
  | "controller_failed"
  | "operation_failed"
  | "interaction_failed"
  | "required_finalization_failed"
  | "unknown_effect";
export type RunCancelledCode = "runtime_cancelled";
export type RunResultCode = RunBlockedCode | RunFailureCode | RunCancelledCode;
