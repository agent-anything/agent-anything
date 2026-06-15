import type { Metadata } from "@agent-anything/shared";
import type { ToolRisk } from "./ToolRisk.js";

export interface ToolCall<TInput = unknown> {
  id: string;
  toolName: string;
  input: TInput;
  risk: ToolRisk;
  metadata: Metadata;
}
