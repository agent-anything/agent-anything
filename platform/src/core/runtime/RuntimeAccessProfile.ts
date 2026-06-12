import type { PermissionMode } from "../../permission/index.js";
import type { Metadata } from "../../shared/types.js";

export type ExecutionAccess = "restricted" | "workspace" | "full";

export interface RuntimeAccessProfile {
  permissionMode: PermissionMode;
  executionAccess: ExecutionAccess;
  metadata: Metadata;
}
