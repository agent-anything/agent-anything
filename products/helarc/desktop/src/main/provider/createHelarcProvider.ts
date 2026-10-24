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
    ...(facts.contextEvidence ? {contextEvidence: Object.freeze({...facts.contextEvidence})} : {}),
    requested: Object.freeze({ ...facts.requested }), effective: Object.freeze({ ...facts.effective }),
    capability: Object.freeze({ ...facts.capability, values: Object.freeze([...facts.capability.values]) }),
    source: facts.source, declarationRevision: facts.declarationRevision,
    contextWindowTokens: facts.contextWindowTokens, maximumOutputTokens: facts.maximumOutputTokens,
  });
  const original = provider.modelContext;
  // Advertised model capacity is applicable only to the bound artifact here. A loaded
  // allocation is a time-scoped observation, never the next request's hard ceiling.
  const capacity = config.providerKind === "ollama" && config.modelArtifact && facts.contextWindowTokens !== null && original.capacity.supported
    ? Object.freeze({...original.capacity, maximum: Math.min(original.capacity.maximum, facts.contextWindowTokens),
      revision: `${original.capacity.revision}:artifact:${config.modelArtifact}:model-capacity:${facts.contextWindowTokens}`}) : original.capacity;
  const modelContext = Object.freeze({...original, capacity,
    ...(original.accounting ? {accounting: Object.freeze({...original.accounting,
      basis: Object.freeze({...original.accounting.basis, advertisedModelCapacity: facts.contextWindowTokens,
        capacityFactSource: facts.source, runtimeVersion: facts.contextEvidence?.runtimeVersion ?? null,
        templateDigest: facts.contextEvidence?.templateDigest ?? null}),
      evidence: Object.freeze({discoverySource: facts.source, advertisedModelCapacity: facts.contextWindowTokens,
        observedLoadedContext: facts.contextEvidence?.loadedContextWindowTokens ?? null,
        observedAt: facts.contextEvidence?.observedAt ?? null}),
      limitations: Object.freeze(original.accounting.limitations.filter(value =>
        !(value === "runtime_template_revision_unknown" && facts.contextEvidence?.runtimeVersion && facts.contextEvidence.templateDigest) &&
        !(value === "deployment_capacity_unobserved" && facts.contextEvidence?.loadedContextWindowTokens !== null &&
          facts.contextEvidence?.loadedContextWindowTokens !== undefined))),
    })} : {})});
  return Object.freeze({
    descriptor: Object.freeze({ ...provider.descriptor, capabilities: Object.freeze({...provider.descriptor.capabilities,
      modelContext: Object.freeze({...provider.descriptor.capabilities.modelContext, capacity})}),
      metadata: Object.freeze({ ...provider.descriptor.metadata, modelSelection }) }),
    modelContext, requestBodyTransportLimit: provider.requestBodyTransportLimit,
    send: provider.send.bind(provider),
  });
}
