import type { Metadata } from "../shared/types.js";
import type { ToolRisk } from "../tools/index.js";

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: unknown;
  risk: ToolRisk;
  metadata: Metadata;
}
