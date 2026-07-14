import type {
  ToolCall,
  ToolInvocationContext,
  ToolResult,
  ToolResultError,
} from "@agent-anything/tools";
import { FileToolError } from "./FileToolError.js";

export async function executeFileTool<TOutput>(
  call: ToolCall,
  now: () => string,
  context: ToolInvocationContext,
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
    if (Object.is(error, context.interruption.signal.reason)) {
      const interruption = interruptionResult<TOutput>(
        call,
        startedAt,
        now(),
        context,
      );
      if (interruption !== null) {
        return interruption;
      }
    }

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

export function throwIfFileToolInterrupted(
  context: ToolInvocationContext,
): void {
  if (context.interruption.signal.aborted) {
    throw context.interruption.signal.reason;
  }
}

function interruptionResult<TOutput>(
  call: ToolCall,
  startedAt: string,
  finishedAt: string,
  context: ToolInvocationContext,
): ToolResult<TOutput> | null {
  if (!context.interruption.signal.aborted) {
    return null;
  }

  const interruption = context.interruption.interruption;
  if (interruption?.kind === "run_cancellation") {
    return {
      toolCallId: call.id,
      toolName: call.toolName,
      status: "cancelled",
      output: null,
      error: {
        code: "tool_cancelled",
        message: "File operation was cancelled.",
        metadata: {
          runId: interruption.cancellation.runId,
          requestId: interruption.cancellation.requestId,
        },
      },
      startedAt,
      finishedAt,
      metadata: call.metadata,
    };
  }

  if (interruption?.kind === "operation_deadline") {
    return {
      toolCallId: call.id,
      toolName: call.toolName,
      status: "timeout",
      output: null,
      error: {
        code: "tool_timeout",
        message: "File operation exceeded its deadline.",
        metadata: {
          operationId: interruption.deadline.operationId,
          deadlineAt: interruption.deadline.deadlineAt,
        },
      },
      startedAt,
      finishedAt,
      metadata: call.metadata,
    };
  }

  return {
    toolCallId: call.id,
    toolName: call.toolName,
    status: "interrupted",
    output: null,
    error: {
      code: "tool_cancellation_unconfirmed",
      message: "File operation was aborted without trusted interruption attribution.",
    },
    startedAt,
    finishedAt,
    metadata: call.metadata,
  };
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
