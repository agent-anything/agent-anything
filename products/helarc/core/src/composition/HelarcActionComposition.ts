import type { ActionAdapterImplementation } from "@agent-anything/action-execution/registration";
import type { ActionExecutor } from "@agent-anything/action-execution/execution";
import {
  createActionRegistrationSnapshot,
  type ActionRegistration,
  type ActionRegistrationInput,
  type ActionRegistrationSnapshot,
} from "@agent-anything/canonical-action/registration";
import {
  createOperationBindingResolverSnapshot,
  type OperationBindingResolverSnapshot,
} from "@agent-anything/operation-catalog/binding";
import {
  createOperationCatalogSnapshot,
  type OperationCatalogSnapshot,
} from "@agent-anything/operation-catalog/catalog";
import {
  CODE_AGENT_EDIT_TOOL,
  CODE_AGENT_GLOB_TOOL,
  CODE_AGENT_GREP_TOOL,
  CODE_AGENT_READ_TOOL,
  CODE_AGENT_WRITE_TOOL,
  createCodeFileOperationContribution,
  type CodeFileActionAdapterIds,
} from "@agent-anything/helarc-code-agent/file-operation";
import {
  createToolRegistrationSnapshot,
} from "@agent-anything/tools/registration";
import {
  createFixedLocalToolSelection,
  type ToolSelectionRevision,
} from "@agent-anything/tools/selection";
import {
  createHelarcCommandOperationContribution,
  HELARC_TASK_STOP_TOOL,
} from "../tools/HelarcCommandOperation.js";
import type { HelarcShellToolName } from "../tools/HelarcBaselineToolContracts.js";
import {
  HELARC_RUN_VALIDATION_CHECK_TOOL,
  type HelarcValidationCheckOperationContribution,
} from "../validation/HelarcValidationCheckOperation.js";

const MODEL_FILE_TOOLS = new Set([
  CODE_AGENT_READ_TOOL,
  CODE_AGENT_GLOB_TOOL,
  CODE_AGENT_GREP_TOOL,
  CODE_AGENT_EDIT_TOOL,
  CODE_AGENT_WRITE_TOOL,
]);

export interface HelarcPhysicalActionContribution {
  readonly registrations: ActionRegistrationSnapshot;
  readonly adapters: readonly ActionAdapterImplementation[];
  readonly executors: readonly ActionExecutor[];
}

export interface HelarcFileActionContribution extends HelarcPhysicalActionContribution {
  readonly actionAdapterIds: CodeFileActionAdapterIds;
}

export interface HelarcCommandActionContribution extends HelarcPhysicalActionContribution {
  readonly shellTool: HelarcShellToolName;
  readonly shellActionAdapterId: string;
  readonly taskStopActionAdapterId: string;
  readonly environment: {
    readonly id: string;
    readonly revision: string;
  };
}

export interface CreateHelarcActionCompositionInput {
  readonly admittedAt: string;
  readonly file: HelarcFileActionContribution;
  readonly command: HelarcCommandActionContribution;
  readonly validation: HelarcValidationCheckOperationContribution | null;
}

export interface HelarcActionComposition {
  readonly operationCatalog: OperationCatalogSnapshot;
  readonly operationBindings: OperationBindingResolverSnapshot;
  readonly toolSelection: ToolSelectionRevision;
  readonly registrations: ActionRegistrationSnapshot;
  readonly adapters: readonly ActionAdapterImplementation[];
  readonly executors: readonly ActionExecutor[];
  readonly composite: HelarcValidationCheckOperationContribution["composite"] | null;
}

