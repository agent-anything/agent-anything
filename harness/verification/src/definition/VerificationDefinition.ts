import type { RunRef } from "@agent-anything/agent-core/run";

export type VerificationTrustedSourceKind =
  | "product_configuration"
  | "run_invocation"
  | "task_contract"
  | "authenticated_host"
  | "project_policy"
  | "trusted_workflow";

export type VerificationNecessity = "mandatory" | "advisory";
export type VerificationCompletionDisposition = "continue" | "wait" | "block" | "fail";
export type VerificationSensitivity =
  | "public"
  | "internal"
  | "confidential"
  | "restricted";

export interface VerificationSpecificationRef {
  readonly id: string;
  readonly revision: string;
}

export interface VerificationRequirementRef {
  readonly id: string;
  readonly revision: string;
}

export interface VerificationOwnerRef {
  readonly owner: string;
  readonly kind: string;
  readonly id: string;
  readonly revision: string;
}

export interface VerificationTrustedSourceRef extends VerificationOwnerRef {
  readonly sourceKind: VerificationTrustedSourceKind;
}

export type VerificationFailureStage =
  | "admission"
  | "subject"
  | "check"
  | "evidence"
  | "assessment"
  | "completion_gate"
  | "projection"
  | "persistence";

export interface VerificationFailure {
  readonly code: `verification_${string}`;
  readonly stage: VerificationFailureStage;
  readonly message: string;
  readonly retryable: boolean;
  readonly cause: VerificationOwnerRef | null;
}

export interface VerificationSpecification {
  readonly ref: VerificationSpecificationRef;
  readonly run: RunRef;
  readonly source: VerificationTrustedSourceRef;
  readonly requirementRefs: readonly VerificationRequirementRef[];
  readonly supersedes: VerificationSpecificationRef | null;
  readonly admittedBy: VerificationOwnerRef;
  readonly createdAt: string;
}

export interface VerificationAssessmentMethodRef extends VerificationOwnerRef {}

export interface VerificationRequirementFreshnessPolicy {
  readonly required: boolean;
  readonly maximumAgeMs: number | null;
}

export interface VerificationRequirementCoveragePolicy {
  readonly kind: "complete" | "minimum";
  readonly minimumRatio: number;
}

export interface VerificationEvidencePolicy {
  readonly minimumAdmittedCount: number;
  readonly acceptedSourceKinds: readonly string[];
  readonly conflictingEvidence: "inconclusive" | "violated";
}

export interface VerificationRequirementLimits {
  readonly maximumAttempts: number;
  readonly maximumDurationMs: number;
  readonly maximumCostUnits: number | null;
}

export interface VerificationDisclosurePolicy {
  readonly sensitivity: VerificationSensitivity;
  readonly audiences: readonly string[];
}

export interface VerificationCompletionHandling {
  readonly unassessed: VerificationCompletionDisposition;
  readonly pending: VerificationCompletionDisposition;
  readonly violated: VerificationCompletionDisposition;
  readonly inconclusive: VerificationCompletionDisposition;
  readonly stale: VerificationCompletionDisposition;
}

export interface VerificationRequirement {
  readonly ref: VerificationRequirementRef;
  readonly specification: VerificationSpecificationRef;
  readonly source: VerificationTrustedSourceRef;
  readonly kind: string;
  readonly claim: string;
  readonly purpose: string;
  readonly necessity: VerificationNecessity;
  readonly subjectKinds: readonly string[];
  readonly checkFamilies: readonly string[];
  readonly assessmentMethod: VerificationAssessmentMethodRef;
  readonly freshness: VerificationRequirementFreshnessPolicy;
  readonly coverage: VerificationRequirementCoveragePolicy;
  readonly evidence: VerificationEvidencePolicy;
  readonly limits: VerificationRequirementLimits;
  readonly disclosure: VerificationDisclosurePolicy;
  readonly completionHandling: VerificationCompletionHandling;
  readonly createdAt: string;
}

export function createVerificationFailure(input: VerificationFailure): VerificationFailure {
  strictRecord(input, "VerificationFailure", ["code", "stage", "message", "retryable", "cause"]);
  token(input.code, "VerificationFailure.code");
  if (!input.code.startsWith("verification_")) {
    throw new TypeError("VerificationFailure.code must use the verification_ owner prefix.");
  }
  oneOf(input.stage, VALIDATION_FAILURE_STAGES, "VerificationFailure.stage");
  text(input.message, "VerificationFailure.message");
  if (typeof input.retryable !== "boolean") {
    throw new TypeError("VerificationFailure.retryable must be boolean.");
  }
  return deepFreeze({
    ...input,
    cause: input.cause === null ? null : snapshotOwnerRef(input.cause, "VerificationFailure.cause"),
  });
}

