import { createHash } from "node:crypto";

import type { EvaluationRecordRef } from "@agent-anything/evaluation/definition";

import {
  HELARC_OPERATIONAL_EVALUATION_TIME,
} from "./HelarcOperationalEvaluation.js";

export const HELARC_INCIDENT_ADMISSION_REVISION =
  "helarc-incident-admission-v1";

export type HelarcIncidentAdmissionStatus = "pending" | "rejected" | "admitted";

export interface HelarcEvaluationIncidentCandidate {
  readonly ref: EvaluationRecordRef;
  readonly observedAt: string;
  readonly source: {
    readonly kind: "observed_product_run";
    readonly targetSnapshotRef: EvaluationRecordRef | null;
    readonly runRef: EvaluationRecordRef | null;
    readonly sanitizedTask: string;
    readonly taskDigest: string;
  };
  readonly symptom: {
    readonly code: string;
    readonly summary: string;
    readonly observedTerminal: "cancelled_by_user" | "failed" | "succeeded";
  };
  readonly limitations: readonly string[];
}

export interface HelarcIncidentAdmissionEvidence {
  readonly reproduction: null | {
    readonly status: "reproduced" | "not_reproduced";
    readonly targetSnapshotRef: EvaluationRecordRef;
    readonly reportRef: EvaluationRecordRef;
  };
  readonly mechanism: null | {
    readonly owner: string;
    readonly invariant: string;
    readonly languageNeutral: boolean;
  };
  readonly minimization: null | {
    readonly caseRef: EvaluationRecordRef;
    readonly fixtureDigest: string;
    readonly taskDigest: string;
    readonly trajectoryDigest: string;
    readonly expectedOutcomes: readonly string[];
    readonly forbiddenOutcomes: readonly string[];
  };
  readonly environment: null | {
    readonly protocolRef: EvaluationRecordRef;
    readonly fingerprints: readonly string[];
    readonly stable: boolean;
  };
  readonly graderControl: null | {
    readonly graderDefinitionRef: EvaluationRecordRef;
    readonly negativeControlRef: EvaluationRecordRef;
    readonly negativeControlPassed: boolean;
  };
  readonly revisionProof: null | {
    readonly failingImplementationRevision: string;
    readonly failingReportRef: EvaluationRecordRef;
    readonly passingImplementationRevision: string;
    readonly passingReportRef: EvaluationRecordRef;
    readonly failedBefore: boolean;
    readonly passedAfter: boolean;
  };
  readonly placement: null | {
    readonly suiteRef: EvaluationRecordRef;
    readonly lifecycle: "permanent_regression";
    readonly owner: string;
    readonly limitations: readonly string[];
  };
}

export interface HelarcIncidentAdmissionDecision {
  readonly ref: EvaluationRecordRef;
  readonly candidateRef: EvaluationRecordRef;
  readonly status: HelarcIncidentAdmissionStatus;
  readonly reasonCodes: readonly string[];
  readonly admittedRegression: null | {
    readonly caseRef: EvaluationRecordRef;
    readonly suiteRef: EvaluationRecordRef;
    readonly owner: string;
    readonly failingReportRef: EvaluationRecordRef;
    readonly passingReportRef: EvaluationRecordRef;
  };
  readonly decidedAt: string;
  readonly digest: string;
}

export const HELARC_CSHARP_CONSOLE_INCIDENT_CANDIDATE: HelarcEvaluationIncidentCandidate =
  createHelarcEvaluationIncidentCandidate({
    ref: ref("helarc.incident.repeating-actions-csharp-console"),
    observedAt: HELARC_OPERATIONAL_EVALUATION_TIME,
    source: {
      kind: "observed_product_run",
      targetSnapshotRef: null,
      runRef: null,
      sanitizedTask: "Create a Hello World console application, execute it, and report the observed result.",
      taskDigest: sha256("create-hello-world-console-application-and-run"),
    },
    symptom: {
      code: "actions_continued_until_user_cancellation",
      summary: "The observed Run continued to emit new Actions and required user cancellation.",
      observedTerminal: "cancelled_by_user",
    },
    limitations: [
      "The original exact Target Snapshot and Run record are unavailable.",
      "The observed task used C#, but only a language-neutral failed mechanism may enter the regression Suite.",
      "No minimized fail-before/pass-after evidence has been established.",
    ],
  });

export function createHelarcEvaluationIncidentCandidate(
  input: HelarcEvaluationIncidentCandidate,
): HelarcEvaluationIncidentCandidate {
  assertRef(input.ref, "candidate ref");
  assertText(input.observedAt, "observedAt");
  assertText(input.source.sanitizedTask, "sanitizedTask");
  assertDigest(input.source.taskDigest, "taskDigest");
  assertText(input.symptom.code, "symptom code");
  assertText(input.symptom.summary, "symptom summary");
  return deepFreeze({
    ref: input.ref,
    observedAt: input.observedAt,
    source: { ...input.source },
    symptom: { ...input.symptom },
    limitations: [...input.limitations],
  });
}

