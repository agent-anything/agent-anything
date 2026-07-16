import type { Metadata } from "@agent-anything/shared";
import type { ToolAnnotations, ToolJsonObject } from "@agent-anything/tools";

export interface McpToolRegistration {
  name: string;
  description?: string;
  inputSchema: ToolJsonObject;
  annotations: ToolAnnotations;
  metadata: Metadata;
}
