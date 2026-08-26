import type { RunRef } from "@agent-anything/agent-core/run";
import type {
  VerificationAssessmentMethodRef,
  VerificationRequirementRef,
  VerificationSpecificationRef,
} from "../definition/index.js";
import type { CheckAttemptRef } from "../execution/index.js";
import type { VerificationEvidenceCoverage, VerificationEvidenceRef } from "../evidence/index.js";
import type { VerificationSubjectSnapshotRef } from "../subject/index.js";

export type VerificationAssessmentVerdict = "satisfied" | "violated" | "inconclusive";

export interface VerificationAssessmentRef {
  readonly id: string;
  readonly revision: string;
}

export interface VerificationAssessment {
  readonly ref: VerificationAssessmentRef;
  readonly requirement: VerificationRequirementRef;
  readonly subject: VerificationSubjectSnapshotRef;
  readonly method: VerificationAssessmentMethodRef;
  readonly evidenceRefs: readonly VerificationEvidenceRef[];
  readonly coverage: VerificationEvidenceCoverage;
  readonly verdict: VerificationAssessmentVerdict;
  readonly basis: string;
  readonly limitations: readonly string[];
  readonly assessedAt: string;
}

interface CurrentRequirementStateBase {
  readonly requirement: VerificationRequirementRef;
  readonly updatedAt: string;
}

export type VerificationCurrentRequirementState =
  | (CurrentRequirementStateBase & {
      readonly status: "unassessed";
      readonly subject: VerificationSubjectSnapshotRef | null;
      readonly assessment: null;
      readonly pendingAttempts: readonly [];
      readonly limitations: readonly string[];
    })
  | (CurrentRequirementStateBase & {
      readonly status: "pending";
      readonly subject: VerificationSubjectSnapshotRef;
      readonly assessment: null;
      readonly pendingAttempts: readonly [CheckAttemptRef, ...CheckAttemptRef[]];
      readonly limitations: readonly string[];
    })
  | (CurrentRequirementStateBase & {
      readonly status: "satisfied" | "violated";
      readonly subject: VerificationSubjectSnapshotRef;
      readonly assessment: VerificationAssessmentRef;
      readonly pendingAttempts: readonly CheckAttemptRef[];
      readonly limitations: readonly string[];
    })
  | (CurrentRequirementStateBase & {
      readonly status: "inconclusive";
      readonly subject: VerificationSubjectSnapshotRef;
      readonly assessment: VerificationAssessmentRef;
      readonly pendingAttempts: readonly CheckAttemptRef[];
      readonly limitations: readonly [string, ...string[]];
    })
  | (CurrentRequirementStateBase & {
      readonly status: "stale";
      readonly subject: VerificationSubjectSnapshotRef;
      readonly assessment: VerificationAssessmentRef | null;
      readonly pendingAttempts: readonly CheckAttemptRef[];
      readonly limitations: readonly [string, ...string[]];
    });

export interface VerificationCurrentSnapshotRef {
  readonly runId: string;
  readonly revision: number;
}

export interface VerificationCurrentSnapshot {
  readonly ref: VerificationCurrentSnapshotRef;
  readonly run: RunRef;
  readonly specification: VerificationSpecificationRef | null;
  readonly requirementStates: readonly VerificationCurrentRequirementState[];
  readonly createdAt: string;
}

