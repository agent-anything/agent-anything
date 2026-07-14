import type { Metadata } from "@agent-anything/shared";
import type { ToolCall } from "./ToolCall.js";
import type { ToolDefinition } from "./ToolDefinition.js";
import type { ToolResult } from "./ToolResult.js";
import type { ToolInvocationContext } from "./ToolInvocationContext.js";

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    assertToolName(tool.name);

    if (this.tools.has(tool.name)) {
      throw new Error(`Tool is already registered: ${tool.name}`);
    }

    this.tools.set(tool.name, tool);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  async execute(
    call: ToolCall,
    context: ToolInvocationContext,
  ): Promise<ToolResult> {
    const interruption = interruptedResult(call, context);
    if (interruption !== null) {
      return interruption;
    }

    const tool = this.tools.get(call.toolName);

    if (!tool) {
      return createFailedToolResult(call, {
        code: "tool_not_found",
        message: `Tool is not registered: ${call.toolName}`,
      });
    }

    try {
      return await tool.execute(call, context);
    } catch (error) {
      return createFailedToolResult(call, {
        code: "tool_execution_failed",
        message: error instanceof Error ? error.message : "Tool execution failed.",
      });
    }
  }
}

function interruptedResult(
  call: ToolCall,
  context: ToolInvocationContext,
): ToolResult | null {
  if (!context.interruption.signal.aborted) {
    return null;
  }

  const now = new Date().toISOString();
  const interruption = context.interruption.interruption;
  if (interruption?.kind === "run_cancellation") {
    return {
      toolCallId: call.id,
      toolName: call.toolName,
      status: "cancelled",
      output: null,
      error: {
        code: "tool_cancelled",
        message: "Tool execution was cancelled before dispatch.",
        metadata: {
          runId: interruption.cancellation.runId,
          requestId: interruption.cancellation.requestId,
        },
      },
      startedAt: now,
      finishedAt: now,
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
        message: "Tool invocation exceeded its operation deadline before dispatch.",
        metadata: {
          operationId: interruption.deadline.operationId,
          deadlineAt: interruption.deadline.deadlineAt,
        },
      },
      startedAt: now,
      finishedAt: now,
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
      message: "Tool invocation was aborted without trusted interruption attribution.",
    },
    startedAt: now,
    finishedAt: now,
    metadata: call.metadata,
  };
}

function assertToolName(name: string): void {
  if (name.trim().length === 0) {
    throw new Error("Tool name must not be empty.");
  }
}

function createFailedToolResult(
  call: ToolCall,
  error: { code: string; message: string; metadata?: Metadata },
): ToolResult {
  const now = new Date().toISOString();

  return {
    toolCallId: call.id,
    toolName: call.toolName,
    status: "failed",
    output: null,
    error,
    startedAt: now,
    finishedAt: now,
    metadata: call.metadata,
  };
}
