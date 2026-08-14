import type { ContextJsonValue } from "../contract/ContextContract.js";
import {
  fail,
  isoDateTime,
  jsonByteLength,
  nonNegativeInteger,
  nullableIsoDateTime,
  nullableToken,
  snapshotJsonValue,
  snapshotTokenList,
  strictRecord,
  token,
  utf8Length,
} from "../contract/ContextContractValidation.js";

export type ContextSensitivity =
  | "public"
  | "internal"
  | "confidential"
  | "restricted";
export type ContextInstructionRole = "data" | "user";
export type ContextRetentionClass = "history" | "current";
export type ContextTransformationKind = "truncate" | "redact" | "reference";

export interface ContextContributionRef {
  readonly id: string;
  readonly revision: string;
}

export interface ContextSourceRef {
  readonly owner: string;
  readonly kind: string;
  readonly id: string;
  readonly revision: string | null;
  readonly observedAt: string | null;
}

export interface ContextContributionScope {
  readonly runId: string;
  readonly ownerScope: string | null;
}

export interface ContextDisclosure {
  readonly sensitivity: ContextSensitivity;
  readonly audiences: readonly string[];
}

export interface ContextHandling {
  readonly retention: ContextRetentionClass;
  readonly replacementKey: string | null;
  readonly instructionRole: ContextInstructionRole;
  readonly necessity: "mandatory" | "optional";
  readonly precedence: number;
  readonly allowedTransformations: readonly ContextTransformationKind[];
}

export interface ContextProvenanceRef {
  readonly owner: string;
  readonly kind: string;
  readonly id: string;
  readonly revision: string;
}

export interface ContextTextPayload {
  readonly kind: "text";
  readonly text: string;
}

export interface ContextStructuredPayload {
  readonly kind: "structured";
  readonly value: ContextJsonValue;
}

export interface ContextResolvableReference {
  readonly owner: string;
  readonly id: string;
  readonly revision: string;
}

export interface ContextReferencePayload {
  readonly kind: "reference";
  readonly reference: ContextResolvableReference;
  readonly label: string;
}

export type ContextPayload =
  | ContextTextPayload
  | ContextStructuredPayload
  | ContextReferencePayload;

export interface ContextPayloadAccounting {
  readonly unit: "bytes";
  readonly payloadBytes: number;
}

export interface ContextContribution {
  readonly ref: ContextContributionRef;
  readonly source: ContextSourceRef;
  readonly payload: ContextPayload;
  readonly scope: ContextContributionScope;
  readonly disclosure: ContextDisclosure;
  readonly handling: ContextHandling;
  readonly provenance: readonly ContextProvenanceRef[];
  readonly createdAt: string;
  readonly accounting: ContextPayloadAccounting;
}

export interface ContextContributionLimits {
  readonly maxPayloadBytes: number;
}

export function snapshotContextContribution(
  input: ContextContribution,
  limits: ContextContributionLimits,
): ContextContribution {
  strictRecord(input, "ContextContribution", [
    "ref", "source", "payload", "scope", "disclosure", "handling",
    "provenance", "createdAt", "accounting",
  ]);
  const maxPayloadBytes = snapshotLimits(limits);
  const payload = snapshotPayload(input.payload);
  const payloadBytes = measurePayload(payload);
  if (payloadBytes > maxPayloadBytes) {
    fail(
      "context_payload_too_large",
      "ContextContribution payload exceeds its declared limit.",
      "ContextContribution.payload",
    );
  }
  strictRecord(input.accounting, "ContextContribution.accounting", [
    "unit", "payloadBytes",
  ]);
  if (input.accounting.unit !== "bytes" || input.accounting.payloadBytes !== payloadBytes) {
    fail(
      "context_contract_invalid",
      "ContextContribution accounting must match the measured payload bytes.",
      "ContextContribution.accounting",
    );
  }

  return Object.freeze({
    ref: snapshotContributionRef(input.ref, "ContextContribution.ref"),
    source: snapshotSourceRef(input.source, "ContextContribution.source"),
    payload,
    scope: snapshotScope(input.scope),
    disclosure: snapshotContextDisclosure(input.disclosure),
    handling: snapshotHandling(input.handling),
    provenance: snapshotProvenance(input.provenance),
    createdAt: isoDateTime(input.createdAt, "ContextContribution.createdAt"),
    accounting: Object.freeze({ unit: "bytes", payloadBytes }),
  });
}

