import type { ContextContribution, ContextContributionRef } from "@agent-anything/context/contribution";
import type {
  VerificationAssessmentRef,
  VerificationAssessmentVerdict,
  VerificationCurrentSnapshotRef,
} from "../assessment/index.js";
import type { CompletionGateDecisionStatus, CompletionGateInvocationRef } from "../completion/index.js";
import type {
  VerificationCompletionDisposition,
  VerificationNecessity,
  VerificationRequirementRef,
} from "../definition/index.js";
import type {
  CheckAttemptRef,
  CheckDefinitionRef,
  CheckFindingRef,
  CheckResultRef,
  CheckResultStatus,
} from "../execution/index.js";
import type { VerificationSubjectSnapshotRef } from "../subject/index.js";

export interface VerificationStateCount {
  readonly state: "unassessed" | "pending" | "satisfied" | "violated" | "inconclusive" | "stale";
  readonly count: number;
}

export type VerificationRecoveryMeaning =
  | "none"
  | "select_admitted_check"
  | "await_active_attempt"
  | "refresh_subject"
  | "repair_and_reverify"
  | "gather_additional_evidence"
  | "select_alternative_check_or_disclose";

export type VerificationFeedbackTrigger =
  | { readonly kind: "state_transition"; readonly snapshot: VerificationCurrentSnapshotRef }
  | { readonly kind: "settled_result"; readonly result: CheckResultRef }
  | { readonly kind: "completion_gate"; readonly gate: CompletionGateInvocationRef };

export interface VerificationProjectedAssessment {
  readonly ref: VerificationAssessmentRef;
  readonly verdict: VerificationAssessmentVerdict;
  readonly basis: string;
  readonly limitations: readonly string[];
}

export interface VerificationProjectedFinding {
  readonly ref: CheckFindingRef;
  readonly claim: string;
  readonly polarity: "supports" | "contradicts" | "limits";
  readonly severity: "info" | "warning" | "error";
  readonly limitations: readonly string[];
}

export interface VerificationProjectedCheckPath {
  readonly family: string;
  readonly definition: CheckDefinitionRef;
}

export interface VerificationProjectedSettlement {
  readonly result: CheckResultRef;
  readonly status: CheckResultStatus;
  readonly failureCode: string | null;
  readonly coverageRatio: number;
  readonly limitations: readonly string[];
}

export interface VerificationProjectedGate {
  readonly ref: CompletionGateInvocationRef;
  readonly status: CompletionGateDecisionStatus;
  readonly disposition: VerificationCompletionDisposition | null;
  readonly reasonCodes: readonly string[];
  readonly affectedRequirements: readonly VerificationRequirementRef[];
}

export interface VerificationRunnerFeedback {
  readonly snapshot: VerificationCurrentSnapshotRef;
  readonly requirement: VerificationRequirementRef;
  readonly necessity: VerificationNecessity;
  readonly state: VerificationStateCount["state"];
  readonly subject: VerificationSubjectSnapshotRef | null;
  readonly assessment: VerificationAssessmentRef | null;
  readonly activeAttempts: readonly CheckAttemptRef[];
  readonly waitingEligible: boolean;
  readonly latestSettlement: VerificationProjectedSettlement | null;
  readonly reasonCodes: readonly string[];
  readonly recovery: VerificationRecoveryMeaning;
}

export interface VerificationRunnerProjection {
  readonly snapshot: VerificationCurrentSnapshotRef;
  readonly trigger: VerificationFeedbackTrigger;
  readonly affectedRequirements: readonly VerificationRequirementRef[];
  readonly feedback: readonly VerificationRunnerFeedback[];
  readonly activeAttempts: readonly CheckAttemptRef[];
  readonly gate: VerificationProjectedGate | null;
  readonly safeReasonCodes: readonly string[];
  readonly recoveryNeeded: boolean;
  readonly contextContribution: ContextContributionRef | null;
}

