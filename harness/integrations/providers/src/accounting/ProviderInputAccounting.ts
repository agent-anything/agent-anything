import { createModelNativeInputFootprint, type ProviderInputAccounting } from "@agent-anything/model-interaction/context";
import type { ModelInputComposition } from "@agent-anything/model-interaction/input";
import type { ModelJsonValue, ProviderUsage } from "@agent-anything/model-interaction";
import { createHash } from "node:crypto";

export function nativeInputAccounting(input: Omit<ProviderInputAccounting, "project"> & {
  readonly encode: (composition: ModelInputComposition) => string;
}): ProviderInputAccounting {
  // One derived footprint per immutable Provider instance. Encoding/validation still
  // runs on every use; no authority, request acceptance or dispatch is cached.
  let cached: {key: string; footprint: ReturnType<typeof createModelNativeInputFootprint>} | null = null;
  return Object.freeze({basis: Object.freeze({...input.basis}), inputUsage: input.inputUsage, outputUsage: input.outputUsage,
    ...(input.evidence ? {evidence: Object.freeze({...input.evidence})} : {}),
    defaultGenerationRoom: input.defaultGenerationRoom, limitations: Object.freeze([...input.limitations]),
    project(composition: ModelInputComposition) {
      const body = JSON.parse(input.encode(composition)) as Record<string, unknown>;
      const projection = Object.fromEntries(["messages", "tools", "response_format", "format", "prompt", "system"]
        .filter(key => key in body).map(key => [key, body[key]]));
      const key = createHash("sha256").update(JSON.stringify(projection)).digest("hex");
      if (cached?.key === key) return cached.footprint;
      const footprint = createModelNativeInputFootprint(projection);
      cached = {key, footprint};
      return footprint;
    }});
}

export function isOfficialDeepSeek(baseUrl: string): boolean {
  const url = new URL(baseUrl);
  return url.protocol === "https:" && url.hostname === "api.deepseek.com" && !url.port &&
    ["", "/", "/v1", "/v1/"].includes(url.pathname);
}

export const DEEPSEEK_ACCOUNTING_REVISION = "deepseek.chat-accounting.2026-10-23";
export function deepSeekGenerationRoom(model: string, thinking: string | undefined, effort: string | undefined): number | null {
  if (!["deepseek-flash", "deepseek-v4-pro"].includes(model)) return null;
  return effort === "none" || (effort === undefined && thinking === "disabled") ? 8192 : effort === "max" ? 131072 : 65536;
}

/** Cache counters are inclusive input subsets, not extra tokens or an occupancy discount. */
export function normalizedUsageMetadata(input: {
  readonly input: number | null; readonly output: number | null;
  readonly cached: unknown; readonly uncached?: unknown; readonly reasoning?: unknown;
  readonly raw: Readonly<Record<string, unknown>>; readonly revision: string;
  readonly reportedModel?: unknown; readonly fingerprint?: unknown;
}): ProviderUsage["metadata"] {
  const count = (value: unknown): number | null => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
  const cached = count(input.cached), uncached = count(input.uncached), reasoning = count(input.reasoning);
  const consistent = (input.cached == null || cached !== null) && (input.uncached == null || uncached !== null) &&
    (input.reasoning == null || reasoning !== null) &&
    (cached === null || input.input === null || cached <= input.input) &&
    (uncached === null || input.input === null || uncached <= input.input) &&
    (cached === null || uncached === null || input.input === null || cached + uncached === input.input) &&
    (reasoning === null || input.output === null || reasoning <= input.output);
  const raw = Object.fromEntries(Object.entries(input.raw).filter(([, value]) => value !== undefined)) as Record<string, ModelJsonValue>;
  return {accountingRevision: input.revision, cachedInputTokens: cached, uncachedInputTokens: uncached,
    reasoningTokens: reasoning, accountingConsistent: consistent, rawCounters: raw,
    reportedIdentity: typeof input.reportedModel === "string" || typeof input.fingerprint === "string"
      ? JSON.stringify({model: input.reportedModel ?? null, fingerprint: input.fingerprint ?? null}) : null};
}
