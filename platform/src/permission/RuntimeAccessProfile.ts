import type { Metadata } from "../shared/types.js";
import type { PermissionMode } from "./PermissionMode.js";

export type ExecutionAccess = "restricted" | "workspace" | "full";

export interface RuntimeAccessProfile {
  permissionMode: PermissionMode;
  executionAccess: ExecutionAccess;
  metadata: Metadata;
}
