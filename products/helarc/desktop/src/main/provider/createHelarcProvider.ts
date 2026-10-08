import type { Provider } from "@agent-anything/model-interaction";
import type { ProviderObserver } from "@agent-anything/model-interaction/transport";
import { OllamaProvider } from "@agent-anything/provider-integrations/ollama";
import { OpenAICompatibleProvider } from "@agent-anything/provider-integrations/openai-compatible";
import type { HelarcProviderConfig } from "./resolveHelarcProviderConfig.js";
import { snapshotHelarcProviderModelSettings } from "@agent-anything/helarc/configuration";

export function createHelarcProvider(config: HelarcProviderConfig, observer?: ProviderObserver): Provider {
  if (!config.model.trim()) throw new TypeError("Select a model before creating a Provider.");
  const settings = snapshotHelarcProviderModelSettings(config.modelSettings, config.providerKind);
  const thinking = settings.thinking;
  const requestBodyTransportLimit = Object.freeze({
    maximumBytes: 512 * 1_024,
    source: "host_configured" as const,
    revision: "helarc.desktop.provider-request-body-limit.v1",
  });
  if (config.providerKind === "ollama") {
    if (config.ollamaRuntime === null) {
      throw new TypeError("Ollama Provider configuration requires runtime limits.");
    }
    return withSelectionFacts(new OllamaProvider({
      baseUrl: config.baseUrl,
      model: config.model,
      modelArtifact: config.modelArtifact,
      timeoutMs: config.timeoutMs,
      runtime: config.ollamaRuntime,
      ...(thinking.mode === "default" ? {} : { think: thinking.mode === "disabled" ? false : thinking.effort ?? true }),
      nativeToolInteraction: { supported: true },
      requestBodyTransportLimit,
    }, undefined, observer), config);
  }
  return withSelectionFacts(new OpenAICompatibleProvider({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    timeoutMs: config.timeoutMs,
    maximumOutputTokens: settings.maximumOutputTokens,
    service: settings.service === "deepseek" ? "deepseek" : "generic",
    ...(thinking.mode === "default" ? {} : { thinking: { type: thinking.mode } }),
    ...(thinking.mode === "enabled" && thinking.effort ? { reasoningEffort: thinking.effort } : {}),
    nativeToolInteraction: { supported: true },
    requestBodyTransportLimit,
  }, undefined, observer), config);
}

function withSelectionFacts(provider: Provider, config: HelarcProviderConfig): Provider {
  if (!config.selectionFacts) return provider;
  const facts = config.selectionFacts;
  const modelSelection = Object.freeze({
    requested: Object.freeze({ ...facts.requested }), effective: Object.freeze({ ...facts.effective }),
    capability: Object.freeze({ ...facts.capability, values: Object.freeze([...facts.capability.values]) }),
    source: facts.source, declarationRevision: facts.declarationRevision,
    contextWindowTokens: facts.contextWindowTokens, maximumOutputTokens: facts.maximumOutputTokens,
  });
  return Object.freeze({
    descriptor: Object.freeze({ ...provider.descriptor, metadata: Object.freeze({ ...provider.descriptor.metadata, modelSelection }) }),
    modelContext: provider.modelContext, requestBodyTransportLimit: provider.requestBodyTransportLimit,
    send: provider.send.bind(provider),
  });
}
