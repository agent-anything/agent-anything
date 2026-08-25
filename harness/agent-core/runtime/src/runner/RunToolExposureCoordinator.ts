import type { RunRef } from "@agent-anything/agent-core/run";
import type { RunLineage } from "@agent-anything/agent-core/run-tree";
import type { OperationBindingRevisionRef } from "@agent-anything/operation-catalog/identity";
import {
  createToolBindingAvailabilityAssessment,
  createToolExposureProof,
  resolveCurrentTurnToolExposure,
  type CurrentTurnToolExposure,
  type ToolBindingUnavailableReason,
  type ToolExposureBasisRef,
  type ToolExposureProof,
  type ToolSelectionRevision,
} from "@agent-anything/tools/selection";
import { toolRevisionKey } from "@agent-anything/tools/identity";
import type { RunInteractionCoordinator } from "./RunInteractionCoordinator.js";
import {
  assessRunTreeDescendantCapacity,
  type RunTreeExecutionSnapshot,
} from "./RunTreeExecution.js";
import type {
  DelegationPreparationPort,
  OperationToolAvailabilityParticipant,
  ToolPathAvailability,
} from "./RunnerDependencies.js";

export interface RunToolExposureResolution {
  readonly runRevision: number;
  readonly exposure: CurrentTurnToolExposure;
  readonly proof: ToolExposureProof;
  readonly ownerBasisRevision: string;
}

export interface RunToolExposureCoordinatorDependencies {
  readonly run: RunRef;
  readonly lineage: RunLineage;
  readonly selection: ToolSelectionRevision;
  readonly operationParticipants: readonly OperationToolAvailabilityParticipant[];
  readonly interactions: RunInteractionCoordinator;
  readonly maxPendingInteractions: number;
  readonly delegation: DelegationPreparationPort | undefined;
  readonly getRunRevision: () => number;
  readonly getRunTreeSnapshot: () => RunTreeExecutionSnapshot;
}

export class RunToolExposureCoordinator {
  private readonly operations: ReadonlyMap<string, OperationToolAvailabilityParticipant>;

  constructor(private readonly dependencies: RunToolExposureCoordinatorDependencies) {
    const operations = new Map<string, OperationToolAvailabilityParticipant>();
    for (const participant of dependencies.operationParticipants) {
      const key = operationBindingKey(participant.binding);
      if (operations.has(key) || typeof participant.assess !== "function") {
        throw new TypeError(`Operation Tool availability participant '${key}' is invalid or duplicated.`);
      }
      operations.set(key, Object.freeze({
        binding: snapshotOperationBinding(participant.binding),
        assess: participant.assess.bind(participant),
      }));
    }
    this.operations = operations;
  }

