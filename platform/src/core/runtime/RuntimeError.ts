import type { Metadata } from "../../shared/types.js";

export type RuntimeErrorCode =
  | "permission_denied"
  | "tool_not_found"
  | "tool_execution_failed"
  | "tool_cancelled"
  | "tool_timeout"
  | "tool_interrupted"
  | "evidence_creation_failed"
  | "report_generation_failed"
  | "storage_failed"
  | "runtime_limit_exceeded"
  | "invalid_runtime_options";

export interface RuntimeError {
  code: RuntimeErrorCode;
  message: string;
  metadata: Metadata;
}
