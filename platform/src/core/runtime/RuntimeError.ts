import type { Metadata } from "../../shared/types.js";

export type RuntimeErrorCode =
  | `provider_${string}`
  | `tool_${string}`
  | `policy_${string}`
  | `permission_${string}`
  | `audit_${string}`
  | `storage_${string}`
  | `context_${string}`
  | `runtime_${string}`;

export interface RuntimeError {
  code: RuntimeErrorCode;
  message: string;
  metadata: Metadata;
}
