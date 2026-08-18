import type { RunRef } from "@agent-anything/agent-core/run";
import {
  snapshotValidationRequirement,
  snapshotValidationSpecification,
  type ValidationOwnerRef,
  type ValidationRequirement,
  type ValidationSpecification,
  type ValidationSpecificationRef,
  type ValidationTrustedSourceRef,
} from "./ValidationDefinition.js";

export type ValidationRequirementTemplate = Omit<
  ValidationRequirement,
  "specification" | "createdAt"
>;

export interface ValidationProfile {
  readonly ref: ValidationOwnerRef;
  readonly specification: ValidationSpecificationRef;
  readonly source: ValidationTrustedSourceRef;
  readonly admittedBy: ValidationOwnerRef;
  readonly requirements: readonly ValidationRequirementTemplate[];
}

export interface MaterializedValidationProfile {
  readonly specification: ValidationSpecification;
  readonly requirements: readonly ValidationRequirement[];
}

const VALIDATION_TIME = "2000-01-01T00:00:00.000Z";

export function snapshotValidationProfile(input: ValidationProfile): ValidationProfile {
  strictRecord(input, "ValidationProfile", [
    "ref", "specification", "source", "admittedBy", "requirements",
  ]);
  const specification = revisionRef(input.specification, "ValidationProfile.specification");
  const requirements = input.requirements.map((requirement, index) => {
    strictRecord(requirement, `ValidationProfile.requirements[${index}]`, [
      "ref", "source", "kind", "claim", "purpose", "necessity", "subjectKinds",
      "checkFamilies", "assessmentMethod", "freshness", "coverage", "evidence",
      "limits", "disclosure", "completionHandling",
    ]);
    const validated = snapshotValidationRequirement({
      ...requirement,
      specification,
      createdAt: VALIDATION_TIME,
    });
    const { specification: _specification, createdAt: _createdAt, ...template } = validated;
    return template;
  });
  const keys = requirements.map((requirement) =>
    `${requirement.ref.id}@${requirement.ref.revision}`);
  if (new Set(keys).size !== keys.length) {
    throw new TypeError("ValidationProfile.requirements must not contain duplicates.");
  }
  return deepFreeze({
    ref: ownerRef(input.ref, "ValidationProfile.ref"),
    specification,
    source: sourceRef(input.source, "ValidationProfile.source"),
    admittedBy: ownerRef(input.admittedBy, "ValidationProfile.admittedBy"),
    requirements,
  });
}

export function materializeValidationProfile(input: {
  readonly profile: ValidationProfile;
  readonly run: RunRef;
  readonly createdAt: string;
}): MaterializedValidationProfile {
  strictRecord(input, "MaterializeValidationProfileInput", ["profile", "run", "createdAt"]);
  const profile = snapshotValidationProfile(input.profile);
  const run = runRef(input.run, "MaterializeValidationProfileInput.run");
  const createdAt = isoDateTime(input.createdAt, "MaterializeValidationProfileInput.createdAt");
  const requirements = profile.requirements.map((requirement) =>
    snapshotValidationRequirement({
      ...requirement,
      specification: profile.specification,
      createdAt,
    }));
  const specification = snapshotValidationSpecification({
    ref: profile.specification,
    run,
    source: profile.source,
    requirementRefs: requirements.map((requirement) => requirement.ref),
    supersedes: null,
    admittedBy: profile.admittedBy,
    createdAt,
  });
  return deepFreeze({ specification, requirements });
}

function revisionRef(
  input: { readonly id: string; readonly revision: string },
  path: string,
) {
  strictRecord(input, path, ["id", "revision"]);
  return { id: token(input.id, `${path}.id`), revision: token(input.revision, `${path}.revision`) };
}

function ownerRef(input: ValidationOwnerRef, path: string): ValidationOwnerRef {
  strictRecord(input, path, ["owner", "kind", "id", "revision"]);
  return {
    owner: token(input.owner, `${path}.owner`),
    kind: token(input.kind, `${path}.kind`),
    id: token(input.id, `${path}.id`),
    revision: token(input.revision, `${path}.revision`),
  };
}

function sourceRef(input: ValidationTrustedSourceRef, path: string): ValidationTrustedSourceRef {
  strictRecord(input, path, ["owner", "kind", "id", "revision", "sourceKind"]);
  if (!["product_configuration", "run_invocation", "task_contract", "authenticated_host",
    "project_policy", "trusted_workflow"].includes(input.sourceKind)) {
    throw new TypeError(`${path}.sourceKind is unsupported.`);
  }
  return { ...ownerRefFields(input, path), sourceKind: input.sourceKind };
}

function ownerRefFields(input: ValidationOwnerRef, path: string): ValidationOwnerRef {
  return {
    owner: token(input.owner, `${path}.owner`),
    kind: token(input.kind, `${path}.kind`),
    id: token(input.id, `${path}.id`),
    revision: token(input.revision, `${path}.revision`),
  };
}

function runRef(input: RunRef, path: string): RunRef {
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