  async resolve(controllerRequestId: string): Promise<RunToolExposureResolution> {
    const runRevision = this.dependencies.getRunRevision();
    const runBasis: ToolExposureBasisRef = Object.freeze({
      owner: "agent-runtime",
      kind: "run_exposure",
      id: this.dependencies.run.id,
      revision: String(runRevision),
    });
    const modelTools = this.dependencies.selection.tools.filter(
      (selected) => selected.origins.includes("model"),
    );
    const paths: { readonly toolKey: string; readonly path: ToolPathAvailability }[] = [];
    for (const selected of modelTools) {
      const binding = selected.registration.descriptor.binding;
      let path: ToolPathAvailability;
      switch (binding.kind) {
        case "operation": {
          const participant = this.operations.get(operationBindingKey({
            operation: binding.operation,
            revision: binding.revision,
          }));
          if (participant === undefined) {
            throw new ToolExposureCoordinationError(
              "tool_availability_participant_missing",
              `No availability participant owns Operation binding '${operationBindingKey({ operation: binding.operation, revision: binding.revision })}'.`,
            );
          }
          try {
            path = await participant.assess({ run: this.dependencies.run });
          } catch (error) {
            throw participantFailure("operation", error);
          }
          break;
        }
        case "interaction": {
          const current = this.dependencies.interactions.getAvailabilitySnapshot(
            binding.protocol,
            this.dependencies.maxPendingInteractions,
          );
          path = Object.freeze({
            basisRefs: Object.freeze([
              Object.freeze({
                owner: "interaction",
                kind: "protocol_registry",
                id: `${binding.protocol.owner}:${binding.protocol.kind}@${binding.protocol.revision}`,
                revision: current.registrySnapshotId,
              }),
              Object.freeze({
                owner: "interaction",
                kind: "run_interaction_capacity",
                id: this.dependencies.run.id,
                revision: `${current.revision}:${current.activeCount}:${current.maximumPending}`,
              }),
            ]),
            disposition: !current.protocolAvailable || current.settled
              ? "unavailable"
              : current.hasCapacity
                ? "available"
                : "unavailable",
            reason: !current.protocolAvailable || current.settled
              ? "binding_inactive"
              : current.hasCapacity
                ? null
                : "interaction_capacity_exhausted",
          });
          break;
        }
        case "descendant_agent": {
          const tree = descendantTreeAvailability(
            this.dependencies.getRunTreeSnapshot(),
            this.dependencies.lineage,
          );
          let owner: ToolPathAvailability;
          if (this.dependencies.delegation === undefined) {
            owner = unavailablePath(
              Object.freeze({
                owner: "agent-runtime",
                kind: "descendant_composition",
                id: `${binding.agent.id}@${binding.agent.revision}`,
                revision: "unconfigured",
              }),
              "execution_path_unavailable",
            );
          } else {
            try {
              owner = snapshotPath(await this.dependencies.delegation.assessAvailability({
                parentRunId: this.dependencies.run.id,
                targetAgent: binding.agent,
              }));
            } catch (error) {
              throw participantFailure("descendant_agent", error);
            }
          }
          path = combineDescendantAvailability(owner, tree);
          break;
        }
      }
      paths.push(Object.freeze({
        toolKey: toolRevisionKey(selected.registration.descriptor.ref),
        path: snapshotPath(path),
      }));
    }

    if (this.dependencies.getRunRevision() !== runRevision) {
      throw new ToolExposureBasisChangedError();
    }
    const basisRefs = uniqueBasisRefs([
      runBasis,
      ...paths.flatMap(({ path }) => path.basisRefs),
    ]);
    const assessments = modelTools.map((selected) => {
      const path = paths.find(({ toolKey }) =>
        toolKey === toolRevisionKey(selected.registration.descriptor.ref)
      )!.path;
      return createToolBindingAvailabilityAssessment({
        selection: this.dependencies.selection,
        tool: selected.registration.descriptor.ref,
        basisRefs: uniqueBasisRefs([runBasis, ...path.basisRefs]),
        disposition: path.disposition,
        reason: path.reason,
      });
    });
    const exposure = resolveCurrentTurnToolExposure(this.dependencies.selection, {
      basisRefs,
      assessments,
    });
    return Object.freeze({
      runRevision,
      exposure,
      proof: createToolExposureProof(exposure, controllerRequestId),
      ownerBasisRevision: ownerBasisRevision(paths),
    });
  }
}

export class ToolExposureCoordinationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ToolExposureCoordinationError";
  }
}

export class ToolExposureBasisChangedError extends Error {
  readonly code = "tool_exposure_basis_changed";

  constructor() {
    super("Tool Exposure basis changed while availability was being resolved.");
    this.name = "ToolExposureBasisChangedError";
  }
}

export function createStaticOperationToolAvailabilityParticipant(
  binding: OperationBindingRevisionRef,
  owner = "operation-catalog",
): OperationToolAvailabilityParticipant {
  const snapshot = snapshotOperationBinding(binding);
  return Object.freeze({
    binding: snapshot,
    assess() {
      return Object.freeze({
        basisRefs: Object.freeze([Object.freeze({
          owner,
          kind: "static_operation_path",
          id: `${snapshot.operation.operation.namespace}.${snapshot.operation.operation.name}@${snapshot.operation.revision}`,
          revision: snapshot.revision,
        })]),
        disposition: "available" as const,
        reason: null,
      });
    },
  });
}

function descendantTreeAvailability(
  snapshot: RunTreeExecutionSnapshot,
  lineage: RunLineage,
): ToolPathAvailability {
  const capacity = assessRunTreeDescendantCapacity(snapshot, lineage);
  const basis = Object.freeze({
    owner: "agent-runtime",
    kind: "run_tree_descendant_capacity",
    id: snapshot.rootRunId,
    revision: String(snapshot.revision),
  });
  if (capacity.disposition === "unavailable") {
    return unavailablePath(basis, "descendant_capacity_exhausted");
  }
  return Object.freeze({
    basisRefs: Object.freeze([basis]),
    disposition: "available",
    reason: null,
  });
}

