import type { Metadata } from "../../shared/types.js";
import type { PermissionMode } from "../../permission/index.js";
import type { RuntimeLimits } from "./RuntimeLimits.js";
import type { RuntimeOutputSpec } from "./RuntimeResult.js";

export interface RuntimeOptions {
  limits: RuntimeLimits;
  permissionMode: PermissionMode;
  outputSpec?: RuntimeOutputSpec;
  metadata: Metadata;
}
