import { snapshotModelThinkingCapability, type ModelDiscovery, type DiscoveredModel } from "@agent-anything/model-interaction";
import { readModelMetadata, record, modelText, positiveCount, unknownThinking } from "../discovery/ModelDiscoveryHttp.js";

export async function discoverChatCompletionModels(input: {
  baseUrl: string; apiKey: string; service: "generic" | "deepseek"; signal?: AbortSignal;
}, fetchImpl: typeof fetch = globalThis.fetch): Promise<ModelDiscovery> {
  const source = `${input.baseUrl.replace(/\/+$/, "")}/models`;
  const data = await readModelMetadata(source, input.apiKey, undefined, input.signal, fetchImpl);
  if (!record(data) || !Array.isArray(data.data) || data.data.length > 4096) throw new TypeError("Invalid model list.");
  let declared = false;
  const models: DiscoveredModel[] = data.data.map(item => {
    if (!record(item)) throw new TypeError("Invalid model metadata.");
    const id = modelText(item.id);
    let thinking: DiscoveredModel["thinking"] = unknownThinking;
    if (input.service === "deepseek") {
      if (item.effort !== undefined) {
        if (!record(item.effort) || !Array.isArray(item.effort.supported_levels) || item.effort.supported_levels.length === 0) throw new TypeError("Invalid DeepSeek effort metadata.");
        thinking = snapshotModelThinkingCapability({ status: "known", source: "endpoint",
          values: [false, true, ...item.effort.supported_levels.map(modelText)],
          defaultValue: item.effort.default_level === undefined ? true : modelText(item.effort.default_level) });
      } else if (id === "deepseek-flash" || id === "deepseek-v4-pro") {
        // Documented omissions only. A model name is never a global capability rule.
        declared = true;
        thinking = snapshotModelThinkingCapability({ status: "known", source: "declaration", values: [false, true, "low", "high", "max"], defaultValue: "high" });
      }
    }
    return { id, name: typeof item.name === "string" ? modelText(item.name) : id, artifact: null,
      contextWindowTokens: positiveCount(item.context_window), maximumOutputTokens: positiveCount(item.max_output_tokens), thinking };
  });
  return Object.freeze({ models: Object.freeze(models), observedAt: new Date().toISOString(), source,
    declarationRevision: declared ? "deepseek.chat-completions.thinking.2026-10-08" : null });
}
