import { snapshotModelThinkingCapability, type ModelDiscovery, type DiscoveredModel } from "@agent-anything/model-interaction";
import { readModelMetadata, record, modelText, positiveCount, unknownThinking } from "../discovery/ModelDiscoveryHttp.js";

export async function discoverOllamaModels(input: {
  baseUrl: string; model?: string; signal?: AbortSignal;
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
    const model = { ...current, thinking, contextWindowTokens: limits.length === 1 ? positiveCount(limits[0]![1]) : null };
    if (index >= 0) models[index] = model; else models.push(model);
  }
  return Object.freeze({ models: Object.freeze(models), observedAt: new Date().toISOString(), source: `${base}/api/tags`, declarationRevision: null });
}
