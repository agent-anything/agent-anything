import type {
  ToolCall,
  ToolResult,
  ToolResultError,
} from "@agent-anything/tools";
import { FileToolError } from "./FileToolError.js";

export async function executeFileTool<TOutput>(
  call: ToolCall,
  now: () => string,
  operation: () => Promise<TOutput>,
): Promise<ToolResult<TOutput>> {
  const startedAt = now();

  try {
    const output = await operation();
    return {
      toolCallId: call.id,
      toolName: call.toolName,
      status: "succeeded",
      output,
      error: null,
      startedAt,
      finishedAt: now(),
      metadata: call.metadata,
    };
  } catch (error) {
    return {
      toolCallId: call.id,
      toolName: call.toolName,
      status: "failed",
      output: null,
      error: toToolResultError(error),
      startedAt,
      finishedAt: now(),
      metadata: call.metadata,
    };
  }
}

function toToolResultError(error: unknown): ToolResultError {
  if (error instanceof FileToolError) {
    return {
      code: error.code,
      message: error.message,
      metadata: error.metadata,
    };
  }

  return {
    code: "file_operation_failed",
    message: "File operation failed.",
  };
}
