import {
  createActionRegistrationSnapshot,
  type ActionAdapterImplementation,
  type ActionExecutor,
  type ActionRegistrationSnapshot,
} from "@agent-anything/agent-core/action-execution";
import type { AgentTask } from "@agent-anything/agent-core/task";
import {
  CODE_AGENT_LIST_FILES_ACTION,
  CODE_AGENT_READ_FILE_ACTION,
  CODE_AGENT_RUN_COMMAND_ACTION,
  CODE_AGENT_SEARCH_FILES_ACTION,
  createCodeAgentCommandActionCapability,
  createCodeAgentFileActionCapability,
  type CodeAgentCommandLimits,
} from "@agent-anything/code-agent";
import {
  createToolCatalogSnapshot,
  type ToolCatalogSnapshot,
  type ToolDescriptor,
} from "@agent-anything/tools";

const READ_ONLY_ACTIONS = new Set([
  CODE_AGENT_LIST_FILES_ACTION,
  CODE_AGENT_READ_FILE_ACTION,
  CODE_AGENT_SEARCH_FILES_ACTION,
]);

export interface CreateHelarcActionCompositionInput {
  readonly enableShell: boolean;
  readonly commandLimits?: Partial<CodeAgentCommandLimits>;
}

export interface HelarcActionComposition {
  readonly exposedCatalog: ToolCatalogSnapshot;
  readonly registrations: ActionRegistrationSnapshot;
  readonly adapters: readonly ActionAdapterImplementation[];
  readonly executors: readonly ActionExecutor[];
  readonly agentTools: readonly ToolDescriptor[];
}

export async function createHelarcActionComposition(
  task: AgentTask,
  input: CreateHelarcActionCompositionInput,
): Promise<HelarcActionComposition> {
  const file = createCodeAgentFileActionCapability({
    workspaceScope: task.workspaceScope,
  });
  const command = input.enableShell
    ? await createCodeAgentCommandActionCapability({
        workspaceScope: task.workspaceScope,
        limits: input.commandLimits,
      })
    : null;
  const capabilities = command === null ? [file] : [file, command];
  const registrations = createActionRegistrationSnapshot(capabilities.flatMap(
    (capability) => capability.registrations.registrations.map((registration) => ({
      actionName: registration.actionName,
      adapter: registration.adapter,
      executor: registration.executor,
    })),
  ));
  const exposedDescriptors = capabilities.flatMap((capability) =>
    capability.catalog.tools.filter((tool) =>
      READ_ONLY_ACTIONS.has(tool.name) || tool.name === CODE_AGENT_RUN_COMMAND_ACTION),
  );
  assertExposedRegistrations(exposedDescriptors, registrations);
  const exposedCatalog = createToolCatalogSnapshot(exposedDescriptors);

  return Object.freeze({
    exposedCatalog,
    registrations,
    adapters: Object.freeze(capabilities.flatMap((capability) => capability.adapters)),
    executors: Object.freeze(capabilities.flatMap((capability) => capability.executors)),
    agentTools: exposedCatalog.tools,
  });
}

function assertExposedRegistrations(
  tools: readonly ToolDescriptor[],
  registrations: ActionRegistrationSnapshot,
): void {
  const registered = new Set(registrations.registrations.map(({ actionName }) => actionName));
  for (const tool of tools) {
    if (!registered.has(tool.name)) {
      throw new TypeError(`Helarc exposed Tool '${tool.name}' has no trusted Action registration.`);
    }
  }
}
