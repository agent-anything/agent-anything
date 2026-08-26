import type { RunRef } from "@agent-anything/agent-core/run";
import {
  snapshotVerificationRequirement,
  snapshotVerificationSpecification,
  type VerificationOwnerRef,
  type VerificationRequirement,
  type VerificationSpecification,
  type VerificationSpecificationRef,
  type VerificationTrustedSourceRef,
} from "./VerificationDefinition.js";

export type VerificationRequirementTemplate = Omit<
  VerificationRequirement,
  "specification" | "createdAt"
>;

export interface VerificationProfile {
  readonly ref: VerificationOwnerRef;
  readonly specification: VerificationSpecificationRef;
  readonly source: VerificationTrustedSourceRef;
  readonly admittedBy: VerificationOwnerRef;
  readonly requirements: readonly VerificationRequirementTemplate[];
}

export interface MaterializedVerificationProfile {
  readonly specification: VerificationSpecification;
  readonly requirements: readonly VerificationRequirement[];
}

const VALIDATION_TIME = "2000-01-01T00:00:00.000Z";

export function snapshotVerificationProfile(input: VerificationProfile): VerificationProfile {
  strictRecord(input, "VerificationProfile", [
    "ref", "specification", "source", "admittedBy", "requirements",
  ]);
  const specification = revisionRef(input.specification, "VerificationProfile.specification");
  const requirements = input.requirements.map((requirement, index) => {
    strictRecord(requirement, `VerificationProfile.requirements[${index}]`, [
      "ref", "source", "kind", "claim", "purpose", "necessity", "subjectKinds",
      "checkFamilies", "assessmentMethod", "freshness", "coverage", "evidence",
      "limits", "disclosure", "completionHandling",
    ]);
    const validated = snapshotVerificationRequirement({
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
    throw new TypeError("VerificationProfile.requirements must not contain duplicates.");
  }
  return deepFreeze({
    ref: ownerRef(input.ref, "VerificationProfile.ref"),
    specification,
    source: sourceRef(input.source, "VerificationProfile.source"),
    admittedBy: ownerRef(input.admittedBy, "VerificationProfile.admittedBy"),
    requirements,
  });
}

export function materializeVerificationProfile(input: {
  readonly profile: VerificationProfile;
  readonly run: RunRef;
  readonly createdAt: string;
}): MaterializedVerificationProfile {
  strictRecord(input, "MaterializeVerificationProfileInput", ["profile", "run", "createdAt"]);
  const profile = snapshotVerificationProfile(input.profile);
  const run = runRef(input.run, "MaterializeVerificationProfileInput.run");
  const createdAt = isoDateTime(input.createdAt, "MaterializeVerificationProfileInput.createdAt");
  const requirements = profile.requirements.map((requirement) =>
    snapshotVerificationRequirement({
      ...requirement,
      specification: profile.specification,
      createdAt,
    }));
  const specification = snapshotVerificationSpecification({
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

function ownerRef(input: VerificationOwnerRef, path: string): VerificationOwnerRef {
  strictRecord(input, path, ["owner", "kind", "id", "revision"]);
  return {
    owner: token(input.owner, `${path}.owner`),
    kind: token(input.kind, `${path}.kind`),
    id: token(input.id, `${path}.id`),
    revision: token(input.revision, `${path}.revision`),
  };
}

function sourceRef(input: VerificationTrustedSourceRef, path: string): VerificationTrustedSourceRef {
  strictRecord(input, path, ["owner", "kind", "id", "revision", "sourceKind"]);
  if (!["product_configuration", "run_invocation", "task_contract", "authenticated_host",
    "project_policy", "trusted_workflow"].includes(input.sourceKind)) {
    throw new TypeError(`${path}.sourceKind is unsupported.`);
  }
  return { ...ownerRefFields(input, path), sourceKind: input.sourceKind };
}

function ownerRefFields(input: VerificationOwnerRef, path: string): VerificationOwnerRef {
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
