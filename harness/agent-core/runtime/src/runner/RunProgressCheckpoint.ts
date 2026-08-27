import { createCanonicalSha256Digest } from "@agent-anything/canonical-action/subject";
import type { OperationResult } from "@agent-anything/operation-catalog/result";
import {
  assessRunProgress,
  createRunProgressBasis,
  createRunProgressSemanticFacts,
  type AssessRunProgressResult,
  type RunProgressCommittedFactInput,
  type RunProgressOwnerOutcome,
  type RunProgressSemanticFact,
} from "../progress/index.js";
import {
  projectPendingRunSubject,
  type RunItem,
  type RunObservation,
  type RunState,
} from "../run/index.js";
import type { ResolvedRunConfig } from "./RunConfig.js";

export interface RunProgressCheckpointInput<TOutput> {
  readonly state: RunState<TOutput>;
  readonly config: ResolvedRunConfig;
}

/** Derives one checkpoint proposal without retaining state or writing the Run. */
export async function assessCommittedRunProgress<TOutput>(
  input: RunProgressCheckpointInput<TOutput>,
): Promise<AssessRunProgressResult> {
  const items = itemsSincePreviousCheckpoint(input.state.items);
  const committedFacts = await collectCommittedFacts(input.state, items, input.config);
  const requiredPending = input.state.pending
    .filter((pending) => pending.required)
    .map(projectPendingRunSubject);
  const basis = await createRunProgressBasis({
    runId: input.state.run.id,
    taskId: input.state.taskId,
    activeAgent: input.state.activeAgent,
    workspaceFingerprint: await workspaceFingerprint(input.state),
    toolSelectionRevision: input.config.tools.revision,
    permissionFingerprint: await permissionFingerprint(input.state, input.config),
    steeringFingerprint: await steeringFingerprint(input.state.items),
    verificationSnapshotRevision: input.state.verification.snapshot.revision,
  });
  return assessRunProgress({
    runId: input.state.run.id,
    previousState: input.state.progress,
    basis,
    committedFacts,
    requiredPending,
    limits: input.config.limits.progress,
  });
}

function itemsSincePreviousCheckpoint<TOutput>(
  items: readonly RunItem<TOutput>[],
): readonly RunItem<TOutput>[] {
  let prior = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]!.payload.kind === "progress_assessment") {
      prior = index;
      break;
    }
  }
  if (prior < 0) {
    const firstTurn = items.findIndex(({ payload }) => payload.kind === "controller_turn");
    return firstTurn < 0 ? Object.freeze([]) : items.slice(firstTurn);
  }
  return items.slice(prior + 1);
}

async function collectCommittedFacts<TOutput>(
  state: RunState<TOutput>,
  items: readonly RunItem<TOutput>[],
  config: ResolvedRunConfig,
): Promise<readonly RunProgressSemanticFact[]> {
  const inputs = (await Promise.all(items.map(async (item): Promise<readonly RunProgressCommittedFactInput[]> => {
    const payload = item.payload;
    switch (payload.kind) {
      case "controller_turn":
        return [{
          kind: "controller_turn",
          status: payload.status,
          decisionKind: payload.decisionKind,
          failureOwner: payload.failure?.kind ?? null,
          failureCode: payload.failure?.failure.code ?? null,
        }];
      case "run_action":
        return [{
          kind: "run_action",
          actionKind: payload.action.subject.kind,
          requestOrigin: payload.action.subject.kind === "operation"
            ? payload.action.subject.requestOrigin
            : null,
        }];
      case "observation":
        return observationInputs(payload.observation);
      case "state_transition":
        if (payload.transition === "active_agent") {
          return [{
            kind: "active_agent",
            previousAgent: payload.previousAgent,
            activeAgent: payload.activeAgent,
          }];
        }
        if (payload.transition === "steering" && payload.steering.status === "applied") {
          return [{ kind: "steering", steering: payload.steering }];
        }
        return [];
      case "verification_feedback":
        return [{ kind: "verification_feedback", verification: payload.verification }];
      case "pending_transition":
        return payload.transition === "opened" && payload.pending.required
          ? [{ kind: "required_pending", pending: projectPendingRunSubject(payload.pending) }]
          : [];
      case "progress_assessment":
      case "progress_correction":
      case "model_call_settlement":
      case "cancellation_transition":
      case "terminal_transition":
        return [];
    }
  }))).flat();

  const boundedRefs = config.limits.progress.checkpointWindowSize;
  for (const ref of state.evidenceRefs.slice(-boundedRefs)) {
    inputs.push({ kind: "evidence_ref", ref });
  }
  for (const ref of state.artifactRefs.slice(-boundedRefs)) {
    inputs.push({ kind: "artifact_ref", ref });
  }
  for (const pending of state.pending.filter((item) => item.required).slice(-boundedRefs)) {
    inputs.push({ kind: "required_pending", pending: projectPendingRunSubject(pending) });
  }

  return Object.freeze((await Promise.all(
    inputs.map(createRunProgressSemanticFacts),
  )).flat());
}

