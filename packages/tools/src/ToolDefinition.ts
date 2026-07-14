import type { Metadata } from "@agent-anything/shared";
import type { ToolCall } from "./ToolCall.js";
import type { ToolResult } from "./ToolResult.js";
import type { ToolRisk } from "./ToolRisk.js";
import type { ToolInvocationContext } from "./ToolInvocationContext.js";

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description?: string;
  risk: ToolRisk;
  metadata?: Metadata;
  execute(
    call: ToolCall<TInput>,
    context: ToolInvocationContext,
  ): Promise<ToolResult<TOutput>>;
}
