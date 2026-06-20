import type { ToolDefinition, ToolRegistry } from "@agent-anything/tools";
import type { CreateCodeAgentFileToolsInput } from "./FileToolContracts.js";
import { resolveFileToolLimits } from "./fileToolLimits.js";
import { createListFilesTool } from "./listFilesTool.js";
import { createReadFileTool } from "./readFileTool.js";
import { createSearchFilesTool } from "./searchFilesTool.js";
import { createWriteFileTool } from "./writeFileTool.js";

export function createCodeAgentFileTools(
  input: CreateCodeAgentFileToolsInput,
): ToolDefinition[] {
  const context = {
    workspaceScope: input.workspaceScope,
    limits: resolveFileToolLimits(input.limits),
    now: input.now ?? (() => new Date().toISOString()),
  };

  return [
    createListFilesTool(context),
    createReadFileTool(context),
    createSearchFilesTool(context),
    createWriteFileTool(context),
  ];
}

export function registerCodeAgentFileTools(
  registry: ToolRegistry,
  input: CreateCodeAgentFileToolsInput,
): void {
  for (const tool of createCodeAgentFileTools(input)) {
    registry.register(tool);
  }
}
