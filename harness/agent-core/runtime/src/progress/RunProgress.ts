import type { AgentRevisionRef } from "@agent-anything/agent-core/agent";

export interface RunProgressLimits {
  readonly checkpointWindowSize: number;
  readonly nonAdvancingCheckpointThreshold: number;
  readonly maxCorrectionRounds: number;
}

export type RunProgressDisposition =
  | "advanced"
  | "unchanged"
  | "repeated"
  | "deferred";

export type RunProgressReasonCode =
  | "new_trusted_fact"
  | "equivalent_fact_repeated"
  | "activity_without_structural_change"
  | "plan_declaration_only"
  | "progression_basis_changed"
  | "required_work_pending"
  | "no_committed_facts";

export type RunProgressFactStrength = "strong" | "declaration" | "activity";

export type RunProgressFactKind =
  | "controller_turn"
  | "run_action"
  | "plan_update"
  | "active_agent"
  | "steering"
  | "operation_result"
  | "operation_rejected"
  | "tool_rejected"
  | "interaction_settlement"
  | "descendant_settlement"
  | "validation_feedback"
  | "completion_gate"
  | "evidence_ref"
  | "artifact_ref"
  | "required_pending"
  | "unsupported_committed_fact";

export interface RunProgressFactRef {
  readonly kind: RunProgressFactKind;
  readonly owner: string;
  readonly subjectId: string | null;
  readonly revision: string | null;
}

/** Internal comparison material. Fingerprints never enter outward projections. */
export interface RunProgressSemanticFact {
  readonly ref: RunProgressFactRef;
  readonly strength: RunProgressFactStrength;
  readonly fingerprint: string;
}

export type RunProgressOwnerOutcomeDisposition =
  | "state_changed"
  | "new_information"
  | "work_settled"
  | "no_change";

export interface RunProgressOwnerOutcome {
  readonly owner: string;
  readonly subjectId: string | null;
  readonly revision: string | null;
  readonly disposition: RunProgressOwnerOutcomeDisposition;
  readonly fingerprint: string;
}

export interface RunProgressBasisProjection {
  readonly runId: string;
  readonly taskId: string;
  readonly activeAgent: AgentRevisionRef;
  readonly workspaceFingerprint: string | null;
  readonly toolSelectionRevision: string;
  readonly permissionFingerprint: string;
  readonly steeringFingerprint: string | null;
  readonly validationSnapshotRevision: number;
}

export interface RunProgressBasis {
  readonly projection: RunProgressBasisProjection;
  readonly fingerprint: string;
}

export interface RunProgressAssessmentRef {
  readonly runId: string;
  readonly checkpointSequence: number;
}

export interface RunProgressAssessment {
  readonly ref: RunProgressAssessmentRef;
  readonly disposition: RunProgressDisposition;
  readonly reasonCode: RunProgressReasonCode;
  readonly basisChanged: boolean;
  readonly factRefs: readonly RunProgressFactRef[];
  readonly consecutiveNonAdvancingCheckpoints: number;
  readonly correctionRounds: number;
  readonly activeCorrectionRound: number | null;
}

export interface RunProgressCheckpointRecord {
  readonly checkpointSequence: number;
  readonly basisFingerprint: string;
  readonly factFingerprints: readonly string[];
}

export interface RunProgressState {
  readonly checkpointSequence: number;
  readonly consecutiveNonAdvancingCheckpoints: number;
  readonly correctionRounds: number;
  readonly activeCorrectionRound: number | null;
  readonly latestAssessment: RunProgressAssessmentRef | null;
  readonly latestAdvancement: RunProgressAssessmentRef | null;
  readonly basisFingerprint: string | null;
  readonly recentCheckpoints: readonly RunProgressCheckpointRecord[];
}

export interface RunProgressProjection {
  readonly checkpointSequence: number;
  readonly disposition: RunProgressDisposition | null;
  readonly reasonCode: RunProgressReasonCode | null;
  readonly consecutiveNonAdvancingCheckpoints: number;
  readonly correctionRounds: number;
  readonly activeCorrectionRound: number | null;
  readonly latestAssessment: RunProgressAssessmentRef | null;
  readonly latestAdvancement: RunProgressAssessmentRef | null;
  readonly factRefs: readonly RunProgressFactRef[];
}

export interface RunProgressCorrectionFeedback {
  readonly assessment: RunProgressAssessmentRef;
  readonly correctionRound: number;
  readonly reasonCode: RunProgressReasonCode;
  readonly factRefs: readonly RunProgressFactRef[];
}

export function createInitialRunProgressState(): RunProgressState {
  return deepFreeze({
    checkpointSequence: 0,
    consecutiveNonAdvancingCheckpoints: 0,
    correctionRounds: 0,
    activeCorrectionRound: null,
    latestAssessment: null,
    latestAdvancement: null,
    basisFingerprint: null,
    recentCheckpoints: [],
  });
}

export function projectRunProgress(
  state: RunProgressState,
  latestAssessment: RunProgressAssessment | null,
): RunProgressProjection {
  if (
    latestAssessment !== null &&
    (
      latestAssessment.ref.checkpointSequence !== state.checkpointSequence ||
      state.latestAssessment?.runId !== latestAssessment.ref.runId
    )
  ) {
    throw new TypeError("Run Progress projection assessment does not match current state.");
  }
  return deepFreeze({
    checkpointSequence: state.checkpointSequence,
    disposition: latestAssessment?.disposition ?? null,
    reasonCode: latestAssessment?.reasonCode ?? null,
    consecutiveNonAdvancingCheckpoints: state.consecutiveNonAdvancingCheckpoints,
    correctionRounds: state.correctionRounds,
    activeCorrectionRound: state.activeCorrectionRound,
    latestAssessment: state.latestAssessment,
    latestAdvancement: state.latestAdvancement,
    factRefs: latestAssessment?.factRefs ?? [],
  });
}

export function assertRunProgressLimits(input: RunProgressLimits): void {
  positive(input.checkpointWindowSize, "RunProgressLimits.checkpointWindowSize");
  positive(
    input.nonAdvancingCheckpointThreshold,
    "RunProgressLimits.nonAdvancingCheckpointThreshold",
  );
  positive(input.maxCorrectionRounds, "RunProgressLimits.maxCorrectionRounds");
  if (input.nonAdvancingCheckpointThreshold > input.checkpointWindowSize) {
    throw new TypeError(
      "RunProgressLimits.nonAdvancingCheckpointThreshold cannot exceed checkpointWindowSize.",
    );
  }
}

function positive(value: unknown, field: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${field} must be a positive safe integer.`);
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
