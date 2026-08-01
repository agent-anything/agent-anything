import type { Metadata } from "../primitives/index.js";

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
