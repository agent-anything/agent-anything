import type { PendingRunSubjectProjection } from "../run/index.js";
import {
  type RunProgressAssessment,
  type RunProgressBasis,
  type RunProgressFactRef,
  type RunProgressLimits,
  type RunProgressReasonCode,
  type RunProgressSemanticFact,
  type RunProgressState,
  assertRunProgressLimits,
} from "./RunProgress.js";

export interface AssessRunProgressInput {
  readonly runId: string;
  readonly previousState: RunProgressState;
  readonly basis: RunProgressBasis;
  readonly committedFacts: readonly RunProgressSemanticFact[];
  readonly requiredPending: readonly PendingRunSubjectProjection[];
  readonly limits: RunProgressLimits;
}

export interface AssessRunProgressResult {
  readonly assessment: RunProgressAssessment;
  readonly state: RunProgressState;
}

export function assessRunProgress(input: AssessRunProgressInput): AssessRunProgressResult {
  assertRunProgressLimits(input.limits);
  assertState(input.previousState, input.limits);
  if (
    typeof input.runId !== "string" ||
    input.runId.length === 0 ||
    input.runId !== input.basis.projection.runId
  ) {
    throw new TypeError("Run Progress assessment Run identity does not match its basis.");
  }
  if (!Array.isArray(input.committedFacts) || !Array.isArray(input.requiredPending)) {
    throw new TypeError("Run Progress assessment inputs must use arrays.");
  }

  const checkpointSequence = input.previousState.checkpointSequence + 1;
  const basisChanged = input.previousState.basisFingerprint !== null &&
    input.previousState.basisFingerprint !== input.basis.fingerprint;
  // Keep prior semantic outcomes comparable across basis episodes so cycling a
  // basis cannot manufacture novelty. The exact basis remains on each record.
  const comparable = input.previousState.recentCheckpoints;
  const observed = new Set(comparable.flatMap((checkpoint) => checkpoint.factFingerprints));
  const strong = input.committedFacts.filter((fact) => fact.strength === "strong");
  const novelStrong = strong.filter((fact) => !observed.has(fact.fingerprint));
  const allRepeated = input.committedFacts.length > 0 &&
    input.committedFacts.every((fact) => observed.has(fact.fingerprint));
  const hasPlanOnly = input.committedFacts.some((fact) => fact.ref.kind === "plan_update") &&
    input.committedFacts.every((fact) =>
      fact.strength === "declaration" ||
      fact.ref.kind === "controller_turn" ||
      fact.ref.kind === "run_action"
    );

  let disposition: RunProgressAssessment["disposition"];
  let reasonCode: RunProgressReasonCode;
  if (input.requiredPending.some((pending) => pending.required)) {
    disposition = "deferred";
    reasonCode = "required_work_pending";
  } else if (novelStrong.length > 0) {
    disposition = "advanced";
    reasonCode = "new_trusted_fact";
  } else if (allRepeated) {
    disposition = "repeated";
    reasonCode = "equivalent_fact_repeated";
  } else {
    disposition = "unchanged";
    reasonCode = basisChanged
      ? "progression_basis_changed"
      : input.committedFacts.length === 0
        ? "no_committed_facts"
        : hasPlanOnly
          ? "plan_declaration_only"
          : "activity_without_structural_change";
  }

  const steeringReset = basisChanged && input.committedFacts.some(
    (fact) => fact.ref.kind === "steering",
  );
  const nonAdvancing = disposition === "unchanged" || disposition === "repeated"
    ? steeringReset
      ? 0
      : input.previousState.consecutiveNonAdvancingCheckpoints + 1
    : disposition === "advanced"
      ? 0
      : input.previousState.consecutiveNonAdvancingCheckpoints;
  const assessmentRef = deepFreeze({ runId: input.runId, checkpointSequence });
  const representativeFacts = boundedFactRefs(
    disposition === "advanced" ? novelStrong : input.committedFacts,
    input.limits.checkpointWindowSize,
  );
  const assessment = deepFreeze({
    ref: assessmentRef,
    disposition,
    reasonCode,
    basisChanged,
    factRefs: representativeFacts,
    consecutiveNonAdvancingCheckpoints: nonAdvancing,
    correctionRounds: input.previousState.correctionRounds,
    activeCorrectionRound: disposition === "advanced" || steeringReset
      ? null
      : input.previousState.activeCorrectionRound,
  });
  const checkpoint = deepFreeze({
    checkpointSequence,
    basisFingerprint: input.basis.fingerprint,
    factFingerprints: Object.freeze([...new Set(
      input.committedFacts.map((fact) => fact.fingerprint),
    )]),
  });
  const recentCheckpoints = Object.freeze([
    ...input.previousState.recentCheckpoints,
    checkpoint,
  ].slice(-input.limits.checkpointWindowSize));
  const state = deepFreeze({
    checkpointSequence,
    consecutiveNonAdvancingCheckpoints: nonAdvancing,
    correctionRounds: input.previousState.correctionRounds,
    activeCorrectionRound: assessment.activeCorrectionRound,
    latestAssessment: assessmentRef,
    latestAdvancement: disposition === "advanced"
      ? assessmentRef
      : input.previousState.latestAdvancement,
    basisFingerprint: input.basis.fingerprint,
    recentCheckpoints,
  });
  return deepFreeze({ assessment, state });
}