export function snapshotVerificationSpecification(
  input: VerificationSpecification,
): VerificationSpecification {
  strictRecord(input, "VerificationSpecification", [
    "ref", "run", "source", "requirementRefs", "supersedes", "admittedBy", "createdAt",
  ]);
  const ref = snapshotSpecificationRef(input.ref, "VerificationSpecification.ref");
  const requirementRefs = uniqueList(
    input.requirementRefs.map((item, index) =>
      snapshotRequirementRef(item, `VerificationSpecification.requirementRefs[${index}]`)),
    (item) => `${item.id}@${item.revision}`,
    "VerificationSpecification.requirementRefs",
  );
  return deepFreeze({
    ref,
    run: snapshotRunRef(input.run, "VerificationSpecification.run"),
    source: snapshotSourceRef(input.source, "VerificationSpecification.source"),
    requirementRefs,
    supersedes: input.supersedes === null
      ? null
      : snapshotSpecificationRef(input.supersedes, "VerificationSpecification.supersedes"),
    admittedBy: snapshotOwnerRef(input.admittedBy, "VerificationSpecification.admittedBy"),
    createdAt: isoDateTime(input.createdAt, "VerificationSpecification.createdAt"),
  });
}

export function snapshotVerificationRequirement(
  input: VerificationRequirement,
): VerificationRequirement {
  strictRecord(input, "VerificationRequirement", [
    "ref", "specification", "source", "kind", "claim", "purpose", "necessity", "subjectKinds",
    "checkFamilies", "assessmentMethod", "freshness", "coverage", "evidence", "limits",
    "disclosure", "completionHandling", "createdAt",
  ]);
  oneOf(input.necessity, ["mandatory", "advisory"] as const, "VerificationRequirement.necessity");
  strictRecord(input.freshness, "VerificationRequirement.freshness", ["required", "maximumAgeMs"]);
  strictRecord(input.coverage, "VerificationRequirement.coverage", ["kind", "minimumRatio"]);
  strictRecord(input.evidence, "VerificationRequirement.evidence", [
    "minimumAdmittedCount", "acceptedSourceKinds", "conflictingEvidence",
  ]);
  strictRecord(input.limits, "VerificationRequirement.limits", [
    "maximumAttempts", "maximumDurationMs", "maximumCostUnits",
  ]);
  strictRecord(input.disclosure, "VerificationRequirement.disclosure", ["sensitivity", "audiences"]);
  strictRecord(input.completionHandling, "VerificationRequirement.completionHandling", [
    "unassessed", "pending", "violated", "inconclusive", "stale",
  ]);
  oneOf(input.coverage.kind, ["complete", "minimum"] as const, "VerificationRequirement.coverage.kind");
  ratio(input.coverage.minimumRatio, "VerificationRequirement.coverage.minimumRatio");
  if (input.coverage.kind === "complete" && input.coverage.minimumRatio !== 1) {
    throw new TypeError("Complete Verification coverage requires minimumRatio 1.");
  }
  if (typeof input.freshness.required !== "boolean") {
    throw new TypeError("VerificationRequirement.freshness.required must be boolean.");
  }
  nullablePositiveInteger(input.freshness.maximumAgeMs, "VerificationRequirement.freshness.maximumAgeMs");
  nonNegativeInteger(input.evidence.minimumAdmittedCount, "VerificationRequirement.evidence.minimumAdmittedCount");
  oneOf(input.evidence.conflictingEvidence, ["inconclusive", "violated"] as const,
    "VerificationRequirement.evidence.conflictingEvidence");
  positiveInteger(input.limits.maximumAttempts, "VerificationRequirement.limits.maximumAttempts");
  positiveInteger(input.limits.maximumDurationMs, "VerificationRequirement.limits.maximumDurationMs");
  nullablePositiveNumber(input.limits.maximumCostUnits, "VerificationRequirement.limits.maximumCostUnits");
  oneOf(input.disclosure.sensitivity,
    ["public", "internal", "confidential", "restricted"] as const,
    "VerificationRequirement.disclosure.sensitivity");
  for (const [key, value] of Object.entries(input.completionHandling)) {
    oneOf(value, ["continue", "wait", "block", "fail"] as const,
      `VerificationRequirement.completionHandling.${key}`);
  }
  return deepFreeze({
    ...input,
    ref: snapshotRequirementRef(input.ref, "VerificationRequirement.ref"),
    specification: snapshotSpecificationRef(input.specification, "VerificationRequirement.specification"),
    source: snapshotSourceRef(input.source, "VerificationRequirement.source"),
    kind: token(input.kind, "VerificationRequirement.kind"),
    claim: text(input.claim, "VerificationRequirement.claim"),
    purpose: text(input.purpose, "VerificationRequirement.purpose"),
    subjectKinds: tokenList(input.subjectKinds, "VerificationRequirement.subjectKinds"),
    checkFamilies: tokenList(input.checkFamilies, "VerificationRequirement.checkFamilies"),
    assessmentMethod: snapshotOwnerRef(input.assessmentMethod, "VerificationRequirement.assessmentMethod"),
    evidence: {
      ...input.evidence,
      acceptedSourceKinds: tokenList(
        input.evidence.acceptedSourceKinds,
        "VerificationRequirement.evidence.acceptedSourceKinds",
      ),
    },
    disclosure: {
      ...input.disclosure,
      audiences: tokenList(input.disclosure.audiences, "VerificationRequirement.disclosure.audiences"),
    },
    createdAt: isoDateTime(input.createdAt, "VerificationRequirement.createdAt"),
  });
}

