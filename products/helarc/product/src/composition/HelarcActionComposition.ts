import {
  createToolActionBindingSnapshot,
  type ActionAdapterImplementation,
  type ToolActionBindingSnapshot,
} from "@agent-anything/action-execution/registration";
import {
  createActionRegistrationSnapshot,
  type ActionRegistrationSnapshot,
} from "@agent-anything/canonical-action/registration";
import {
  type ActionExecutor,
} from "@agent-anything/action-execution/execution";
import type { WorkspaceSelection } from "@agent-anything/workspace/selection";
import {
  CODE_AGENT_LIST_FILES_ACTION,
  CODE_AGENT_READ_FILE_ACTION,
  CODE_AGENT_SEARCH_FILES_ACTION,
  CODE_AGENT_CREATE_FILE_ACTION,
  CODE_AGENT_UPDATE_FILE_ACTION,
  CODE_AGENT_DELETE_FILE_ACTION,
  createCodeAgentFileActionCapability,
} from "@agent-anything/helarc-code-agent/file-actions";
import {
  CODE_AGENT_RUN_COMMAND_ACTION,
  createCodeAgentCommandActionCapability,
  type CodeAgentCommandLimits,
} from "@agent-anything/helarc-code-agent/command";
import { createToolRegistrationSnapshot } from "@agent-anything/tools/registration";
import { createToolSelectionSnapshot } from "@agent-anything/tools/selection";

const READ_ONLY_ACTIONS = new Set([
  CODE_AGENT_LIST_FILES_ACTION,
  CODE_AGENT_READ_FILE_ACTION,
  CODE_AGENT_SEARCH_FILES_ACTION,
]);
const WORKFLOW_ACTIONS = new Set([
  CODE_AGENT_CREATE_FILE_ACTION,
  CODE_AGENT_UPDATE_FILE_ACTION,
  CODE_AGENT_DELETE_FILE_ACTION,
]);

export interface CreateHelarcActionCompositionInput {
  readonly enableShell: boolean;
  readonly commandLimits?: Partial<CodeAgentCommandLimits>;
}

export interface HelarcActionComposition {
  readonly toolBindings: ToolActionBindingSnapshot;
  readonly registrations: ActionRegistrationSnapshot;
  readonly adapters: readonly ActionAdapterImplementation[];
  readonly executors: readonly ActionExecutor[];
}

export async function createHelarcActionComposition(
  workspace: WorkspaceSelection,
  input: CreateHelarcActionCompositionInput,
): Promise<HelarcActionComposition> {
  const file = createCodeAgentFileActionCapability({
    workspace,
  });
  const command = input.enableShell
    ? await createCodeAgentCommandActionCapability({
        workspace,
        limits: input.commandLimits,
      })
    : null;
  const capabilities = command === null ? [file] : [file, command];
  const registrations = createActionRegistrationSnapshot(capabilities.flatMap(
    (capability) => capability.actionRegistrations.registrations.map((registration) => ({
      actionName: registration.actionName,
      adapter: registration.adapter,
      executor: registration.executor,
    })),
  ));
  const toolRegistrations = createToolRegistrationSnapshot(
    capabilities.flatMap((capability) =>
      capability.toolRegistrations.registrations.map((registration) => ({
        descriptor: registration.descriptor,
        source: registration.source,
        schema: registration.schema,
        boundActionName: registration.boundActionName,
        registrationVersion: registration.registrationVersion,
      }))
    ),
  );
  const selection = createToolSelectionSnapshot(
    toolRegistrations,
    toolRegistrations.registrations.map((registration) => ({
      toolName: registration.descriptor.name,
      origins: WORKFLOW_ACTIONS.has(registration.descriptor.name)
        ? ["workflow" as const]
        : READ_ONLY_ACTIONS.has(registration.descriptor.name) ||
            registration.descriptor.name === CODE_AGENT_RUN_COMMAND_ACTION
          ? ["model" as const]
          : [],
    })),
  );
  const toolBindings = createToolActionBindingSnapshot(selection, registrations);

  return Object.freeze({
    toolBindings,
    registrations,
    adapters: Object.freeze(capabilities.flatMap((capability) => capability.adapters)),
    executors: Object.freeze(capabilities.flatMap((capability) => capability.executors)),
  });
}
