import type { EvidenceRef } from "@agent-anything/context/evidence";
import {
  createVerificationFailure,
  type VerificationFailure,
  type VerificationOwnerRef,
  type VerificationRequirementRef,
  type VerificationSensitivity,
} from "../definition/index.js";
import type { CheckResultRef } from "../execution/index.js";
import type { VerificationSubjectSnapshotRef } from "../subject/index.js";

export interface VerificationEvidenceRef {
  readonly id: string;
  readonly revision: string;
}

export type VerificationEvidenceSource =
  | { readonly kind: "check_result"; readonly result: CheckResultRef }
  | { readonly kind: "context_evidence"; readonly evidence: EvidenceRef }
  | { readonly kind: "owner_record"; readonly record: VerificationOwnerRef };

export interface VerificationEvidenceCoverage {
  readonly ratio: number;
  readonly basis: string;
}

export type VerificationEvidenceAdmission =
  | { readonly status: "admitted"; readonly failure: null }
  | { readonly status: "rejected"; readonly failure: VerificationFailure };

export interface VerificationEvidence {
  readonly ref: VerificationEvidenceRef;
  readonly requirement: VerificationRequirementRef;
  readonly subject: VerificationSubjectSnapshotRef;
  readonly source: VerificationEvidenceSource;
  readonly admission: VerificationEvidenceAdmission;
  readonly coverage: VerificationEvidenceCoverage;
  readonly sensitivity: VerificationSensitivity;
  readonly audiences: readonly string[];
  readonly limitations: readonly string[];
  readonly createdAt: string;
}

export function snapshotVerificationEvidence(input: VerificationEvidence): VerificationEvidence {
  strictRecord(input, "VerificationEvidence", [
    "ref", "requirement", "subject", "source", "admission", "coverage", "sensitivity",
    "audiences", "limitations", "createdAt",
  ]);
  strictRecord(input.ref, "VerificationEvidence.ref", ["id", "revision"]);
  strictRecord(input.requirement, "VerificationEvidence.requirement", ["id", "revision"]);
  strictRecord(input.subject, "VerificationEvidence.subject", ["id", "revision"]);
  strictRecord(input.source, "VerificationEvidence.source", ["kind", "result", "evidence", "record"]);
  strictRecord(input.admission, "VerificationEvidence.admission", ["status", "failure"]);
  strictRecord(input.coverage, "VerificationEvidence.coverage", ["ratio", "basis"]);
  if (input.admission.status === "admitted" && input.admission.failure !== null) {
    throw new TypeError("Admitted VerificationEvidence cannot carry a Failure.");
  }
  if (input.admission.status === "rejected" && input.admission.failure === null) {
    throw new TypeError("Rejected VerificationEvidence requires VerificationFailure.");
  }
  if (input.admission.status !== "admitted" && input.admission.status !== "rejected") {
    throw new TypeError("VerificationEvidence.admission.status is unsupported.");
  }
  if (!["public", "internal", "confidential", "restricted"].includes(input.sensitivity)) {
    throw new TypeError("VerificationEvidence.sensitivity is unsupported.");
  }
  ratio(input.coverage.ratio, "VerificationEvidence.coverage.ratio");
  return deepFreeze(clone({
    ...input,
    ref: revisionRef(input.ref, "VerificationEvidence.ref"),
    requirement: revisionRef(input.requirement, "VerificationEvidence.requirement"),
    subject: revisionRef(input.subject, "VerificationEvidence.subject"),
    source: snapshotSource(input.source),
    admission: input.admission.status === "admitted"
      ? { status: "admitted", failure: null }
      : { status: "rejected", failure: createVerificationFailure(input.admission.failure) },
    coverage: { ratio: input.coverage.ratio, basis: nonEmpty(input.coverage.basis, "VerificationEvidence.coverage.basis") },
    audiences: tokenList(input.audiences, "VerificationEvidence.audiences", true),
    limitations: textList(input.limitations, "VerificationEvidence.limitations", true),
    createdAt: isoDateTime(input.createdAt, "VerificationEvidence.createdAt"),
  }));
}

function snapshotSource(input: VerificationEvidenceSource): VerificationEvidenceSource {
  switch (input.kind) {
    case "check_result":
      strictRecord(input, "VerificationEvidence.source", ["kind", "result"]);
      return { kind: "check_result", result: revisionRef(input.result, "VerificationEvidence.source.result") };
    case "context_evidence":
      strictRecord(input, "VerificationEvidence.source", ["kind", "evidence"]);
      return { kind: "context_evidence", evidence: token(input.evidence, "VerificationEvidence.source.evidence") };
    case "owner_record":
      strictRecord(input, "VerificationEvidence.source", ["kind", "record"]);
      return { kind: "owner_record", record: ownerRef(input.record, "VerificationEvidence.source.record") };
    default:
      throw new TypeError("VerificationEvidence.source.kind is unsupported.");
  }
}

function ownerRef(input: VerificationOwnerRef, path: string): VerificationOwnerRef {
  strictRecord(input, path, ["owner", "kind", "id", "revision"]);
  return { owner: token(input.owner, `${path}.owner`), kind: token(input.kind, `${path}.kind`),
    id: token(input.id, `${path}.id`), revision: token(input.revision, `${path}.revision`) };
}
function revisionRef(input: { readonly id: string; readonly revision: string }, path: string) {
  strictRecord(input, path, ["id", "revision"]);
  return { id: token(input.id, `${path}.id`), revision: token(input.revision, `${path}.revision`) };
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
function ratio(input: unknown, path: string): number {
  if (typeof input !== "number" || !Number.isFinite(input) || input < 0 || input > 1) throw new TypeError(`${path} must be between 0 and 1.`);
  return input;
}
function isoDateTime(input: unknown, path: string): string {
  if (typeof input !== "string" || Number.isNaN(Date.parse(input)) || new Date(input).toISOString() !== input) throw new TypeError(`${path} must be an ISO date-time.`);
  return input;
}
function tokenList(input: readonly string[], path: string, allowEmpty: boolean): readonly string[] {
  if (!Array.isArray(input) || (!allowEmpty && input.length === 0)) throw new TypeError(`${path} must be an array.`);
  return unique(input.map((item, index) => token(item, `${path}[${index}]`)), path);
}
function textList(input: readonly string[], path: string, allowEmpty: boolean): readonly string[] {
  if (!Array.isArray(input) || (!allowEmpty && input.length === 0)) throw new TypeError(`${path} must be an array.`);
  return unique(input.map((item, index) => nonEmpty(item, `${path}[${index}]`)), path);
}
function unique(input: readonly string[], path: string): readonly string[] {
  if (new Set(input).size !== input.length) throw new TypeError(`${path} must not contain duplicates.`);
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
