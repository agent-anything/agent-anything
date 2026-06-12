import type { Metadata } from "../shared/types.js";

export interface McpToolCallInput<TInput = unknown> {
  serverId: string;
  toolName: string;
  toolCallId: string;
  input: TInput;
  metadata: Metadata;
}

export interface McpToolCallResult<TOutput = unknown> {
  toolCallId: string;
  toolName: string;
  output: TOutput;
  metadata: Metadata;
}

export interface McpConnectionPort {
  callTool<TInput = unknown, TOutput = unknown>(
    input: McpToolCallInput<TInput>,
  ): Promise<McpToolCallResult<TOutput>>;
}
