import type { ActiveContextItemRef, ActiveContextRef } from "../active-context/ActiveContext.js";
import { snapshotActiveContextRef } from "../active-context/ActiveContext.js";
import type {
  ContextContributionRef,
  ContextInstructionRole,
  ContextPayload,
  ContextTransformationKind,
} from "../contribution/ContextContribution.js";
import {
  measureContextPayload,
  snapshotContextContributionRef,
} from "../contribution/ContextContribution.js";
import {
  fail,
  isoDateTime,
  nonNegativeInteger,
  snapshotJsonValue,
  snapshotTokenList,
  strictRecord,
  token,
} from "../contract/ContextContractValidation.js";

export interface ContextProjectionConsumer {
  readonly owner: string;
  readonly kind: string;
  readonly id: string;
}

export interface ContextProjectionProfileRef {
  readonly id: string;
  readonly revision: string;
}

export interface ContextPolicyRef {
  readonly id: string;
  readonly revision: string;
}

export interface ContextEstimatorRef {
  readonly id: string;
  readonly revision: string;
  readonly unit: ContextProjectionAccountingUnit;
}

export type ContextProjectionAccountingUnit = "bytes" | "tokens";

export interface ContextProjectionProfile {
  readonly ref: ContextProjectionProfileRef;
  readonly ordering: "precedence_desc_created_at_asc_id_asc";
  readonly allowedTransformations: readonly ContextTransformationKind[];
}

export interface ContextBudgetGrant {
  readonly unit: ContextProjectionAccountingUnit;
  readonly maximum: number;
}

export interface ContextProjectionRequest {
  readonly id: string;
  readonly activeContext: ActiveContextRef;
  readonly consumer: ContextProjectionConsumer;
  readonly purpose: string;
  readonly profile: ContextProjectionProfile;
  readonly budget: ContextBudgetGrant;
  readonly policy: ContextPolicyRef;
  readonly estimator: ContextEstimatorRef;
  readonly audiences: readonly string[];
  readonly requestedAt: string;
}

export interface ContextProjectionTransformation {
  readonly kind: ContextTransformationKind;
  readonly originalPayloadBytes: number;
}

export interface ContextProjectionBlock {
  readonly id: string;
  readonly item: ActiveContextItemRef;
  readonly contribution: ContextContributionRef;
  readonly instructionRole: ContextInstructionRole;
  readonly payload: ContextPayload;
  readonly accounting: {
    readonly unit: ContextProjectionAccountingUnit;
    readonly amount: number;
  };
  readonly transformation: ContextProjectionTransformation | null;
}

export type ContextProjectionDisposition =
  | "included"
  | "transformed"
  | "referenced"
  | "omitted"
  | "rejected"
  | "blocked";

export type ContextProjectionReason =
  | "included_exact"
  | "transformed_truncate"
  | "transformed_redact"
  | "transformed_reference"
  | "omitted_budget"
  | "omitted_scope"
  | "omitted_disclosure"
  | "omitted_replaced"
  | "omitted_invalidated"
  | "omitted_removed"
  | "omitted_duplicate"
  | "rejected_contract"
  | "blocked_mandatory_overflow";

export interface ProjectionManifestRecord {
  readonly item: ActiveContextItemRef;
  readonly contribution: ContextContributionRef;
  readonly disposition: ContextProjectionDisposition;
  readonly reason: ContextProjectionReason;
  readonly originalPayloadBytes: number;
  readonly projectedAmount: number;
}

export interface ProjectionManifestAccounting {
  readonly unit: ContextProjectionAccountingUnit;
  readonly consideredItems: number;
  readonly projectedItems: number;
  readonly projectedAmount: number;
}

export interface ProjectionManifest {
  readonly id: string;
  readonly projectionId: string;
  readonly requestId: string;
  readonly activeContext: ActiveContextRef;
  readonly profile: ContextProjectionProfileRef;
  readonly policy: ContextPolicyRef;
  readonly estimator: ContextEstimatorRef;
  readonly records: readonly ProjectionManifestRecord[];
  readonly accounting: ProjectionManifestAccounting;
  readonly createdAt: string;
}

