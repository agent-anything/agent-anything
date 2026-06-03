import type { Metadata } from "../shared/types";
import type { ToolRisk } from "../tools";

export interface PermissionRequest {
  id: string;
  taskId: string;
  toolCallId: string;
  toolName: string;
  risk: ToolRisk;
  reason: string;
  metadata: Metadata;
}