export interface VerificationContextRequirementProjection {
  readonly snapshot: VerificationCurrentSnapshotRef;
  readonly requirement: VerificationRequirementRef;
  readonly necessity: VerificationNecessity;
  readonly claim: string;
  readonly purpose: string;
  readonly state: VerificationStateCount["state"];
  readonly subject: VerificationSubjectSnapshotRef | null;
  readonly assessment: VerificationProjectedAssessment | null;
  readonly findings: readonly VerificationProjectedFinding[];
  readonly admittedChecks: readonly VerificationProjectedCheckPath[];
  readonly activeAttempts: readonly CheckAttemptRef[];
  readonly waitingEligible: boolean;
  readonly remainingAttempts: number;
  readonly remainingDurationMs: number;
  readonly latestSettlement: VerificationProjectedSettlement | null;
  readonly gate: VerificationProjectedGate | null;
  readonly reasonCodes: readonly string[];
  readonly recovery: VerificationRecoveryMeaning;
}

export interface VerificationContextProjection {
  readonly snapshot: VerificationCurrentSnapshotRef;
  readonly trigger: VerificationFeedbackTrigger;
  readonly requirements: readonly VerificationContextRequirementProjection[];
  readonly gate: VerificationProjectedGate | null;
  readonly contribution: ContextContribution | null;
}

export interface VerificationHostProjection {
  readonly snapshot: VerificationCurrentSnapshotRef;
  readonly counts: readonly VerificationStateCount[];
  readonly activeAttempts: readonly CheckAttemptRef[];
  readonly gate: VerificationProjectedGate | null;
  readonly waiting: boolean;
  readonly recoveryNeeded: boolean;
  readonly safeReasons: readonly string[];
  readonly updatedAt: string;
}

export interface VerificationObservabilityProjection {
  readonly snapshot: VerificationCurrentSnapshotRef;
  readonly trigger: VerificationFeedbackTrigger;
  readonly activeAttempts: readonly CheckAttemptRef[];
  readonly latestResult: {
    readonly ref: CheckResultRef;
    readonly status: CheckResultStatus;
    readonly failureCode: string | null;
    readonly durationMs: number;
    readonly coverageRatio: number;
    readonly costUnits: number | null;
  } | null;
  readonly latestAssessment: {
    readonly ref: VerificationAssessmentRef;
    readonly requirement: VerificationRequirementRef;
    readonly subject: VerificationSubjectSnapshotRef;
    readonly verdict: VerificationAssessmentVerdict;
  } | null;
  readonly gate: VerificationProjectedGate | null;
  readonly waiting: boolean;
  readonly recoveryNeeded: boolean;
  readonly safeCodes: readonly string[];
  readonly emittedAt: string;
}

export interface VerificationEvaluationProjection {
  readonly snapshot: VerificationCurrentSnapshotRef;
  readonly requirements: readonly {
    readonly requirement: VerificationRequirementRef;
    readonly state: VerificationStateCount["state"];
    readonly subject: VerificationSubjectSnapshotRef | null;
    readonly assessment: VerificationAssessmentRef | null;
  }[];
  readonly attempts: readonly {
    readonly attempt: CheckAttemptRef;
    readonly requirement: VerificationRequirementRef;
    readonly definition: CheckDefinitionRef;
    readonly origin: string;
  }[];
  readonly results: readonly {
    readonly result: CheckResultRef;
    readonly attempt: CheckAttemptRef;
    readonly status: CheckResultStatus;
    readonly latencyMs: number;
    readonly costUnits: number | null;
    readonly failureOwner: string | null;
    readonly failureCode: string | null;
  }[];
  readonly assessments: readonly {
    readonly assessment: VerificationAssessmentRef;
    readonly requirement: VerificationRequirementRef;
    readonly subject: VerificationSubjectSnapshotRef;
    readonly verdict: VerificationAssessmentVerdict;
  }[];
  readonly gate: VerificationProjectedGate | null;
}