export interface ContextProjection {
  readonly id: string;
  readonly requestId: string;
  readonly activeContext: ActiveContextRef;
  readonly estimator: ContextEstimatorRef;
  readonly blocks: readonly ContextProjectionBlock[];
  readonly accounting: {
    readonly unit: ContextProjectionAccountingUnit;
    readonly amount: number;
  };
  readonly manifestId: string;
  readonly createdAt: string;
}

export function snapshotContextProjectionRequest(
  input: ContextProjectionRequest,
): ContextProjectionRequest {
  strictRecord(input, "ContextProjectionRequest", [
    "id", "activeContext", "consumer", "purpose", "profile", "budget",
    "policy", "estimator", "audiences", "requestedAt",
  ], "context_projection_contract_invalid");
  strictRecord(input.consumer, "ContextProjectionRequest.consumer", [
    "owner", "kind", "id",
  ], "context_projection_contract_invalid");
  strictRecord(input.budget, "ContextProjectionRequest.budget", [
    "unit", "maximum",
  ], "context_projection_contract_invalid");
  if (!isAccountingUnit(input.budget.unit)) {
    projectionFailure("Context budget unit is invalid.", "ContextProjectionRequest.budget.unit");
  }
  return Object.freeze({
    id: projectionToken(input.id, "ContextProjectionRequest.id"),
    activeContext: snapshotActiveContextRef(
      input.activeContext,
      "ContextProjectionRequest.activeContext",
    ),
    consumer: Object.freeze({
      owner: projectionToken(input.consumer.owner, "ContextProjectionRequest.consumer.owner"),
      kind: projectionToken(input.consumer.kind, "ContextProjectionRequest.consumer.kind"),
      id: projectionToken(input.consumer.id, "ContextProjectionRequest.consumer.id"),
    }),
    purpose: projectionToken(input.purpose, "ContextProjectionRequest.purpose"),
    profile: snapshotProfile(input.profile),
    budget: Object.freeze({
      unit: input.budget.unit,
      maximum: nonNegativeInteger(
        input.budget.maximum,
        "ContextProjectionRequest.budget.maximum",
        "context_projection_contract_invalid",
      ),
    }),
    policy: snapshotRevisionRef(input.policy, "ContextProjectionRequest.policy"),
    estimator: snapshotEstimator(input.estimator, "ContextProjectionRequest.estimator"),
    audiences: snapshotTokenList(
      input.audiences,
      "ContextProjectionRequest.audiences",
      {},
      "context_projection_contract_invalid",
    ),
    requestedAt: isoDateTime(
      input.requestedAt,
      "ContextProjectionRequest.requestedAt",
      "context_projection_contract_invalid",
    ),
  });
}

export function snapshotContextProjection(
  input: ContextProjection,
): ContextProjection {
  strictRecord(input, "ContextProjection", [
    "id", "requestId", "activeContext", "estimator", "blocks", "accounting",
    "manifestId", "createdAt",
  ], "context_projection_contract_invalid");
  if (!Array.isArray(input.blocks)) {
    projectionFailure("ContextProjection.blocks must be an array.", "ContextProjection.blocks");
  }
  const blocks = input.blocks.map((block, index) =>
    snapshotBlock(block, `ContextProjection.blocks[${index}]`),
  );
  if (
    new Set(blocks.map((block) => block.id)).size !== blocks.length ||
    new Set(blocks.map((block) => block.item.id)).size !== blocks.length
  ) {
    projectionFailure(
      "ContextProjection block and item identities must be unique.",
      "ContextProjection.blocks",
    );
  }
  const estimator = snapshotEstimator(
    input.estimator,
    "ContextProjection.estimator",
  );
  if (blocks.some((block) => block.accounting.unit !== estimator.unit)) {
    projectionFailure(
      "ContextProjection blocks must use the estimator unit.",
      "ContextProjection.blocks",
    );
  }
  const amount = blocks.reduce(
    (total, block) => total + block.accounting.amount,
    0,
  );
  strictRecord(input.accounting, "ContextProjection.accounting", [
    "unit", "amount",
  ], "context_projection_contract_invalid");
  if (
    input.accounting.unit !== estimator.unit ||
    input.accounting.amount !== amount
  ) {
    projectionFailure(
      "ContextProjection accounting must equal its block accounting.",
      "ContextProjection.accounting",
    );
  }
  return Object.freeze({
    id: projectionToken(input.id, "ContextProjection.id"),
    requestId: projectionToken(input.requestId, "ContextProjection.requestId"),
    activeContext: snapshotActiveContextRef(input.activeContext, "ContextProjection.activeContext"),
    estimator,
    blocks: Object.freeze(blocks),
    accounting: Object.freeze({ unit: estimator.unit, amount }),
    manifestId: projectionToken(input.manifestId, "ContextProjection.manifestId"),
    createdAt: isoDateTime(
      input.createdAt,
      "ContextProjection.createdAt",
      "context_projection_contract_invalid",
    ),
  });
}

