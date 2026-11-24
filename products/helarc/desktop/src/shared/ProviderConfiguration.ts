import type { HelarcCredentialSelection } from "./HelarcProviderCredentials.js";
import { ProviderConfigurationError } from "./ProviderConfigurationError.js";
export { ProviderConfigurationError };
import type {ProviderCompactionPolicy} from "./ProviderCompactionPolicy.js";

export const MODEL_INTERACTION_PROTOCOLS = {
  "ollama.chat": { name: "Ollama Chat", provider: "ollama", preset: "http://localhost:11435" },
  "openai.responses": { name: "OpenAI Responses", provider: "openai", preset: "https://api.openai.com/v1" },
  "deepseek.chat-completions": { name: "DeepSeek Chat Completions", provider: "deepseek", preset: "https://api.deepseek.com" },
} as const;
export type ProviderProtocolId = keyof typeof MODEL_INTERACTION_PROTOCOLS;
export interface ProviderObservationPolicy {
  readonly revision: "helarc.provider-observation.v1";
  readonly connectMs: number;
  readonly readMs: number;
  readonly silenceMs: number;
  readonly pollMinimumMs: number;
  readonly pollMaximumMs: number;
  readonly failureRetries: number;
  readonly failureEpisodeMs: number;
}
export type ProviderNativeChoices =
  | { readonly protocol: "ollama.chat"; readonly contextWindowTokens: number; readonly think: "default" | "disabled" | "enabled" }
  | { readonly protocol: "deepseek.chat-completions"; readonly thinking: "default" | "disabled" | "enabled" }
  | { readonly protocol: "openai.responses"; readonly organization: string | null; readonly project: string | null;
      readonly transport: "http" | "websocket"; readonly background: boolean; readonly stream: boolean;
      readonly continuity: "replay" | "stored-response" | "connection-memory";
      readonly store: boolean; readonly allowTemporaryRetention: boolean; readonly allowConnectionMemory: boolean;
      readonly allowInRequestCompaction: boolean; readonly reasoningEffort: string | null };

export interface ProviderCapacityDeclaration {
  readonly target:string;
  readonly sharedTokens:number;
  readonly basis:string;
  readonly validUntil:string|null;
}

/** User choices and accepted target identity are separate from credentials and native progress. */
export interface ProviderConfigurationDraft {
  readonly protocol: ProviderProtocolId;
  readonly name: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly generationLifetimeMs: number;
  readonly native: ProviderNativeChoices;
  readonly observation: ProviderObservationPolicy;
  readonly capacityDeclaration?:ProviderCapacityDeclaration;
  readonly inRequestCompaction?:ProviderCompactionPolicy;
}
export type CredentialAvailability = "not_configured" | "unchecked" | "locally_resolvable" | "unavailable" | "missing" | "changed" | "revoked";
export interface ProviderConfiguration extends ProviderConfigurationDraft {
  readonly id: string;
  readonly revision: string;
  readonly semanticRevision: string;
  readonly connectionBindingId: string;
  readonly credentialBackend: HelarcCredentialSelection["source"] | "none";
  readonly credentialAvailability: CredentialAvailability;
  readonly availabilityObservedAt: string | null;
  readonly targetAttribution: "provider_endpoint" | "user_declared_route";
  readonly isDefault: boolean;
  readonly archived: boolean;
}
export type CredentialEdit =
  | { readonly kind: "keep" | "none" }
  | { readonly kind: "set"; readonly storage: "safe-storage" | "windows-managed"; readonly secret: string }
  | { readonly kind: "reference"; readonly target: string; readonly encoding: "utf16le" | "utf8" };
export interface SaveProviderConfiguration {
  readonly updateId: string;
  readonly configurationId: string;
  readonly expectedRevision: string | null;
  readonly draft: ProviderConfigurationDraft;
  readonly credential: CredentialEdit;
}
export interface ProviderConfigurationReceipt {
  readonly updateId: string;
  readonly disposition: "committed" | "pending" | "abandoned";
  readonly configuration: ProviderConfiguration | null;
}
export interface ProviderConfigurationListing {
  readonly configurations: readonly ProviderConfiguration[];
  readonly defaultSelection: { readonly id: string; readonly revision: string } | null;
}
export function providerToken(value: unknown): string {
  if (typeof value !== "string" || !value || value.trim() !== value || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value))
    throw new ProviderConfigurationError("provider_identity_invalid");
  return value;
}
export function providerRecord(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length ||
      keys.some(key => !Object.hasOwn(value, key))) throw new ProviderConfigurationError("provider_configuration_invalid");
}
export function defaultProviderDraft(protocol: ProviderProtocolId): ProviderConfigurationDraft {
  const draft:ProviderConfigurationDraft={ protocol, name: MODEL_INTERACTION_PROTOCOLS[protocol].name, baseUrl: MODEL_INTERACTION_PROTOCOLS[protocol].preset,
    model:"", generationLifetimeMs: 300_000_000,
    observation: { revision: "helarc.provider-observation.v1", connectMs: 15_000, readMs: 30_000, silenceMs: 120_000,
      pollMinimumMs: 1_000, pollMaximumMs: 10_000, failureRetries: 3, failureEpisodeMs: 120_000 },
    native: protocol === "ollama.chat" ? { protocol, contextWindowTokens: 163840, think: "default" }
      : protocol === "deepseek.chat-completions" ? { protocol, thinking: "default" }
      : { protocol, organization: null, project: null, transport: "http", background: false, stream: true,
        continuity: "replay", store: false, allowTemporaryRetention: false, allowConnectionMemory: false,
        allowInRequestCompaction: false, reasoningEffort: null } };
  return draft;
}
export function providerDestination(base: string, protocol: ProviderProtocolId): { baseUrl: string; attribution: ProviderConfiguration["targetAttribution"] } {
  let url: URL;
  try { url = new URL(base); } catch { throw new ProviderConfigurationError("provider_destination_invalid"); }
  if (url.username || url.password || url.search || url.hash || !["https:", "http:"].includes(url.protocol))
    throw new ProviderConfigurationError("provider_destination_invalid");
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (url.protocol === "http:" && !loopback) throw new ProviderConfigurationError("provider_tls_required");
  const known = url.hostname === "api.openai.com" ? "openai.responses" : url.hostname === "api.deepseek.com" ? "deepseek.chat-completions" : null;
  if (known && known !== protocol) throw new ProviderConfigurationError("provider_destination_protocol_mismatch");
  return { baseUrl: url.href.replace(/\/+$/, ""), attribution: known === protocol ? "provider_endpoint" : "user_declared_route" };
}
export function providerCapacityTarget(value:Pick<ProviderConfigurationDraft,"protocol"|"baseUrl"|"model"|"native">):string {
  const n=value.native;
  return JSON.stringify([value.protocol,providerDestination(value.baseUrl,value.protocol).baseUrl,value.model.trim(),
    n.protocol==="openai.responses"?n.organization:null,n.protocol==="openai.responses"?n.project:null]);
}
export function providerCompactionTarget(value:Pick<ProviderConfigurationDraft,"protocol"|"baseUrl"|"model"|"native">):string{
  const n=value.native;
  return JSON.stringify([providerCapacityTarget(value),n.protocol==="openai.responses"?
    [n.reasoningEffort,n.transport,n.continuity,n.background,n.store,n.stream]:n]);
}