function combineDescendantAvailability(
  owner: ToolPathAvailability,
  tree: ToolPathAvailability,
): ToolPathAvailability {
  const disposition = owner.disposition === "available" && tree.disposition === "available"
    ? "available"
    : "unavailable";
  return Object.freeze({
    basisRefs: uniqueBasisRefs([...owner.basisRefs, ...tree.basisRefs]),
    disposition,
    reason: disposition === "available" ? null : owner.reason ?? tree.reason,
  });
}

function unavailablePath(
  basis: ToolExposureBasisRef,
  reason: ToolBindingUnavailableReason,
): ToolPathAvailability {
  return Object.freeze({
    basisRefs: Object.freeze([basis]),
    disposition: "unavailable",
    reason,
  });
}

function snapshotPath(input: ToolPathAvailability): ToolPathAvailability {
  if (input === null || typeof input !== "object" || !Array.isArray(input.basisRefs) || input.basisRefs.length === 0) {
    throw new ToolExposureCoordinationError("tool_availability_participant_invalid", "Tool availability participant returned an invalid result.");
  }
  if (input.disposition !== "available" && input.disposition !== "unavailable") {
    throw new ToolExposureCoordinationError("tool_availability_participant_invalid", "Tool availability disposition is invalid.");
  }
  if ((input.disposition === "available") !== (input.reason === null)) {
    throw new ToolExposureCoordinationError("tool_availability_participant_invalid", "Tool availability reason contradicts its disposition.");
  }
  return Object.freeze({
    basisRefs: uniqueBasisRefs(input.basisRefs),
    disposition: input.disposition,
    reason: input.reason,
  });
}

function uniqueBasisRefs(input: readonly ToolExposureBasisRef[]): readonly ToolExposureBasisRef[] {
  const refs = new Map<string, ToolExposureBasisRef>();
  for (const ref of input) {
    const snapshot = Object.freeze({
      owner: token(ref.owner),
      kind: token(ref.kind),
      id: token(ref.id),
      revision: token(ref.revision),
    });
    refs.set(`${snapshot.owner}/${snapshot.kind}/${snapshot.id}@${snapshot.revision}`, snapshot);
  }
  return Object.freeze([...refs.values()].sort((left, right) =>
    `${left.owner}/${left.kind}/${left.id}@${left.revision}`.localeCompare(
      `${right.owner}/${right.kind}/${right.id}@${right.revision}`,
    )
  ));
}

function ownerBasisRevision(
  paths: readonly { readonly toolKey: string; readonly path: ToolPathAvailability }[],
): string {
  return JSON.stringify(paths.map(({ toolKey, path }) => ({
    toolKey,
    disposition: path.disposition,
    reason: path.reason,
    basisRefs: path.basisRefs.map((ref) =>
      `${ref.owner}/${ref.kind}/${ref.id}@${ref.revision}`
    ).sort(),
  })).sort((left, right) => left.toolKey.localeCompare(right.toolKey)));
}

function snapshotOperationBinding(
  input: OperationBindingRevisionRef,
): OperationBindingRevisionRef {
  return Object.freeze({
    operation: Object.freeze({
      operation: Object.freeze({
        namespace: token(input.operation.operation.namespace),
        name: token(input.operation.operation.name),
      }),
      revision: token(input.operation.revision),
    }),
    revision: token(input.revision),
  });
}

function operationBindingKey(input: OperationBindingRevisionRef): string {
  return `${input.operation.operation.namespace}.${input.operation.operation.name}@${input.operation.revision}:${input.revision}`;
}

function token(input: unknown): string {
  if (typeof input !== "string" || input.length === 0 || input !== input.trim()) {
    throw new TypeError("Tool availability identity must be a canonical token.");
  }
  return input;
}

function participantFailure(owner: string, error: unknown): ToolExposureCoordinationError {
  return new ToolExposureCoordinationError(
    "tool_availability_participant_failed",
    `${owner} availability participant failed: ${error instanceof Error ? error.message : "unknown failure"}`,
  );
}
