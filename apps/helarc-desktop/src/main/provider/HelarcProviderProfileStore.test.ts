import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { ProviderCredentialStore, type ProviderCredentialCipher, type ProviderCredentialPersistence, type PersistedProviderCredential } from "./ProviderCredentialStore.js";
import { FileHelarcProviderProfileStore } from "./HelarcProviderProfileStore.js";

describe("FileHelarcProviderProfileStore", () => {
  it("persists safe provider metadata and resolves credentials through the credential store", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "helarc-provider-profile-store-"));
    const profilePath = join(rootPath, "provider-profile.json");
    const credentialStore = new ProviderCredentialStore(
      new MemoryCredentialPersistence(),
      new PlainTextCipher(),
    );
    const store = new FileHelarcProviderProfileStore(profilePath);

    const saved = await store.saveActiveProfile({
      displayName: "DeepSeek",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
      timeoutMs: 45_000,
      apiKeyUpdate: "set",
      apiKey: " secret-key ",
    }, credentialStore);

    expect(saved).toMatchObject({
      ok: true,
      config: {
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: "secret-key",
        model: "deepseek-chat",
        timeoutMs: 45_000,
      },
      profile: {
        displayName: "DeepSeek",
        baseUrl: "https://api.deepseek.com/v1",
        credentialStatus: "present",
      },
    });
    await expect(readFile(profilePath, "utf8")).resolves.not.toContain("secret-key");

    const restored = await new FileHelarcProviderProfileStore(profilePath)
      .resolveActiveProfile(credentialStore);

    expect(restored).toMatchObject({
      ok: true,
      config: {
        apiKey: "secret-key",
      },
      profile: {
        credentialStatus: "present",
      },
    });
  });

  it("overwrites persisted base URL when provider settings are saved again", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "helarc-provider-profile-store-"));
    const profilePath = join(rootPath, "provider-profile.json");
    const credentialStore = new ProviderCredentialStore(
      new MemoryCredentialPersistence(),
      new PlainTextCipher(),
    );
    const store = new FileHelarcProviderProfileStore(profilePath);

    await store.saveActiveProfile({
      displayName: "Local",
      baseUrl: "http://localhost:11434/v1",
      model: "gemma3:4b",
      timeoutMs: 30_000,
      apiKeyUpdate: "clear",
      apiKey: "",
    }, credentialStore);

    const saved = await store.saveActiveProfile({
      displayName: "Local",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "gemma3:4b",
      timeoutMs: 30_000,
      apiKeyUpdate: "clear",
      apiKey: "",
    }, credentialStore);

    expect(saved).toMatchObject({
      ok: true,
      config: {
        baseUrl: "http://127.0.0.1:11434/v1",
      },
      profile: {
        baseUrl: "http://127.0.0.1:11434/v1",
        baseUrlOrigin: "http://127.0.0.1:11434",
      },
    });
    await expect(readFile(profilePath, "utf8")).resolves.toContain("http://127.0.0.1:11434/v1");

    const restored = await new FileHelarcProviderProfileStore(profilePath)
      .resolveActiveProfile(credentialStore);

    expect(restored).toMatchObject({
      ok: true,
      config: {
        baseUrl: "http://127.0.0.1:11434/v1",
      },
      profile: {
        baseUrl: "http://127.0.0.1:11434/v1",
      },
    });
  });

  it("keeps an existing API key when only base URL is changed", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "helarc-provider-profile-store-"));
    const profilePath = join(rootPath, "provider-profile.json");
    const credentialStore = new ProviderCredentialStore(
      new MemoryCredentialPersistence(),
      new PlainTextCipher(),
    );
    const store = new FileHelarcProviderProfileStore(profilePath);

    await store.saveActiveProfile({
      displayName: "Cloud Provider",
      baseUrl: "https://first.provider/v1",
      model: "model-a",
      timeoutMs: 30_000,
      apiKeyUpdate: "set",
      apiKey: "secret-key",
    }, credentialStore);

    const saved = await store.saveActiveProfile({
      displayName: "Cloud Provider",
      baseUrl: "https://second.provider/v1",
      model: "model-a",
      timeoutMs: 30_000,
      apiKeyUpdate: "keep",
      apiKey: "",
    }, credentialStore);

    expect(saved).toMatchObject({
      ok: true,
      config: {
        baseUrl: "https://second.provider/v1",
        apiKey: "secret-key",
      },
      profile: {
        baseUrl: "https://second.provider/v1",
        credentialStatus: "present",
      },
    });
    await expect(readFile(profilePath, "utf8")).resolves.toContain("https://second.provider/v1");
    await expect(readFile(profilePath, "utf8")).resolves.not.toContain("secret-key");
  });
});

class MemoryCredentialPersistence implements ProviderCredentialPersistence {
  private readonly records = new Map<string, PersistedProviderCredential>();

  async read(profileId: string): Promise<PersistedProviderCredential | null> {
    return this.records.get(profileId) ?? null;
  }

  async write(record: PersistedProviderCredential): Promise<void> {
    this.records.set(record.profileId, record);
  }

  async delete(profileId: string): Promise<void> {
    this.records.delete(profileId);
  }
}

class PlainTextCipher implements ProviderCredentialCipher {
  isEncryptionAvailable(): boolean {
    return true;
  }

  encryptString(value: string): string {
    return value;
  }

  decryptString(value: string): string {
    return value;
  }
}
