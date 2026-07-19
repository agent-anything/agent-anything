export type RunResultStatus = "succeeded" | "blocked" | "failed" | "cancelled";

export type RunBlockedCode = "runtime_no_safe_path";

export type RunFailureCode =
  | "runtime_invalid_options"
  | "runtime_limit_exceeded"
  | "runtime_workspace_resolution_failed"
  | "runtime_identity_resolution_failed"
  | "runtime_cancellation_settlement_timeout"
  | "model_request_failed"
  | "model_output_invalid"
  | "model_structured_output_retry_exhausted"
  | "provider_request_failed"
  | "provider_timeout"
  | "provider_retry_exhausted"
  | "provider_stream_retry_exhausted"
  | "provider_stream_incomplete"
  | "provider_cancellation_unconfirmed"
  | "approval_reviewer_unavailable"
  | "approval_review_failed"
  | "approval_review_malformed"
  | "approval_review_timeout"
  | "approval_review_retry_exhausted"
  | "approval_review_failure_limit_exceeded"
  | "approval_cancellation_unconfirmed"
  | "granted_permissions_invalid"
  | "session_authority_commit_failed"
  | "session_authority_commit_unconfirmed"
  | "policy_amendment_invalid"
  | "policy_amendment_commit_failed"
  | "policy_amendment_commit_unconfirmed"
  | "sandbox_enforcement_failed"
  | "tool_sandbox_escalation_failed"
  | "tool_execution_failed"
  | "tool_timeout"
  | "tool_cancellation_unconfirmed"
  | "storage_write_failed"
  | "audit_required_failed"
  | "audit_finalization_timeout"
  | "runtime_telemetry_required_failed"
  | "runtime_telemetry_finalization_timeout";

export type RunCancelledCode = "runtime_cancelled";

export type RunResultCode = RunBlockedCode | RunFailureCode | RunCancelledCode;