export function snapshotProjectionManifest(
  input: ProjectionManifest,
): ProjectionManifest {
  strictRecord(input, "ProjectionManifest", [
    "id", "projectionId", "requestId", "activeContext", "profile", "policy",
    "estimator", "records", "accounting", "createdAt",
  ], "context_projection_contract_invalid");
  if (!Array.isArray(input.records)) {
    projectionFailure("ProjectionManifest.records must be an array.", "ProjectionManifest.records");
  }
  const records = input.records.map((record, index) =>
    snapshotManifestRecord(record, `ProjectionManifest.records[${index}]`),
  );
  if (new Set(records.map((record) => record.item.id)).size !== records.length) {
    projectionFailure(
      "ProjectionManifest must contain exactly one record per considered item.",
      "ProjectionManifest.records",
    );
  }
  const projectedRecords = records.filter((record) =>
    record.disposition === "included" ||
    record.disposition === "transformed" ||
    record.disposition === "referenced",
  );
  const estimator = snapshotEstimator(
    input.estimator,
    "ProjectionManifest.estimator",
  );
  const projectedAmount = projectedRecords.reduce(
    (total, record) => total + record.projectedAmount,
    0,
  );
  strictRecord(input.accounting, "ProjectionManifest.accounting", [
    "unit", "consideredItems", "projectedItems", "projectedAmount",
  ], "context_projection_contract_invalid");
  if (
    input.accounting.unit !== estimator.unit ||
    input.accounting.consideredItems !== records.length ||
    input.accounting.projectedItems !== projectedRecords.length ||
    input.accounting.projectedAmount !== projectedAmount
  ) {
    projectionFailure(
      "ProjectionManifest accounting must match its disposition records.",
      "ProjectionManifest.accounting",
    );
  }
  return Object.freeze({
    id: projectionToken(input.id, "ProjectionManifest.id"),
    projectionId: projectionToken(input.projectionId, "ProjectionManifest.projectionId"),
    requestId: projectionToken(input.requestId, "ProjectionManifest.requestId"),
    activeContext: snapshotActiveContextRef(input.activeContext, "ProjectionManifest.activeContext"),
    profile: snapshotRevisionRef(input.profile, "ProjectionManifest.profile"),
    policy: snapshotRevisionRef(input.policy, "ProjectionManifest.policy"),
    estimator,
    records: Object.freeze(records),
    accounting: Object.freeze({
      unit: estimator.unit,
      consideredItems: records.length,
      projectedItems: projectedRecords.length,
      projectedAmount,
    }),
    createdAt: isoDateTime(
      input.createdAt,
      "ProjectionManifest.createdAt",
      "context_projection_contract_invalid",
    ),
  });
}

function snapshotProfile(input: ContextProjectionProfile): ContextProjectionProfile {
  strictRecord(input, "ContextProjectionRequest.profile", [
    "ref", "ordering", "allowedTransformations",
  ], "context_projection_contract_invalid");
  if (input.ordering !== "precedence_desc_created_at_asc_id_asc") {
    projectionFailure("Context projection ordering is invalid.", "ContextProjectionRequest.profile.ordering");
  }
  const transformations = snapshotTokenList(
    input.allowedTransformations,
    "ContextProjectionRequest.profile.allowedTransformations",
    { allowEmpty: true },
    "context_projection_contract_invalid",
  );
  for (const transformation of transformations) {
    if (transformation !== "truncate" && transformation !== "redact" && transformation !== "reference") {
      projectionFailure(
        "Context projection transformation is invalid.",
        "ContextProjectionRequest.profile.allowedTransformations",
      );
    }
  }
  return Object.freeze({
    ref: snapshotRevisionRef(input.ref, "ContextProjectionRequest.profile.ref"),
    ordering: input.ordering,
    allowedTransformations: transformations as readonly ContextTransformationKind[],
  });
}