export function snapshotVerificationRunnerProjection(input: VerificationRunnerProjection): VerificationRunnerProjection {
  strictRecord(input, "VerificationRunnerProjection", [
    "snapshot", "trigger", "affectedRequirements", "feedback", "activeAttempts",
    "gate", "safeReasonCodes", "recoveryNeeded", "contextContribution",
  ]);
  const snapshot = snapshotRef(input.snapshot, "VerificationRunnerProjection.snapshot");
  if (typeof input.recoveryNeeded !== "boolean") {
    throw new TypeError("VerificationRunnerProjection.recoveryNeeded must be boolean.");
  }
  return deepFreeze({
    snapshot,
    trigger: feedbackTrigger(input.trigger, "VerificationRunnerProjection.trigger"),
    affectedRequirements: uniqueRefs(input.affectedRequirements, "VerificationRunnerProjection.affectedRequirements"),
    feedback: input.feedback.map((item, index) => runnerFeedback(item, snapshot, `VerificationRunnerProjection.feedback[${index}]`)),
    activeAttempts: uniqueAttempts(input.activeAttempts, "VerificationRunnerProjection.activeAttempts"),
    gate: input.gate === null ? null : projectedGate(input.gate, "VerificationRunnerProjection.gate"),
    safeReasonCodes: tokenList(input.safeReasonCodes, "VerificationRunnerProjection.safeReasonCodes"),
    recoveryNeeded: input.recoveryNeeded,
    contextContribution: input.contextContribution === null
      ? null
      : revisionRef(input.contextContribution, "VerificationRunnerProjection.contextContribution"),
  });
}

export function snapshotVerificationContextProjection(input: VerificationContextProjection): VerificationContextProjection {
  strictRecord(input, "VerificationContextProjection", ["snapshot", "trigger", "requirements", "gate", "contribution"]);
  const snapshot = snapshotRef(input.snapshot, "VerificationContextProjection.snapshot");
  return deepFreeze({
    snapshot,
    trigger: feedbackTrigger(input.trigger, "VerificationContextProjection.trigger"),
    requirements: input.requirements.map((item, index) => contextRequirement(
      item,
      snapshot,
      `VerificationContextProjection.requirements[${index}]`,
    )),
    gate: input.gate === null ? null : projectedGate(input.gate, "VerificationContextProjection.gate"),
    contribution: input.contribution === null ? null : clone(input.contribution),
  });
}

export function snapshotVerificationHostProjection(input: VerificationHostProjection): VerificationHostProjection {
  strictRecord(input, "VerificationHostProjection", [
    "snapshot", "counts", "activeAttempts", "gate", "waiting", "recoveryNeeded",
    "safeReasons", "updatedAt",
  ]);
  if (typeof input.waiting !== "boolean" || typeof input.recoveryNeeded !== "boolean") {
    throw new TypeError("VerificationHostProjection waiting and recovery flags must be boolean.");
  }
  return deepFreeze({
    snapshot: snapshotRef(input.snapshot, "VerificationHostProjection.snapshot"),
    counts: unique(input.counts.map((item, index) => {
      const path = `VerificationHostProjection.counts[${index}]`;
      strictRecord(item, path, ["state", "count"]);
      state(item.state, `${path}.state`);
      return { state: item.state, count: nonNegative(item.count, `${path}.count`) };
    }), (item) => item.state, "VerificationHostProjection.counts"),
    activeAttempts: uniqueAttempts(input.activeAttempts, "VerificationHostProjection.activeAttempts"),
    gate: input.gate === null ? null : projectedGate(input.gate, "VerificationHostProjection.gate"),
    waiting: input.waiting,
    recoveryNeeded: input.recoveryNeeded,
    safeReasons: textList(input.safeReasons, "VerificationHostProjection.safeReasons"),
    updatedAt: isoDateTime(input.updatedAt, "VerificationHostProjection.updatedAt"),
  });
}