export function snapshotVerificationAssessment(input: VerificationAssessment): VerificationAssessment {
  strictRecord(input, "VerificationAssessment", [
    "ref", "requirement", "subject", "method", "evidenceRefs", "verdict", "basis",
    "coverage", "limitations", "assessedAt",
  ]);
  if (!["satisfied", "violated", "inconclusive"].includes(input.verdict)) {
    throw new TypeError("VerificationAssessment.verdict is unsupported.");
  }
  if (input.verdict === "inconclusive" && input.limitations.length === 0) {
    throw new TypeError("An inconclusive VerificationAssessment requires limitations.");
  }
  if (input.evidenceRefs.length === 0) {
    throw new TypeError("VerificationAssessment.evidenceRefs must not be empty.");
  }
  return deepFreeze({
    ...input,
    ref: revisionRef(input.ref, "VerificationAssessment.ref"),
    requirement: revisionRef(input.requirement, "VerificationAssessment.requirement"),
    subject: revisionRef(input.subject, "VerificationAssessment.subject"),
    method: methodRef(input.method),
    evidenceRefs: unique(input.evidenceRefs.map((item, index) => revisionRef(item, `VerificationAssessment.evidenceRefs[${index}]`)),
      (item) => `${item.id}@${item.revision}`, "VerificationAssessment.evidenceRefs"),
    coverage: coverage(input.coverage),
    basis: nonEmpty(input.basis, "VerificationAssessment.basis"),
    limitations: textList(input.limitations, "VerificationAssessment.limitations", true),
    assessedAt: isoDateTime(input.assessedAt, "VerificationAssessment.assessedAt"),
  });
}

export function snapshotVerificationCurrentSnapshot(
  input: VerificationCurrentSnapshot,
): VerificationCurrentSnapshot {
  strictRecord(input, "VerificationCurrentSnapshot", ["ref", "run", "specification", "requirementStates", "createdAt"]);
  strictRecord(input.ref, "VerificationCurrentSnapshot.ref", ["runId", "revision"]);
  strictRecord(input.run, "VerificationCurrentSnapshot.run", ["id"]);
  if (input.ref.runId !== input.run.id) throw new TypeError("VerificationCurrentSnapshot ref and Run must match.");
  if (!Number.isSafeInteger(input.ref.revision) || input.ref.revision < 0) throw new TypeError("VerificationCurrentSnapshot.ref.revision must be non-negative.");
  return deepFreeze({
    ref: { runId: token(input.ref.runId, "VerificationCurrentSnapshot.ref.runId"), revision: input.ref.revision },
    run: { id: token(input.run.id, "VerificationCurrentSnapshot.run.id") },
    specification: input.specification === null ? null : revisionRef(input.specification, "VerificationCurrentSnapshot.specification"),
    requirementStates: unique(input.requirementStates.map((state, index) => snapshotCurrentState(
      state,
      `VerificationCurrentSnapshot.requirementStates[${index}]`,
    )), (state) => `${state.requirement.id}@${state.requirement.revision}`, "VerificationCurrentSnapshot.requirementStates"),
    createdAt: isoDateTime(input.createdAt, "VerificationCurrentSnapshot.createdAt"),
  });
}

export function snapshotVerificationCurrentRequirementState(
  input: VerificationCurrentRequirementState,
): VerificationCurrentRequirementState {
  return deepFreeze(snapshotCurrentState(input, "VerificationCurrentRequirementState"));
}

function snapshotCurrentState(input: VerificationCurrentRequirementState, path: string): VerificationCurrentRequirementState {
  strictRecord(input, path, ["requirement", "status", "subject", "assessment", "pendingAttempts", "limitations", "updatedAt"]);
  if (!["unassessed", "pending", "satisfied", "violated", "inconclusive", "stale"].includes(input.status)) {
    throw new TypeError(`${path}.status is unsupported.`);
  }
  const requirement = revisionRef(input.requirement, `${path}.requirement`);
  const subject = input.subject === null ? null : revisionRef(input.subject, `${path}.subject`);
  const assessment = input.assessment === null ? null : revisionRef(input.assessment, `${path}.assessment`);
  const pendingAttempts = unique(input.pendingAttempts.map((item, index) => attemptRef(item, `${path}.pendingAttempts[${index}]`)),
    (item) => `${item.id}#${item.ordinal}`, `${path}.pendingAttempts`);
  const limitations = textList(input.limitations, `${path}.limitations`, true);
  if (input.status === "unassessed" && (assessment !== null || pendingAttempts.length > 0)) {
    throw new TypeError("An unassessed state cannot carry Assessment or pending work.");
  }
  if (input.status === "pending" && (subject === null || assessment !== null || pendingAttempts.length === 0)) {
    throw new TypeError("A pending state requires a subject and active work without a current Assessment.");
  }
  if ((input.status === "satisfied" || input.status === "violated") && (subject === null || assessment === null)) {
    throw new TypeError(`${input.status} state requires current subject and Assessment refs.`);
  }
  if (input.status === "inconclusive" && (subject === null || assessment === null || limitations.length === 0)) {
    throw new TypeError("An inconclusive state requires subject, Assessment, and limitations.");
  }
  if (input.status === "stale" && (subject === null || limitations.length === 0)) {
    throw new TypeError("A stale state requires prior subject and staleness limitations.");
  }
  return {
    ...input,
    requirement,
    subject,
    assessment,
    pendingAttempts,
    limitations,
    updatedAt: isoDateTime(input.updatedAt, `${path}.updatedAt`),
  } as VerificationCurrentRequirementState;
}

