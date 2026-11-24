import { ProviderConfigurationError, providerDestination, providerToken } from "../../shared/ProviderConfiguration.js";
import type { ProviderDiscoveryRejection, ProviderModelListing } from "../../shared/ProviderSettingsApi.js";
import type { ProviderConfigurationService } from "./ProviderConfigurationService.js";

export class ProviderDiscoveryAccessError extends ProviderConfigurationError {
  constructor(readonly rejection: ProviderDiscoveryRejection) { super("provider_authentication_rejected"); }
}

// Remote messages, headers and arbitrary error codes may echo credentials.
async function readAccessCode(response: Response): Promise<ProviderDiscoveryRejection["providerCode"]> {
  if (!response.body || !response.headers.get("content-type")?.toLowerCase().includes("application/json")) return null;
  const reader = response.body.getReader();
  try {
    const chunks: Uint8Array[] = []; let length = 0;
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      length += part.value.byteLength;
      if (length > 8192) return null;
      if (part.value.byteLength) chunks.push(part.value);
    }
    const code: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))?.error?.code;
    switch (code) {
      case "invalid_api_key": case "insufficient_permissions": case "insufficient_scope":
      case "unsupported_country_region_territory": case "invalid_organization": case "invalid_project": return code;
      default: return null;
    }
  } catch { return null; } finally { reader.releaseLock(); }
}

/** Explicit metadata query. This does not infer reasoning, compaction, pricing or execution support. */
export async function discoverProviderModels(service: ProviderConfigurationService, id: string, revision: string,
  fetchImpl: typeof fetch = globalThis.fetch): Promise<ProviderModelListing> {
  providerToken(id); providerToken(revision);
  const config = await service.get(id, revision);
  if (!config || config.archived) throw new ProviderConfigurationError("provider_configuration_missing");
  return service.withConnection(config.connectionBindingId, async (bound, secret) => {
    const { baseUrl } = providerDestination(bound.baseUrl, bound.protocol);
    const url = `${baseUrl}/${bound.protocol === "ollama.chat" ? "api/tags" : "models"}`;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (secret) headers.Authorization = `Bearer ${secret}`;
    if (bound.native.protocol === "openai.responses") {
      if (bound.native.organization) headers["OpenAI-Organization"] = bound.native.organization;
      if (bound.native.project) headers["OpenAI-Project"] = bound.native.project;
    }
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), bound.observation.connectMs + bound.observation.readMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetchImpl(url, { method: "GET", headers, redirect: "manual", signal: abort.signal });
      if (response.status >= 300 && response.status < 400) throw new ProviderConfigurationError("provider_redirect_refused");
      if (response.status === 401 || response.status === 403)
        throw new ProviderDiscoveryAccessError({ httpStatus: response.status, providerCode: await readAccessCode(response) });
      if (!response.ok) throw new ProviderConfigurationError("provider_discovery_failed");
      if (!response.body) throw new ProviderConfigurationError("provider_discovery_empty");
      reader = response.body.getReader();
      const chunks: Uint8Array[] = []; let length = 0;
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        length += part.value.byteLength;
        if (length > 1_048_576) throw new ProviderConfigurationError("provider_discovery_size_limit");
        chunks.push(part.value);
      }
      const json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const records = bound.protocol === "ollama.chat" ? json.models : json.data;
      if (!Array.isArray(records) || records.length > 4096) throw new ProviderConfigurationError("provider_discovery_shape_invalid");
      const models = [...new Set(records.map(record => providerToken(bound.protocol === "ollama.chat" ? record?.name : record?.id)))].sort();
      const current = await service.get(id);
      if (!current || current.archived || current.revision !== revision) throw new ProviderConfigurationError("provider_discovery_revision_stale");
      return { configurationId: id, revision, observedAt: new Date().toISOString(), models, capabilityEvidence: "unknown" };
    } catch (error) {
      if (error instanceof ProviderConfigurationError) throw error;
      throw new ProviderConfigurationError(abort.signal.aborted ? "provider_discovery_timeout" : "provider_discovery_failed");
    } finally { clearTimeout(timer); abort.abort(); await reader?.cancel().catch(() => {}); }
  });
}
