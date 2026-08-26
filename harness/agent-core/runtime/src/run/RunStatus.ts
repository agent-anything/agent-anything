export type RunResultStatus = "succeeded" | "blocked" | "failed" | "cancelled";
export type RunBlockedCode =
  | "runtime_no_safe_path"
  | "runtime_no_progress"
  | "verification_blocked";
export type RunFailureCode =
  | "runtime_execution_failed"
  | "runtime_limit_exceeded"
  | "runtime_deadline_exceeded"
  | "context_projection_failed"
  | "controller_failed"
  | "tool_exposure_failed"
  | "operation_failed"
  | "interaction_failed"
  | "required_finalization_failed"
  | "verification_failed"
  | "unknown_effect";
export type RunCancelledCode = "runtime_cancelled";
export type RunResultCode = RunBlockedCode | RunFailureCode | RunCancelledCode;
