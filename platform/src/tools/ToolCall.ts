import type { Metadata } from "../shared/types";
import type { ToolRisk } from "./ToolRisk";

export interface ToolCall<TInput = unknown> {
  id: string;
  toolName: string;
  input: TInput;
  risk: ToolRisk;
  metadata: Metadata;
}
