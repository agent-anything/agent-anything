import type { ContextContribution } from "@agent-anything/context/contribution";
import type { VerificationAssessmentVerdict, VerificationCurrentSnapshotRef } from "../assessment/index.js";
import type { CompletionGateDecisionStatus, CompletionGateInvocationRef } from "../completion/index.js";
import type { VerificationRequirementRef } from "../definition/index.js";
import type { CheckAttemptRef, CheckResultStatus } from "../execution/index.js";

export interface VerificationStateCount {
  readonly state: "unassessed" | "pending" | "satisfied" | "violated" | "inconclusive" | "stale";
  readonly count: number;
}

export interface VerificationRunnerFeedback {
  readonly snapshot: VerificationCurrentSnapshotRef;
  readonly requirement: VerificationRequirementRef;
  readonly state: VerificationStateCount["state"];
  readonly code: string;
  readonly message: string;
  readonly recoveryNeeded: boolean;
}

export interface VerificationRunnerProjection {
  readonly snapshot: VerificationCurrentSnapshotRef;
  readonly feedback: readonly VerificationRunnerFeedback[];
  readonly pendingAttempts: readonly CheckAttemptRef[];
  readonly gate: CompletionGateInvocationRef | null;
}

export interface VerificationContextProjection {
  readonly snapshot: VerificationCurrentSnapshotRef;
  readonly contribution: ContextContribution | null;
}

export interface VerificationHostProjection {
  readonly snapshot: VerificationCurrentSnapshotRef;
  readonly counts: readonly VerificationStateCount[];
  readonly activeChecks: number;
  readonly gateStatus: CompletionGateDecisionStatus | null;
  readonly safeReasons: readonly string[];
  readonly updatedAt: string;
}

export interface VerificationObservabilityProjection {
  readonly snapshot: VerificationCurrentSnapshotRef;
  readonly checkStatus: CheckResultStatus | null;
  readonly safeCode: string | null;
  readonly durationMs: number | null;
  readonly coverageRatio: number | null;
  readonly emittedAt: string;
}

export interface VerificationEvaluationProjection {
  readonly snapshot: VerificationCurrentSnapshotRef;
  readonly checkStatus: CheckResultStatus | null;
  readonly assessmentVerdict: VerificationAssessmentVerdict | null;
  readonly gateStatus: CompletionGateDecisionStatus | null;
  readonly latencyMs: number | null;
  readonly costUnits: number | null;
  readonly failureOwner: string | null;
}

