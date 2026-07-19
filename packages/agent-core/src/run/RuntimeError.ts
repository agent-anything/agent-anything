import type { Metadata } from "@agent-anything/shared";

export type RuntimeErrorOwner =
  | "runtime"
  | "model"
  | "provider"
  | "approval"
  | "permission"
  | "policy"
  | "sandbox"
  | "tool"
  | "storage"
  | "audit"
  | "telemetry";

export interface RuntimeError {
  readonly owner: RuntimeErrorOwner;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly metadata: Metadata;
}
