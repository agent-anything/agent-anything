import {snapshotProviderDraft} from "./ProviderDraftValidation.js";
import { createHmac, randomBytes } from "node:crypto";
import { ProviderConfigurationError, providerToken, type SaveProviderConfiguration,
  type ProviderConfiguration, type ProviderConfigurationListing, type ProviderConfigurationReceipt } from "../../shared/ProviderConfiguration.js";
import { snapshotCredentialSelection } from "../../shared/HelarcProviderCredentials.js";
import type { ProviderCredentialStore, ProviderCredentialRef } from "./ProviderCredentialStore.js";
import type { ProviderCredentialCipher } from "./SafeStorageCredentialBackend.js";
import type { PrivateConnectionBinding, PrivateCredentialRevision, ProviderDependencyPin, ProviderRegistryPort, ProviderRegistryEvent, CredentialCollectionPage, ProviderRegistryUpdate } from "./ProviderRegistryProtocol.js";
import type { ProviderCustodyObserver } from "./ProviderRegistryClient.js";
import type { ProviderDependencySummary } from "../../shared/ProviderSettingsApi.js";

/** Coordinates protected-store work with durable Host intent. Never carries secrets in registry requests. */
export class ProviderConfigurationService {
  constructor(readonly registry: ProviderRegistryPort, private readonly credentials: ProviderCredentialStore,
    private readonly cipher: ProviderCredentialCipher, private readonly observer?: ProviderCustodyObserver) {}
  async list(): Promise<ProviderConfigurationListing> { return await this.registry.request({ kind: "list" }) as ProviderConfigurationListing; }
  async get(id: string, revision?: string): Promise<ProviderConfiguration | null> {
    return await this.registry.request({ kind: "get", id, ...(revision === undefined ? {} : { revision }) }) as ProviderConfiguration | null;
  }
  async defaultConfiguration(): Promise<ProviderConfiguration | null> { return await this.registry.request({ kind: "default" }) as ProviderConfiguration | null; }
  async receipt(updateId: string): Promise<ProviderConfigurationReceipt | null> {
    return await this.registry.request({ kind: "update_receipt", id: updateId }) as ProviderConfigurationReceipt | null;
  }
  async save(input: SaveProviderConfiguration): Promise<ProviderConfigurationReceipt> {
    providerToken(input.configurationId); providerToken(input.updateId);
    if (!/^[a-f0-9-]{36}$/.test(input.updateId)) throw new ProviderConfigurationError("provider_update_id_invalid");
    const draft = snapshotProviderDraft(input.draft);
    const edit = input.credential;
    let credential: PrivateCredentialRevision | null = null;
    let secret: string | null = null;
    const id = `${input.configurationId}-${input.updateId}`;
    if (edit.kind === "set" || edit.kind === "reference") {
      let ref: ProviderCredentialRef;
      if (edit.kind === "set") {
        if (!["windows-managed", "safe-storage"].includes(edit.storage)) throw new ProviderConfigurationError("provider_credential_storage_invalid");
        secret = validSecret(edit.secret);
        if (edit.storage === "windows-managed" && Buffer.byteLength(secret, "utf16le") > 2560)
          throw new ProviderConfigurationError("provider_credential_invalid");
        ref = edit.storage === "safe-storage" ? { storage: "safe-storage", ownership: "managed", id }
          : { storage: "windows", ownership: "managed", id: `Helarc/Provider/${id}`, encoding: "utf16le" };
      } else {
        snapshotCredentialSelection({ source: "windows-reference", target: edit.target, encoding: edit.encoding });
        ref = { storage: "windows", ownership: "external", id: edit.target, encoding: edit.encoding };
        secret = await this.readSecret(ref, input.updateId);
      }
      credential = { id, ref, equalityTag: await this.tag(ref, secret), status: "staged" };
    } else if (edit.kind !== "keep" && edit.kind !== "none") throw new ProviderConfigurationError("provider_credential_intent_invalid");
    const receipt = await this.registry.request({ kind: "begin_update", update: { id: input.updateId,
      configurationId: input.configurationId, expectedRevision: input.expectedRevision, draft,
      credentialMode: edit.kind === "keep" ? "keep" : edit.kind === "none" ? "none" : "replace", credential } }) as ProviderConfigurationReceipt;
    if (receipt.disposition !== "pending") return receipt;
    if (credential) {
      let stored = await this.vault("read_staged", credential.id, () => this.credentials.resolveApiKey(credential.ref));
      if (!stored.ok) throw new ProviderConfigurationError(stored.error.code);
      if (stored.apiKey === null) {
        if (edit.kind !== "set" || secret === null) throw new ProviderConfigurationError("provider_credential_missing");
        const staged = await this.vault("stage", credential.id, () => this.credentials.stage(id, secret!, { source: edit.storage }));
        if (!staged.ok) throw new ProviderConfigurationError(staged.error.code);
        if (JSON.stringify(staged.ref) !== JSON.stringify(credential.ref)) throw new ProviderConfigurationError("provider_credential_reference_mismatch");
        stored = await this.vault("verify_staged", credential.id, () => this.credentials.resolveApiKey(credential!.ref));
      }
      if (!stored.ok || !stored.apiKey) throw new ProviderConfigurationError("provider_credential_verification_failed");
      const equalityTag = await this.tag(credential.ref, stored.apiKey);
      await this.registry.request({ kind: "verify_credential", id: credential.id, equalityTag });
    }
    try { return await this.registry.request({ kind: "publish_update", id: input.updateId }) as ProviderConfigurationReceipt; }
    catch (error) {
      // Only a definitive conflict after our vault operation has settled proves abandonment.
      if (error instanceof ProviderConfigurationError && error.code === "provider_configuration_conflict")
        await this.registry.request({ kind: "abandon_update", id: input.updateId });
      throw error;
    }
  }
  async activate(id: string, revision: string, canExecute: (configuration: ProviderConfiguration) => void): Promise<ProviderConfiguration> {
    const configuration = await this.get(id, revision);
    if (!configuration) throw new ProviderConfigurationError("provider_configuration_missing");
    canExecute(configuration);
    return await this.registry.request({ kind: "activate", id, revision }) as ProviderConfiguration;
  }
  async archive(id: string, revision: string): Promise<void> { await this.registry.request({ kind: "archive", id, revision }); }
  async binding(id: string): Promise<PrivateConnectionBinding> { return await this.registry.request({ kind: "binding", id }) as PrivateConnectionBinding; }
  async dependencies(id: string): Promise<ProviderDependencySummary> { return await this.registry.request({ kind: "dependencies", id }) as ProviderDependencySummary; }
  async credentialSettings(id: string | null): Promise<import("../../shared/HelarcProviderCredentials.js").HelarcCredentialSettings> {
    const ref = id === null ? null : (await this.binding(id)).credential?.ref;
    const windowsAvailable = await this.credentials.windowsAvailable();
    return { windowsAvailable, selection: !ref && windowsAvailable ? { source: "windows-managed" } : ref?.storage === "windows"
      ? ref.ownership === "external" ? { source: "windows-reference", target: ref.id, encoding: ref.encoding } : { source: "windows-managed" }
      : { source: "safe-storage" } };
  }
  /** The callback is the trusted sender; no consumer receives a reusable public secret-bearing configuration. */
  async withConnection<T>(id: string, send: (configuration: ProviderConfiguration, secret: string) => Promise<T>): Promise<T> {
    const binding = await this.binding(id);
    if (binding.revoked) throw new ProviderConfigurationError("provider_binding_revoked");
    let secret = "";
    if (binding.credential) {
      if (binding.credential.status !== "verified") throw new ProviderConfigurationError("provider_credential_not_usable");
      try {
        secret = await this.readSecret(binding.credential.ref, binding.id);
        if (await this.tag(binding.credential.ref, secret, false) !== binding.credential.equalityTag) throw new ProviderConfigurationError("provider_credential_changed");
        await this.registry.request({ kind:"availability",id,revision:binding.revision,status:"locally_resolvable" });
      } catch(error) {
        const code=error instanceof ProviderConfigurationError?error.code:"";
        await this.registry.request({kind:"availability",id,revision:binding.revision,status:code==="provider_credential_missing"?"missing":code==="provider_credential_changed"?"changed":"unavailable"}).catch(()=>{});
        throw error;
      }
    }
    // Linearize permission after the vault read; pass those exact bytes to the sender, never re-resolve them.
    await this.registry.request({ kind: "authorize", id, revision: binding.revision, credentialId: binding.credential?.id ?? null });
    return send(binding.configuration, secret);
  }
  async pin(pin: ProviderDependencyPin): Promise<void> { await this.registry.request({ kind: "pin", pin }); }
  async readPin(id: string): Promise<ProviderDependencyPin | null> { return await this.registry.request({ kind: "read_pin", id }) as ProviderDependencyPin | null; }
  async settlePin(id: string, acceptanceId: string, disposition: "confirmed" | "released"): Promise<void> {
    await this.registry.request({ kind: "settle_pin", id, acceptanceId, disposition });
  }
  async pins(after = "", limit = 100, bindingId?: string): Promise<readonly ProviderDependencyPin[]> {
    return await this.registry.request({ kind: "pins", after, limit, ...(bindingId ? { bindingId } : {}) }) as readonly ProviderDependencyPin[];
  }
  async repair(id: string, revision: number, replacementBindingId: string, confirmedSameScope: boolean): Promise<void> {
    await this.withConnection(replacementBindingId, async () => undefined);
    await this.registry.request({ kind: "repair", id, revision, replacementBindingId, confirmedSameScope });
  }
  async revoke(id: string, revision: number): Promise<void> { await this.registry.request({ kind: "revoke", id, revision }); }
  async destroyCredential(id: string, revision: number): Promise<void> {
    const credential = await this.registry.request({ kind: "destroy_credential", id, revision }) as PrivateCredentialRevision;
    await this.vault("destroy", credential.id, () => this.credentials.deleteApiKey(credential.ref));
    await this.registry.request({ kind: "finish_collection", id: credential.id });
  }
  async collect(after = "", limit = 100): Promise<{ examined: number; deleted: number; failed: number; next: string | null }> {
    const page = await this.registry.request({ kind: "collectible", after, limit }) as CredentialCollectionPage;
    let deleted = 0, failed = 0;
    for (const candidate of page.candidates) {
      try {
        const claimed = await this.registry.request({ kind: "claim_collection", id: candidate.id }) as PrivateCredentialRevision | null;
        if (!claimed) continue;
        await this.vault("delete", candidate.id, () => this.credentials.deleteApiKey(claimed.ref));
        await this.registry.request({ kind: "finish_collection", id: candidate.id }); deleted++;
      } catch { failed++; }
    }
    return { examined: page.examined, deleted, failed, next: page.next };
  }
  async events(after = 0, limit = 100): Promise<readonly ProviderRegistryEvent[]> {
    return await this.registry.request({ kind: "events", after, limit }) as readonly ProviderRegistryEvent[];
  }
  /** Reconcile exact staged identities; never create a replacement key or infer that an uncertain writer is dead. */
  async reconcileUpdates(after = "", limit = 100): Promise<{ resolved: number; retained: number; next: string | null }> {
    const updates = await this.registry.request({ kind: "pending_updates", after, limit }) as readonly ProviderRegistryUpdate[];
    let resolved = 0, retained = 0;
    for (const update of updates) {
      try {
        if (update.credential) {
          const secret = await this.readSecret(update.credential.ref, update.id);
          const equalityTag = await this.tag(update.credential.ref, secret, false);
          await this.registry.request({ kind: "verify_credential", id: update.credential.id, equalityTag });
        }
        await this.registry.request({ kind: "publish_update", id: update.id }); resolved++;
      } catch { retained++; }
    }
    return { resolved, retained, next: updates.length === limit ? updates.at(-1)!.id : null };
  }
  private async readSecret(ref: ProviderCredentialRef, subject: string): Promise<string> {
    const result = await this.vault("resolve", subject, () => this.credentials.resolveApiKey(ref));
    if (!result.ok) throw new ProviderConfigurationError(result.error.code);
    if (result.apiKey === null) throw new ProviderConfigurationError("provider_credential_missing");
    return validSecret(result.apiKey);
  }
  private async tag(ref: ProviderCredentialRef, secret: string, allowCreate = true): Promise<string> {
    let sealed = await this.registry.request({ kind: "key_basis" }) as string | null;
    if (!sealed) {
      if (!allowCreate) throw new ProviderConfigurationError("provider_credential_check_basis_missing");
      if (!this.cipher.isEncryptionAvailable()) throw new ProviderConfigurationError("provider_credential_encryption_unavailable");
      const generated = randomBytes(32);
      try { sealed = await this.registry.request({ kind: "key_basis", sealed: this.cipher.encryptString(generated.toString("hex")) }) as string; }
      finally { generated.fill(0); }
    }
    let raw: string;
    try { raw = this.cipher.decryptString(sealed); } catch { throw new ProviderConfigurationError("provider_credential_check_basis_unavailable"); }
    if (!/^[a-f0-9]{64}$/.test(raw)) throw new ProviderConfigurationError("provider_credential_check_basis_invalid");
    const key = Buffer.from(raw, "hex");
    try { return createHmac("sha256", key).update(JSON.stringify(ref)).update("\0").update(secret, "utf8").digest("hex"); }
    finally { key.fill(0); }
  }
  private async vault<T>(operation: string, subjectId: string, work: () => Promise<T>): Promise<T> {
    const start = performance.now(); let outcome: "ok" | "rejected" = "ok";
    try { const result = await work(); if (result && typeof result === "object" && "ok" in result && result.ok === false) outcome = "rejected"; return result; }
    catch (error) { outcome = "rejected"; throw error; }
    finally { try { this.observer?.({ operation, subjectId, stage: "vault", durationMs: performance.now() - start, outcome }); } catch { /* Independent observer. */ } }
  }
}
function validSecret(value: string): string {
  if (typeof value !== "string" || !value || value !== value.trim() || /[\r\n\u0000]/u.test(value) || Buffer.byteLength(value, "utf8") > 16384)
    throw new ProviderConfigurationError("provider_credential_invalid");
  return value;
}
