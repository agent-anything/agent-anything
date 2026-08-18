import type { RunRef } from "@agent-anything/agent-core/run";

export type ValidationTrustedSourceKind =
  | "product_configuration"
  | "run_invocation"
  | "task_contract"
  | "authenticated_host"
  | "project_policy"
  | "trusted_workflow";

export type ValidationNecessity = "mandatory" | "advisory";
export type ValidationCompletionDisposition = "continue" | "wait" | "block" | "fail";
export type ValidationSensitivity =
  | "public"
  | "internal"
  | "confidential"
  | "restricted";

export interface ValidationSpecificationRef {
  readonly id: string;
  readonly revision: string;
}

export interface ValidationRequirementRef {
  readonly id: string;
  readonly revision: string;
}

export interface ValidationOwnerRef {
  readonly owner: string;
  readonly kind: string;
  readonly id: string;
  readonly revision: string;
}

export interface ValidationTrustedSourceRef extends ValidationOwnerRef {
  readonly sourceKind: ValidationTrustedSourceKind;
}

export type ValidationFailureStage =
  | "admission"
  | "subject"
  | "check"
  | "evidence"
  | "assessment"
  | "completion_gate"
  | "projection"
  | "persistence";

export interface ValidationFailure {
  readonly code: `validation_${string}`;
  readonly stage: ValidationFailureStage;
  readonly message: string;
  readonly retryable: boolean;
  readonly cause: ValidationOwnerRef | null;
}

export interface ValidationSpecification {
  readonly ref: ValidationSpecificationRef;
  readonly run: RunRef;
  readonly source: ValidationTrustedSourceRef;
  readonly requirementRefs: readonly ValidationRequirementRef[];
  readonly supersedes: ValidationSpecificationRef | null;
  readonly admittedBy: ValidationOwnerRef;
  readonly createdAt: string;
}

export interface ValidationAssessmentMethodRef extends ValidationOwnerRef {}

export interface ValidationRequirementFreshnessPolicy {
  readonly required: boolean;
  readonly maximumAgeMs: number | null;
}

export interface ValidationRequirementCoveragePolicy {
  readonly kind: "complete" | "minimum";
  readonly minimumRatio: number;
}

export interface ValidationEvidencePolicy {
  readonly minimumAdmittedCount: number;
  readonly acceptedSourceKinds: readonly string[];
  readonly conflictingEvidence: "inconclusive" | "violated";
}

export interface ValidationRequirementLimits {
  readonly maximumAttempts: number;
  readonly maximumDurationMs: number;
  readonly maximumCostUnits: number | null;
}

export interface ValidationDisclosurePolicy {
  readonly sensitivity: ValidationSensitivity;
  readonly audiences: readonly string[];
}

export interface ValidationCompletionHandling {
  readonly unassessed: ValidationCompletionDisposition;
  readonly pending: ValidationCompletionDisposition;
  readonly violated: ValidationCompletionDisposition;
  readonly inconclusive: ValidationCompletionDisposition;
  readonly stale: ValidationCompletionDisposition;
}

export interface ValidationRequirement {
  readonly ref: ValidationRequirementRef;
  readonly specification: ValidationSpecificationRef;
  readonly source: ValidationTrustedSourceRef;
  readonly claim: string;
  readonly purpose: string;
  readonly necessity: ValidationNecessity;
  readonly subjectKinds: readonly string[];
  readonly checkFamilies: readonly string[];
  readonly assessmentMethod: ValidationAssessmentMethodRef;
  readonly freshness: ValidationRequirementFreshnessPolicy;
  readonly coverage: ValidationRequirementCoveragePolicy;
  readonly evidence: ValidationEvidencePolicy;
  readonly limits: ValidationRequirementLimits;
  readonly disclosure: ValidationDisclosurePolicy;
  readonly completionHandling: ValidationCompletionHandling;
  readonly createdAt: string;
}

export function createValidationFailure(input: ValidationFailure): ValidationFailure {
  strictRecord(input, "ValidationFailure", ["code", "stage", "message", "retryable", "cause"]);
  token(input.code, "ValidationFailure.code");
  if (!input.code.startsWith("validation_")) {
    throw new TypeError("ValidationFailure.code must use the validation_ owner prefix.");
  }
  oneOf(input.stage, VALIDATION_FAILURE_STAGES, "ValidationFailure.stage");
  text(input.message, "ValidationFailure.message");
  if (typeof input.retryable !== "boolean") {
    throw new TypeError("ValidationFailure.retryable must be boolean.");
  }
  return deepFreeze({
    ...input,
    cause: input.cause === null ? null : snapshotOwnerRef(input.cause, "ValidationFailure.cause"),
  });
}

export function snapshotValidationSpecification(
  input: ValidationSpecification,
): ValidationSpecification {
  strictRecord(input, "ValidationSpecification", [
    "ref", "run", "source", "requirementRefs", "supersedes", "admittedBy", "createdAt",
  ]);
  const ref = snapshotSpecificationRef(input.ref, "ValidationSpecification.ref");
  const requirementRefs = uniqueList(
    input.requirementRefs.map((item, index) =>
      snapshotRequirementRef(item, `ValidationSpecification.requirementRefs[${index}]`)),
    (item) => `${item.id}@${item.revision}`,
    "ValidationSpecification.requirementRefs",
  );
  return deepFreeze({
    ref,
    run: snapshotRunRef(input.run, "ValidationSpecification.run"),
    source: snapshotSourceRef(input.source, "ValidationSpecification.source"),
    requirementRefs,
    supersedes: input.supersedes === null
      ? null
      : snapshotSpecificationRef(input.supersedes, "ValidationSpecification.supersedes"),
    admittedBy: snapshotOwnerRef(input.admittedBy, "ValidationSpecification.admittedBy"),
    createdAt: isoDateTime(input.createdAt, "ValidationSpecification.createdAt"),
  });
}

