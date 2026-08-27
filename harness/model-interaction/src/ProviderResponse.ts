

import type { ModelOpaqueContinuationState } from "./continuation/index.js";
import type { ModelJsonValue } from "./ModelInteractionContractValidation.js";
import { snapshotJsonValue, strictRecord } from "./ModelInteractionContractValidation.js";
import { snapshotModelTurn, type ModelTurn } from "./ModelTurn.js";
import { snapshotProviderUsage, type ProviderUsage } from "./ProviderUsage.js";

interface ProviderResponseBase {
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
  readonly metadata: Readonly<Record<string, unknown>>;
}

export function snapshotProviderResponse(input: ProviderResponse): ProviderResponse {
  strictRecord(input as unknown, "ProviderResponse", [
    "kind", "responseId", "output", "usage", "turn", "continuation", "metadata",
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
      "kind", "responseId", "output", "usage", "continuation", "metadata",
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