function snapshotBlock(input: ContextProjectionBlock, path: string): ContextProjectionBlock {
  strictRecord(input, path, [
    "id", "item", "contribution", "instructionRole", "payload", "accounting",
    "transformation",
  ], "context_projection_contract_invalid");
  const payload = snapshotProjectionPayload(input.payload, `${path}.payload`);
  const payloadBytes = measureContextPayload(payload).payloadBytes;
  strictRecord(input.accounting, `${path}.accounting`, [
    "unit", "amount",
  ], "context_projection_contract_invalid");
  if (!isAccountingUnit(input.accounting.unit)) {
    projectionFailure("Projection block accounting unit is invalid.", `${path}.accounting.unit`);
  }
  const amount = nonNegativeInteger(
    input.accounting.amount,
    `${path}.accounting.amount`,
    "context_projection_contract_invalid",
  );
  if (input.accounting.unit === "bytes" && amount !== payloadBytes) {
    projectionFailure("Byte-accounted Projection block must match its payload bytes.", `${path}.accounting`);
  }
  if (input.instructionRole !== "data" && input.instructionRole !== "user") {
    projectionFailure("Projection block instruction role is invalid.", `${path}.instructionRole`);
  }
  return Object.freeze({
    id: projectionToken(input.id, `${path}.id`),
    item: snapshotItemRef(input.item, `${path}.item`),
    contribution: snapshotContextContributionRef(input.contribution),
    instructionRole: input.instructionRole,
    payload,
    accounting: Object.freeze({ unit: input.accounting.unit, amount }),
    transformation: input.transformation === null
      ? null
      : snapshotTransformation(input.transformation, `${path}.transformation`),
  });
}

function snapshotProjectionPayload(input: ContextPayload, path: string): ContextPayload {
  strictRecord(input, path, ["kind", "text", "value", "reference", "label"], "context_projection_contract_invalid");
  switch (input.kind) {
    case "text":
      strictRecord(input, path, ["kind", "text"], "context_projection_contract_invalid");
      if (typeof input.text !== "string") projectionFailure("Projection text payload is invalid.", `${path}.text`);
      return Object.freeze({ kind: "text", text: input.text });
    case "structured": {
      strictRecord(input, path, ["kind", "value"], "context_projection_contract_invalid");
      return Object.freeze({
        kind: "structured",
        value: snapshotJsonValue(
          input.value,
          `${path}.value`,
          new WeakSet<object>(),
          "context_projection_contract_invalid",
        ),
      });
    }
    case "reference":
      strictRecord(input, path, ["kind", "reference", "label"], "context_projection_contract_invalid");
      strictRecord(input.reference, `${path}.reference`, ["owner", "id", "revision"], "context_projection_contract_invalid");
      return Object.freeze({
        kind: "reference",
        reference: Object.freeze({
          owner: projectionToken(input.reference.owner, `${path}.reference.owner`),
          id: projectionToken(input.reference.id, `${path}.reference.id`),
          revision: projectionToken(input.reference.revision, `${path}.reference.revision`),
        }),
        label: projectionToken(input.label, `${path}.label`),
      });
    default:
      return projectionFailure("Projection payload kind is invalid.", `${path}.kind`);
  }
}

