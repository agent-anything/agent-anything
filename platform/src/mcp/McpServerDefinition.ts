import type { Metadata } from "../shared/types.js";
import type { McpToolDefinition } from "./McpToolDefinition.js";

export interface McpServerDefinition {
  id: string;
  name: string;
  transport: string;
  tools: McpToolDefinition[];
  metadata: Metadata;
}