export function snapshotContextDisclosure(input: ContextDisclosure): ContextDisclosure {
  strictRecord(
    input,
    "ContextDisclosure",
    ["sensitivity", "audiences"],
    "context_disclosure_invalid",
  );
  if (!isSensitivity(input.sensitivity)) {
    fail(
      "context_disclosure_invalid",
      "ContextDisclosure sensitivity is invalid.",
      "ContextDisclosure.sensitivity",
    );
  }
  return Object.freeze({
    sensitivity: input.sensitivity,
    audiences: snapshotTokenList(
      input.audiences,
      "ContextDisclosure.audiences",
      { allowEmpty: true },
      "context_disclosure_invalid",
    ),
  });
}

export function isContextDisclosureAtLeastAsRestrictive(
  next: ContextDisclosure,
  current: ContextDisclosure,
): boolean {
  const nextSnapshot = snapshotContextDisclosure(next);
  const currentSnapshot = snapshotContextDisclosure(current);
  const currentAudiences = new Set(currentSnapshot.audiences);
  return (
    sensitivityRank(nextSnapshot.sensitivity) >=
      sensitivityRank(currentSnapshot.sensitivity) &&
    nextSnapshot.audiences.every((audience) => currentAudiences.has(audience))
  );
}

export function measureContextPayload(
  payload: ContextPayload,
): ContextPayloadAccounting {
  const snapshot = snapshotPayload(payload);
  return Object.freeze({ unit: "bytes", payloadBytes: measurePayload(snapshot) });
}

export function snapshotContextContributionRef(
  input: ContextContributionRef,
): ContextContributionRef {
  return snapshotContributionRef(input, "ContextContributionRef");
}

function snapshotContributionRef(
  input: ContextContributionRef,
  path: string,
): ContextContributionRef {
  strictRecord(input, path, ["id", "revision"]);
  return Object.freeze({
    id: token(input.id, `${path}.id`),
    revision: token(input.revision, `${path}.revision`),
  });
}

function snapshotSourceRef(input: ContextSourceRef, path: string): ContextSourceRef {
  strictRecord(input, path, ["owner", "kind", "id", "revision", "observedAt"]);
  return Object.freeze({
    owner: token(input.owner, `${path}.owner`),
    kind: token(input.kind, `${path}.kind`),
    id: token(input.id, `${path}.id`),
    revision: nullableToken(input.revision, `${path}.revision`),
    observedAt: nullableIsoDateTime(input.observedAt, `${path}.observedAt`),
  });
}

function snapshotScope(input: ContextContributionScope): ContextContributionScope {
  strictRecord(input, "ContextContribution.scope", ["runId", "ownerScope"]);
  return Object.freeze({
    runId: token(input.runId, "ContextContribution.scope.runId"),
    ownerScope: nullableToken(input.ownerScope, "ContextContribution.scope.ownerScope"),
  });
}

function snapshotHandling(input: ContextHandling): ContextHandling {
  strictRecord(input, "ContextContribution.handling", [
    "retention", "replacementKey", "instructionRole", "necessity",
    "precedence", "allowedTransformations",
  ]);
  if (input.retention !== "history" && input.retention !== "current") {
    fail(
      "context_contract_invalid",
      "Context retention class is invalid.",
      "ContextContribution.handling.retention",
    );
  }
  const replacementKey = nullableToken(
    input.replacementKey,
    "ContextContribution.handling.replacementKey",
  );
  if (
    (input.retention === "current" && replacementKey === null) ||
    (input.retention === "history" && replacementKey !== null)
  ) {
    fail(
      "context_contract_invalid",
      "Current Contributions require a replacement key and history Contributions forbid one.",
      "ContextContribution.handling.replacementKey",
    );
  }
  if (input.instructionRole !== "data" && input.instructionRole !== "user") {
    fail(
      "context_contract_invalid",
      "Context instruction role is invalid.",
      "ContextContribution.handling.instructionRole",
    );
  }
  if (input.necessity !== "mandatory" && input.necessity !== "optional") {
    fail(
      "context_contract_invalid",
      "Context necessity is invalid.",
      "ContextContribution.handling.necessity",
    );
  }
  const transformations = snapshotTokenList(
    input.allowedTransformations,
    "ContextContribution.handling.allowedTransformations",
    { allowEmpty: true },
  );
  for (const transformation of transformations) {
    if (
      transformation !== "truncate" &&
      transformation !== "redact" &&
      transformation !== "reference"
    ) {
      fail(
        "context_contract_invalid",
        "Context transformation permission is invalid.",
        "ContextContribution.handling.allowedTransformations",
      );
    }
  }
  return Object.freeze({
    retention: input.retention,
    replacementKey,
    instructionRole: input.instructionRole,
    necessity: input.necessity,
    precedence: nonNegativeInteger(
      input.precedence,
      "ContextContribution.handling.precedence",
    ),
    allowedTransformations: transformations as readonly ContextTransformationKind[],
  });
}

