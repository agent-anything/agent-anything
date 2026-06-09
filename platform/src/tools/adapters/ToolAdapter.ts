import type { ToolDefinition } from "../ToolDefinition.js";

export interface ToolAdapter {
  readonly name: string;
  toToolDefinition(): ToolDefinition;
}
