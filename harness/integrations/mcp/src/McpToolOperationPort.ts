import type { Metadata } from "@agent-anything/foundation";
import type { McpActivationSnapshot } from "./McpLifecycle.js";

export interface McpToolCallInput<TInput = unknown> {
  readonly activation: McpActivationSnapshot;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly input: TInput;
  readonly timeoutMs: number | null;
  readonly metadata: Metadata;
}

export interface McpToolCallResult<TOutput = unknown> {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly output: TOutput;
  readonly metadata: Metadata;
}

export interface McpToolOperationPort {
  callTool<TInput = unknown, TOutput = unknown>(
    input: McpToolCallInput<TInput>,
  ): Promise<McpToolCallResult<TOutput>>;
}