const VALIDATION_FAILURE_STAGES: readonly VerificationFailureStage[] = [
  "admission", "subject", "check", "evidence", "assessment", "completion_gate",
  "projection", "persistence",
];

function snapshotSpecificationRef(input: VerificationSpecificationRef, path: string) {
  strictRecord(input, path, ["id", "revision"]);
  return { id: token(input.id, `${path}.id`), revision: token(input.revision, `${path}.revision`) };
}

function snapshotRequirementRef(input: VerificationRequirementRef, path: string) {
  strictRecord(input, path, ["id", "revision"]);
  return { id: token(input.id, `${path}.id`), revision: token(input.revision, `${path}.revision`) };
}

function snapshotOwnerRef(input: VerificationOwnerRef, path: string): VerificationOwnerRef {
  strictRecord(input, path, ["owner", "kind", "id", "revision"]);
  return {
    owner: token(input.owner, `${path}.owner`),
    kind: token(input.kind, `${path}.kind`),
    id: token(input.id, `${path}.id`),
    revision: token(input.revision, `${path}.revision`),
  };
}

function snapshotSourceRef(input: VerificationTrustedSourceRef, path: string): VerificationTrustedSourceRef {
  strictRecord(input, path, ["owner", "kind", "id", "revision", "sourceKind"]);
  oneOf(input.sourceKind, [
    "product_configuration", "run_invocation", "task_contract", "authenticated_host",
    "project_policy", "trusted_workflow",
  ] as const, `${path}.sourceKind`);
  return {
    owner: token(input.owner, `${path}.owner`),
    kind: token(input.kind, `${path}.kind`),
    id: token(input.id, `${path}.id`),
    revision: token(input.revision, `${path}.revision`),
    sourceKind: input.sourceKind,
  };
}

function snapshotRunRef(input: RunRef, path: string): RunRef {
  strictRecord(input, path, ["id"]);
  return { id: token(input.id, `${path}.id`) };
}

function strictRecord(input: unknown, path: string, keys: readonly string[]): asserts input is Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(`${path} must be a record.`);
  }
  const unknown = Object.keys(input).filter((key) => !keys.includes(key));
  if (unknown.length > 0) throw new TypeError(`${path} contains unsupported field '${unknown[0]}'.`);
}

function token(input: unknown, path: string): string {
  if (typeof input !== "string" || input.length === 0 || input !== input.trim() || /\s/.test(input)) {
    throw new TypeError(`${path} must be a canonical token.`);
  }
  return input;
}

function text(input: unknown, path: string): string {
  if (typeof input !== "string" || input.trim().length === 0) throw new TypeError(`${path} is required.`);
  return input;
}

function tokenList(input: readonly string[], path: string): readonly string[] {
  if (!Array.isArray(input) || input.length === 0) throw new TypeError(`${path} must not be empty.`);
  return uniqueList(input.map((item, index) => token(item, `${path}[${index}]`)), (item) => item, path);
}

function uniqueList<T>(input: readonly T[], key: (item: T) => string, path: string): readonly T[] {
  const keys = input.map(key);
  if (new Set(keys).size !== keys.length) throw new TypeError(`${path} must not contain duplicates.`);
  return [...input];
}

function oneOf<T extends string>(input: unknown, values: readonly T[], path: string): asserts input is T {
  if (!values.includes(input as T)) throw new TypeError(`${path} is unsupported.`);
}

function positiveInteger(input: unknown, path: string): number {
  if (!Number.isSafeInteger(input) || (input as number) < 1) throw new TypeError(`${path} must be a positive integer.`);
  return input as number;
}

function nonNegativeInteger(input: unknown, path: string): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) throw new TypeError(`${path} must be a non-negative integer.`);
  return input as number;
}

function nullablePositiveInteger(input: unknown, path: string): number | null {
  return input === null ? null : positiveInteger(input, path);
}

function nullablePositiveNumber(input: unknown, path: string): number | null {
  if (input === null) return null;
  if (typeof input !== "number" || !Number.isFinite(input) || input <= 0) {
    throw new TypeError(`${path} must be a positive finite number or null.`);
  }
  return input;
}

function ratio(input: unknown, path: string): number {
  if (typeof input !== "number" || !Number.isFinite(input) || input < 0 || input > 1) {
    throw new TypeError(`${path} must be between 0 and 1.`);
  }
  return input;
}

function isoDateTime(input: unknown, path: string): string {
  if (typeof input !== "string" || Number.isNaN(Date.parse(input)) || new Date(input).toISOString() !== input) {
    throw new TypeError(`${path} must be an ISO date-time.`);
  }
  return input;
}

function deepFreeze<T>(input: T): T {
  if (input !== null && typeof input === "object" && !Object.isFrozen(input)) {
    for (const value of Object.values(input as Record<string, unknown>)) deepFreeze(value);
    Object.freeze(input);
  }
  return input;
}