function snapshotProvenance(
  input: readonly ContextProvenanceRef[],
): readonly ContextProvenanceRef[] {
  if (!Array.isArray(input) || input.length === 0) {
    fail(
      "context_contract_invalid",
      "ContextContribution provenance must be non-empty.",
      "ContextContribution.provenance",
    );
  }
  const values = input.map((value, index) => {
    const path = `ContextContribution.provenance[${index}]`;
    strictRecord(value, path, ["owner", "kind", "id", "revision"]);
    return Object.freeze({
      owner: token(value.owner, `${path}.owner`),
      kind: token(value.kind, `${path}.kind`),
      id: token(value.id, `${path}.id`),
      revision: token(value.revision, `${path}.revision`),
    });
  });
  const identities = values.map(
    (value) => `${value.owner}:${value.kind}:${value.id}@${value.revision}`,
  );
  if (new Set(identities).size !== identities.length) {
    fail(
      "context_contract_invalid",
      "ContextContribution provenance must not contain duplicates.",
      "ContextContribution.provenance",
    );
  }
  return Object.freeze(values);
}

function snapshotPayload(input: ContextPayload): ContextPayload {
  strictRecord(input, "ContextContribution.payload", [
    "kind", "text", "value", "reference", "label",
  ]);
  switch (input.kind) {
    case "text":
      strictRecord(input, "ContextContribution.payload", ["kind", "text"]);
      if (typeof input.text !== "string") {
        fail(
          "context_contract_invalid",
          "Context text payload must contain a string.",
          "ContextContribution.payload.text",
        );
      }
      return Object.freeze({ kind: "text", text: input.text });
    case "structured":
      strictRecord(input, "ContextContribution.payload", ["kind", "value"]);
      return Object.freeze({
        kind: "structured",
        value: snapshotJsonValue(input.value, "ContextContribution.payload.value"),
      });
    case "reference":
      strictRecord(input, "ContextContribution.payload", [
        "kind", "reference", "label",
      ]);
      strictRecord(input.reference, "ContextContribution.payload.reference", [
        "owner", "id", "revision",
      ]);
      return Object.freeze({
        kind: "reference",
        reference: Object.freeze({
          owner: token(
            input.reference.owner,
            "ContextContribution.payload.reference.owner",
          ),
          id: token(input.reference.id, "ContextContribution.payload.reference.id"),
          revision: token(
            input.reference.revision,
            "ContextContribution.payload.reference.revision",
          ),
        }),
        label: token(input.label, "ContextContribution.payload.label"),
      });
    default:
      return fail(
        "context_contract_invalid",
        "Context payload kind is invalid.",
        "ContextContribution.payload.kind",
      );
  }
}

function measurePayload(payload: ContextPayload): number {
  switch (payload.kind) {
    case "text":
      return utf8Length(payload.text);
    case "structured":
      return jsonByteLength(payload.value);
    case "reference":
      return utf8Length(JSON.stringify(payload));
  }
}

function snapshotLimits(input: ContextContributionLimits): number {
  strictRecord(input, "ContextContributionLimits", ["maxPayloadBytes"]);
  return nonNegativeInteger(
    input.maxPayloadBytes,
    "ContextContributionLimits.maxPayloadBytes",
  );
}

function isSensitivity(value: unknown): value is ContextSensitivity {
  return (
    value === "public" ||
    value === "internal" ||
    value === "confidential" ||
    value === "restricted"
  );
}

function sensitivityRank(value: ContextSensitivity): number {
  switch (value) {
    case "public": return 0;
    case "internal": return 1;
    case "confidential": return 2;
    case "restricted": return 3;
  }
}
