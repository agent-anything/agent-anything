import type { Metadata } from "@agent-anything/shared";
import type { ToolRisk } from "@agent-anything/tools";

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: unknown;
  risk: ToolRisk;
  metadata: Metadata;
}
