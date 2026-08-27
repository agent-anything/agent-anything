import type { ModelJsonValue } from "./ModelInteractionContractValidation.js";
import {
  nonNegativeInteger,
  snapshotJsonValue,
  strictRecord,
} from "./ModelInteractionContractValidation.js";

export interface ProviderUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly metadata: { readonly [key: string]: ModelJsonValue };
}

export function snapshotProviderUsage(input: ProviderUsage | null): ProviderUsage | null {
  if (input === null) return null;
  strictRecord(input, "ProviderUsage", [
    "inputTokens", "outputTokens", "totalTokens", "metadata",
  ]);
  const inputTokens = nullableCount(input.inputTokens, "ProviderUsage.inputTokens");
  const outputTokens = nullableCount(input.outputTokens, "ProviderUsage.outputTokens");
  const totalTokens = nullableCount(input.totalTokens, "ProviderUsage.totalTokens");
  if (
    inputTokens !== null &&
    outputTokens !== null &&
    totalTokens !== null &&
    inputTokens + outputTokens !== totalTokens
  ) {
    throw new TypeError("ProviderUsage.totalTokens is inconsistent.");
  }
  const metadata = snapshotJsonValue(input.metadata, "ProviderUsage.metadata");
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new TypeError("ProviderUsage.metadata must be a JSON object.");
  }
  return Object.freeze({
    inputTokens,
    outputTokens,
    totalTokens,
    metadata: metadata as { readonly [key: string]: ModelJsonValue },
  });
}

function nullableCount(value: number | null, path: string): number | null {
  return value === null ? null : nonNegativeInteger(value, path);
}
