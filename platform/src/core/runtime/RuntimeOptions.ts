import type { Metadata } from "../../shared/types";
import type { PermissionMode } from "../../permission";
import type { RuntimeLimits } from "./RuntimeLimits";

export interface RuntimeOptions {
  limits: RuntimeLimits;
  permissionMode: PermissionMode;
  metadata: Metadata;
}