async function observationInputs(
  observation: RunObservation,
): Promise<readonly RunProgressCommittedFactInput[]> {
  const payload = observation.payload;
  switch (payload.kind) {
    case "plan_update":
      return [{ kind: "plan_update", result: payload.result }];
    case "handoff":
      return payload.status === "rejected"
        ? [{ kind: "operation_rejected", owner: "agent-runtime", code: payload.code! }]
        : [];
    case "operation":
      return [{
        kind: "operation_result",
        result: payload.result,
        toolResult: payload.toolResult,
        ownerOutcome: await ownerOutcome(payload.result),
      }];
    case "operation_rejected":
      return [{ kind: "operation_rejected", owner: payload.owner, code: payload.code }];
    case "tool_rejected":
      return [{ kind: "tool_rejected", code: payload.code }];
    case "model_call_rejected":
      return [{ kind: "tool_rejected", code: payload.code }];
    case "interaction":
      return [{
        kind: "interaction_settlement",
        owner: payload.owner,
        status: payload.status,
        contentDigest: payload.contentDigest,
        lowerRefs: observation.lowerRefs.map((ref) => ({
          kind: "interaction_settlement" as const,
          owner: ref.owner,
          subjectId: ref.id,
          revision: ref.revision,
        })),
        toolResult: payload.toolResult,
      }];
    case "descendant_run":
      return [{
        kind: "descendant_settlement",
        status: payload.status,
        failureOwner: payload.failure?.owner ?? null,
        failureCode: payload.failure?.code ?? null,
        lowerRefs: observation.lowerRefs.map((ref) => ({
          kind: "descendant_settlement" as const,
          owner: ref.owner,
          subjectId: ref.id,
          revision: ref.revision,
        })),
        toolResult: payload.toolResult,
      }];
  }
}

async function ownerOutcome(result: OperationResult): Promise<RunProgressOwnerOutcome | null> {
  if (result.status !== "succeeded") {
    return null;
  }
  const stableRefs = result.lowerRefs
    .filter((ref): ref is typeof ref & { readonly revision: string } => ref.revision !== null)
    .map((ref) => ({ owner: ref.owner, kind: ref.kind, revision: ref.revision }))
    .sort(compareSemanticRefs);
  if (stableRefs.length === 0) return null;
  const operation = result.binding.operation.operation;
  return Object.freeze({
    owner: result.semanticOwner,
    subjectId: `${operation.namespace}.${operation.name}`,
    revision: result.binding.revision,
    disposition: "new_information",
    fingerprint: await createCanonicalSha256Digest(
      "agent-anything.run-progress-owner-outcome.v1",
      {
        owner: result.semanticOwner,
        operation: result.binding.operation,
        status: result.status,
        lowerRefs: stableRefs,
        effectCertainty: semanticMetadata(result.metadata.effectCertainty),
        completionExtent: semanticMetadata(result.metadata.completionExtent),
      },
    ),
  });
}

async function workspaceFingerprint<TOutput>(state: RunState<TOutput>): Promise<string | null> {
  if (state.workspace === null) return null;
  return createCanonicalSha256Digest(
    "agent-anything.run-progress-workspace.v1",
    [state.workspace.primary, ...state.workspace.additional]
      .map((workspace) => ({
        id: workspace.id,
        trustState: workspace.trustState,
        source: workspace.source,
        policyRefs: [...workspace.policyRefs].sort(),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  );
}

async function permissionFingerprint<TOutput>(
  state: RunState<TOutput>,
  config: ResolvedRunConfig,
): Promise<string> {
  return createCanonicalSha256Digest(
    "agent-anything.run-progress-permission.v1",
    {
      profile: {
        id: config.permissions.permissionProfile.id,
        environmentId: config.permissions.permissionProfile.environmentId,
        enforcement: config.permissions.permissionProfile.enforcement,
        managedConstraintSetId: config.permissions.permissionProfile.managedConstraintSetId,
      },
      actionCoverage: state.permission.actionCoverage.map((record) => ({
        actionFingerprint: record.actionFingerprint,
        status: record.status,
        grantedPermissions: record.grantedPermissions,
      })),
      runGrants: state.permission.runPermissionGrants.map((record) => ({
        sourceActionFingerprint: record.sourceActionFingerprint,
        permissions: record.permissions,
      })),
      sessionAuthority: state.permission.sessionAuthorityRecords.map((record) => ({
        category: record.category,
        sourceActionFingerprint: record.sourceActionFingerprint,
        applicabilityKeys: record.applicabilityKeys,
        grantedPermissions: record.grantedPermissions,
      })),
      amendments: state.permission.appliedPolicyAmendments.map((record) => ({
        sourceActionFingerprint: record.sourceActionFingerprint,
        amendment: record.amendment,
      })),
    },
  );
}

async function steeringFingerprint<TOutput>(
  items: readonly RunItem<TOutput>[],
): Promise<string | null> {
  let latest: RunItem<TOutput> | undefined;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const candidate = items[index]!;
    if (
      candidate.payload.kind === "state_transition" &&
      candidate.payload.transition === "steering" &&
      candidate.payload.steering.status === "applied"
    ) {
      latest = candidate;
      break;
    }
  }
  if (latest?.payload.kind !== "state_transition" || latest.payload.transition !== "steering") {
    return null;
  }
  const command = latest.payload.steering.command;
  return createCanonicalSha256Digest(
    "agent-anything.run-progress-steering.v1",
    {
      instruction: command.instruction,
      attribution: command.attribution,
    },
  );
}

function semanticMetadata(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function compareSemanticRefs(
  left: { readonly owner: string; readonly kind: string; readonly revision: string },
  right: { readonly owner: string; readonly kind: string; readonly revision: string },
): number {
  return `${left.owner}:${left.kind}:${left.revision}`.localeCompare(
    `${right.owner}:${right.kind}:${right.revision}`,
  );
}
