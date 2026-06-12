import type { Metadata } from "../shared/types.js";
import type {
  ToolAdapter,
  ToolCall,
  ToolDefinition,
  ToolResult,
  ToolRisk,
} from "../tools/index.js";
import type { RemoteToolCall } from "./RemoteToolCall.js";
import type { RemoteToolNode } from "./RemoteToolNode.js";
import type { RemoteToolPort } from "./RemoteToolPort.js";

export interface RemoteToolAdapterInput {
  name: string;
  risk: ToolRisk;
  remoteNode: RemoteToolNode;
  remoteToolPort: RemoteToolPort;
  description?: string;
  timeoutMs?: number | null;
  metadata?: Metadata;
}

export class RemoteToolAdapter<TInput = unknown, TOutput = unknown>
implements ToolAdapter {
  readonly name: string;
  private readonly risk: ToolRisk;
  private readonly remoteNode: RemoteToolNode;
  private readonly remoteToolPort: RemoteToolPort;
  private readonly description?: string;
  private readonly timeoutMs: number | null;
  private readonly metadata: Metadata;

  constructor(input: RemoteToolAdapterInput) {
    assertName(input.name);

    this.name = input.name;
    this.risk = input.risk;
    this.remoteNode = input.remoteNode;
    this.remoteToolPort = input.remoteToolPort;
    this.description = input.description;
    this.timeoutMs = input.timeoutMs ?? null;
    this.metadata = input.metadata ?? {};
  }

  toToolDefinition(): ToolDefinition<TInput, TOutput> {
    return {
      name: this.name,
      risk: this.risk,
      description: this.description,
      metadata: {
        ...this.metadata,
        adapter: "remote-tool",
        remoteNodeId: this.remoteNode.id,
      },
      execute: async (call) => this.execute(call),
    };
  }

  private async execute(call: ToolCall<TInput>): Promise<ToolResult<TOutput>> {
    const startedAt = new Date().toISOString();
    const remoteCall = this.createRemoteToolCall(call);

    try {
      const remoteResult = await this.remoteToolPort.call<TInput, TOutput>(remoteCall);
      if (!matchesOriginalCall(remoteResult.toolResult, call)) {
        return createFailedToolResult<TOutput>(call, {
          code: "tool_remote_result_mismatch",
          message: "Remote tool result did not match the original platform tool call.",
          startedAt,
          metadata: {
            remoteCallId: remoteResult.remoteCallId,
            resultToolCallId: remoteResult.toolResult.toolCallId,
            resultToolName: remoteResult.toolResult.toolName,
          },
        });
      }

      return remoteResult.toolResult;
    } catch (error) {
      return createFailedToolResult<TOutput>(call, {
        code: classifyRemoteError(error),
        message: error instanceof Error
          ? error.message
          : "Remote tool execution failed.",
        startedAt,
        metadata: {
          remoteCallId: remoteCall.id,
          remoteNodeId: this.remoteNode.id,
        },
      });
    }
  }

  private createRemoteToolCall(call: ToolCall<TInput>): RemoteToolCall<TInput> {
    return {
      id: `remote_call_${call.id}`,
      toolCallId: call.id,
      toolName: call.toolName,
      remoteNodeId: this.remoteNode.id,
      input: call.input,
      timeoutMs: this.timeoutMs,
      metadata: {
        ...this.metadata,
        ...call.metadata,
      },
    };
  }
}

function matchesOriginalCall(
  result: ToolResult,
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
      remote: true,
    },
  };
}

function classifyRemoteError(error: unknown): string {
  if (isRemoteErrorCode(error, "tool_remote_unavailable")) {
    return "tool_remote_unavailable";
  }

  if (isRemoteErrorCode(error, "tool_timeout")) {
    return "tool_timeout";
  }

  return "tool_remote_execution_failed";
}

function isRemoteErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function assertName(name: string): void {
  if (name.trim().length === 0) {
    throw new Error("Remote tool adapter name must not be empty.");
  }
}