export function snapshotValidationRequirement(
  input: ValidationRequirement,
): ValidationRequirement {
  strictRecord(input, "ValidationRequirement", [
    "ref", "specification", "source", "claim", "purpose", "necessity", "subjectKinds",
    "checkFamilies", "assessmentMethod", "freshness", "coverage", "evidence", "limits",
    "disclosure", "completionHandling", "createdAt",
  ]);
  oneOf(input.necessity, ["mandatory", "advisory"] as const, "ValidationRequirement.necessity");
  strictRecord(input.freshness, "ValidationRequirement.freshness", ["required", "maximumAgeMs"]);
  strictRecord(input.coverage, "ValidationRequirement.coverage", ["kind", "minimumRatio"]);
  strictRecord(input.evidence, "ValidationRequirement.evidence", [
    "minimumAdmittedCount", "acceptedSourceKinds", "conflictingEvidence",
  ]);
  strictRecord(input.limits, "ValidationRequirement.limits", [
    "maximumAttempts", "maximumDurationMs", "maximumCostUnits",
  ]);
  strictRecord(input.disclosure, "ValidationRequirement.disclosure", ["sensitivity", "audiences"]);
  strictRecord(input.completionHandling, "ValidationRequirement.completionHandling", [
    "unassessed", "pending", "violated", "inconclusive", "stale",
  ]);
  oneOf(input.coverage.kind, ["complete", "minimum"] as const, "ValidationRequirement.coverage.kind");
  ratio(input.coverage.minimumRatio, "ValidationRequirement.coverage.minimumRatio");
  if (input.coverage.kind === "complete" && input.coverage.minimumRatio !== 1) {
    throw new TypeError("Complete Validation coverage requires minimumRatio 1.");
  }
  if (typeof input.freshness.required !== "boolean") {
    throw new TypeError("ValidationRequirement.freshness.required must be boolean.");
  }
  nullablePositiveInteger(input.freshness.maximumAgeMs, "ValidationRequirement.freshness.maximumAgeMs");
  nonNegativeInteger(input.evidence.minimumAdmittedCount, "ValidationRequirement.evidence.minimumAdmittedCount");
  oneOf(input.evidence.conflictingEvidence, ["inconclusive", "violated"] as const,
    "ValidationRequirement.evidence.conflictingEvidence");
  positiveInteger(input.limits.maximumAttempts, "ValidationRequirement.limits.maximumAttempts");
  positiveInteger(input.limits.maximumDurationMs, "ValidationRequirement.limits.maximumDurationMs");
  nullablePositiveNumber(input.limits.maximumCostUnits, "ValidationRequirement.limits.maximumCostUnits");
  oneOf(input.disclosure.sensitivity,
    ["public", "internal", "confidential", "restricted"] as const,
    "ValidationRequirement.disclosure.sensitivity");
  for (const [key, value] of Object.entries(input.completionHandling)) {
    oneOf(value, ["continue", "wait", "block", "fail"] as const,
      `ValidationRequirement.completionHandling.${key}`);
  }
  return deepFreeze({
    ...input,
    ref: snapshotRequirementRef(input.ref, "ValidationRequirement.ref"),
    specification: snapshotSpecificationRef(input.specification, "ValidationRequirement.specification"),
    source: snapshotSourceRef(input.source, "ValidationRequirement.source"),
    claim: text(input.claim, "ValidationRequirement.claim"),
    purpose: text(input.purpose, "ValidationRequirement.purpose"),
    subjectKinds: tokenList(input.subjectKinds, "ValidationRequirement.subjectKinds"),
    checkFamilies: tokenList(input.checkFamilies, "ValidationRequirement.checkFamilies"),
    assessmentMethod: snapshotOwnerRef(input.assessmentMethod, "ValidationRequirement.assessmentMethod"),
    evidence: {
      ...input.evidence,
      acceptedSourceKinds: tokenList(
        input.evidence.acceptedSourceKinds,
        "ValidationRequirement.evidence.acceptedSourceKinds",
      ),
    },
    disclosure: {
      ...input.disclosure,
      audiences: tokenList(input.disclosure.audiences, "ValidationRequirement.disclosure.audiences"),
    },
    createdAt: isoDateTime(input.createdAt, "ValidationRequirement.createdAt"),
  });
}

const VALIDATION_FAILURE_STAGES: readonly ValidationFailureStage[] = [
  "admission", "subject", "check", "evidence", "assessment", "completion_gate",
  "projection", "persistence",
];

function snapshotSpecificationRef(input: ValidationSpecificationRef, path: string) {
  strictRecord(input, path, ["id", "revision"]);
  return { id: token(input.id, `${path}.id`), revision: token(input.revision, `${path}.revision`) };
}

function snapshotRequirementRef(input: ValidationRequirementRef, path: string) {
  strictRecord(input, path, ["id", "revision"]);
  return { id: token(input.id, `${path}.id`), revision: token(input.revision, `${path}.revision`) };
}

function snapshotOwnerRef(input: ValidationOwnerRef, path: string): ValidationOwnerRef {
  strictRecord(input, path, ["owner", "kind", "id", "revision"]);
  return {
    owner: token(input.owner, `${path}.owner`),
    kind: token(input.kind, `${path}.kind`),
    id: token(input.id, `${path}.id`),
    revision: token(input.revision, `${path}.revision`),
  };
}

function snapshotSourceRef(input: ValidationTrustedSourceRef, path: string): ValidationTrustedSourceRef {
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
