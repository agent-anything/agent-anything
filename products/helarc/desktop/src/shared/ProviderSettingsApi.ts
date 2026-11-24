import type {ProviderCompactionPolicy} from "./ProviderCompactionPolicy.js";
import type { ProviderConfigurationDraft, ProviderConfiguration, ProviderConfigurationListing, ProviderConfigurationReceipt, SaveProviderConfiguration } from "./ProviderConfiguration.js";
import type { HelarcCredentialSettings } from "./HelarcProviderCredentials.js";

export interface ProviderDiscoveryRejection {
  readonly httpStatus: 401 | 403;
  readonly providerCode: "invalid_api_key" | "insufficient_permissions" | "insufficient_scope" | "unsupported_country_region_territory" | "invalid_organization" | "invalid_project" | null;
}
export type ProviderSettingsResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string; readonly discoveryRejection?: ProviderDiscoveryRejection };
export interface ProviderExecutionEligibility { readonly available: boolean; readonly reason: string | null }
export interface ProviderTaskSelection { readonly id: string; readonly revision: string }
export interface ProviderDependencySummary {
  readonly bindingRevision: number;
  readonly bindingOutstanding: number;
  readonly credentialOutstanding: number;
  readonly credentialBindings: number;
}
export interface ProviderModelListing {
  readonly configurationId: string;
  readonly revision: string;
  readonly observedAt: string;
  readonly models: readonly string[];
  readonly capabilityEvidence: "unknown";
}
export interface ProviderSettingsApi {
  list(): Promise<ProviderSettingsResult<ProviderConfigurationListing>>;
  save(input: SaveProviderConfiguration): Promise<ProviderSettingsResult<ProviderConfigurationReceipt>>;
  receipt(updateId: string): Promise<ProviderSettingsResult<ProviderConfigurationReceipt | null>>;
  previewPolicy(input:{draft:ProviderConfigurationDraft}):Promise<ProviderSettingsResult<ProviderCompactionPolicy>>;
  credentialSettings(bindingId: string | null): Promise<ProviderSettingsResult<HelarcCredentialSettings>>;
  discover(input: { id: string; revision: string }): Promise<ProviderSettingsResult<ProviderModelListing>>;
  eligibility(input: { id: string; revision: string }): Promise<ProviderSettingsResult<ProviderExecutionEligibility>>;
  activate(input: { id: string; revision: string }): Promise<ProviderSettingsResult<ProviderConfiguration>>;
  archive(input: { id: string; revision: string }): Promise<ProviderSettingsResult<null>>;
  dependencies(bindingId: string): Promise<ProviderSettingsResult<ProviderDependencySummary>>;
  revoke(input: { bindingId: string; revision: number; confirmed: boolean }): Promise<ProviderSettingsResult<null>>;
  destroyCredential(input: { bindingId: string; revision: number; confirmed: boolean }): Promise<ProviderSettingsResult<null>>;
  repair(input: { bindingId: string; revision: number; replacementBindingId: string; confirmedSameScope: boolean }): Promise<ProviderSettingsResult<null>>;
}
