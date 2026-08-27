import { createHash } from "node:crypto";
import {
  snapshotModelMessage,
  type ModelMessage,
} from "./ModelMessage.js";
import {
  nullableToken,
  strictRecord,
  token,
} from "./ModelInteractionContractValidation.js";
import {
  snapshotProviderUsage,
  type ProviderUsage,
} from "./ProviderUsage.js";

export interface ProviderResponseRef {
  readonly providerId: string;
  readonly requestId: string;
  readonly responseId: string | null;
}

export type ModelTurnFinish =
  | { readonly kind: "normal" }
  | { readonly kind: "output_limit" }
  | { readonly kind: "refusal"; readonly reason: string | null }
  | { readonly kind: "content_filter" }
  | { readonly kind: "protocol_pause" }
  | { readonly kind: "unknown"; readonly safeCode: string | null };

export interface ModelTurn {
  readonly turnId: string;
  readonly assistant: Extract<ModelMessage, { readonly role: "assistant" }>;
  readonly finish: ModelTurnFinish;
  readonly usage: ProviderUsage | null;
  readonly responseRef: ProviderResponseRef;
}

export function createModelTurnId(input: {
  readonly providerId: string;
  readonly requestId: string;
  readonly responseId: string | null;
}): string {
  const identity = Object.freeze({
    providerId: token(input.providerId, "ModelTurn.providerId"),
    requestId: token(input.requestId, "ModelTurn.requestId"),
    responseId: nullableToken(input.responseId, "ModelTurn.responseId"),
  });
  return `model-turn:sha256:${createHash("sha256")
    .update(JSON.stringify(identity), "utf8")
    .digest("hex")}`;
}

export function snapshotModelTurn(input: ModelTurn): ModelTurn {
  strictRecord(input, "ModelTurn", [
    "turnId", "assistant", "finish", "usage", "responseRef",
  ]);
  const turnId = token(input.turnId, "ModelTurn.turnId");
  const assistant = snapshotModelMessage(input.assistant);
  if (assistant.role !== "assistant") {
    throw new TypeError("ModelTurn.assistant must be an assistant Model Message.");
  }
  const responseRef = snapshotProviderResponseRef(input.responseRef);
  for (const block of assistant.content) {
    if (
      block.kind === "model_tool_call" &&
      (block.call.modelCallRef.turnId !== turnId ||
        block.call.modelCallRef.providerRequestId !== responseRef.requestId ||
        (block.call.providerCallRef !== null &&
          block.call.providerCallRef.providerId !== responseRef.providerId))
    ) {
      throw new TypeError("Model Tool Call correlation does not match its Model Turn.");
    }
  }
  return Object.freeze({
    turnId,
    assistant,
    finish: snapshotModelTurnFinish(input.finish),
    usage: snapshotProviderUsage(input.usage),
    responseRef,
  });
}

export function snapshotModelTurnFinish(input: ModelTurnFinish): ModelTurnFinish {
  strictRecord(input as unknown, "ModelTurnFinish", ["kind", "reason", "safeCode"]);
  if (
    input.kind === "normal" ||
    input.kind === "output_limit" ||
    input.kind === "content_filter" ||
    input.kind === "protocol_pause"
  ) {
    strictRecord(input as unknown, "ModelTurnFinish", ["kind"]);
    return Object.freeze({ kind: input.kind });
  }
  if (input.kind === "refusal") {
    strictRecord(input as unknown, "ModelTurnFinish", ["kind", "reason"]);
    return Object.freeze({
      kind: "refusal",
      reason: nullableBoundedToken(input.reason, "ModelTurnFinish.reason"),
    });
  }
  if (input.kind === "unknown") {
    strictRecord(input as unknown, "ModelTurnFinish", ["kind", "safeCode"]);
    return Object.freeze({
      kind: "unknown",
      safeCode: nullableBoundedToken(input.safeCode, "ModelTurnFinish.safeCode"),
    });
  }
  throw new TypeError("ModelTurnFinish.kind is unsupported.");
}

function snapshotProviderResponseRef(input: ProviderResponseRef): ProviderResponseRef {
  strictRecord(input, "ProviderResponseRef", ["providerId", "requestId", "responseId"]);
  return Object.freeze({
    providerId: token(input.providerId, "ProviderResponseRef.providerId"),
    requestId: token(input.requestId, "ProviderResponseRef.requestId"),
    responseId: nullableToken(input.responseId, "ProviderResponseRef.responseId"),
  });
}

function nullableBoundedToken(value: string | null, path: string): string | null {
  const result = nullableToken(value, path);
  if (result !== null && result.length > 1_024) {
    throw new TypeError(`${path} is too large.`);
  }
  return result;
}
