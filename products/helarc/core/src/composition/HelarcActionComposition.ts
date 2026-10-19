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
  createCodeFileOperationContribution,
  operationRefForCodeFileTool,
  type CodeFileActionAdapterIds,
} from "@agent-anything/helarc-code-agent/file-operation";
import {
  createToolRegistrationSnapshot,
  type ToolRegistrationInput,
} from "@agent-anything/tools/registration";
import {
  createFixedLocalToolSelection,
  type ToolSelectionRevision,
} from "@agent-anything/tools/selection";
import { createHelarcCommandOperationContribution, HELARC_TASK_OUTPUT_BINDING, HELARC_SHELL_OPERATION, HELARC_TASK_STOP_OPERATION } from "../tools/HelarcCommandOperation.js";
import type {
  HelarcShellRuntimeProfile,
  HelarcShellToolName,
} from "../tools/HelarcBaselineToolContracts.js";
import type { OperationBindingRevisionRef } from "@agent-anything/operation-catalog/identity";
import { operationRevisionKey } from "@agent-anything/operation-catalog/identity";
import { commandInputValidator, type HelarcCommandInputContract } from "../tools/HelarcCommandInputContract.js";
import type { OperationToolAvailabilityParticipant, InternalOperationHandler, CompositeOperationResolverPort } from "@agent-anything/agent-runtime/runner";
import { createOperationResultContracts, type OperationResultContracts } from "@agent-anything/operation-catalog/result";
import { commandResultContract } from "../tools/HelarcCommandResultContract.js";
import { createHelarcToolResultPresenters, type HelarcCommandResultDelivery } from "../tools/HelarcToolResultPresenters.js";
import { withHelarcCompensationInput, withoutHelarcCompensationInput } from "../tools/HelarcCompensationInput.js";
import { createHelarcCompensationBindings } from "../tools/HelarcCompensationBindings.js";
import { createHelarcExecutionDetailsContribution, createHelarcExecutionDetailsHandler, type HelarcExecutionMaterialReader } from "../tools/HelarcExecutionDetails.js";
import { createHelarcFileRestorationContribution } from "../tools/HelarcFileRestoration.js";

export interface HelarcPhysicalActionContribution {
  readonly registrations: ActionRegistrationSnapshot;
  readonly adapters: readonly ActionAdapterImplementation[];
  readonly executors: readonly ActionExecutor[];
}

export interface HelarcFileActionContribution extends HelarcPhysicalActionContribution {
  readonly actionAdapterIds: CodeFileActionAdapterIds;
}

export interface HelarcCommandActionContribution extends HelarcPhysicalActionContribution {
  readonly taskDelivery: HelarcCommandResultDelivery;
  readonly inputContract: HelarcCommandInputContract;
  readonly processManagerId: string;
  readonly internalHandlers: readonly InternalOperationHandler[];
  readonly shellTool: HelarcShellToolName;
  readonly shellRuntime: HelarcShellRuntimeProfile;
  readonly shellActionAdapterId: string;
  readonly taskStopActionAdapterId: string;
  readonly environment: {
    readonly id: string;
    readonly revision: string;
  };
  readonly taskStopBinding: OperationBindingRevisionRef;
  readonly taskState: {
    getRunSnapshots(runId: string): readonly import("../controller/HelarcCommandState.js").HelarcCommandStateSnapshot[];
  };
  readonly taskAvailability: {
    getRunAvailability(runId: string): {
      readonly revision: number;
      readonly activeTaskCount: number;
      readonly retainedTaskCount: number;
    };
  };
}

export interface CreateHelarcActionCompositionInput {
  readonly executionEvidenceAccess?: import("@agent-anything/operation-catalog/evidence").ExecutionEvidenceAccessPort;
  readonly executionMaterials?: HelarcExecutionMaterialReader;
  readonly executionCollections?: import("../tools/HelarcExecutionDetails.js").HelarcExecutionCollectionReader;
  readonly executionCallable?: (runId: string, binding: import("@agent-anything/operation-catalog/identity").OperationBindingRevisionRef) => string | null;
  readonly executionEvidence?: import("@agent-anything/operation-catalog/evidence").ExecutionEvidenceRecordPort;
  readonly admittedAt: string;
  readonly file: HelarcFileActionContribution;
  readonly command: HelarcCommandActionContribution;
  readonly semanticTools: readonly ToolRegistrationInput[];
}

