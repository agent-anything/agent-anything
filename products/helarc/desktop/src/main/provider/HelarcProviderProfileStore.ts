import { randomUUID } from "node:crypto";
import {
  createHelarcProviderProfile, type HelarcProviderKind, type HelarcOllamaRuntimeProfile,
  type HelarcProviderProfile, type HelarcProviderProfileError, type HelarcProviderModelSettings,
  type HelarcModelUsePolicy,
} from "@agent-anything/helarc/configuration";
import { HELARC_DEFAULT_PROVIDER_SETTINGS } from "../../shared/HelarcDesktopApi.js";
import { SerializedAtomicFile, type AtomicFileTransaction, type SerializedAtomicFileOptions } from "../persistence/SerializedAtomicFile.js";
import type { HelarcProviderConfig } from "./resolveHelarcProviderConfig.js";
import type { ProviderCredentialStore, ProviderCredentialStoreError } from "./ProviderCredentialStore.js";
import { selectionFor, validCredentialRef, type ProviderCredentialRef } from "./ProviderCredentialStore.js";
import { snapshotCredentialSelection, type HelarcCredentialSelection } from "../../shared/HelarcProviderCredentials.js";

export interface SaveHelarcProviderProfileInput {
  profileId?: string | null;
  expectedRevision?: string | null;
  providerKind: HelarcProviderKind;
  displayName: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  ollamaRuntime: HelarcOllamaRuntimeProfile | null;
  modelSettings?: HelarcProviderModelSettings;
  qualificationPolicy?: HelarcModelUsePolicy;
  apiKeyUpdate: "keep" | "set" | "clear" | "reference";
  credential?: HelarcCredentialSelection;
  apiKey: string;
}
export interface PersistedHelarcProviderProfile {
  readonly id: string;
  readonly revision: string;
  readonly providerKind: HelarcProviderKind;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly ollamaRuntime: Readonly<HelarcOllamaRuntimeProfile> | null;
  readonly modelSettings: HelarcProviderModelSettings;
  readonly qualificationPolicy: HelarcModelUsePolicy;
  readonly credentialRef: ProviderCredentialRef | null;
  readonly updatedAt: string;
}
interface StoreDocument {
  readonly formatVersion: 5;
  readonly activeProfileId: string | null;
  readonly profiles: readonly PersistedHelarcProviderProfile[];
}
export interface HelarcProviderProfileStoreError {
  readonly code: "provider_profile_persistence_failed" | "provider_profile_conflict";
  readonly message: string;
}
export type ResolveHelarcStoredProviderProfileResult =
  | { ok: true; config: HelarcProviderConfig; profile: HelarcProviderProfile; cleanupWarning?: string }
  | { ok: false; error: HelarcProviderProfileError | ProviderCredentialStoreError | HelarcProviderProfileStoreError };

export class HelarcProviderProfileStoreCorruptionError extends Error {
  readonly code = "provider_profile_store_corrupt";
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "HelarcProviderProfileStoreCorruptionError"; }
}
export class FileHelarcProviderProfileStore {
  private readonly atomicFile: SerializedAtomicFile;
  constructor(filePath: string, options: SerializedAtomicFileOptions = {}) { this.atomicFile = new SerializedAtomicFile(filePath, options); }

