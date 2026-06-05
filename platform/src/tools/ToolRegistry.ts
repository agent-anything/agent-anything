import type { Metadata } from "../shared/types.js";
import type { ToolCall } from "./ToolCall.js";
import type { ToolDefinition } from "./ToolDefinition.js";
import type { ToolResult } from "./ToolResult.js";

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

  async execute(call: ToolCall): Promise<ToolResult> {
    const tool = this.tools.get(call.toolName);

    if (!tool) {
      return createFailedToolResult(call, {
        code: "tool_not_found",
        message: `Tool is not registered: ${call.toolName}`,
      });
    }

    try {
      return await tool.execute(call);
    } catch (error) {
      return createFailedToolResult(call, {
        code: "tool_execution_failed",
        message: error instanceof Error ? error.message : "Tool execution failed.",
      });
    }
  }
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