function boundedFactRefs(
  facts: readonly RunProgressSemanticFact[],
  maximum: number,
): readonly RunProgressFactRef[] {
  const unique = new Map<string, RunProgressFactRef>();
  for (const fact of facts) {
    const key = `${fact.ref.kind}:${fact.ref.owner}:${fact.ref.subjectId ?? ""}:${fact.ref.revision ?? ""}`;
    if (!unique.has(key)) unique.set(key, fact.ref);
    if (unique.size === maximum) break;
  }
  return Object.freeze([...unique.values()]);
}

function assertState(state: RunProgressState, limits: RunProgressLimits): void {
  for (const [field, value] of [
    ["checkpointSequence", state.checkpointSequence],
    ["consecutiveNonAdvancingCheckpoints", state.consecutiveNonAdvancingCheckpoints],
    ["correctionRounds", state.correctionRounds],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`RunProgressState.${field} must be a non-negative safe integer.`);
    }
  }
  if (!Array.isArray(state.recentCheckpoints)) {
    throw new TypeError("RunProgressState.recentCheckpoints must be an array.");
  }
  if (state.recentCheckpoints.length > limits.checkpointWindowSize) {
    throw new TypeError("RunProgressState.recentCheckpoints exceeds the configured window.");
  }
  if (
    (state.checkpointSequence === 0) !== (state.latestAssessment === null) ||
    (state.checkpointSequence === 0) !== (state.basisFingerprint === null)
  ) {
    throw new TypeError("RunProgressState assessment and basis do not match its checkpoint sequence.");
  }
  if (
    state.latestAssessment !== null &&
    state.latestAssessment.checkpointSequence !== state.checkpointSequence
  ) {
    throw new TypeError("RunProgressState latest assessment is not current.");
  }
  if (
    state.activeCorrectionRound !== null &&
    (
      !Number.isSafeInteger(state.activeCorrectionRound) ||
      state.activeCorrectionRound < 1 ||
      state.activeCorrectionRound > state.correctionRounds
    )
  ) {
    throw new TypeError("RunProgressState active correction round is incoherent.");
  }
  let prior = 0;
  for (const checkpoint of state.recentCheckpoints) {
    if (
      !Number.isSafeInteger(checkpoint.checkpointSequence) ||
      checkpoint.checkpointSequence <= prior ||
      checkpoint.checkpointSequence > state.checkpointSequence ||
      !Array.isArray(checkpoint.factFingerprints)
    ) {
      throw new TypeError("RunProgressState checkpoint history is incoherent.");
    }
    prior = checkpoint.checkpointSequence;
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
