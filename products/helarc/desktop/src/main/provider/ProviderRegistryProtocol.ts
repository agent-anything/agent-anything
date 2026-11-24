import type { ProviderConfiguration, ProviderConfigurationDraft, ProviderConfigurationListing, ProviderConfigurationReceipt } from "../../shared/ProviderConfiguration.js";
import type { ProviderCredentialRef } from "./ProviderCredentialStore.js";
import type { ProviderDependencySummary } from "../../shared/ProviderSettingsApi.js";

export interface PrivateCredentialRevision {
  readonly id: string;
  readonly ref: ProviderCredentialRef;
  readonly equalityTag: string;
  readonly status: "staged" | "verified" | "deleting" | "deleted" | "revoked";
}
export interface PrivateConnectionBinding {
  readonly id: string;
  readonly revision: number;
  readonly configuration: ProviderConfiguration;
  readonly credential: PrivateCredentialRevision | null;
  readonly revoked: boolean;
}
export interface ProviderDependencyPin {
  readonly id: string;
  readonly bindingId: string;
  readonly acceptanceId: string;
  readonly owner: string;
  readonly purpose: string;
  readonly state: "provisional" | "confirmed" | "released";
}
export interface ProviderRegistryUpdate {
  readonly id: string;
  readonly configurationId: string;
  readonly expectedRevision: string | null;
  readonly draft: ProviderConfigurationDraft;
  readonly credentialMode: "keep" | "replace" | "none";
  readonly credential: PrivateCredentialRevision | null;
}
export interface CredentialCollectionPage {
  readonly examined: number;
  readonly next: string | null;
  readonly candidates: readonly PrivateCredentialRevision[];
}
export type ProviderRegistryCommand =
  | { readonly kind: "identity" }
  | { readonly kind: "list" }
  | { readonly kind: "get"; readonly id: string; readonly revision?: string }
  | { readonly kind: "default" }
  | { readonly kind: "key_basis"; readonly sealed?: string }
  | { readonly kind: "begin_update"; readonly update: ProviderRegistryUpdate }
  | { readonly kind: "verify_credential"; readonly id: string; readonly equalityTag: string }
  | { readonly kind: "publish_update"; readonly id: string }
  | { readonly kind: "update_receipt"; readonly id: string }
  | { readonly kind: "pending_updates"; readonly after: string; readonly limit: number }
  | { readonly kind: "abandon_update"; readonly id: string }
  | { readonly kind: "activate"; readonly id: string; readonly revision: string }
  | { readonly kind: "archive"; readonly id: string; readonly revision: string }
  | { readonly kind: "binding"; readonly id: string }
  | { readonly kind: "dependencies"; readonly id: string }
  | { readonly kind: "authorize"; readonly id: string; readonly revision: number; readonly credentialId: string | null }
  | { readonly kind: "availability"; readonly id: string; readonly revision: number; readonly status: "locally_resolvable" | "missing" | "changed" | "unavailable" }
  | { readonly kind: "pin"; readonly pin: ProviderDependencyPin }
  | { readonly kind: "read_pin"; readonly id: string }
  | { readonly kind: "settle_pin"; readonly id: string; readonly acceptanceId: string; readonly disposition: "confirmed" | "released" }
  | { readonly kind: "pins"; readonly bindingId?: string; readonly after: string; readonly limit: number }
  | { readonly kind: "repair"; readonly id: string; readonly revision: number; readonly replacementBindingId: string; readonly confirmedSameScope: boolean }
  | { readonly kind: "revoke"; readonly id: string; readonly revision: number }
  | { readonly kind: "destroy_credential"; readonly id: string; readonly revision: number }
  | { readonly kind: "claim_collection"; readonly id: string }
  | { readonly kind: "finish_collection"; readonly id: string }
  | { readonly kind: "collectible"; readonly after: string; readonly limit: number }
  | { readonly kind: "events"; readonly after: number; readonly limit: number }
  | { readonly kind: "close" };
export interface ProviderRegistryEvent {
  readonly sequence: number;
  readonly kind: string;
  readonly subjectId: string;
  readonly occurredAt: string;
}
export type ProviderRegistryValue = ProviderConfigurationListing | ProviderConfiguration | ProviderConfigurationReceipt |
  PrivateConnectionBinding | PrivateCredentialRevision | readonly PrivateCredentialRevision[] | readonly ProviderDependencyPin[] |
  readonly ProviderRegistryEvent[] | readonly ProviderRegistryUpdate[] | ProviderDependencyPin | CredentialCollectionPage | ProviderDependencySummary | string | null;
export interface ProviderRegistryPort {
  request(command: ProviderRegistryCommand): Promise<ProviderRegistryValue>;
  close(): Promise<void>;
}
