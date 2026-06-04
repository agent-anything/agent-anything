import type { Metadata } from "../shared/types";
import type { ToolCall } from "../tools";
import type { PermissionRequest } from "./PermissionRequest";

export interface CreatePermissionRequestInput {
  id: string;
  taskId: string;
  toolCall: Pick<ToolCall, "id" | "toolName" | "risk">;
  reason: string;
  metadata: Metadata;
}

export function createPermissionRequest(
  input: CreatePermissionRequestInput,
): PermissionRequest {
  return {
    id: input.id,
    taskId: input.taskId,
    toolCallId: input.toolCall.id,
    toolName: input.toolCall.toolName,
    risk: input.toolCall.risk,
    reason: input.reason,
    metadata: input.metadata,
  };
}