export interface HelarcActionComposition {
  readonly resultPresenters: readonly import("@agent-anything/agent-runtime/runner").ToolResultPresenter[];
  readonly resultContracts: OperationResultContracts;
  readonly toolInputSemanticValidators: readonly import("@agent-anything/tools/validation").ToolInputSemanticValidator[];
  readonly internalHandlers: readonly InternalOperationHandler[];
  readonly composite: CompositeOperationResolverPort;
  readonly operationCatalog: OperationCatalogSnapshot;
  readonly operationBindings: OperationBindingResolverSnapshot;
  readonly toolSelection: ToolSelectionRevision;
  readonly registrations: ActionRegistrationSnapshot;
  readonly adapters: readonly ActionAdapterImplementation[];
  readonly executors: readonly ActionExecutor[];
  readonly operationAvailability: readonly OperationToolAvailabilityParticipant[];
}

export function createHelarcActionComposition(
  input: CreateHelarcActionCompositionInput,
): HelarcActionComposition {
  const { command, operationCatalog, operationBindings, toolSelection, toolInputSemanticValidators, resultContracts, toolRegistrations } = createHelarcToolProfile(input);
  const physical = [input.file, input.command];
  const registrations = createActionRegistrationSnapshot(
    physical.flatMap((contribution) =>
      contribution.registrations.registrations.map(actionRegistrationInput)
    ),
  );
  assertActionRegistrationsBelongToCatalog(registrations, operationCatalog);
  const operationAvailability = createOperationAvailability(operationCatalog, input.command);
  return Object.freeze({
    operationCatalog, operationBindings: createHelarcCompensationBindings({bindings: operationBindings,
      tools: toolRegistrations.registrations, records: input.executionEvidence, access: input.executionEvidenceAccess}), toolSelection, registrations, resultContracts,
    resultPresenters: createHelarcToolResultPresenters(toolRegistrations.registrations, input.command.taskDelivery, input.executionEvidence),
    toolInputSemanticValidators: Object.freeze(toolInputSemanticValidators.map(validator => Object.freeze({...validator,
      scope: Object.freeze({owner: "helarc-command", kind: "contribution", id: input.command.processManagerId, revision: "1"})}))),
    adapters: Object.freeze(physical.flatMap((contribution) => contribution.adapters)),
    executors: Object.freeze(physical.flatMap((contribution) => contribution.executors)),
    operationAvailability,
    internalHandlers: Object.freeze([...input.command.internalHandlers, createHelarcExecutionDetailsHandler({records: input.executionEvidence,
      access: input.executionEvidenceAccess, materials: input.executionMaterials, collections: input.executionCollections, callable: input.executionCallable})]),
    composite: command.composite,
  });
}

