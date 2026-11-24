import { createHash } from "node:crypto";
import { nativeModelSourceKey, snapshotNativeModelSource, type NativeModelSourceRef } from "./protocol/NativeModelSource.js";
import { snapshotProtocolRevisionRef, sameRevisionRef, protocolDigest, type ProtocolRevisionRef } from "./protocol/ProtocolIdentity.js";
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

interface ModelCallIdentity {
  readonly id: string;
  readonly providerRequestId: string;
  readonly controllerRequestId: string;
  readonly contentBlockOrdinal: number;
  readonly branchId: string;
}
export type ModelCallRef = ModelCallIdentity & (
  | { readonly turnId: string; readonly nativeSource?: never; readonly purposeAcceptance?: never }
  | { readonly turnId: null; readonly nativeSource: NativeModelSourceRef; readonly purposeAcceptance: ProtocolRevisionRef }
);
export type TurnModelCallRef = Extract<ModelCallRef, { readonly turnId: string }>;

export interface ProviderCallRef {
  readonly providerId: string;
  readonly id: string;
}

export interface ModelCallableRequest {
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
  readonly runId?: string;
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
  readonly presentation: ModelResultPresentation;
  readonly content: ModelJsonValue;
  readonly sourceRefs: readonly ModelCallSettlementSourceRef[];
}

export interface ModelResultPresentation {
  readonly presenter: { readonly id: string; readonly revision: string };
  readonly disposition: "complete" | "bounded" | "unavailable";
  readonly failureCode: string | null;
}

export function snapshotModelResultPresentation(input: ModelResultPresentation): ModelResultPresentation {
  strictRecord(input, "ModelResultPresentation", ["presenter", "disposition", "failureCode"]);
  strictRecord(input.presenter, "ModelResultPresentation.presenter", ["id", "revision"]);
  if (!["complete", "bounded", "unavailable"].includes(input.disposition) ||
      (input.disposition === "unavailable" ? input.failureCode === null : input.failureCode !== null)) {
    throw new TypeError("Model result presentation disposition and failure are inconsistent.");
  }
  return Object.freeze({presenter: Object.freeze({id: token(input.presenter.id, "ModelResultPresentation.presenter.id"),
    revision: token(input.presenter.revision, "ModelResultPresentation.presenter.revision")}),
    disposition: input.disposition, failureCode: nullableToken(input.failureCode, "ModelResultPresentation.failureCode")});
}

export function createModelCallRef(input: {
  readonly providerRequestId: string;
  readonly controllerRequestId: string;
  readonly turnId: string;
  readonly contentBlockOrdinal: number;
  readonly branchId: string;
}): TurnModelCallRef {
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
  return Object.freeze({
    id: `model-call:sha256:${createHash("sha256")
      .update(JSON.stringify(identity), "utf8")
      .digest("hex")}`,
    ...identity,
  });
}

export function createNativeModelCallRef(input: {
  readonly providerRequestId: string;
  readonly controllerRequestId: string;
  readonly branchId: string;
  readonly contentBlockOrdinal: number;
  readonly nativeSource: NativeModelSourceRef;
  readonly purposeAcceptance: ProtocolRevisionRef;
}): ModelCallRef {
  strictRecord(input, "NativeModelCallRef", ["providerRequestId", "controllerRequestId", "branchId", "contentBlockOrdinal", "nativeSource", "purposeAcceptance"]);
  const identity = Object.freeze({ providerRequestId: token(input.providerRequestId, "providerRequestId"),
    controllerRequestId: token(input.controllerRequestId, "controllerRequestId"), branchId: token(input.branchId, "branchId"),
    contentBlockOrdinal: nonNegativeInteger(input.contentBlockOrdinal, "contentBlockOrdinal"),
    turnId: null, nativeSource: snapshotNativeModelSource(input.nativeSource), purposeAcceptance: snapshotProtocolRevisionRef(input.purposeAcceptance) });
  const effectIdentity = { runId: identity.nativeSource.scope.runId, acceptance: identity.purposeAcceptance, ordinal: identity.contentBlockOrdinal };
  return Object.freeze({ id: `model-call:native:sha256:${createHash("sha256").update(JSON.stringify(effectIdentity), "utf8").digest("hex")}`, ...identity });
}

