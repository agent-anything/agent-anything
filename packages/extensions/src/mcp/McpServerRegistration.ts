import type { Metadata } from "@agent-anything/shared";
import type { McpToolRegistration } from "./McpToolRegistration.js";

export interface McpServerRegistration {
  id: string;
  name: string;
  transport: string;
  tools: McpToolRegistration[];
  metadata: Metadata;
}
