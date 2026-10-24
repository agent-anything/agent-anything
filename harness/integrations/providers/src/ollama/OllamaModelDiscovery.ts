import { snapshotModelThinkingCapability, type ModelDiscovery, type DiscoveredModel } from "@agent-anything/model-interaction";
import { createHash } from "node:crypto";
import { readModelMetadata, record, modelText, positiveCount, unknownThinking } from "../discovery/ModelDiscoveryHttp.js";

export async function discoverOllamaModels(input: {
  baseUrl: string; model?: string; signal?: AbortSignal; includeRuntimeContext?: boolean;
}, fetchImpl: typeof fetch = globalThis.fetch): Promise<ModelDiscovery> {
  const base = input.baseUrl.replace(/\/+$/, "");
  const data = await readModelMetadata(`${base}/api/tags`, "", undefined, input.signal, fetchImpl);
  if (!record(data) || !Array.isArray(data.models) || data.models.length > 4096) throw new TypeError("Invalid Ollama model list.");
  const models: DiscoveredModel[] = data.models.map(item => {
    if (!record(item)) throw new TypeError("Invalid Ollama model entry.");
    const id = modelText(item.name ?? item.model);
    return { id, name: id, artifact: typeof item.digest === "string" ? modelText(item.digest) : null,
      contextWindowTokens: null, maximumOutputTokens: null, thinking: unknownThinking };
  });
  if (input.model) {
    const detail = await readModelMetadata(`${base}/api/show`, "", { model: input.model }, input.signal, fetchImpl);
    if (!record(detail)) throw new TypeError("Invalid Ollama model details.");
    let thinking = unknownThinking as DiscoveredModel["thinking"];
    if (detail.thinking !== undefined) {
      if (!record(detail.thinking) || !Array.isArray(detail.thinking.values)) throw new TypeError("Invalid Ollama thinking metadata.");
      thinking = snapshotModelThinkingCapability({ status: "known", source: "endpoint",
        values: detail.thinking.values as (string | boolean)[], defaultValue: (detail.thinking.default ?? null) as string | boolean | null });
    }
    const index = models.findIndex(model => model.id === input.model);
    const current = index >= 0 ? models[index]! : { id: input.model, name: input.model, artifact: null, maximumOutputTokens: null };
    const limits = record(detail.model_info) ? Object.entries(detail.model_info).filter(([key]) => key.endsWith(".context_length")) : [];
    let contextEvidence: DiscoveredModel["contextEvidence"];
    if (input.includeRuntimeContext) {
      const optional = async (path: string) => {
        try { return await readModelMetadata(`${base}${path}`, "", undefined, input.signal, fetchImpl); }
        catch { input.signal?.throwIfAborted(); return null; }
      };
      const version = await optional("/api/version");
      const running = await optional("/api/ps");
      const loaded = record(running) && Array.isArray(running.models) ? running.models.filter(item => record(item) &&
        (item.name === input.model || item.model === input.model) && current.artifact !== null && item.digest === current.artifact) : [];
      contextEvidence = {runtimeVersion: record(version) && typeof version.version === "string" ? modelText(version.version) : null,
        templateDigest: typeof detail.template === "string" ? `sha256:${createHash("sha256").update(detail.template).digest("hex")}` : null,
        loadedContextWindowTokens: loaded.length === 1 && record(loaded[0]) ? positiveCount(loaded[0].context_length) : null,
        observedAt: new Date().toISOString()};
    }
    const model = { ...current, thinking, contextWindowTokens: limits.length === 1 ? positiveCount(limits[0]![1]) : null,
      ...(contextEvidence ? {contextEvidence} : {}) };
    if (index >= 0) models[index] = model; else models.push(model);
  }
  return Object.freeze({ models: Object.freeze(models), observedAt: new Date().toISOString(), source: `${base}/api/tags`, declarationRevision: null });
}