export function snapshotVerificationRunnerProjection(input: VerificationRunnerProjection): VerificationRunnerProjection {
  strictRecord(input, "VerificationRunnerProjection", ["snapshot", "feedback", "pendingAttempts", "gate"]);
  const snapshot = snapshotRef(input.snapshot, "VerificationRunnerProjection.snapshot");
  return deepFreeze({
    snapshot,
    feedback: input.feedback.map((item, index) => {
      const path = `VerificationRunnerProjection.feedback[${index}]`;
      strictRecord(item, path, ["snapshot", "requirement", "state", "code", "message", "recoveryNeeded"]);
      if (snapshotKey(item.snapshot) !== snapshotKey(snapshot)) throw new TypeError(`${path}.snapshot must match the Projection snapshot.`);
      if (!STATES.includes(item.state)) throw new TypeError(`${path}.state is unsupported.`);
      if (typeof item.recoveryNeeded !== "boolean") throw new TypeError(`${path}.recoveryNeeded must be boolean.`);
      return {
        snapshot: snapshotRef(item.snapshot, `${path}.snapshot`),
        requirement: revisionRef(item.requirement, `${path}.requirement`),
        state: item.state,
        code: token(item.code, `${path}.code`),
        message: text(item.message, `${path}.message`),
        recoveryNeeded: item.recoveryNeeded,
      };
    }),
    pendingAttempts: input.pendingAttempts.map((item, index) => attemptRef(item, `VerificationRunnerProjection.pendingAttempts[${index}]`)),
    gate: input.gate === null ? null : revisionRef(input.gate, "VerificationRunnerProjection.gate"),
  });
}
export function snapshotVerificationContextProjection(input: VerificationContextProjection): VerificationContextProjection {
  strictRecord(input, "VerificationContextProjection", ["snapshot", "contribution"]);
  return deepFreeze({
    snapshot: snapshotRef(input.snapshot, "VerificationContextProjection.snapshot"),
    contribution: input.contribution === null ? null : clone(input.contribution),
  });
}
export function snapshotVerificationHostProjection(input: VerificationHostProjection): VerificationHostProjection {
  strictRecord(input, "VerificationHostProjection", [
    "snapshot", "counts", "activeChecks", "gateStatus", "safeReasons", "updatedAt",
  ]);
  return deepFreeze({
    snapshot: snapshotRef(input.snapshot, "VerificationHostProjection.snapshot"),
    counts: unique(input.counts.map((item, index) => {
      const path = `VerificationHostProjection.counts[${index}]`;
      strictRecord(item, path, ["state", "count"]);
      if (!STATES.includes(item.state)) throw new TypeError(`${path}.state is unsupported.`);
      return { state: item.state, count: nonNegative(item.count, `${path}.count`) };
    }), (item) => item.state, "VerificationHostProjection.counts"),
    activeChecks: nonNegative(input.activeChecks, "VerificationHostProjection.activeChecks"),
    gateStatus: nullableGateStatus(input.gateStatus, "VerificationHostProjection.gateStatus"),
    safeReasons: input.safeReasons.map((item, index) => text(item, `VerificationHostProjection.safeReasons[${index}]`)),
    updatedAt: isoDateTime(input.updatedAt, "VerificationHostProjection.updatedAt"),
  });
}
export function snapshotVerificationObservabilityProjection(input: VerificationObservabilityProjection): VerificationObservabilityProjection {
  strictRecord(input, "VerificationObservabilityProjection", [
    "snapshot", "checkStatus", "safeCode", "durationMs", "coverageRatio", "emittedAt",
  ]);
  return deepFreeze({
    snapshot: snapshotRef(input.snapshot, "VerificationObservabilityProjection.snapshot"),
    checkStatus: nullableCheckStatus(input.checkStatus, "VerificationObservabilityProjection.checkStatus"),
    safeCode: input.safeCode === null ? null : token(input.safeCode, "VerificationObservabilityProjection.safeCode"),
    durationMs: nullableNonNegative(input.durationMs, "VerificationObservabilityProjection.durationMs"),
    coverageRatio: nullableRatio(input.coverageRatio, "VerificationObservabilityProjection.coverageRatio"),
    emittedAt: isoDateTime(input.emittedAt, "VerificationObservabilityProjection.emittedAt"),
  });
}
export function snapshotVerificationEvaluationProjection(input: VerificationEvaluationProjection): VerificationEvaluationProjection {
  strictRecord(input, "VerificationEvaluationProjection", [
    "snapshot", "checkStatus", "assessmentVerdict", "gateStatus", "latencyMs", "costUnits", "failureOwner",
  ]);
  if (input.assessmentVerdict !== null && !ASSESSMENT_VERDICTS.includes(input.assessmentVerdict)) {
    throw new TypeError("VerificationEvaluationProjection.assessmentVerdict is unsupported.");
  }
  return deepFreeze({
    snapshot: snapshotRef(input.snapshot, "VerificationEvaluationProjection.snapshot"),
    checkStatus: nullableCheckStatus(input.checkStatus, "VerificationEvaluationProjection.checkStatus"),
    assessmentVerdict: input.assessmentVerdict,
    gateStatus: nullableGateStatus(input.gateStatus, "VerificationEvaluationProjection.gateStatus"),
    latencyMs: nullableNonNegative(input.latencyMs, "VerificationEvaluationProjection.latencyMs"),
    costUnits: nullableNonNegative(input.costUnits, "VerificationEvaluationProjection.costUnits"),
    failureOwner: input.failureOwner === null ? null : token(input.failureOwner, "VerificationEvaluationProjection.failureOwner"),
  });
}

const STATES: readonly VerificationStateCount["state"][] = [
  "unassessed", "pending", "satisfied", "violated", "inconclusive", "stale",
];
const CHECK_STATUSES: readonly CheckResultStatus[] = [
  "invalid", "unavailable", "denied", "cancelled", "timed_out", "failed", "partial", "completed",
];
const GATE_STATUSES: readonly CompletionGateDecisionStatus[] = [
  "completion_eligible", "blocked_unassessed", "blocked_pending", "blocked_stale",
  "blocked_violated", "blocked_inconclusive", "invalid", "failed",
];
const ASSESSMENT_VERDICTS: readonly VerificationAssessmentVerdict[] = ["satisfied", "violated", "inconclusive"];

function snapshotRef(input: VerificationCurrentSnapshotRef, path: string): VerificationCurrentSnapshotRef {
  strictRecord(input, path, ["runId", "revision"]);
  return { runId: token(input.runId, `${path}.runId`), revision: nonNegative(input.revision, `${path}.revision`) };
}
function snapshotKey(input: VerificationCurrentSnapshotRef): string { return `${input.runId}#${input.revision}`; }
function revisionRef(input: { readonly id: string; readonly revision: string }, path: string) {
  strictRecord(input, path, ["id", "revision"]);
  return { id: token(input.id, `${path}.id`), revision: token(input.revision, `${path}.revision`) };
}
function attemptRef(input: CheckAttemptRef, path: string): CheckAttemptRef {
  strictRecord(input, path, ["id", "ordinal"]);
  if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 1) throw new TypeError(`${path}.ordinal must be positive.`);
  return { id: token(input.id, `${path}.id`), ordinal: input.ordinal };
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
function nullableRatio(input: number | null, path: string): number | null {
  if (input === null) return null;
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
