import type { Metadata } from "../shared/types.js";
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
