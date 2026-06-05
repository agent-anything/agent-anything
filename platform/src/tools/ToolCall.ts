import type { Metadata } from "../shared/types.js";
import type { ToolRisk } from "./ToolRisk.js";

export interface ToolCall<TInput = unknown> {
  id: string;
  toolName: string;
  input: TInput;
  risk: ToolRisk;
  metadata: Metadata;
}