export function evaluateHelarcIncidentAdmission(input: {
  readonly candidate: HelarcEvaluationIncidentCandidate;
  readonly evidence: Partial<HelarcIncidentAdmissionEvidence>;
  readonly decidedAt?: string;
}): HelarcIncidentAdmissionDecision {
  const candidate = createHelarcEvaluationIncidentCandidate(input.candidate);
  const evidence: HelarcIncidentAdmissionEvidence = Object.freeze({
    reproduction: input.evidence.reproduction ?? null,
    mechanism: input.evidence.mechanism ?? null,
    minimization: input.evidence.minimization ?? null,
    environment: input.evidence.environment ?? null,
    graderControl: input.evidence.graderControl ?? null,
    revisionProof: input.evidence.revisionProof ?? null,
    placement: input.evidence.placement ?? null,
  });
  const rejected = rejectionReasons(evidence);
  const missing = missingReasons(evidence);
  const status: HelarcIncidentAdmissionStatus = rejected.length > 0
    ? "rejected"
    : missing.length > 0
      ? "pending"
      : "admitted";
  const reasonCodes = Object.freeze((status === "rejected" ? rejected : missing).sort());
  const admittedRegression = status === "admitted"
    ? Object.freeze({
        caseRef: evidence.minimization!.caseRef,
        suiteRef: evidence.placement!.suiteRef,
        owner: evidence.placement!.owner,
        failingReportRef: evidence.revisionProof!.failingReportRef,
        passingReportRef: evidence.revisionProof!.passingReportRef,
      })
    : null;
  const material = deepFreeze({
    ref: ref(`${candidate.ref.id}.admission-decision`),
    candidateRef: candidate.ref,
    status,
    reasonCodes,
    admittedRegression,
    decidedAt: input.decidedAt ?? HELARC_OPERATIONAL_EVALUATION_TIME,
  });
  return deepFreeze({ ...material, digest: sha256(stableJson(material)) });
}

export function evaluateCSharpConsoleIncidentCandidate(): HelarcIncidentAdmissionDecision {
  return evaluateHelarcIncidentAdmission({
    candidate: HELARC_CSHARP_CONSOLE_INCIDENT_CANDIDATE,
    evidence: {},
  });
}

function missingReasons(evidence: HelarcIncidentAdmissionEvidence): string[] {
  const reasons: string[] = [];
  if (evidence.reproduction === null) reasons.push("exact_reproduction_missing");
  if (evidence.mechanism === null) reasons.push("isolated_mechanism_missing");
  if (evidence.minimization === null) reasons.push("minimized_case_missing");
  if (evidence.environment === null) reasons.push("stable_environment_evidence_missing");
  if (evidence.graderControl === null) reasons.push("grader_negative_control_missing");
  if (evidence.revisionProof === null) reasons.push("fail_before_pass_after_missing");
  if (evidence.placement === null) reasons.push("regression_placement_missing");
  return reasons;
}

function rejectionReasons(evidence: HelarcIncidentAdmissionEvidence): string[] {
  const reasons: string[] = [];
  if (evidence.reproduction?.status === "not_reproduced") {
    reasons.push("exact_target_not_reproduced");
  }
  if (evidence.mechanism !== null && !evidence.mechanism.languageNeutral) {
    reasons.push("mechanism_is_language_specific");
  }
  if (evidence.minimization !== null) {
    if (evidence.minimization.expectedOutcomes.length === 0) {
      reasons.push("expected_outcomes_missing");
    }
    if (evidence.minimization.forbiddenOutcomes.length === 0) {
      reasons.push("forbidden_outcomes_missing");
    }
  }
  if (evidence.environment !== null) {
    if (!evidence.environment.stable || new Set(evidence.environment.fingerprints).size !== 1) {
      reasons.push("environment_not_stable");
    }
  }
  if (evidence.graderControl !== null && !evidence.graderControl.negativeControlPassed) {
    reasons.push("grader_negative_control_failed");
  }
  if (evidence.revisionProof !== null) {
    if (!evidence.revisionProof.failedBefore || !evidence.revisionProof.passedAfter) {
      reasons.push("fail_before_pass_after_not_proven");
    }
    if (
      evidence.revisionProof.failingImplementationRevision ===
        evidence.revisionProof.passingImplementationRevision
    ) {
      reasons.push("implementation_revisions_not_distinct");
    }
    if (refKey(evidence.revisionProof.failingReportRef) === refKey(evidence.revisionProof.passingReportRef)) {
      reasons.push("evidence_reports_not_distinct");
    }
  }
  return reasons;
}

function assertRef(value: EvaluationRecordRef, label: string): void {
  assertText(value?.id, `${label}.id`);
  assertText(value?.revision, `${label}.revision`);
}

function assertDigest(value: string, label: string): void {
  assertText(value, label);
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new TypeError(`${label} must be a SHA-256 digest.`);
}

function assertText(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must not be empty.`);
  }
}

function ref(id: string): EvaluationRecordRef {
  return Object.freeze({ id, revision: HELARC_INCIDENT_ADMISSION_REVISION });
}

function refKey(value: EvaluationRecordRef): string {
  return `${value.id}@${value.revision}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortValue(child)]));
  }
  return value;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
