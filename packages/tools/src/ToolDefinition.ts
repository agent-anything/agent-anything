import type { Metadata } from "@agent-anything/shared";
import type { ToolCall } from "./ToolCall.js";
import type { ToolResult } from "./ToolResult.js";
import type { ToolRisk } from "./ToolRisk.js";

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description?: string;
  risk: ToolRisk;
  metadata?: Metadata;
  execute(call: ToolCall<TInput>): Promise<ToolResult<TOutput>>;
}
