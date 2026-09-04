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
import { createHelarcCommandOperationContribution } from "../tools/HelarcCommandOperation.js";
import type {
  HelarcShellRuntimeProfile,
  HelarcShellToolName,
} from "../tools/HelarcBaselineToolContracts.js";
import type { OperationBindingRevisionRef } from "@agent-anything/operation-catalog/identity";
import type { OperationToolAvailabilityParticipant } from "@agent-anything/agent-runtime/runner";

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
  readonly shellRuntime: HelarcShellRuntimeProfile;
  readonly shellActionAdapterId: string;
  readonly taskStopActionAdapterId: string;
  readonly environment: {
    readonly id: string;
    readonly revision: string;
  };
  readonly taskStopBinding: OperationBindingRevisionRef;
  readonly taskAvailability: {
    getRunAvailability(runId: string): {
      readonly revision: number;
      readonly activeTaskCount: number;
    };
  };
}

export interface CreateHelarcActionCompositionInput {
  readonly admittedAt: string;
  readonly file: HelarcFileActionContribution;
  readonly command: HelarcCommandActionContribution;
  readonly semanticTools: readonly ToolRegistrationInput[];
}

export interface HelarcActionComposition {
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
  ];
  const operationCatalog = createOperationCatalogSnapshot({
    id: "helarc.operations",
    revision: "1",
    entries: operationEntries,
  });
  const operationBindings = createOperationBindingResolverSnapshot(
    "helarc.operation-bindings.v1",
    [...file.bindings, ...command.bindings],
  );
  const toolRegistrations = createToolRegistrationSnapshot(
    operationCatalog,
    [
      ...file.tools,
      ...command.tools,
      ...input.semanticTools,
    ],
  );
  const toolSelection = createFixedLocalToolSelection(
    toolRegistrations,
    operationCatalog,
    toolRegistrations.registrations.map((registration) => ({
      tool: registration.descriptor.ref,
      origins: registration.allowedOrigins,
    })),
  );
  const physical = [input.file, input.command];
  const registrations = createActionRegistrationSnapshot(
    physical.flatMap((contribution) =>
      contribution.registrations.registrations.map(actionRegistrationInput)
    ),
  );
  assertActionRegistrationsBelongToCatalog(registrations, operationCatalog);
  const operationAvailability = Object.freeze(operationCatalog.entries.map(
    (entry): OperationToolAvailabilityParticipant => {
      if (sameOperationBinding(entry.binding.ref, input.command.taskStopBinding)) {
        return Object.freeze({
          binding: entry.binding.ref,
          assess({ run }: { readonly run: import("@agent-anything/agent-core/run").RunRef }) {
            const current = input.command.taskAvailability.getRunAvailability(run.id);
            return Object.freeze({
              basisRefs: Object.freeze([Object.freeze({
                owner: "helarc-command",
                kind: "run_process_tasks",
                id: run.id,
                revision: String(current.revision),
              })]),
              disposition: current.activeTaskCount > 0
                ? "available" as const
                : "unavailable" as const,
              reason: current.activeTaskCount > 0
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
  return Object.freeze({
    operationCatalog,
    operationBindings,
    toolSelection,
    registrations,
    adapters: Object.freeze(physical.flatMap((contribution) => contribution.adapters)),
    executors: Object.freeze(physical.flatMap((contribution) => contribution.executors)),
    operationAvailability,
  });
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