function methodRef(input: VerificationAssessment["method"]): VerificationAssessment["method"] {
  strictRecord(input, "VerificationAssessment.method", ["owner", "kind", "id", "revision"]);
  return {
    owner: token(input.owner, "VerificationAssessment.method.owner"),
    kind: token(input.kind, "VerificationAssessment.method.kind"),
    id: token(input.id, "VerificationAssessment.method.id"),
    revision: token(input.revision, "VerificationAssessment.method.revision"),
  };
}
function coverage(input: VerificationEvidenceCoverage): VerificationEvidenceCoverage {
  strictRecord(input, "VerificationAssessment.coverage", ["ratio", "basis"]);
  if (typeof input.ratio !== "number" || !Number.isFinite(input.ratio) || input.ratio < 0 || input.ratio > 1) {
    throw new TypeError("VerificationAssessment.coverage.ratio must be between 0 and 1.");
  }
  return {
    ratio: input.ratio,
    basis: nonEmpty(input.basis, "VerificationAssessment.coverage.basis"),
  };
}
function revisionRef(input: { readonly id: string; readonly revision: string }, path: string) {
  strictRecord(input, path, ["id", "revision"]);
  return { id: token(input.id, `${path}.id`), revision: token(input.revision, `${path}.revision`) };
}
function attemptRef(input: CheckAttemptRef, path: string): CheckAttemptRef {
  strictRecord(input, path, ["id", "ordinal"]);
  if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 1) throw new TypeError(`${path}.ordinal must be positive.`);
  return { id: token(input.id, `${path}.id`), ordinal: input.ordinal };
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
function nonEmpty(input: unknown, path: string): string {
  if (typeof input !== "string" || input.trim().length === 0) throw new TypeError(`${path} is required.`);
  return input;
}
function isoDateTime(input: unknown, path: string): string {
  if (typeof input !== "string" || Number.isNaN(Date.parse(input)) || new Date(input).toISOString() !== input) throw new TypeError(`${path} must be an ISO date-time.`);
  return input;
}
function textList(input: readonly string[], path: string, allowEmpty: boolean): readonly string[] {
  if (!Array.isArray(input) || (!allowEmpty && input.length === 0)) throw new TypeError(`${path} must be an array.`);
  return unique(input.map((item, index) => nonEmpty(item, `${path}[${index}]`)), (item) => item, path);
}
function unique<T>(input: readonly T[], key: (item: T) => string, path: string): readonly T[] {
  const keys = input.map(key);
  if (new Set(keys).size !== keys.length) throw new TypeError(`${path} must not contain duplicates.`);
  return [...input];
}
function deepFreeze<T>(input: T): T {
  if (input !== null && typeof input === "object" && !Object.isFrozen(input)) {
    for (const value of Object.values(input as Record<string, unknown>)) deepFreeze(value);
    Object.freeze(input);
  }
  return input;
}
