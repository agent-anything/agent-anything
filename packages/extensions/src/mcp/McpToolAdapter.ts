import type { Metadata } from "@agent-anything/shared";
import type {
  ToolAdapter,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from "@agent-anything/tools";
import type {
  McpConnectionPort,
  McpToolCallResult,
} from "./McpConnectionPort.js";
import type { McpServerDefinition } from "./McpServerDefinition.js";
import type { McpToolDefinition } from "./McpToolDefinition.js";

export interface McpToolAdapterInput {
  server: McpServerDefinition;
  tool: McpToolDefinition;
  connectionPort: McpConnectionPort;
  metadata?: Metadata;
}

export class McpToolAdapter<TInput = unknown, TOutput = unknown>
implements ToolAdapter {
  readonly name: string;
  private readonly server: McpServerDefinition;
  private readonly tool: McpToolDefinition;
  private readonly connectionPort: McpConnectionPort;
  private readonly metadata: Metadata;

  constructor(input: McpToolAdapterInput) {
    assertName(input.tool.name);

    this.name = input.tool.name;
    this.server = input.server;
    this.tool = input.tool;
    this.connectionPort = input.connectionPort;
    this.metadata = input.metadata ?? {};
  }

  toToolDefinition(): ToolDefinition<TInput, TOutput> {
    return {
      name: this.tool.name,
      description: this.tool.description,
      risk: this.tool.risk,
      metadata: {
        ...this.metadata,
        ...this.tool.metadata,
        adapter: "mcp",
        mcpServerId: this.server.id,
        inputSchema: this.tool.inputSchema,
      },
      execute: async (call) => this.execute(call),
    };
  }

  private async execute(call: ToolCall<TInput>): Promise<ToolResult<TOutput>> {
    const startedAt = new Date().toISOString();

    try {
      const result = await this.connectionPort.callTool<TInput, TOutput>({
        serverId: this.server.id,
        toolName: this.tool.name,
        toolCallId: call.id,
        input: call.input,
        timeoutMs: null,
        metadata: {
          ...this.metadata,
          ...call.metadata,
        },
      });

      if (!matchesOriginalCall(result, call)) {
        return createFailedToolResult<TOutput>(call, {
          code: "tool_mcp_result_mismatch",
          message: "MCP tool result did not match the original platform tool call.",
          startedAt,
          metadata: {
            resultToolCallId: result.toolCallId,
            resultToolName: result.toolName,
            mcpServerId: this.server.id,
          },
        });
      }

      return {
        toolCallId: call.id,
        toolName: call.toolName,
        status: "succeeded",
        output: result.output,
        error: null,
        startedAt,
        finishedAt: new Date().toISOString(),
        metadata: {
          ...result.metadata,
          mcpServerId: this.server.id,
        },
      };
    } catch (error) {
      return createFailedToolResult<TOutput>(call, {
        code: classifyMcpError(error),
        message: error instanceof Error
          ? error.message
          : "MCP tool call failed.",
        startedAt,
        metadata: {
          mcpServerId: this.server.id,
          toolName: this.tool.name,
        },
      });
    }
  }
}

function matchesOriginalCall(
  result: McpToolCallResult,
  call: ToolCall,
): boolean {
  return result.toolCallId === call.id && result.toolName === call.toolName;
}

function createFailedToolResult<TOutput>(
  call: ToolCall,
  input: {
    code: string;
    message: string;
    startedAt: string;
    metadata: Metadata;
  },
): ToolResult<TOutput> {
  const status = input.code === "tool_timeout" ? "timeout" : "failed";

  return {
    toolCallId: call.id,
    toolName: call.toolName,
    status,
    output: null,
    error: {
      code: input.code,
      message: input.message,
      metadata: input.metadata,
    },
    startedAt: input.startedAt,
    finishedAt: new Date().toISOString(),
    metadata: {
      ...call.metadata,
      mcp: true,
    },
  };
}

function classifyMcpError(error: unknown): string {
  if (isMcpErrorCode(error, "tool_mcp_unavailable")) {
    return "tool_mcp_unavailable";
  }

  if (isMcpErrorCode(error, "tool_timeout")) {
    return "tool_timeout";
  }

  return "tool_mcp_call_failed";
}

function isMcpErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function assertName(name: string): void {
  if (name.trim().length === 0) {
    throw new Error("MCP tool adapter name must not be empty.");
  }
}
