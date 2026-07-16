import type { Metadata } from "@agent-anything/shared";

export interface McpToolCallInput<TInput = unknown> {
  serverId: string;
  toolName: string;
  toolCallId: string;
  input: TInput;
  timeoutMs: number | null;
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