export function createHelarcActionComposition(
  input: CreateHelarcActionCompositionInput,
): HelarcActionComposition {
  requireIsoDate(input.admittedAt);
  const file = createCodeFileOperationContribution({
    actionAdapterIds: input.file.actionAdapterIds,
    admittedAt: input.admittedAt,
  });
  const command = createHelarcCommandOperationContribution({
    shellTool: input.command.shellTool,
    shellActionAdapterId: input.command.shellActionAdapterId,
    taskStopActionAdapterId: input.command.taskStopActionAdapterId,
    admittedAt: input.admittedAt,
  });
  const operationEntries = [
    ...file.operations,
    ...command.operations,
    ...(input.validation?.operations ?? []),
  ];
  const operationCatalog = createOperationCatalogSnapshot({
    id: "helarc.operations",
    revision: "1",
    entries: operationEntries,
  });
  const operationBindings = createOperationBindingResolverSnapshot(
    "helarc.operation-bindings.v1",
    [...file.bindings, ...command.bindings, ...(input.validation?.bindings ?? [])],
  );
  const toolRegistrations = createToolRegistrationSnapshot(
    operationCatalog,
    [...file.tools, ...command.tools, ...(input.validation?.tools ?? [])],
  );
  const toolSelection = createFixedLocalToolSelection(
    toolRegistrations,
    operationCatalog,
    toolRegistrations.registrations.map((registration) => ({
      tool: registration.descriptor.ref,
      origins: selectionOrigins(registration.descriptor.name),
    })),
  );
  const physical = [input.file, input.command];
  const registrations = createActionRegistrationSnapshot(
    physical.flatMap((contribution) =>
      contribution.registrations.registrations.map(actionRegistrationInput)
    ),
  );
  assertActionRegistrationsBelongToCatalog(registrations, operationCatalog);
  return Object.freeze({
    operationCatalog,
    operationBindings,
    toolSelection,
    registrations,
    adapters: Object.freeze(physical.flatMap((contribution) => contribution.adapters)),
    executors: Object.freeze(physical.flatMap((contribution) => contribution.executors)),
    composite: input.validation?.composite ?? null,
  });
}

export function validateHelarcToolInput(schema: unknown, candidate: unknown): boolean {
  return validateSchemaNode(schema, candidate);
}

function selectionOrigins(name: string): readonly ("model" | "workflow")[] {
  if (MODEL_FILE_TOOLS.has(name) || name === "Bash" || name === "PowerShell" || name === HELARC_TASK_STOP_TOOL ||
      name === HELARC_RUN_VALIDATION_CHECK_TOOL) {
    return Object.freeze(["model" as const]);
  }
  throw new TypeError(`Helarc Tool '${name}' has no Product selection policy.`);
}

function actionRegistrationInput(
  registration: ActionRegistration,
): ActionRegistrationInput {
  const { registrationFingerprint: _fingerprint, ...input } = registration;
  return input;
}

function assertActionRegistrationsBelongToCatalog(
  registrations: ActionRegistrationSnapshot,
  catalog: OperationCatalogSnapshot,
): void {
  const admitted = new Set(catalog.entries.map((entry) =>
    `${entry.operation.ref.operation.namespace}:${entry.operation.ref.operation.name}@${entry.operation.ref.revision}:${entry.binding.ref.revision}`
  ));
  for (const registration of registrations.registrations) {
    const key = `${registration.operation.operation.namespace}:${registration.operation.operation.name}@${registration.operation.revision}:${registration.binding.revision}`;
    if (!admitted.has(key)) {
      throw new TypeError(`Action registration '${registration.registrationId}' has no admitted Operation binding.`);
    }
  }
}

function validateSchemaNode(schema: unknown, value: unknown): boolean {
  if (!isRecord(schema)) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    return false;
  }
  switch (schema.type) {
    case "object": {
      if (!isRecord(value)) return false;
      const properties = isRecord(schema.properties) ? schema.properties : {};
      const required = Array.isArray(schema.required) ? schema.required : [];
      if (required.some((key) => typeof key !== "string" || !Object.hasOwn(value, key))) return false;
      if (schema.additionalProperties === false && Object.keys(value).some((key) => !Object.hasOwn(properties, key))) return false;
      return Object.entries(value).every(([key, item]) =>
        !Object.hasOwn(properties, key) || validateSchemaNode(properties[key], item)
      );
    }
    case "array":
      return Array.isArray(value) && value.every((item) => validateSchemaNode(schema.items, item));
    case "string":
      return typeof value === "string" &&
        (typeof schema.minLength !== "number" || value.length >= schema.minLength);
    case "integer":
      return Number.isSafeInteger(value) &&
        (typeof schema.minimum !== "number" || (value as number) >= schema.minimum);
    case "number":
      return typeof value === "number" && Number.isFinite(value) &&
        (typeof schema.minimum !== "number" || value >= schema.minimum);
    case "boolean":
      return typeof value === "boolean";
    default:
      return true;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, any>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireIsoDate(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new TypeError("Helarc action composition admission time must be an ISO date-time.");
  }
}
