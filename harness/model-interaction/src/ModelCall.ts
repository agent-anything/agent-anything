import { createHash } from "node:crypto";
import type { ModelJsonValue } from "./ModelInteractionContractValidation.js";
import {
  nonNegativeInteger,
  nullableToken,
  snapshotJsonValue,
  strictRecord,
  token,
} from "./ModelInteractionContractValidation.js";

const MAX_MODEL_CALL_INPUT_BYTES = 131_072;
const MAX_MODEL_RESULT_BYTES = 131_072;
const MAX_SETTLEMENT_SOURCE_COUNT = 32;

export interface ModelCallRef {
  readonly id: string;
  readonly providerRequestId: string;
  readonly controllerRequestId: string;
  readonly turnId: string;
  readonly contentBlockOrdinal: number;
  readonly branchId: string;
}

export interface ProviderCallRef {
  readonly providerId: string;
  readonly id: string;
}

export interface ModelToolCall {
  readonly modelCallRef: ModelCallRef;
  readonly providerCallRef: ProviderCallRef | null;
  readonly name: string;
  readonly input: { readonly [key: string]: ModelJsonValue };
  readonly ordinal: number;
}

export type ModelCallSettlementKind =
  | "succeeded"
  | "failed"
  | "denied"
  | "invalid"
  | "invalidated"
  | "cancelled";

export interface ModelCallSettlementSourceRef {
  readonly owner: string;
  readonly kind: string;
  readonly id: string;
  readonly revision: string | null;
}

export interface ModelToolResult {
  readonly modelCallRef: ModelCallRef;
  readonly providerCallRef: ProviderCallRef | null;
  readonly name: string;
  readonly settlement: ModelCallSettlementKind;
  readonly content: ModelJsonValue;
  readonly sourceRefs: readonly ModelCallSettlementSourceRef[];
}

export function createModelCallRef(input: {
  readonly providerRequestId: string;
  readonly controllerRequestId: string;
  readonly turnId: string;
  readonly contentBlockOrdinal: number;
  readonly branchId: string;
}): ModelCallRef {
  const identity = {
    providerRequestId: token(input.providerRequestId, "ModelCallRef.providerRequestId"),
    controllerRequestId: token(input.controllerRequestId, "ModelCallRef.controllerRequestId"),
    turnId: token(input.turnId, "ModelCallRef.turnId"),
    contentBlockOrdinal: nonNegativeInteger(
      input.contentBlockOrdinal,
      "ModelCallRef.contentBlockOrdinal",
    ),
    branchId: token(input.branchId, "ModelCallRef.branchId"),
  };
  return snapshotModelCallRef({
    id: `model-call:sha256:${createHash("sha256")
      .update(JSON.stringify(identity), "utf8")
      .digest("hex")}`,
    ...identity,
  });
}

export function snapshotModelCallRef(input: ModelCallRef): ModelCallRef {
  strictRecord(input, "ModelCallRef", [
    "id", "providerRequestId", "controllerRequestId", "turnId",
    "contentBlockOrdinal", "branchId",
  ]);
  return Object.freeze({
    id: token(input.id, "ModelCallRef.id"),
    providerRequestId: token(input.providerRequestId, "ModelCallRef.providerRequestId"),
    controllerRequestId: token(input.controllerRequestId, "ModelCallRef.controllerRequestId"),
    turnId: token(input.turnId, "ModelCallRef.turnId"),
    contentBlockOrdinal: nonNegativeInteger(
      input.contentBlockOrdinal,
      "ModelCallRef.contentBlockOrdinal",
    ),
    branchId: token(input.branchId, "ModelCallRef.branchId"),
  });
}

export function snapshotProviderCallRef(
  input: ProviderCallRef | null,
): ProviderCallRef | null {
  if (input === null) return null;
  strictRecord(input, "ProviderCallRef", ["providerId", "id"]);
  return Object.freeze({
    providerId: token(input.providerId, "ProviderCallRef.providerId"),
    id: token(input.id, "ProviderCallRef.id"),
  });
}

export function snapshotModelToolCall(input: ModelToolCall): ModelToolCall {
  strictRecord(input, "ModelToolCall", [
    "modelCallRef", "providerCallRef", "name", "input", "ordinal",
  ]);
  const callInput = snapshotJsonValue(input.input, "ModelToolCall.input");
  if (callInput === null || typeof callInput !== "object" || Array.isArray(callInput)) {
    throw new TypeError("ModelToolCall.input must be a JSON object.");
  }
  if (utf8Length(JSON.stringify(callInput)) > MAX_MODEL_CALL_INPUT_BYTES) {
    throw new TypeError("ModelToolCall.input is too large.");
  }
  return Object.freeze({
    modelCallRef: snapshotModelCallRef(input.modelCallRef),
    providerCallRef: snapshotProviderCallRef(input.providerCallRef),
    name: token(input.name, "ModelToolCall.name"),
    input: callInput as { readonly [key: string]: ModelJsonValue },
    ordinal: nonNegativeInteger(input.ordinal, "ModelToolCall.ordinal"),
  });
}

export function snapshotModelToolResult(input: ModelToolResult): ModelToolResult {
  strictRecord(input, "ModelToolResult", [
    "modelCallRef", "providerCallRef", "name", "settlement", "content", "sourceRefs",
  ]);
  if (!isSettlement(input.settlement)) {
    throw new TypeError("ModelToolResult.settlement is unsupported.");
  }
  const content = snapshotJsonValue(input.content, "ModelToolResult.content");
  if (utf8Length(JSON.stringify(content)) > MAX_MODEL_RESULT_BYTES) {
    throw new TypeError("ModelToolResult.content is too large.");
  }
  if (
    !Array.isArray(input.sourceRefs) ||
    input.sourceRefs.length === 0 ||
    input.sourceRefs.length > MAX_SETTLEMENT_SOURCE_COUNT
  ) {
    throw new TypeError("ModelToolResult.sourceRefs must be a bounded non-empty array.");
  }
  return Object.freeze({
    modelCallRef: snapshotModelCallRef(input.modelCallRef),
    providerCallRef: snapshotProviderCallRef(input.providerCallRef),
    name: token(input.name, "ModelToolResult.name"),
    settlement: input.settlement,
    content,
    sourceRefs: Object.freeze(input.sourceRefs.map((source, index) => {
      strictRecord(source, `ModelToolResult.sourceRefs[${index}]`, [
        "owner", "kind", "id", "revision",
      ]);
      return Object.freeze({
        owner: token(source.owner, `ModelToolResult.sourceRefs[${index}].owner`),
        kind: token(source.kind, `ModelToolResult.sourceRefs[${index}].kind`),
        id: token(source.id, `ModelToolResult.sourceRefs[${index}].id`),
        revision: nullableToken(
          source.revision,
          `ModelToolResult.sourceRefs[${index}].revision`,
        ),
      });
    })),
  });
}

export function modelCallRefKey(input: ModelCallRef): string {
  const ref = snapshotModelCallRef(input);
  return [
    ref.id,
    ref.providerRequestId,
    ref.controllerRequestId,
    ref.turnId,
    ref.contentBlockOrdinal,
    ref.branchId,
  ].join("\u0000");
}

function isSettlement(value: unknown): value is ModelCallSettlementKind {
  return value === "succeeded" || value === "failed" || value === "denied" ||
    value === "invalid" || value === "invalidated" || value === "cancelled";
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