export function snapshotVerificationObservabilityProjection(input: VerificationObservabilityProjection): VerificationObservabilityProjection {
  strictRecord(input, "VerificationObservabilityProjection", [
    "snapshot", "trigger", "activeAttempts", "latestResult", "latestAssessment", "gate",
    "waiting", "recoveryNeeded", "safeCodes", "emittedAt",
  ]);
  if (typeof input.waiting !== "boolean" || typeof input.recoveryNeeded !== "boolean") {
    throw new TypeError("VerificationObservabilityProjection waiting and recovery flags must be boolean.");
  }
  return deepFreeze({
    snapshot: snapshotRef(input.snapshot, "VerificationObservabilityProjection.snapshot"),
    trigger: feedbackTrigger(input.trigger, "VerificationObservabilityProjection.trigger"),
    activeAttempts: uniqueAttempts(input.activeAttempts, "VerificationObservabilityProjection.activeAttempts"),
    latestResult: input.latestResult === null ? null : projectedOperationalResult(
      input.latestResult,
      "VerificationObservabilityProjection.latestResult",
    ),
    latestAssessment: input.latestAssessment === null ? null : projectedOperationalAssessment(
      input.latestAssessment,
      "VerificationObservabilityProjection.latestAssessment",
    ),
    gate: input.gate === null ? null : projectedGate(input.gate, "VerificationObservabilityProjection.gate"),
    waiting: input.waiting,
    recoveryNeeded: input.recoveryNeeded,
    safeCodes: tokenList(input.safeCodes, "VerificationObservabilityProjection.safeCodes"),
    emittedAt: isoDateTime(input.emittedAt, "VerificationObservabilityProjection.emittedAt"),
  });
}

export function snapshotVerificationEvaluationProjection(input: VerificationEvaluationProjection): VerificationEvaluationProjection {
  strictRecord(input, "VerificationEvaluationProjection", [
    "snapshot", "requirements", "attempts", "results", "assessments", "gate",
  ]);
  return deepFreeze({
    snapshot: snapshotRef(input.snapshot, "VerificationEvaluationProjection.snapshot"),
    requirements: input.requirements.map((item, index) => projectedEvaluationRequirement(
      item,
      `VerificationEvaluationProjection.requirements[${index}]`,
    )),
    attempts: input.attempts.map((item, index) => projectedEvaluationAttempt(
      item,
      `VerificationEvaluationProjection.attempts[${index}]`,
    )),
    results: input.results.map((item, index) => projectedEvaluationResult(
      item,
      `VerificationEvaluationProjection.results[${index}]`,
    )),
    assessments: input.assessments.map((item, index) => projectedEvaluationAssessment(
      item,
      `VerificationEvaluationProjection.assessments[${index}]`,
    )),
    gate: input.gate === null ? null : projectedGate(input.gate, "VerificationEvaluationProjection.gate"),
  });
}

function runnerFeedback(
  input: VerificationRunnerFeedback,
  snapshot: VerificationCurrentSnapshotRef,
  path: string,
): VerificationRunnerFeedback {
  strictRecord(input, path, [
    "snapshot", "requirement", "necessity", "state", "subject", "assessment", "activeAttempts",
    "waitingEligible", "latestSettlement", "reasonCodes", "recovery",
  ]);
  if (snapshotKey(input.snapshot) !== snapshotKey(snapshot)) throw new TypeError(`${path}.snapshot must match the Projection snapshot.`);
  if (input.necessity !== "mandatory" && input.necessity !== "advisory") throw new TypeError(`${path}.necessity is unsupported.`);
  state(input.state, `${path}.state`);
  if (typeof input.waitingEligible !== "boolean") throw new TypeError(`${path}.waitingEligible must be boolean.`);
  return {
    snapshot: snapshotRef(input.snapshot, `${path}.snapshot`),
    requirement: revisionRef(input.requirement, `${path}.requirement`),
    necessity: input.necessity,
    state: input.state,
    subject: input.subject === null ? null : revisionRef(input.subject, `${path}.subject`),
    assessment: input.assessment === null ? null : revisionRef(input.assessment, `${path}.assessment`),
    activeAttempts: uniqueAttempts(input.activeAttempts, `${path}.activeAttempts`),
    waitingEligible: input.waitingEligible,
    latestSettlement: input.latestSettlement === null ? null : projectedSettlement(input.latestSettlement, `${path}.latestSettlement`),
    reasonCodes: tokenList(input.reasonCodes, `${path}.reasonCodes`),
    recovery: recovery(input.recovery, `${path}.recovery`),
  };
}