/** Definitions only: resolving a Tool profile grants no execution authority. */
export function createHelarcToolProfile(input: {
  readonly admittedAt: string;
  readonly file: Pick<HelarcFileActionContribution, "actionAdapterIds">;
  readonly command: Pick<HelarcCommandActionContribution, "shellTool" | "shellActionAdapterId" | "taskStopActionAdapterId" | "inputContract">;
  readonly semanticTools: readonly ToolRegistrationInput[];
}) {
  requireIsoDate(input.admittedAt);
  const details = createHelarcExecutionDetailsContribution(input.admittedAt);
  const restoration = createHelarcFileRestorationContribution(input.admittedAt);
  const file = createCodeFileOperationContribution({
    actionAdapterIds: input.file.actionAdapterIds,
    admittedAt: input.admittedAt,
  });
  const command = createHelarcCommandOperationContribution({
    shellTool: input.command.shellTool,
    inputContract: input.command.inputContract,
    shellActionAdapterId: input.command.shellActionAdapterId,
    taskStopActionAdapterId: input.command.taskStopActionAdapterId,
    admittedAt: input.admittedAt,
  });
  const operationEntries = [
    details.operation,
    restoration.operation,
    ...file.operations,
    ...command.operations,
  ];
  const operationCatalog = createOperationCatalogSnapshot({
    id: "helarc.operations",
    revision: "1",
    entries: operationEntries,
  });
  const operationBindings = createOperationBindingResolverSnapshot(
    "helarc.operation-bindings.v1",
    [...file.bindings, ...command.bindings, details.resolver, restoration.resolver],
  );
  const resultContracts = createOperationResultContracts(operationCatalog, [
    ...file.resultContracts, ...command.operations.map(commandResultContract), details.contract, restoration.contract,
  ]);
  const toolRegistrations = createToolRegistrationSnapshot(
    operationCatalog,
    [
      ...file.tools,
      ...command.tools,
      ...input.semanticTools,
      details.tool,
      restoration.tool,
    ].map(tool => {
      const participant = tool.descriptor.binding.kind === "operation" && [
        operationRefForCodeFileTool("Edit"), operationRefForCodeFileTool("Write"),
        HELARC_SHELL_OPERATION, HELARC_TASK_STOP_OPERATION,
      ].some(operation => tool.descriptor.binding.kind === "operation" &&
        operationRevisionKey(operation) === operationRevisionKey(tool.descriptor.binding.operation));
      return participant ? withHelarcCompensationInput(tool) : tool;
    }),
  );
  const toolSelection = createFixedLocalToolSelection(
    toolRegistrations,
    operationCatalog,
    toolRegistrations.registrations.map((registration) => ({
      tool: registration.descriptor.ref,
      origins: registration.allowedOrigins,
    })),
  );
  const shell = toolRegistrations.registrations.find(registration => registration.descriptor.name === input.command.shellTool)!;
  const commandValidator = commandInputValidator(input.command.inputContract, shell.descriptor.ref);
  const toolInputSemanticValidators = Object.freeze([{...commandValidator,
    validate(value: unknown) { return commandValidator.validate(withoutHelarcCompensationInput(value)); },
  }]);
  return Object.freeze({ command, operationCatalog, operationBindings, toolSelection, toolRegistrations, toolInputSemanticValidators, resultContracts });
}

function createOperationAvailability(
  operationCatalog: OperationCatalogSnapshot,
  command: HelarcCommandActionContribution,
): readonly OperationToolAvailabilityParticipant[] {
  const operationAvailability = Object.freeze(operationCatalog.entries.map(
    (entry): OperationToolAvailabilityParticipant => {
      if (sameOperationBinding(entry.binding.ref, command.taskStopBinding) || sameOperationBinding(entry.binding.ref, HELARC_TASK_OUTPUT_BINDING)) {
        return Object.freeze({
          binding: entry.binding.ref,
          assess({ run }: { readonly run: import("@agent-anything/agent-core/run").RunRef }) {
            const current = command.taskAvailability.getRunAvailability(run.id);
            const available = sameOperationBinding(entry.binding.ref,HELARC_TASK_OUTPUT_BINDING) ? current.retainedTaskCount > 0 : current.activeTaskCount > 0;
            return Object.freeze({
              basisRefs: Object.freeze([Object.freeze({
                owner: "helarc-command",
                kind: "run_process_tasks",
                id: run.id,
                revision: String(current.revision),
              })]),
              disposition: available
                ? "available" as const
                : "unavailable" as const,
              reason: available
                ? null
                : "no_eligible_subject" as const,
            });
          },
        });
      }
      return Object.freeze({
        binding: entry.binding.ref,
        assess() {
          return Object.freeze({
            basisRefs: Object.freeze([Object.freeze({
              owner: entry.operation.semanticOwner,
              kind: "static_operation_path",
              id: `${entry.operation.ref.operation.namespace}.${entry.operation.ref.operation.name}@${entry.operation.ref.revision}`,
              revision: entry.binding.ref.revision,
            })]),
            disposition: "available" as const,
            reason: null,
          });
        },
      });
    },
  ));
  return operationAvailability;
}

function sameOperationBinding(
  left: OperationBindingRevisionRef,
  right: OperationBindingRevisionRef,
): boolean {
  return left.operation.operation.namespace === right.operation.operation.namespace &&
    left.operation.operation.name === right.operation.operation.name &&
    left.operation.revision === right.operation.revision &&
    left.revision === right.revision;
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

function requireIsoDate(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new TypeError("Helarc action composition admission time must be an ISO date-time.");
  }
}
