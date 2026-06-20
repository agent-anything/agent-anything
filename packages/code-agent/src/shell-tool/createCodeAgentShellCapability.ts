import type {
  ToolExecutionContextResolver,
} from "@agent-anything/agent-core";
import type { ToolRegistry } from "@agent-anything/tools";
import { CodeAgentShellExecutionContextResolver } from "./CodeAgentShellExecutionContextResolver.js";
import type {
  CodeAgentShellCapability,
  CreateCodeAgentShellCapabilityInput,
} from "./ShellToolContracts.js";
import { createRunCommandTool } from "./runCommandTool.js";
import { resolveShellLimits } from "./shellLimits.js";

export function createCodeAgentShellCapability(
  input: CreateCodeAgentShellCapabilityInput,
): CodeAgentShellCapability {
  const limits = resolveShellLimits(input.limits);
  const context = {
    workspaceScope: input.workspaceScope,
    limits,
    environment: input.environment,
    now: input.now ?? (() => new Date().toISOString()),
    nowMs: input.nowMs ?? (() => Date.now()),
  };

  return {
    tool: createRunCommandTool(context),
    executionContextResolver:
      new CodeAgentShellExecutionContextResolver(
        input.workspaceScope,
        limits,
      ),
  };
}

export function registerCodeAgentShellTool(
  registry: ToolRegistry,
  input: CreateCodeAgentShellCapabilityInput,
): ToolExecutionContextResolver {
  const capability = createCodeAgentShellCapability(input);
  registry.register(capability.tool);
  return capability.executionContextResolver;
}
