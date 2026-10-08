import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileHelarcProviderProfileStore, type SaveHelarcProviderProfileInput } from "./HelarcProviderProfileStore.js";
import { ProviderCredentialStore, type WindowsCredentialBackend } from "./ProviderCredentialStore.js";
import { SafeStorageCredentialBackend, FileProviderCredentialPersistence } from "./SafeStorageCredentialBackend.js";

const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) {
    const target = resolve(dir);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("helarc-credential-tests-")) throw new Error("Invalid test cleanup target.");
    await rm(target, { recursive: true, force: true });
  }
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "helarc-credential-tests-")); directories.push(directory);
  const path = join(directory, "profiles.json");
  const values = new Map<string, string>();
  const windows: WindowsCredentialBackend = { available: vi.fn(async () => true),
    read: vi.fn(async target => values.get(target) ?? null),
    create: vi.fn(async (target, key) => { if (values.has(target)) throw new Error(); values.set(target, key); }),
    delete: vi.fn(async target => { values.delete(target); }) };
  const credentials = new ProviderCredentialStore(new SafeStorageCredentialBackend(new FileProviderCredentialPersistence(join(directory, "keys")),
    { isEncryptionAvailable: () => true, encryptString: text => `encrypted:${text}`, decryptString: text => text.slice(10) }), windows);
  const store = new FileHelarcProviderProfileStore(path);
  return { path, values, windows, credentials, store };
}
function input(patch: Partial<SaveHelarcProviderProfileInput> = {}): SaveHelarcProviderProfileInput {
  return { providerKind: "openai-compatible", displayName: "Provider", baseUrl: "https://provider.test/v1", model: "model",
    timeoutMs: 30000, ollamaRuntime: null, modelSettings: { service: "generic", thinking: { mode: "default" }, maximumOutputTokens: 4096 },
    apiKeyUpdate: "set", apiKey: "dummy-key", ...patch };
}

