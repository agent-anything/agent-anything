import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { HelarcProviderSelection } from "./HelarcProviderSelection.js";
import { ProviderCredentialStore } from "./ProviderCredentialStore.js";
import { SafeStorageCredentialBackend, type ProviderCredentialCipher, type ProviderCredentialPersistence, type PersistedProviderCredential } from "./SafeStorageCredentialBackend.js";
import { FileHelarcProviderProfileStore, HelarcProviderProfileStoreCorruptionError, type SaveHelarcProviderProfileInput } from "./HelarcProviderProfileStore.js";

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "helarc-provider-profiles-"));
  const path = join(directory, "provider-profile.json");
  const persistence = new MemoryCredentialPersistence();
  const credentials = new ProviderCredentialStore(new SafeStorageCredentialBackend(persistence, new PlainTextCipher()));
  return { path, persistence, credentials, store: new FileHelarcProviderProfileStore(path) };
}
function input(patch: Partial<SaveHelarcProviderProfileInput> = {}): SaveHelarcProviderProfileInput {
  return { providerKind: "openai-compatible", displayName: "Provider", baseUrl: "https://provider.test/v1",
    model: "model", timeoutMs: 30000, ollamaRuntime: null,
    modelSettings: { service: "generic", thinking: { mode: "default" }, maximumOutputTokens: 4096 },
    apiKeyUpdate: "set", apiKey: "secret-key", ...patch };
}
describe("named Provider profiles", () => {
  it("saves a credential before model discovery and keeps it when a model is selected later", async () => {
    const { path, store, credentials, persistence } = await setup();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ data: [{ id: "selected-model" }] })));
    const selector = new HelarcProviderSelection(store, credentials, fetch);
    const saved = await store.saveActiveProfile(input({ model: "" }), credentials, config => selector.validateSavedSelection(config));
    if (!saved.ok) throw Error("Connection save failed");
    expect(fetch).not.toHaveBeenCalled();
    const reopened = new FileHelarcProviderProfileStore(path);
    expect(await reopened.resolveActiveProfile(credentials)).toMatchObject({ ok: true, profile: { model: "" }, config: { apiKey: "secret-key" } });
    const selection = new HelarcProviderSelection(reopened, credentials, fetch);
    await expect(selection.resolve()).rejects.toThrow("Select a model");
    expect(await selection.discover({ profileId: saved.profile.id, profileRevision: saved.profile.revision!, model: "", refresh: false }))
      .toMatchObject({ ok: true, catalog: { models: [{ id: "selected-model" }] } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).get("authorization")).toBe("Bearer secret-key");
    persistence.failWrites = true;
    const updated = await reopened.saveActiveProfile(input({ profileId: saved.profile.id, expectedRevision: saved.profile.revision,
      model: "selected-model", apiKeyUpdate: "keep", apiKey: "" }), credentials, config => selection.validateSavedSelection(config));
    expect(updated).toMatchObject({ ok: true, config: { model: "selected-model", apiKey: "secret-key" } });
    expect(await selection.resolve()).toMatchObject({ ok: true, config: { model: "selected-model" } });
  });
  it("persists independent credentials and defaults across restart and selection", async () => {
    const { path, credentials, store } = await setup();
    const first = await store.saveActiveProfile(input(), credentials);
    const second = await store.saveActiveProfile(input({ displayName: "Second", baseUrl: "https://second.test", apiKey: "second-key" }), credentials);
    if (!first.ok || !second.ok) throw Error("save failed");
    expect(first.profile.id).not.toBe(second.profile.id);
    expect(await readFile(path, "utf8")).not.toContain("secret-key");
    const reopened = new FileHelarcProviderProfileStore(path);
    expect((await reopened.listProfiles(credentials)).map(p => p.isActive)).toEqual([false, true]);
    expect(await reopened.resolveProfile(first.profile.id, credentials)).toMatchObject({ ok: true, config: { apiKey: "secret-key" } });
    expect(await reopened.selectActiveProfile(first.profile.id, credentials)).toMatchObject({ ok: true, profile: { id: first.profile.id } });
    expect(await reopened.resolveActiveProfile(credentials)).toMatchObject({ ok: true, config: { apiKey: "secret-key" } });
  });
  it("requires the expected revision and keeps credentials on cosmetic edits", async () => {
    const { store, credentials } = await setup();
    const saved = await store.saveActiveProfile(input(), credentials);
    if (!saved.ok) throw Error("save failed");
    const update = input({ profileId: saved.profile.id, expectedRevision: saved.profile.revision, displayName: "Renamed", apiKeyUpdate: "keep", apiKey: "" });
    expect(await store.saveActiveProfile(update, credentials)).toMatchObject({ ok: true, config: { apiKey: "secret-key" }, profile: { displayName: "Renamed" } });
    expect(await store.saveActiveProfile(update, credentials)).toMatchObject({ ok: false, error: { code: "provider_profile_conflict" } });
  });
  it("cannot transfer an old credential to a different endpoint", async () => {
    const { store, credentials } = await setup();
    const saved = await store.saveActiveProfile(input(), credentials);
    if (!saved.ok) throw Error("save failed");
    expect(await store.saveActiveProfile(input({ profileId: saved.profile.id, expectedRevision: saved.profile.revision, apiKeyUpdate: "keep", baseUrl: "https://other.test" }), credentials)).toMatchObject({ ok: false });
    expect(await store.resolveActiveProfile(credentials)).toMatchObject({ ok: true, config: { baseUrl: "https://provider.test/v1", apiKey: "secret-key" } });
  });
  it("keeps the old credential and profile if the atomic profile commit fails", async () => {
    const { path, credentials, store } = await setup();
    const saved = await store.saveActiveProfile(input(), credentials);
    if (!saved.ok) throw Error("save failed");
    const before = await readFile(path, "utf8");
    const failing = new FileHelarcProviderProfileStore(path, { operations: { async replace() { throw Error("injected failure"); } } });
    expect(await failing.saveActiveProfile(input({ profileId: saved.profile.id, expectedRevision: saved.profile.revision, apiKey: "replacement-secret" }), credentials)).toMatchObject({ ok: false, error: { code: "provider_profile_persistence_failed" } });
    expect(await readFile(path, "utf8")).toBe(before);
    expect(await store.resolveActiveProfile(credentials)).toMatchObject({ ok: true, config: { apiKey: "secret-key" } });
  });
  it("does not publish a configuration after credential persistence fails", async () => {
    const { store, credentials, persistence } = await setup();
    persistence.failWrites = true;
    expect(await store.saveActiveProfile(input(), credentials)).toMatchObject({ ok: false });
    expect(await store.resolveActiveProfile(credentials)).toBeNull();
  });
  it("keeps the previous profile and credential when selection validation fails", async () => {
    const { path, store, credentials } = await setup();
    const saved = await store.saveActiveProfile(input(), credentials);
    if (!saved.ok) throw Error("save failed");
    const before = await readFile(path, "utf8");
    const result = await store.saveActiveProfile(input({ profileId: saved.profile.id,
      expectedRevision: saved.profile.revision, apiKey: "replacement-secret" }), credentials,
      async () => { throw new Error("Unsupported thinking selection."); });
    expect(result).toMatchObject({ ok: false, error: { message: "Unsupported thinking selection." } });
    expect(await readFile(path, "utf8")).toBe(before);
    expect(await store.resolveActiveProfile(credentials)).toMatchObject({ ok: true, config: { apiKey: "secret-key" } });
  });
  it("deletes only the chosen profile and selects a remaining profile", async () => {
    const { store, credentials } = await setup();
    const first = await store.saveActiveProfile(input(), credentials);
    const second = await store.saveActiveProfile(input({ displayName: "Second" }), credentials);
    if (!first.ok || !second.ok) throw Error("save failed");
    await store.deleteProfile(second.profile.id, second.profile.revision!, credentials);
    expect(await store.resolveActiveProfile(credentials)).toMatchObject({ ok: true, profile: { id: first.profile.id } });
    await expect(store.deleteProfile(first.profile.id, "stale", credentials)).rejects.toThrow();
    await store.deleteProfile(first.profile.id, first.profile.revision!, credentials);
    expect(await store.resolveActiveProfile(credentials)).toBeNull();
  });
  it("serializes concurrent additions without losing either profile", async () => {
    const { path, store, credentials } = await setup();
    await Promise.all([store.saveActiveProfile(input(), credentials),
      new FileHelarcProviderProfileStore(path).saveActiveProfile(input({ displayName: "Second" }), credentials)]);
    expect(await store.listProfiles(credentials)).toHaveLength(2);
  });
  it.each(['{"formatVersion":3,"activeProfile":{}}', "{bad", '{"formatVersion":4,"activeProfileId":"missing","profiles":[]}'])("rejects incompatible or malformed stores", async document => {
    const { path, store, credentials } = await setup();
    await writeFile(path, document);
    await expect(store.resolveActiveProfile(credentials)).rejects.toBeInstanceOf(HelarcProviderProfileStoreCorruptionError);
    await expect(store.saveActiveProfile(input(), credentials)).rejects.toBeInstanceOf(HelarcProviderProfileStoreCorruptionError);
    expect(await readFile(path, "utf8")).toBe(document);
  });
  it("rejects invalid URLs, runtime limits and service/transport combinations before saving credentials", async () => {
    const { store, credentials } = await setup();
    for (const patch of [{ baseUrl: "https://user:secret@provider.test" }, { baseUrl: "http://remote.test" },
      { providerKind: "ollama" as const, ollamaRuntime: null }, { modelSettings: { service: "ollama" as const, thinking: { mode: "default" as const }, maximumOutputTokens: 10 } }]) {
      expect(await store.saveActiveProfile(input(patch), credentials)).toMatchObject({ ok: false });
    }
    expect(await store.listProfiles(credentials)).toEqual([]);
  });
});

class MemoryCredentialPersistence implements ProviderCredentialPersistence {
  private readonly records = new Map<string, PersistedProviderCredential>();
  failWrites = false;
  async read(id: string) { return this.records.get(id) ?? null; }
  async write(record: PersistedProviderCredential) { if (this.failWrites) throw Error("injected failure"); this.records.set(record.profileId, record); }
  async delete(id: string) { this.records.delete(id); }
}
class PlainTextCipher implements ProviderCredentialCipher {
  isEncryptionAvailable() { return true; }
  encryptString(value: string) { return value; }
  decryptString(value: string) { return value; }
}
