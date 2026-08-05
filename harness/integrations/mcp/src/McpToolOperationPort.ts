
import type {
  McpSourceLookup,
  McpToolCallOutput,
} from "./McpPrimitives.js";

export interface McpToolCallInput<TInput = unknown> {
  readonly source: McpSourceLookup;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly input: TInput;
  readonly signal?: AbortSignal;
}

export interface McpToolCallResult {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly isError: boolean;
  readonly output: McpToolCallOutput;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface McpToolOperationPort {
  callTool<TInput = unknown>(
    input: McpToolCallInput<TInput>,
  ): Promise<McpToolCallResult>;
}
