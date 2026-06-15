import type { PermissionMode } from "@agent-anything/permission";
import type { Metadata } from "@agent-anything/shared";

export type ExecutionAccess = "restricted" | "workspace" | "full";

export interface RuntimeAccessProfile {
  permissionMode: PermissionMode;
  executionAccess: ExecutionAccess;
  metadata: Metadata;
}
