import type { Metadata } from "../shared/types.js";
import type { ToolCall } from "../tools/index.js";
import type { PermissionRequestInput } from "./PermissionRequest.js";

export interface CreatePermissionRequestInput {
  id: string;
  taskId: string;
  toolCall: Pick<ToolCall, "id" | "toolName" | "risk">;
  action?: string;
  reason: string;
  metadata: Metadata;
}

export function createPermissionRequest(
  input: CreatePermissionRequestInput,
): PermissionRequestInput {
  return {
    id: input.id,
    taskId: input.taskId,
    action: input.action ?? "tool.execute",
    toolCallId: input.toolCall.id,
    toolName: input.toolCall.toolName,
    risk: input.toolCall.risk,
    reason: input.reason,
    target: {
      kind: "tool",
      name: input.toolCall.toolName,
      resource: input.toolCall.id,
    },
    metadata: input.metadata,
  };
}