function contextRequirement(
  input: VerificationContextRequirementProjection,
  snapshot: VerificationCurrentSnapshotRef,
  path: string,
): VerificationContextRequirementProjection {
  strictRecord(input, path, [
    "snapshot", "requirement", "necessity", "claim", "purpose", "state", "subject",
    "assessment", "findings", "admittedChecks", "activeAttempts", "waitingEligible",
    "remainingAttempts", "remainingDurationMs", "latestSettlement", "gate", "reasonCodes", "recovery",
  ]);
  if (snapshotKey(input.snapshot) !== snapshotKey(snapshot)) throw new TypeError(`${path}.snapshot must match the Projection snapshot.`);
  if (input.necessity !== "mandatory" && input.necessity !== "advisory") throw new TypeError(`${path}.necessity is unsupported.`);
  state(input.state, `${path}.state`);
  if (typeof input.waitingEligible !== "boolean") throw new TypeError(`${path}.waitingEligible must be boolean.`);
  return {
    snapshot: snapshotRef(input.snapshot, `${path}.snapshot`),
    requirement: revisionRef(input.requirement, `${path}.requirement`),
    necessity: input.necessity,
    claim: text(input.claim, `${path}.claim`),
    purpose: text(input.purpose, `${path}.purpose`),
    state: input.state,
    subject: input.subject === null ? null : revisionRef(input.subject, `${path}.subject`),
    assessment: input.assessment === null ? null : projectedAssessment(input.assessment, `${path}.assessment`),
    findings: input.findings.map((item, index) => projectedFinding(item, `${path}.findings[${index}]`)),
    admittedChecks: unique(input.admittedChecks.map((item, index) => projectedCheckPath(item, `${path}.admittedChecks[${index}]`)),
      (item) => `${item.definition.id}@${item.definition.revision}`, `${path}.admittedChecks`),
    activeAttempts: uniqueAttempts(input.activeAttempts, `${path}.activeAttempts`),
    waitingEligible: input.waitingEligible,
    remainingAttempts: nonNegative(input.remainingAttempts, `${path}.remainingAttempts`),
    remainingDurationMs: nonNegative(input.remainingDurationMs, `${path}.remainingDurationMs`),
    latestSettlement: input.latestSettlement === null ? null : projectedSettlement(input.latestSettlement, `${path}.latestSettlement`),
    gate: input.gate === null ? null : projectedGate(input.gate, `${path}.gate`),
    reasonCodes: tokenList(input.reasonCodes, `${path}.reasonCodes`),
    recovery: recovery(input.recovery, `${path}.recovery`),
  };
}

function feedbackTrigger(input: VerificationFeedbackTrigger, path: string): VerificationFeedbackTrigger {
  if (input.kind === "state_transition") {
    strictRecord(input, path, ["kind", "snapshot"]);
    return { kind: input.kind, snapshot: snapshotRef(input.snapshot, `${path}.snapshot`) };
  }
  if (input.kind === "settled_result") {
    strictRecord(input, path, ["kind", "result"]);
    return { kind: input.kind, result: revisionRef(input.result, `${path}.result`) };
  }
  if (input.kind === "completion_gate") {
    strictRecord(input, path, ["kind", "gate"]);
    return { kind: input.kind, gate: revisionRef(input.gate, `${path}.gate`) };
  }
  throw new TypeError(`${path}.kind is unsupported.`);
}

function projectedAssessment(input: VerificationProjectedAssessment, path: string): VerificationProjectedAssessment {
  strictRecord(input, path, ["ref", "verdict", "basis", "limitations"]);
  if (!ASSESSMENT_VERDICTS.includes(input.verdict)) throw new TypeError(`${path}.verdict is unsupported.`);
  return {
    ref: revisionRef(input.ref, `${path}.ref`),
    verdict: input.verdict,
    basis: text(input.basis, `${path}.basis`),
    limitations: textList(input.limitations, `${path}.limitations`),
  };
}

function projectedFinding(input: VerificationProjectedFinding, path: string): VerificationProjectedFinding {
  strictRecord(input, path, ["ref", "claim", "polarity", "severity", "limitations"]);
  if (!["supports", "contradicts", "limits"].includes(input.polarity)) throw new TypeError(`${path}.polarity is unsupported.`);
  if (!["info", "warning", "error"].includes(input.severity)) throw new TypeError(`${path}.severity is unsupported.`);
  return {
    ref: revisionRef(input.ref, `${path}.ref`),
    claim: text(input.claim, `${path}.claim`),
    polarity: input.polarity,
    severity: input.severity,
    limitations: textList(input.limitations, `${path}.limitations`),
  };
}

