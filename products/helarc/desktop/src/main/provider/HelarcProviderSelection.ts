import { resolveModelThinkingSelection, type ModelDiscovery, type ModelThinkingCapability } from "@agent-anything/model-interaction";
import { snapshotHelarcProviderModelSettings } from "@agent-anything/helarc/configuration";
import { discoverOllamaModels } from "@agent-anything/provider-integrations/ollama";
import { discoverChatCompletionModels } from "@agent-anything/provider-integrations/openai-compatible";
import type { HelarcModelSelection, HelarcModelDiscoveryQuery, HelarcModelDiscoveryResult } from "../../shared/HelarcModelSelection.js";
import type { FileHelarcProviderProfileStore, ResolveHelarcStoredProviderProfileResult } from "./HelarcProviderProfileStore.js";
import type { ProviderCredentialStore } from "./ProviderCredentialStore.js";
import type { HelarcProviderConfig } from "./resolveHelarcProviderConfig.js";

type ResolvedProfile = Extract<ResolveHelarcStoredProviderProfileResult, { ok: true }>;
const unknownThinking: ModelThinkingCapability = { status: "unknown", source: "unknown", values: [], defaultValue: null };

/** Main-owned discovery association. No renderer facts authorize request parameters. */
export class HelarcProviderSelection {
  private readonly cache = new Map<string, { expiresAt: number; catalog: ModelDiscovery }>();
  constructor(private readonly store: FileHelarcProviderProfileStore, private readonly credentials: ProviderCredentialStore,
    private readonly fetchImpl: typeof fetch = globalThis.fetch, private readonly now = () => Date.now()) {}

  async validateSavedSelection(config: HelarcProviderConfig): Promise<void> {
    const settings = snapshotHelarcProviderModelSettings(config.modelSettings, config.providerKind);
    // A connection can be saved offline with provider defaults. Explicit controls
    // require authoritative support before the profile/credential transaction commits.
    if (settings.thinking.mode === "default") return;
    if (!config.model.trim()) throw new Error("Select a model before configuring thinking.");
    const catalog = await this.query(config, config.model);
    const facts = catalog.models.find(item => item.id === config.model);
    resolveModelThinkingSelection(settings.thinking, facts?.thinking ?? unknownThinking);
    this.validateOutput(config, facts?.maximumOutputTokens);
  }

  async discover(query: HelarcModelDiscoveryQuery): Promise<HelarcModelDiscoveryResult> {
    try {
      const result = await this.store.resolveProfile(query.profileId, this.credentials);
      if (!result.ok) return { ok: false, error: result.error.message };
      if (result.profile.revision !== query.profileRevision) return { ok: false, error: "Provider profile changed; reload settings." };
      const catalog = await this.catalog(result, query.model, query.refresh);
      const current = await this.store.resolveProfile(query.profileId, this.credentials);
      if (!current.ok || current.profile.revision !== query.profileRevision) return { ok: false, error: "Provider profile changed during discovery." };
      return { ok: true, profileId: query.profileId, profileRevision: query.profileRevision, catalog };
    } catch {
      return { ok: false, error: "Model metadata is unavailable. Check the service, endpoint and credential; a model identifier can still be entered manually." };
    }
  }

  async resolve(selection?: HelarcModelSelection): Promise<ResolvedProfile | null> {
    const stored = selection ? await this.store.resolveProfile(selection.profileId, this.credentials)
      : await this.store.resolveActiveProfile(this.credentials);
    if (!stored) return null;
    if (!stored.ok) throw new Error(stored.error.message);
    if (selection && stored.profile.revision !== selection.profileRevision) throw new Error("Provider profile changed; select the current configuration.");
    const settings = snapshotHelarcProviderModelSettings(stored.config.modelSettings, stored.config.providerKind);
    const model = (selection?.model ?? stored.config.model).trim();
    if (!model) throw new Error("Select a model before starting work or verification.");
    const requested = selection?.thinking ?? settings.thinking;
    let catalog: ModelDiscovery | null = null;
    try { catalog = await this.catalog(stored, model, false); }
    catch (error) { if (error instanceof TypeError) throw new Error("Provider model metadata is inconsistent."); }
    const facts = catalog?.models.find(item => item.id === model);
    const thinking = resolveModelThinkingSelection(requested, facts?.thinking ?? unknownThinking);
    const config: HelarcProviderConfig = { ...stored.config, model,
      modelArtifact: facts?.artifact ?? null, modelSettings: { ...settings, thinking },
      selectionFacts: { requested, effective: thinking, capability: facts?.thinking ?? unknownThinking,
        source: catalog?.source ?? null, declarationRevision: catalog?.declarationRevision ?? null,
        contextWindowTokens: facts?.contextWindowTokens ?? null, maximumOutputTokens: facts?.maximumOutputTokens ?? null } };
    this.validateOutput(config, facts?.maximumOutputTokens);
    const current = selection ? await this.store.resolveProfile(stored.profile.id, this.credentials)
      : await this.store.resolveActiveProfile(this.credentials);
    if (!current?.ok || current.profile.id !== stored.profile.id || current.profile.revision !== stored.profile.revision) {
      throw new Error("Provider profile changed during selection.");
    }
    return { ok: true, config, profile: { ...stored.profile, model, modelSettings: { ...settings, thinking: requested } } };
  }
  private async catalog(stored: ResolvedProfile, model: string, refresh: boolean): Promise<ModelDiscovery> {
    const key = JSON.stringify([stored.profile.id, stored.profile.revision, stored.config.providerKind === "ollama" ? model : null]);
    const cached = this.cache.get(key);
    if (!refresh && cached && cached.expiresAt > this.now()) return cached.catalog;
    const catalog = await this.query(stored.config, model);
    this.cache.set(key, { catalog, expiresAt: this.now() + 5 * 60_000 });
    while (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value!);
    return catalog;
  }
  private validateOutput(config: HelarcProviderConfig, maximum?: number | null): void {
    const settings = snapshotHelarcProviderModelSettings(config.modelSettings, config.providerKind);
    if (maximum && config.providerKind !== "ollama" && settings.maximumOutputTokens > maximum) {
      throw new Error("Maximum output exceeds the model's advertised limit.");
    }
  }
  private async query(config: HelarcProviderConfig, model: string): Promise<ModelDiscovery> {
    const settings = snapshotHelarcProviderModelSettings(config.modelSettings, config.providerKind);
    return config.providerKind === "ollama"
      ? await discoverOllamaModels({ baseUrl: config.baseUrl, model }, this.fetchImpl)
      : await discoverChatCompletionModels({ baseUrl: config.baseUrl, apiKey: config.apiKey,
          service: settings.service === "deepseek" ? "deepseek" : "generic" }, this.fetchImpl);
  }
}
