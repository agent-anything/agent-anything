import type { Metadata } from "@agent-anything/shared";
import type { PermissionMode } from "@agent-anything/permission";
import type { RuntimeLimits } from "./RuntimeLimits.js";
import type { RuntimeOutputSpec } from "./RuntimeResult.js";

export interface RuntimeOptions {
  limits: RuntimeLimits;
  permissionMode: PermissionMode;
  auditMode?: "optional" | "required";
  telemetryMode?: "optional" | "required";
  outputSpec?: RuntimeOutputSpec;
  metadata: Metadata;
}
