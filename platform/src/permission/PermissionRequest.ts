import type { Metadata } from "../shared/types";
import type { PermissionRisk } from "./PermissionRisk";

export interface PermissionRequest {
  id: string;
  taskId: string;
  toolCallId: string;
  toolName: string;
  risk: PermissionRisk;
  reason: string;
  metadata: Metadata;
}