function projectedCheckPath(input: VerificationProjectedCheckPath, path: string): VerificationProjectedCheckPath {
  strictRecord(input, path, ["family", "definition"]);
  return { family: token(input.family, `${path}.family`), definition: revisionRef(input.definition, `${path}.definition`) };
}

function projectedSettlement(input: VerificationProjectedSettlement, path: string): VerificationProjectedSettlement {
  strictRecord(input, path, ["result", "status", "failureCode", "coverageRatio", "limitations"]);
  return {
    result: revisionRef(input.result, `${path}.result`),
    status: nullableCheckStatus(input.status, `${path}.status`)!,
    failureCode: input.failureCode === null ? null : token(input.failureCode, `${path}.failureCode`),
    coverageRatio: ratio(input.coverageRatio, `${path}.coverageRatio`),
    limitations: textList(input.limitations, `${path}.limitations`),
  };
}

function projectedGate(input: VerificationProjectedGate, path: string): VerificationProjectedGate {
  strictRecord(input, path, ["ref", "status", "disposition", "reasonCodes", "affectedRequirements"]);
  const status = nullableGateStatus(input.status, `${path}.status`)!;
  if (status === "completion_eligible" && input.disposition !== null) throw new TypeError(`${path}.disposition must be null for completion eligibility.`);
  if (status !== "completion_eligible" && input.disposition === null) throw new TypeError(`${path}.disposition is required for non-eligible gates.`);
  if (input.disposition !== null && !DISPOSITIONS.includes(input.disposition)) throw new TypeError(`${path}.disposition is unsupported.`);
  return {
    ref: revisionRef(input.ref, `${path}.ref`),
    status,
    disposition: input.disposition,
    reasonCodes: tokenList(input.reasonCodes, `${path}.reasonCodes`),
    affectedRequirements: uniqueRefs(input.affectedRequirements, `${path}.affectedRequirements`),
  };
}

function projectedOperationalResult(
  input: VerificationObservabilityProjection["latestResult"] & {},
  path: string,
): NonNullable<VerificationObservabilityProjection["latestResult"]> {
  strictRecord(input, path, [
    "ref", "status", "failureCode", "durationMs", "coverageRatio", "costUnits",
  ]);
  return {
    ref: revisionRef(input.ref, `${path}.ref`),
    status: nullableCheckStatus(input.status, `${path}.status`)!,
    failureCode: input.failureCode === null ? null : token(input.failureCode, `${path}.failureCode`),
    durationMs: nullableNonNegative(input.durationMs, `${path}.durationMs`)!,
    coverageRatio: ratio(input.coverageRatio, `${path}.coverageRatio`),
    costUnits: nullableNonNegative(input.costUnits, `${path}.costUnits`),
  };
}

function projectedEvaluationRequirement(
  input: VerificationEvaluationProjection["requirements"][number],
  path: string,
): VerificationEvaluationProjection["requirements"][number] {
  strictRecord(input, path, ["requirement", "state", "subject", "assessment"]);
  state(input.state, `${path}.state`);
  return {
    requirement: revisionRef(input.requirement, `${path}.requirement`),
    state: input.state,
    subject: input.subject === null ? null : revisionRef(input.subject, `${path}.subject`),
    assessment: input.assessment === null ? null : revisionRef(input.assessment, `${path}.assessment`),
  };
}

function projectedEvaluationAttempt(
  input: VerificationEvaluationProjection["attempts"][number],
  path: string,
): VerificationEvaluationProjection["attempts"][number] {
  strictRecord(input, path, ["attempt", "requirement", "definition", "origin"]);
  return {
    attempt: attemptRef(input.attempt, `${path}.attempt`),
    requirement: revisionRef(input.requirement, `${path}.requirement`),
    definition: revisionRef(input.definition, `${path}.definition`),
    origin: token(input.origin, `${path}.origin`),
  };
}

