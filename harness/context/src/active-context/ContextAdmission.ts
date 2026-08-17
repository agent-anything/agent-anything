import type {
  ContextContribution,
  ContextDisclosure,
  ContextInstructionRole,
  ContextRetentionClass,
  ContextSensitivity,
  ContextTransformationKind,
} from "../contribution/ContextContribution.js";
import { isContextDisclosureAtLeastAsRestrictive } from "../contribution/ContextContribution.js";
import {
  fail,
  nonNegativeInteger,
  snapshotTokenList,
  strictRecord,
  token,
} from "../contract/ContextContractValidation.js";

export interface ContextAdmissionProfileRef {
  readonly id: string;
  readonly revision: string;
}

export interface ContextAdmissionProfile {
  readonly ref: ContextAdmissionProfileRef;
  readonly owner: string;
  readonly sourceKinds: readonly string[];
  readonly disclosure: ContextDisclosure;
  readonly retention: readonly ContextRetentionClass[];
  readonly instructionRoles: readonly ContextInstructionRole[];
  readonly necessities: readonly ("mandatory" | "optional")[];
  readonly maximumPrecedence: number;
  readonly transformations: readonly ContextTransformationKind[];
}

export function admitContextContribution(
  contribution: ContextContribution,
  profileInput: ContextAdmissionProfile,
): void {
  const profile = snapshotContextAdmissionProfile(profileInput);
  if (contribution.source.owner !== profile.owner) {
    reject("Contribution source owner is not admitted by the profile.", "ContextContribution.source.owner");
  }
  if (!profile.sourceKinds.includes(contribution.source.kind)) {
    reject("Contribution source kind is not admitted by the profile.", "ContextContribution.source.kind");
  }
  if (!isContextDisclosureAtLeastAsRestrictive(contribution.disclosure, profile.disclosure)) {
    reject("Contribution disclosure is broader than the admitted profile.", "ContextContribution.disclosure");
  }
  if (!profile.retention.includes(contribution.handling.retention)) {
    reject("Contribution retention is not admitted by the profile.", "ContextContribution.handling.retention");
  }
  if (!profile.instructionRoles.includes(contribution.handling.instructionRole)) {
    reject("Contribution instruction role is not admitted by the profile.", "ContextContribution.handling.instructionRole");
  }
  if (!profile.necessities.includes(contribution.handling.necessity)) {
    reject("Contribution necessity is not admitted by the profile.", "ContextContribution.handling.necessity");
  }
  if (contribution.handling.precedence > profile.maximumPrecedence) {
    reject("Contribution precedence exceeds the admitted profile.", "ContextContribution.handling.precedence");
  }
  if (contribution.handling.allowedTransformations.some((kind) => !profile.transformations.includes(kind))) {
    reject("Contribution transformation is not admitted by the profile.", "ContextContribution.handling.allowedTransformations");
  }
}

export function snapshotContextAdmissionProfile(
  input: ContextAdmissionProfile,
): ContextAdmissionProfile {
  strictRecord(input, "ContextAdmissionProfile", [
    "ref", "owner", "sourceKinds", "disclosure", "retention",
    "instructionRoles", "necessities", "maximumPrecedence", "transformations",
  ], "context_admission_rejected");
  strictRecord(input.ref, "ContextAdmissionProfile.ref", ["id", "revision"], "context_admission_rejected");
  strictRecord(input.disclosure, "ContextAdmissionProfile.disclosure", ["sensitivity", "audiences"], "context_admission_rejected");
  if (!isSensitivity(input.disclosure.sensitivity)) {
    reject("Admission profile sensitivity is invalid.", "ContextAdmissionProfile.disclosure.sensitivity");
  }
  const sourceKinds = snapshotTokenList(input.sourceKinds, "ContextAdmissionProfile.sourceKinds", {}, "context_admission_rejected");
  const audiences = snapshotTokenList(input.disclosure.audiences, "ContextAdmissionProfile.disclosure.audiences", { allowEmpty: true }, "context_admission_rejected");
  const retention = snapshotTokenList(input.retention, "ContextAdmissionProfile.retention", {}, "context_admission_rejected");
  const instructionRoles = snapshotTokenList(input.instructionRoles, "ContextAdmissionProfile.instructionRoles", {}, "context_admission_rejected");
  const necessities = snapshotTokenList(input.necessities, "ContextAdmissionProfile.necessities", {}, "context_admission_rejected");
  const transformations = snapshotTokenList(input.transformations, "ContextAdmissionProfile.transformations", { allowEmpty: true }, "context_admission_rejected");
  if (retention.some((value) => value !== "history" && value !== "current")) {
    reject("Admission profile retention is invalid.", "ContextAdmissionProfile.retention");
  }
  if (instructionRoles.some((value) => value !== "data" && value !== "user")) {
    reject("Admission profile instruction role is invalid.", "ContextAdmissionProfile.instructionRoles");
  }
  if (necessities.some((value) => value !== "mandatory" && value !== "optional")) {
    reject("Admission profile necessity is invalid.", "ContextAdmissionProfile.necessities");
  }
  if (transformations.some((value) => value !== "truncate" && value !== "redact" && value !== "reference")) {
    reject("Admission profile transformation is invalid.", "ContextAdmissionProfile.transformations");
  }
  return Object.freeze({
    ref: Object.freeze({
      id: token(input.ref.id, "ContextAdmissionProfile.ref.id", "context_admission_rejected"),
      revision: token(input.ref.revision, "ContextAdmissionProfile.ref.revision", "context_admission_rejected"),
    }),
    owner: token(input.owner, "ContextAdmissionProfile.owner", "context_admission_rejected"),
    sourceKinds,
    disclosure: Object.freeze({ sensitivity: input.disclosure.sensitivity, audiences }),
    retention: retention as readonly ContextRetentionClass[],
    instructionRoles: instructionRoles as readonly ContextInstructionRole[],
    necessities: necessities as readonly ("mandatory" | "optional")[],
    maximumPrecedence: nonNegativeInteger(input.maximumPrecedence, "ContextAdmissionProfile.maximumPrecedence", "context_admission_rejected"),
    transformations: transformations as readonly ContextTransformationKind[],
  });
}

function reject(message: string, path: string): never {
  return fail("context_admission_rejected", message, path);
}

function isSensitivity(value: unknown): value is ContextSensitivity {
  return value === "public" || value === "internal" || value === "confidential" || value === "restricted";
}
