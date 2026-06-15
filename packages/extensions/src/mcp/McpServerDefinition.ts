import type { Metadata } from "@agent-anything/shared";
import type { McpToolDefinition } from "./McpToolDefinition.js";

export interface McpServerDefinition {
  id: string;
  name: string;
  transport: string;
  tools: McpToolDefinition[];
  metadata: Metadata;
}