function projectedEvaluationResult(
  input: VerificationEvaluationProjection["results"][number],
  path: string,
): VerificationEvaluationProjection["results"][number] {
  strictRecord(input, path, [
    "result", "attempt", "status", "latencyMs", "costUnits", "failureOwner", "failureCode",
  ]);
  return {
    result: revisionRef(input.result, `${path}.result`),
    attempt: attemptRef(input.attempt, `${path}.attempt`),
    status: nullableCheckStatus(input.status, `${path}.status`)!,
    latencyMs: nullableNonNegative(input.latencyMs, `${path}.latencyMs`)!,
    costUnits: nullableNonNegative(input.costUnits, `${path}.costUnits`),
    failureOwner: input.failureOwner === null ? null : token(input.failureOwner, `${path}.failureOwner`),
    failureCode: input.failureCode === null ? null : token(input.failureCode, `${path}.failureCode`),
  };
}

function projectedEvaluationAssessment(
  input: VerificationEvaluationProjection["assessments"][number],
  path: string,
): VerificationEvaluationProjection["assessments"][number] {
  strictRecord(input, path, ["assessment", "requirement", "subject", "verdict"]);
  if (!ASSESSMENT_VERDICTS.includes(input.verdict)) throw new TypeError(`${path}.verdict is unsupported.`);
  return {
    assessment: revisionRef(input.assessment, `${path}.assessment`),
    requirement: revisionRef(input.requirement, `${path}.requirement`),
    subject: revisionRef(input.subject, `${path}.subject`),
    verdict: input.verdict,
  };
}

function projectedOperationalAssessment(
  input: NonNullable<VerificationObservabilityProjection["latestAssessment"]>,
  path: string,
): NonNullable<VerificationObservabilityProjection["latestAssessment"]> {
  strictRecord(input, path, ["ref", "requirement", "subject", "verdict"]);
  if (!ASSESSMENT_VERDICTS.includes(input.verdict)) throw new TypeError(`${path}.verdict is unsupported.`);
  return {
    ref: revisionRef(input.ref, `${path}.ref`),
    requirement: revisionRef(input.requirement, `${path}.requirement`),
    subject: revisionRef(input.subject, `${path}.subject`),
    verdict: input.verdict,
  };
}

const STATES: readonly VerificationStateCount["state"][] = [
  "unassessed", "pending", "satisfied", "violated", "inconclusive", "stale",
];
const RECOVERY: readonly VerificationRecoveryMeaning[] = [
  "none", "select_admitted_check", "await_active_attempt", "refresh_subject",
  "repair_and_reverify", "gather_additional_evidence", "select_alternative_check_or_disclose",
];
const CHECK_STATUSES: readonly CheckResultStatus[] = [
  "invalid", "unavailable", "denied", "cancelled", "timed_out", "failed", "partial", "completed",
];
const GATE_STATUSES: readonly CompletionGateDecisionStatus[] = [
  "completion_eligible", "blocked_unassessed", "blocked_pending", "blocked_stale",
  "blocked_violated", "blocked_inconclusive", "invalid", "failed",
];
const ASSESSMENT_VERDICTS: readonly VerificationAssessmentVerdict[] = ["satisfied", "violated", "inconclusive"];
const DISPOSITIONS: readonly VerificationCompletionDisposition[] = ["continue", "wait", "block", "fail"];

