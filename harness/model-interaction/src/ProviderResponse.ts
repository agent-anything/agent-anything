

import type { ModelOpaqueContinuationState } from "./continuation/index.js";
import type { ModelJsonValue } from "./ModelInteractionContractValidation.js";
import { nonNegativeInteger, snapshotJsonValue, strictRecord, token } from "./ModelInteractionContractValidation.js";
import { snapshotModelTurn, type ModelTurn } from "./ModelTurn.js";
import { snapshotProviderUsage, type ProviderUsage } from "./ProviderUsage.js";
import { snapshotModelReasoning, type ModelReasoning } from "./ModelReasoning.js";

interface ProviderResponseBase {
  readonly reasoning?: ModelReasoning;
  readonly responseId: string | null;
  readonly usage: ProviderUsage | null;
  readonly continuation: ModelOpaqueContinuationState | null;
  readonly metadata: { readonly [key: string]: ModelJsonValue };
}

export type ProviderResponse =
  | ProviderResponseBase & {
      readonly kind: "structured_generation";
      readonly output: ModelJsonValue;
    }
  | ProviderResponseBase & {
      readonly kind: "text_generation";
      readonly output: string;
    }
  | {
      readonly kind: "native_tool_turn";
      readonly turn: ModelTurn;
      readonly continuation: ModelOpaqueContinuationState | null;
      readonly metadata: { readonly [key: string]: ModelJsonValue };
    };

export interface ProviderFailure {
  readonly category: string;
  readonly code: string;
  readonly message: string;
  readonly retryAfterMs?: number;
  readonly requestId?: string;
  readonly statusCode?: number;
  readonly metadata: { readonly [key: string]: ModelJsonValue };
}

export function snapshotProviderFailure(input: unknown): ProviderFailure {
  strictRecord(input, "ProviderFailure", ["category", "code", "message", "retryAfterMs", "requestId", "statusCode", "metadata"]);
  assertPlainFailureData(input);
  const metadata = snapshotJsonValue(input.metadata, "ProviderFailure.metadata");
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata))
    throw new TypeError("ProviderFailure.metadata must be a JSON object.");
  const statusCode = input.statusCode === undefined ? undefined : nonNegativeInteger(input.statusCode, "ProviderFailure.statusCode");
  if (statusCode !== undefined && (statusCode < 100 || statusCode > 599))
    throw new TypeError("ProviderFailure.statusCode must be an HTTP status.");
  return Object.freeze({
    category: token(input.category, "ProviderFailure.category"),
    code: token(input.code, "ProviderFailure.code"),
    message: token(input.message, "ProviderFailure.message"),
    ...(input.retryAfterMs === undefined ? {} : {retryAfterMs: nonNegativeInteger(input.retryAfterMs, "ProviderFailure.retryAfterMs")}),
    ...(input.requestId === undefined ? {} : {requestId: token(input.requestId, "ProviderFailure.requestId")}),
    ...(statusCode === undefined ? {} : {statusCode}),
    metadata: metadata as {readonly [key: string]: ModelJsonValue},
  });
}

// Reject runtime objects/accessors before the JSON snapshot can erase their meaning.
function assertPlainFailureData(input: object): void {
  const pending: object[] = [input], visited = new WeakSet<object>();
  while (pending.length) {
    const value = pending.pop()!;
    if (visited.has(value)) continue;
    visited.add(value);
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
      throw new TypeError("ProviderFailure requires plain data objects.");
    if (Object.getOwnPropertySymbols(value).length)
      throw new TypeError("ProviderFailure cannot contain symbol properties.");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (array && Object.keys(value).length !== value.length)
      throw new TypeError("ProviderFailure cannot contain sparse arrays or array properties.");
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (array && key === "length") continue;
      if (!descriptor.enumerable || !("value" in descriptor) || (array && !/^(0|[1-9][0-9]*)$/.test(key)))
        throw new TypeError("ProviderFailure requires enumerable data properties.");
      if (descriptor.value !== null && typeof descriptor.value === "object") pending.push(descriptor.value);
    }
  }
}

export function snapshotProviderResponse(input: ProviderResponse): ProviderResponse {
  strictRecord(input as unknown, "ProviderResponse", [
    "kind", "responseId", "output", "usage", "turn", "continuation", "metadata", "reasoning",
  ]);
  const metadata = snapshotJsonValue(input.metadata, "ProviderResponse.metadata");
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new TypeError("ProviderResponse.metadata must be a JSON object.");
  }
  if (input.kind === "native_tool_turn") {
    strictRecord(input as unknown, "ProviderResponse", ["kind", "turn", "continuation", "metadata"]);
    return Object.freeze({
      kind: "native_tool_turn",
      turn: snapshotModelTurn(input.turn),
      continuation: input.continuation,
      metadata: metadata as { readonly [key: string]: ModelJsonValue },
    });
  }
  if (input.kind === "text_generation" || input.kind === "structured_generation") {
    strictRecord(input as unknown, "ProviderResponse", [
      "kind", "responseId", "output", "usage", "continuation", "metadata", "reasoning",
    ]);
    const output = input.kind === "text_generation"
      ? input.output
      : snapshotJsonValue(input.output, "ProviderResponse.output");
    if (input.kind === "text_generation" && typeof output !== "string") {
      throw new TypeError("Text generation output must be a string.");
    }
    return Object.freeze({
      kind: input.kind,
      responseId: input.responseId,
      output,
      usage: snapshotProviderUsage(input.usage),
      ...(input.reasoning === undefined ? {} : { reasoning: snapshotModelReasoning(input.reasoning) }),
      continuation: input.continuation,
      metadata: metadata as { readonly [key: string]: ModelJsonValue },
    }) as ProviderResponse;
  }
  throw new TypeError("ProviderResponse.kind is unsupported.");
}

export function providerGeneratedOutput(
  response: ProviderResponse,
): ModelJsonValue | null {
  return response.kind === "native_tool_turn" ? null : response.output;
}

export function providerResponseUsage(response: ProviderResponse): ProviderUsage | null {
  return response.kind === "native_tool_turn" ? response.turn.usage : response.usage;
}

export type { ProviderUsage } from "./ProviderUsage.js";
