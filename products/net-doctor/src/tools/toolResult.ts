import type { Metadata } from "@agent-anything/shared";
import type { ToolCall, ToolResult } from "@agent-anything/tools";

export function createSucceededToolResult<TOutput>(
  call: ToolCall,
  output: TOutput,
  metadata: Metadata = call.metadata,
): ToolResult<TOutput> {
  const now = new Date().toISOString();

  return {
    toolCallId: call.id,
    toolName: call.toolName,
    status: "succeeded",
    output,
    error: null,
    startedAt: now,
    finishedAt: now,
    metadata,
  };
}

export function createFailedToolResult<TOutput = unknown>(
  call: ToolCall,
  code: string,
  message: string,
  metadata: Metadata = call.metadata,
): ToolResult<TOutput> {
  const now = new Date().toISOString();

  return {
    toolCallId: call.id,
    toolName: call.toolName,
    status: "failed",
    output: null,
    error: {
      code,
      message,
    },
    startedAt: now,
    finishedAt: now,
    metadata,
  };
}