  async resolveActiveProfile(credentials: ProviderCredentialStore): Promise<ResolveHelarcStoredProviderProfileResult | null> {
    return this.atomicFile.transact(async file => {
      const doc = await this.readDocument(file);
      const profile = doc.profiles.find(p => p.id === doc.activeProfileId);
      return profile ? resolve(profile, true, credentials) : null;
    });
  }
  async resolveProfile(id: string, credentials: ProviderCredentialStore): Promise<ResolveHelarcStoredProviderProfileResult> {
    return this.atomicFile.transact(async file => {
      const doc = await this.readDocument(file);
      const profile = doc.profiles.find(p => p.id === id);
      return profile ? resolve(profile, id === doc.activeProfileId, credentials) : missing();
    });
  }
  async listProfiles(credentials: ProviderCredentialStore): Promise<HelarcProviderProfile[]> {
    return this.atomicFile.transact(async file => {
      const doc = await this.readDocument(file);
      const profiles: HelarcProviderProfile[] = [];
      for (const stored of doc.profiles) {
        const result = await resolve(stored, stored.id === doc.activeProfileId, credentials);
        const safe = result.ok ? result : createHelarcProviderProfile({ ...stored, credentialStatus: "missing", isActive: stored.id === doc.activeProfileId });
        if (!safe.ok) throw new Error(safe.error.message);
        profiles.push(safe.profile);
      }
      return profiles;
    });
  }
  async credentialSelection(id: string, revision: string): Promise<HelarcCredentialSelection> {
    return this.atomicFile.transact(async file => {
      const profile = (await this.readDocument(file)).profiles.find(p => p.id === id && p.revision === revision);
      if (!profile) throw new Error("Provider profile changed; reload settings.");
      return selectionFor(profile.credentialRef);
    });
  }
  async selectActiveProfile(id: string, credentials: ProviderCredentialStore): Promise<ResolveHelarcStoredProviderProfileResult> {
    return this.atomicFile.transact(async file => {
      const doc = await this.readDocument(file);
      const stored = doc.profiles.find(p => p.id === id);
      if (!stored) return missing();
      const result = await resolve(stored, true, credentials);
      await write(file, { ...doc, activeProfileId: id });
      return result;
    });
  }
  async deleteProfile(id: string, expectedRevision: string, credentials: ProviderCredentialStore): Promise<string | null> {
    return this.atomicFile.transact(async file => {
      const doc = await this.readDocument(file);
      const stored = doc.profiles.find(p => p.id === id);
      if (!stored || stored.revision !== expectedRevision) throw new Error("Provider profile changed; reload settings.");
      const profiles = doc.profiles.filter(p => p.id !== id);
      await write(file, { ...doc, profiles, activeProfileId: doc.activeProfileId === id ? profiles[0]?.id ?? null : doc.activeProfileId });
      if (stored.credentialRef) {
        try { await credentials.deleteApiKey(stored.credentialRef); }
        catch { return "Provider deleted, but its managed credential could not be removed from storage."; }
      }
      return null;
    });
  }
  async saveActiveProfile(input: SaveHelarcProviderProfileInput, credentials: ProviderCredentialStore,
    validate?: (config: HelarcProviderConfig) => Promise<void>): Promise<ResolveHelarcStoredProviderProfileResult> {
    return this.atomicFile.transact(async file => {
      const doc = await this.readDocument(file);
      const previous = input.profileId ? doc.profiles.find(p => p.id === input.profileId) : undefined;
      if (input.profileId && (!previous || previous.revision !== input.expectedRevision)) return conflict();
      if (!previous && doc.profiles.length >= 64) return conflict("At most 64 Provider profiles can be saved.");
      const id = previous?.id ?? `provider-${randomUUID()}`;
      const revision = randomUUID();
      const validated = createHelarcProviderProfile({ ...input, id, revision, credentialStatus: "missing",
        qualificationPolicy: input.qualificationPolicy ?? HELARC_DEFAULT_PROVIDER_SETTINGS.qualificationPolicy, isActive: true });
      if (!validated.ok) return validated;
      let choice: HelarcCredentialSelection;
      try { choice = snapshotCredentialSelection(input.credential ?? selectionFor(previous?.credentialRef ?? null)); }
      catch { return conflict("Credential selection is invalid."); }
      if ((input.apiKeyUpdate === "reference" && choice.source !== "windows-reference") ||
          (input.apiKeyUpdate === "set" && choice.source === "windows-reference") ||
          (input.apiKeyUpdate !== "set" && input.apiKey.length !== 0)) return conflict("Credential update intent does not match its source.");
      if (input.apiKeyUpdate === "keep" && previous &&
          (validated.profile.baseUrl.replace(/\/+$/, "") !== previous.baseUrl.replace(/\/+$/, "") ||
           input.providerKind !== previous.providerKind || validated.profile.modelSettings?.service !== previous.modelSettings.service)) {
        return conflict("Changing the service or endpoint requires setting or clearing the credential.");
      }
      let credentialRef = input.apiKeyUpdate === "keep" ? previous?.credentialRef ?? null : null;
      let apiKey = input.apiKeyUpdate === "set" ? input.apiKey.trim() : "";
      if (input.apiKeyUpdate === "reference" && choice.source === "windows-reference") {
        credentialRef = { storage: "windows", ownership: "external", id: choice.target, encoding: choice.encoding };
      }
      if (credentialRef) {
        const key = await credentials.resolveApiKey(credentialRef);
        if (!key.ok) return key;
        apiKey = key.apiKey ?? "";
        if (!apiKey) return { ok: false, error: { code: "provider_credential_missing", message: "The selected credential does not exist. Check its target or replace it." } };
      }
      const sourceChanged = JSON.stringify(choice) !== JSON.stringify(selectionFor(credentialRef));
      if (input.apiKeyUpdate === "keep" && sourceChanged && (credentialRef?.ownership !== "managed" || choice.source === "windows-reference")) {
        return conflict("Changing an external credential source requires explicitly selecting the reference or entering a key.");
      }
      if (validate) {
        try { await validate({ providerKind: validated.profile.providerKind, baseUrl: validated.profile.baseUrl,
          model: validated.profile.model, timeoutMs: validated.profile.timeoutMs, ollamaRuntime: validated.profile.ollamaRuntime,
          modelSettings: validated.profile.modelSettings, apiKey }); }
        catch (error) { return conflict(error instanceof Error ? error.message : "Provider selection is invalid."); }
      }
      // Publish a new credential reference only with the atomic profile commit.
      let stagedRef: ProviderCredentialRef | null = null;
      if (apiKey && (input.apiKeyUpdate === "set" || (input.apiKeyUpdate === "keep" && sourceChanged))) {
        const staged = await credentials.stage(`${id}-${revision}`, apiKey, choice);
        if (!staged.ok) return staged;
        stagedRef = staged.ref;
        credentialRef = staged.ref;
      }
      const p = { ...validated.profile, credentialStatus: apiKey ? "present" as const : "empty_allowed" as const };
      const stored: PersistedHelarcProviderProfile = { id, revision, providerKind: p.providerKind, displayName: p.displayName,
        baseUrl: p.baseUrl, model: p.model, timeoutMs: p.timeoutMs, ollamaRuntime: p.ollamaRuntime,
        modelSettings: p.modelSettings!, qualificationPolicy: p.qualificationPolicy, credentialRef, updatedAt: new Date().toISOString() };
      try {
        await write(file, { formatVersion: 5, activeProfileId: id,
          profiles: previous ? doc.profiles.map(p => p.id === id ? stored : p) : [...doc.profiles, stored] });
      } catch {
        if (stagedRef) {
          try { await credentials.deleteApiKey(stagedRef); }
          catch { return conflict("Profile was not saved; staged credential cleanup also failed."); }
        }
        return { ok: false, error: { code: "provider_profile_persistence_failed", message: "Provider profile could not be persisted." } };
      }
      if (previous?.credentialRef && JSON.stringify(previous.credentialRef) !== JSON.stringify(credentialRef)) {
        try { await credentials.deleteApiKey(previous.credentialRef); }
        catch { return { ok: true, profile: p, config: configuration(stored, apiKey), cleanupWarning: "Provider saved, but the replaced managed credential could not be removed from storage." }; }
      }
      return { ok: true, profile: p, config: configuration(stored, apiKey) };
    });
  }
  private async readDocument(file: AtomicFileTransaction): Promise<StoreDocument> {
    const text = await file.readText();
    if (text === null) return { formatVersion: 5, activeProfileId: null, profiles: [] };
    try {
      const doc = JSON.parse(text) as StoreDocument;
      if (!doc || doc.formatVersion !== 5 || Object.keys(doc).sort().join() !== "activeProfileId,formatVersion,profiles" ||
          !Array.isArray(doc.profiles) || doc.profiles.length > 64 ||
          new Set(doc.profiles.map(p => p.id)).size !== doc.profiles.length ||
          (doc.activeProfileId !== null && !doc.profiles.some(p => p.id === doc.activeProfileId)) ||
          (doc.activeProfileId === null && doc.profiles.length !== 0)) throw new Error("shape");
      for (const p of doc.profiles) {
        if (Object.keys(p).sort().join() !== "baseUrl,credentialRef,displayName,id,model,modelSettings,ollamaRuntime,providerKind,qualificationPolicy,revision,timeoutMs,updatedAt" ||
            !/^provider-[a-f0-9-]{36}$/.test(p.id) || typeof p.revision !== "string" || !/^[a-f0-9-]{36}$/.test(p.revision) ||
            (p.credentialRef !== null && !validCredentialRef(p.credentialRef, p.id)) ||
            !Number.isFinite(Date.parse(p.updatedAt)) || p.modelSettings === undefined ||
            !createHelarcProviderProfile({ ...p, credentialStatus: "missing" }).ok) throw new Error("profile");
      }
      return doc;
    } catch (cause) {
      throw new HelarcProviderProfileStoreCorruptionError("Provider Profile Store document version or shape is invalid.", { cause });
    }
  }
}
function configuration(p: PersistedHelarcProviderProfile, apiKey: string): HelarcProviderConfig {
  return { providerKind: p.providerKind, baseUrl: p.baseUrl, apiKey, model: p.model,
    timeoutMs: p.timeoutMs, ollamaRuntime: p.ollamaRuntime, modelSettings: p.modelSettings };
}
async function resolve(p: PersistedHelarcProviderProfile, isActive: boolean, credentials: ProviderCredentialStore): Promise<ResolveHelarcStoredProviderProfileResult> {
  const key = p.credentialRef ? await credentials.resolveApiKey(p.credentialRef) : { ok: true as const, apiKey: "", credentialStatus: "empty_allowed" as const };
  if (!key.ok) return key;
  if (p.credentialRef && !key.apiKey) return { ok: false, error: { code: "provider_credential_missing", message: "The configured credential no longer exists. Update Provider settings." } };
  const result = createHelarcProviderProfile({ ...p, isActive, credentialStatus: key.credentialStatus });
  return result.ok ? { ok: true, profile: result.profile, config: configuration(p, key.apiKey ?? "") } : result;
}
function missing(): ResolveHelarcStoredProviderProfileResult {
  return { ok: false, error: { code: "provider_profile_not_found", message: "Provider profile was not found." } };
}
function conflict(message = "Provider profile changed; reload settings."): ResolveHelarcStoredProviderProfileResult {
  return { ok: false, error: { code: "provider_profile_conflict", message } };
}
async function write(file: AtomicFileTransaction, doc: StoreDocument): Promise<void> { await file.replaceText(`${JSON.stringify(doc, null, 2)}\n`); }