function state(input: unknown, path: string): asserts input is VerificationStateCount["state"] {
  if (!STATES.includes(input as VerificationStateCount["state"])) throw new TypeError(`${path} is unsupported.`);
}
function recovery(input: unknown, path: string): VerificationRecoveryMeaning {
  if (!RECOVERY.includes(input as VerificationRecoveryMeaning)) throw new TypeError(`${path} is unsupported.`);
  return input as VerificationRecoveryMeaning;
}
function snapshotRef(input: VerificationCurrentSnapshotRef, path: string): VerificationCurrentSnapshotRef {
  strictRecord(input, path, ["runId", "revision"]);
  return { runId: token(input.runId, `${path}.runId`), revision: nonNegative(input.revision, `${path}.revision`) };
}
function snapshotKey(input: VerificationCurrentSnapshotRef): string { return `${input.runId}#${input.revision}`; }
function revisionRef<T extends { readonly id: string; readonly revision: string }>(input: T, path: string): T {
  strictRecord(input, path, ["id", "revision"]);
  return { id: token(input.id, `${path}.id`), revision: token(input.revision, `${path}.revision`) } as T;
}
function attemptRef(input: CheckAttemptRef, path: string): CheckAttemptRef {
  strictRecord(input, path, ["id", "ordinal"]);
  if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 1) throw new TypeError(`${path}.ordinal must be positive.`);
  return { id: token(input.id, `${path}.id`), ordinal: input.ordinal };
}
function uniqueAttempts(input: readonly CheckAttemptRef[], path: string): readonly CheckAttemptRef[] {
  return unique(input.map((item, index) => attemptRef(item, `${path}[${index}]`)), (item) => `${item.id}#${item.ordinal}`, path);
}
function uniqueRefs<T extends { readonly id: string; readonly revision: string }>(input: readonly T[], path: string): readonly T[] {
  return unique(input.map((item, index) => revisionRef(item, `${path}[${index}]`)), (item) => `${item.id}@${item.revision}`, path);
}
function nullableCheckStatus(input: CheckResultStatus | null, path: string): CheckResultStatus | null {
  if (input !== null && !CHECK_STATUSES.includes(input)) throw new TypeError(`${path} is unsupported.`);
  return input;
}
function nullableGateStatus(input: CompletionGateDecisionStatus | null, path: string): CompletionGateDecisionStatus | null {
  if (input !== null && !GATE_STATUSES.includes(input)) throw new TypeError(`${path} is unsupported.`);
  return input;
}
function nullableNonNegative(input: number | null, path: string): number | null {
  if (input === null) return null;
  if (typeof input !== "number" || !Number.isFinite(input) || input < 0) throw new TypeError(`${path} must be non-negative.`);
  return input;
}
function nullableRatio(input: number | null, path: string): number | null { return input === null ? null : ratio(input, path); }
function ratio(input: unknown, path: string): number {
  if (typeof input !== "number" || !Number.isFinite(input) || input < 0 || input > 1) throw new TypeError(`${path} must be between 0 and 1.`);
  return input;
}
function nonNegative(input: unknown, path: string): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) throw new TypeError(`${path} must be a non-negative integer.`);
  return input as number;
}
function strictRecord(input: unknown, path: string, keys: readonly string[]): asserts input is Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new TypeError(`${path} must be a record.`);
  const unknown = Object.keys(input).filter((key) => !keys.includes(key));
  if (unknown.length > 0) throw new TypeError(`${path} contains unsupported field '${unknown[0]}'.`);
}
function token(input: unknown, path: string): string {
  if (typeof input !== "string" || input.length === 0 || input !== input.trim() || /\s/.test(input)) throw new TypeError(`${path} must be a canonical token.`);
  return input;
}
function text(input: unknown, path: string): string {
  if (typeof input !== "string" || input.trim().length === 0) throw new TypeError(`${path} is required.`);
  return input;
}
function tokenList(input: readonly string[], path: string): readonly string[] {
  return unique(input.map((item, index) => token(item, `${path}[${index}]`)), (item) => item, path);
}
function textList(input: readonly string[], path: string): readonly string[] {
  return unique(input.map((item, index) => text(item, `${path}[${index}]`)), (item) => item, path);
}
function isoDateTime(input: unknown, path: string): string {
  if (typeof input !== "string" || Number.isNaN(Date.parse(input)) || new Date(input).toISOString() !== input) throw new TypeError(`${path} must be an ISO date-time.`);
  return input;
}
function unique<T>(input: readonly T[], key: (item: T) => string, path: string): readonly T[] {
  const values = input.map(key);
  if (new Set(values).size !== values.length) throw new TypeError(`${path} must not contain duplicates.`);
  return [...input];
}
function clone<T>(input: T): T {
  if (Array.isArray(input)) return input.map((item) => clone(item)) as T;
  if (input !== null && typeof input === "object") return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, clone(value)])) as T;
  return input;
}
function deepFreeze<T>(input: T): T {
  if (input !== null && typeof input === "object" && !Object.isFrozen(input)) {
    for (const value of Object.values(input as Record<string, unknown>)) deepFreeze(value);
    Object.freeze(input);
  }
  return input;
}