describe("credential storage ownership", () => {
  it("references external Windows credentials without copying, updating or deleting them", async () => {
    const { store, credentials, windows, values, path } = await setup();
    values.set("Example/DeepSeek", "external-secret");
    const saved = await store.saveActiveProfile(input({ apiKeyUpdate: "reference", apiKey: "",
      credential: { source: "windows-reference", target: "Example/DeepSeek", encoding: "utf8" } }), credentials);
    if (!saved.ok) throw new Error("save failed");
    expect(saved.config.apiKey).toBe("external-secret");
    expect(await store.credentialSelection(saved.profile.id, saved.profile.revision!)).toEqual({ source: "windows-reference", target: "Example/DeepSeek", encoding: "utf8" });
    expect(windows.read).toHaveBeenCalledWith("Example/DeepSeek", "utf8");
    expect(await readFile(path, "utf8")).not.toContain("external-secret");
    const edit = await store.saveActiveProfile(input({ profileId: saved.profile.id, expectedRevision: saved.profile.revision,
      displayName: "Renamed", apiKeyUpdate: "keep", apiKey: "" }), credentials);
    if (!edit.ok) throw new Error("save failed");
    await store.deleteProfile(edit.profile.id, edit.profile.revision!, credentials);
    expect(values.get("Example/DeepSeek")).toBe("external-secret");
    expect(windows.create).not.toHaveBeenCalled(); expect(windows.delete).not.toHaveBeenCalled();
  });
  it("rejects a missing reference before commit and preserves the prior credential", async () => {
    const { store, credentials, path } = await setup();
    const saved = await store.saveActiveProfile(input(), credentials);
    if (!saved.ok) throw new Error();
    const before = await readFile(path, "utf8");
    expect(await store.saveActiveProfile(input({ profileId: saved.profile.id, expectedRevision: saved.profile.revision,
      apiKeyUpdate: "reference", apiKey: "", credential: { source: "windows-reference", target: "Missing", encoding: "utf16le" } }), credentials))
      .toMatchObject({ ok: false, error: { code: "provider_credential_missing" } });
    expect(await readFile(path, "utf8")).toBe(before);
    expect(await store.resolveActiveProfile(credentials)).toMatchObject({ ok: true, config: { apiKey: "dummy-key" } });
  });
  it("moves a managed key between explicit backends without a renderer secret round trip", async () => {
    const { store, credentials, windows, values } = await setup();
    const saved = await store.saveActiveProfile(input(), credentials);
    if (!saved.ok) throw new Error();
    const moved = await store.saveActiveProfile(input({ profileId: saved.profile.id, expectedRevision: saved.profile.revision,
      apiKeyUpdate: "keep", apiKey: "", credential: { source: "windows-managed" } }), credentials);
    if (!moved.ok) throw new Error();
    expect(values.size).toBe(1);
    expect(await store.credentialSelection(moved.profile.id, moved.profile.revision!)).toEqual({ source: "windows-managed" });
    expect(await store.resolveActiveProfile(credentials)).toMatchObject({ ok: true, config: { apiKey: "dummy-key" } });
    const back = await store.saveActiveProfile(input({ profileId: moved.profile.id, expectedRevision: moved.profile.revision,
      apiKeyUpdate: "keep", apiKey: "", credential: { source: "safe-storage" } }), credentials);
    expect(back).toMatchObject({ ok: true, config: { apiKey: "dummy-key" } });
    expect(values.size).toBe(0); expect(windows.delete).toHaveBeenCalledOnce();
  });
  it("rolls back only the staged managed credential on failed profile commit", async () => {
    const { store, credentials, values, path } = await setup();
    const saved = await store.saveActiveProfile(input({ credential: { source: "windows-managed" } }), credentials);
    if (!saved.ok) throw new Error();
    const before = await readFile(path, "utf8"), target = [...values.keys()][0]!;
    const failing = new FileHelarcProviderProfileStore(path, { operations: { async replace() { throw new Error(); } } });
    expect(await failing.saveActiveProfile(input({ profileId: saved.profile.id, expectedRevision: saved.profile.revision,
      apiKey: "replacement", credential: { source: "windows-managed" } }), credentials)).toMatchObject({ ok: false });
    expect(await readFile(path, "utf8")).toBe(before); expect([...values.keys()]).toEqual([target]);
    expect(values.get(target)).toBe("dummy-key");
  });
  it("allows repairing disappeared credentials and does not fall back to local storage", async () => {
    const { store, credentials, values, windows } = await setup();
    values.set("External", "external-secret");
    const saved = await store.saveActiveProfile(input({ apiKeyUpdate: "reference", apiKey: "",
      credential: { source: "windows-reference", target: "External", encoding: "utf16le" } }), credentials);
    if (!saved.ok) throw new Error();
    values.clear();
    expect(await store.resolveActiveProfile(credentials)).toMatchObject({ ok: false, error: { code: "provider_credential_missing" } });
    expect(await store.listProfiles(credentials)).toMatchObject([{ id: saved.profile.id, credentialStatus: "missing" }]);
    vi.mocked(windows.available).mockResolvedValue(false);
    expect(await store.resolveActiveProfile(credentials)).toMatchObject({ ok: false, error: { code: "provider_credential_unavailable" } });
    const repaired = await store.saveActiveProfile(input({ profileId: saved.profile.id, expectedRevision: saved.profile.revision,
      credential: { source: "safe-storage" } }), credentials);
    expect(repaired).toMatchObject({ ok: true });
    expect(windows.create).not.toHaveBeenCalled(); expect(windows.delete).not.toHaveBeenCalled();
  });
  it("rejects forged ownership and implicit transfer across endpoints", async () => {
    const { store, credentials, path } = await setup();
    const saved = await store.saveActiveProfile(input({ credential: { source: "windows-managed" } }), credentials);
    if (!saved.ok) throw new Error();
    expect(await store.saveActiveProfile(input({ profileId: saved.profile.id, expectedRevision: saved.profile.revision,
      apiKeyUpdate: "keep", apiKey: "", baseUrl: "https://different.test", credential: { source: "safe-storage" } }), credentials)).toMatchObject({ ok: false });
    expect(await store.saveActiveProfile(input({ apiKeyUpdate: "reference", apiKey: "", credential: {
      source: "windows-reference", target: "hELARC/pROVIDER/something", encoding: "utf16le" } }), credentials)).toMatchObject({ ok: false });
    const doc = JSON.parse(await readFile(path, "utf8"));
    doc.profiles[0].credentialRef.id = "External";
    await writeFile(path, JSON.stringify(doc));
    await expect(store.listProfiles(credentials)).rejects.toThrow("shape is invalid");
  });
  it("reports post-commit cleanup failure without claiming the save was rolled back", async () => {
    const { store, credentials, windows } = await setup();
    const saved = await store.saveActiveProfile(input({ credential: { source: "windows-managed" } }), credentials);
    if (!saved.ok) throw new Error();
    vi.mocked(windows.delete).mockRejectedValue(new Error("storage unavailable"));
    const result = await store.saveActiveProfile(input({ profileId: saved.profile.id, expectedRevision: saved.profile.revision,
      credential: { source: "safe-storage" }, apiKey: "new-key" }), credentials);
    expect(result).toMatchObject({ ok: true, cleanupWarning: expect.stringContaining("Provider saved") });
    expect(await store.resolveActiveProfile(credentials)).toMatchObject({ ok: true, config: { apiKey: "new-key" } });
  });
});