/** This guard belongs only to consumers of the existing Turn convention. */
export function requireModelCallTurn(input: ModelCallRef): string {
  const ref = snapshotModelCallRef(input);
  if (ref.turnId === null) throw new TypeError("model_call_turn_convention_required");
  return ref.turnId;
}

export function modelCallsShareDecisionBasis(left: ModelCallRef, right: ModelCallRef): boolean {
  const a = snapshotModelCallRef(left), b = snapshotModelCallRef(right);
  if (a.controllerRequestId !== b.controllerRequestId || a.branchId !== b.branchId) return false;
  if (a.turnId !== null || b.turnId !== null) return a.turnId !== null && b.turnId !== null && a.turnId === b.turnId;
  return sameRevisionRef(a.purposeAcceptance, b.purposeAcceptance) &&
    protocolDigest(a.nativeSource.scope) === protocolDigest(b.nativeSource.scope);
}

export function snapshotModelCallRef(input: ModelCallRef): ModelCallRef {
  strictRecord(input, "ModelCallRef", [
    "id", "providerRequestId", "controllerRequestId", "turnId",
    "contentBlockOrdinal", "branchId", "nativeSource", "purposeAcceptance",
  ]);
  const origin = input.turnId === null
    ? { turnId: null, nativeSource: snapshotNativeModelSource(input.nativeSource), purposeAcceptance: snapshotProtocolRevisionRef(input.purposeAcceptance) }
    : { turnId: token(input.turnId, "ModelCallRef.turnId") };
  if (input.turnId !== null && (input.nativeSource !== undefined || input.purposeAcceptance !== undefined)) throw new TypeError("Model Call cannot have competing source identities.");
  if (input.turnId === null && input.id !== createNativeModelCallRef({ providerRequestId: input.providerRequestId,
    controllerRequestId: input.controllerRequestId, branchId: input.branchId, contentBlockOrdinal: input.contentBlockOrdinal,
    nativeSource: input.nativeSource, purposeAcceptance: input.purposeAcceptance }).id)
    throw new TypeError("native_model_call_identity_invalid");
  return Object.freeze({
    id: token(input.id, "ModelCallRef.id"),
    providerRequestId: token(input.providerRequestId, "ModelCallRef.providerRequestId"),
    controllerRequestId: token(input.controllerRequestId, "ModelCallRef.controllerRequestId"),
    ...origin,
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

export function snapshotModelCallableRequest(input: ModelCallableRequest): ModelCallableRequest {
  strictRecord(input, "ModelCallableRequest", [
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
    "modelCallRef", "providerCallRef", "name", "settlement", "presentation", "content", "sourceRefs",
  ]);
  if (!isSettlement(input.settlement)) {
    throw new TypeError("ModelToolResult.settlement is unsupported.");
  }
  const content = snapshotModelToolResultContent(input.content);
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
    presentation: snapshotModelResultPresentation(input.presentation),
    content,
    sourceRefs: Object.freeze(input.sourceRefs.map((source, index) => {
      strictRecord(source, `ModelToolResult.sourceRefs[${index}]`, [
        "owner", "kind", "id", "revision", "runId",
      ]);
      return Object.freeze({
        ...(source.runId === undefined ? {} : {runId: token(source.runId, `ModelToolResult.sourceRefs[${index}].runId`)}),
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

export function snapshotModelToolResultContent(input: unknown): ModelJsonValue {
  const content = snapshotJsonValue(input, "ModelToolResult.content");
  if (utf8Length(JSON.stringify(content)) > MAX_MODEL_RESULT_BYTES) {
    throw new TypeError("ModelToolResult.content is too large.");
  }
  return content;
}

export function modelCallRefKey(input: ModelCallRef): string {
  const ref = snapshotModelCallRef(input);
  const key = [
    ref.id,
    ref.providerRequestId,
    ref.controllerRequestId,
    ref.turnId,
    ref.contentBlockOrdinal,
    ref.branchId,
  ].join("\u0000");
  return ref.turnId === null ? `${key}\u0000${nativeModelSourceKey(ref.nativeSource)}\u0000${JSON.stringify(ref.purposeAcceptance)}` : key;
}

function isSettlement(value: unknown): value is ModelCallSettlementKind {
  return value === "succeeded" || value === "failed" || value === "denied" ||
    value === "invalid" || value === "invalidated" || value === "cancelled";
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
