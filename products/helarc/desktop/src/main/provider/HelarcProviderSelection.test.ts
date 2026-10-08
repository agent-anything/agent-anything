import { describe, expect, it, vi } from "vitest";
import { createHelarcProviderProfile } from "@agent-anything/helarc/configuration";
import type { FileHelarcProviderProfileStore } from "./HelarcProviderProfileStore.js";
import type { ProviderCredentialStore } from "./ProviderCredentialStore.js";
import { HelarcProviderSelection } from "./HelarcProviderSelection.js";
import { createHelarcProvider } from "./createHelarcProvider.js";

function fixture() {
  const p = createHelarcProviderProfile({ id: "local", revision: "1", providerKind: "ollama", displayName: "Local",
    baseUrl: "http://localhost:11435", model: "model", timeoutMs: 1000, credentialStatus: "empty_allowed",
    ollamaRuntime: { contextWindowTokens: 16384, maximumOutputTokens: 2048 } });
  if (!p.ok) throw Error("profile");
  const stored = { ok: true as const, profile: p.profile, config: { providerKind: "ollama" as const,
    baseUrl: p.profile.baseUrl, model: p.profile.model, apiKey: "", timeoutMs: 1000, ollamaRuntime: p.profile.ollamaRuntime,
    modelSettings: p.profile.modelSettings } };
  const store = { resolveActiveProfile: vi.fn(async () => stored), resolveProfile: vi.fn(async () => stored) };
  const fetch = vi.fn<typeof globalThis.fetch>(async url => new Response(JSON.stringify(String(url).endsWith("/api/tags")
    ? { models: [{ name: "model", digest: "sha256:artifact" }] }
    : { thinking: { values: [false, true], default: true } })));
  const selection = new HelarcProviderSelection(store as unknown as FileHelarcProviderProfileStore, {} as ProviderCredentialStore, fetch);
  return { selection, store, stored, fetch };
}

describe("Provider selection admission", () => {
  it("discovers from an incomplete connection but requires a model for generation", async () => {
    const { selection, stored, fetch } = fixture();
    stored.config.model = "";
    stored.profile.model = "";
    await expect(selection.validateSavedSelection(stored.config)).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    await expect(selection.resolve()).rejects.toThrow("Select a model");
    expect(() => createHelarcProvider(stored.config)).toThrow("Select a model");
    expect(fetch).not.toHaveBeenCalled();
    expect(await selection.discover({ profileId: "local", profileRevision: "1", model: "", refresh: false }))
      .toMatchObject({ ok: true, catalog: { models: [{ id: "model" }] } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]![0])).toContain("/api/tags");
    expect(await selection.resolve({ profileId: "local", profileRevision: "1", model: "model", thinking: { mode: "default" } }))
      .toMatchObject({ ok: true, config: { model: "model" } });
  });
  it("freezes a known default without replacing the saved preference", async () => {
    const { selection, stored, fetch } = fixture();
    const resolved = await selection.resolve();
    expect(resolved?.config.modelSettings?.thinking).toEqual({ mode: "enabled" });
    expect(resolved?.profile.modelSettings?.thinking).toEqual({ mode: "default" });
    expect(stored.config.modelSettings?.thinking).toEqual({ mode: "default" });
    expect(resolved?.config.modelArtifact).toBe("sha256:artifact");
    await selection.resolve();
    expect(fetch).toHaveBeenCalledTimes(2);
    stored.profile = { ...stored.profile, revision: "2", displayName: "Renamed" };
    const next = await selection.resolve();
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(createHelarcProvider(next!.config).descriptor).toEqual(createHelarcProvider(resolved!.config).descriptor);
  });
  it("rejects stale selection and responses that arrive after a profile edit", async () => {
    const { selection, store, stored, fetch } = fixture();
    await expect(selection.resolve({ profileId: "local", profileRevision: "old", model: "model", thinking: { mode: "default" } })).rejects.toThrow("changed");
    expect(fetch).not.toHaveBeenCalled();
    store.resolveActiveProfile.mockResolvedValueOnce(stored).mockResolvedValueOnce({ ...stored, profile: { ...stored.profile, revision: "2" } });
    await expect(selection.resolve()).rejects.toThrow("changed during selection");
  });
  it("rejects an active-profile switch during default resolution", async () => {
    const { selection, store, stored } = fixture();
    store.resolveActiveProfile.mockResolvedValueOnce(stored).mockResolvedValueOnce({ ...stored, profile: { ...stored.profile, id: "other" } });
    await expect(selection.resolve()).rejects.toThrow("changed during selection");
  });
  it("does not silently downgrade unsupported controls", async () => {
    const { selection } = fixture();
    await expect(selection.resolve({ profileId: "local", profileRevision: "1", model: "model", thinking: { mode: "enabled", effort: "max" } })).rejects.toThrow("not supported");
    const disabled = await selection.resolve({ profileId: "local", profileRevision: "1", model: "model", thinking: { mode: "disabled" } });
    expect(disabled?.config.modelSettings?.thinking).toEqual({ mode: "disabled" });
  });
  it("allows an unresolved provider default offline but rejects explicit controls", async () => {
    const { selection, fetch } = fixture();
    fetch.mockRejectedValue(new TypeError("fetch failed"));
    expect((await selection.resolve())?.config.modelSettings?.thinking).toEqual({ mode: "default" });
    await expect(selection.resolve({ profileId: "local", profileRevision: "1", model: "model", thinking: { mode: "disabled" } })).rejects.toThrow("not known");
  });
  it("rejects contradictory metadata rather than assuming a default", async () => {
    const { selection, fetch } = fixture();
    fetch.mockImplementation(async url => new Response(JSON.stringify(String(url).endsWith("/api/tags") ? { models: [] }
      : { thinking: { values: [false], default: true } })));
    await expect(selection.resolve()).rejects.toThrow("inconsistent");
  });
});
