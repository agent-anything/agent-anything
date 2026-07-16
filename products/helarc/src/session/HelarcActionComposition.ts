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
  type CodeAgentShellLimits,
} from "@agent-anything/code-agent";
import {
  createToolCatalogSnapshot,
  type ToolCatalogSnapshot,
  type ToolDefinition,
  type ToolDescriptor,
} from "@agent-anything/tools";

const READ_ONLY_ACTIONS = new Set([
  CODE_AGENT_LIST_FILES_ACTION,
  CODE_AGENT_READ_FILE_ACTION,
  CODE_AGENT_SEARCH_FILES_ACTION,
]);

export interface CreateHelarcActionCompositionInput {
  readonly enableShell: boolean;
  readonly shellLimits?: Partial<CodeAgentShellLimits>;
}

export interface HelarcActionComposition {
  readonly exposedCatalog: ToolCatalogSnapshot;
  readonly registrations: ActionRegistrationSnapshot;
  readonly adapters: readonly ActionAdapterImplementation[];
  readonly executors: readonly ActionExecutor[];
  readonly agentTools: readonly ToolDefinition[];
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
        limits: input.shellLimits,
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
    agentTools: Object.freeze(exposedCatalog.tools.map(createInertAgentTool)),
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

function createInertAgentTool(descriptor: ToolDescriptor): ToolDefinition {
  return Object.freeze({
    name: descriptor.name,
    description: descriptor.description,
    risk: descriptor.name === CODE_AGENT_RUN_COMMAND_ACTION ? "risky" : "safe",
    metadata: Object.freeze({
      inputSchema: descriptor.inputSchema,
      annotations: descriptor.annotations,
      declarativeOnly: true,
    }),
    async execute() {
      throw new TypeError(
        "Helarc declarative Tools execute only through the canonical Action pipeline.",
      );
    },
  });
}