function snapshotManifestRecord(input: ProjectionManifestRecord, path: string): ProjectionManifestRecord {
  strictRecord(input, path, [
    "item", "contribution", "disposition", "reason", "originalPayloadBytes",
    "projectedAmount",
  ], "context_projection_contract_invalid");
  if (!isDisposition(input.disposition) || !isReason(input.reason)) {
    projectionFailure("Projection Manifest disposition or reason is invalid.", path);
  }
  const originalPayloadBytes = nonNegativeInteger(input.originalPayloadBytes, `${path}.originalPayloadBytes`, "context_projection_contract_invalid");
  const projectedAmount = nonNegativeInteger(input.projectedAmount, `${path}.projectedAmount`, "context_projection_contract_invalid");
  if (!isDispositionReasonPair(input.disposition, input.reason, projectedAmount)) {
    projectionFailure("Projection Manifest reason does not match its disposition.", path);
  }
  return Object.freeze({
    item: snapshotItemRef(input.item, `${path}.item`),
    contribution: snapshotContextContributionRef(input.contribution),
    disposition: input.disposition,
    reason: input.reason,
    originalPayloadBytes,
    projectedAmount,
  });
}

function snapshotTransformation(input: ContextProjectionTransformation, path: string): ContextProjectionTransformation {
  strictRecord(input, path, ["kind", "originalPayloadBytes"], "context_projection_contract_invalid");
  if (input.kind !== "truncate" && input.kind !== "redact" && input.kind !== "reference") {
    projectionFailure("Projection transformation kind is invalid.", `${path}.kind`);
  }
  return Object.freeze({
    kind: input.kind,
    originalPayloadBytes: nonNegativeInteger(input.originalPayloadBytes, `${path}.originalPayloadBytes`, "context_projection_contract_invalid"),
  });
}

function snapshotItemRef(input: ActiveContextItemRef, path: string): ActiveContextItemRef {
  strictRecord(input, path, ["id"], "context_projection_contract_invalid");
  return Object.freeze({ id: projectionToken(input.id, `${path}.id`) });
}

function snapshotRevisionRef<T extends { readonly id: string; readonly revision: string }>(input: T, path: string): T {
  strictRecord(input, path, ["id", "revision"], "context_projection_contract_invalid");
  return Object.freeze({
    id: projectionToken(input.id, `${path}.id`),
    revision: projectionToken(input.revision, `${path}.revision`),
  }) as T;
}

function snapshotEstimator(input: ContextEstimatorRef, path: string): ContextEstimatorRef {
  strictRecord(input, path, ["id", "revision", "unit"], "context_projection_contract_invalid");
  if (!isAccountingUnit(input.unit)) projectionFailure("Context estimator unit is invalid.", `${path}.unit`);
  return Object.freeze({
    id: projectionToken(input.id, `${path}.id`),
    revision: projectionToken(input.revision, `${path}.revision`),
    unit: input.unit,
  });
}

function projectionToken(value: unknown, path: string): string {
  return token(value, path, "context_projection_contract_invalid");
}

function projectionFailure(message: string, path: string): never {
  return fail("context_projection_contract_invalid", message, path);
}

function isDisposition(value: unknown): value is ContextProjectionDisposition {
  return value === "included" || value === "transformed" || value === "referenced" || value === "omitted" || value === "rejected" || value === "blocked";
}

function isReason(value: unknown): value is ContextProjectionReason {
  return value === "included_exact" || value === "transformed_truncate" || value === "transformed_redact" || value === "transformed_reference" || value === "omitted_budget" || value === "omitted_scope" || value === "omitted_disclosure" || value === "omitted_replaced" || value === "omitted_invalidated" || value === "omitted_removed" || value === "omitted_duplicate" || value === "rejected_contract" || value === "blocked_mandatory_overflow";
}

function isDispositionReasonPair(disposition: ContextProjectionDisposition, reason: ContextProjectionReason, projectedAmount: number): boolean {
  if (disposition === "included") return reason === "included_exact";
  if (disposition === "transformed") return reason === "transformed_truncate" || reason === "transformed_redact";
  if (disposition === "referenced") return reason === "transformed_reference";
  if (disposition === "omitted") return reason.startsWith("omitted_") && projectedAmount === 0;
  if (disposition === "rejected") return reason === "rejected_contract" && projectedAmount === 0;
  return reason === "blocked_mandatory_overflow" && projectedAmount === 0;
}

function isAccountingUnit(value: unknown): value is ContextProjectionAccountingUnit {
  return value === "bytes" || value === "tokens";
}
