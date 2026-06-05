import type { Metadata } from "../shared/types.js";
import type { PermissionRisk } from "./PermissionRisk.js";

export interface PermissionRequest {
  id: string;
  taskId: string;
  toolCallId: string;
  toolName: string;
  risk: PermissionRisk;
  reason: string;
  metadata: Metadata;
}
