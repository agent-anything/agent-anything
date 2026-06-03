import type { Metadata } from "../shared/types";
import type { ToolCall } from "./ToolCall";
import type { ToolResult } from "./ToolResult";
import type { ToolRisk } from "./ToolRisk";

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description?: string;
  risk: ToolRisk;
  metadata?: Metadata;
  execute(call: ToolCall<TInput>): Promise<ToolResult<TOutput>>;
}
