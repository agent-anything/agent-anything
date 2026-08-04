import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { ProviderCredentialStore, type ProviderCredentialCipher, type ProviderCredentialPersistence, type PersistedProviderCredential } from "./ProviderCredentialStore.js";
import {
  FileHelarcProviderProfileStore,
  HelarcProviderProfileStoreCorruptionError,
} from "./HelarcProviderProfileStore.js";

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
      providerKind: "openai-compatible",
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
        providerKind: "openai-compatible",
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: "secret-key",
        model: "deepseek-chat",
        timeoutMs: 45_000,
      },
      profile: {
        providerKind: "openai-compatible",
        displayName: "DeepSeek",
        baseUrl: "https://api.deepseek.com/v1",
        credentialStatus: "present",
      },
    });
    const persisted = await readFile(profilePath, "utf8");
    expect(persisted).not.toContain("secret-key");
    expect(JSON.parse(persisted)).toMatchObject({
      formatVersion: 1,
      activeProfile: {
        id: "desktop-provider",
        providerKind: "openai-compatible",
      },
    });

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
      providerKind: "openai-compatible",
      displayName: "Local",
      baseUrl: "http://localhost:11434/v1",
      model: "gemma3:4b",
      timeoutMs: 30_000,
      apiKeyUpdate: "clear",
      apiKey: "",
    }, credentialStore);

    const saved = await store.saveActiveProfile({
      providerKind: "openai-compatible",
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
        providerKind: "openai-compatible",
        baseUrl: "http://127.0.0.1:11434/v1",
      },
      profile: {
        providerKind: "openai-compatible",
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
      providerKind: "openai-compatible",
      displayName: "Cloud Provider",
      baseUrl: "https://first.provider/v1",
      model: "model-a",
      timeoutMs: 30_000,
      apiKeyUpdate: "set",
      apiKey: "secret-key",
    }, credentialStore);

    const saved = await store.saveActiveProfile({
      providerKind: "openai-compatible",
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
        providerKind: "openai-compatible",
        baseUrl: "https://second.provider/v1",
        apiKey: "secret-key",
      },
      profile: {
        providerKind: "openai-compatible",
        baseUrl: "https://second.provider/v1",
        credentialStatus: "present",
      },
    });
    await expect(readFile(profilePath, "utf8")).resolves.toContain("https://second.provider/v1");
    await expect(readFile(profilePath, "utf8")).resolves.not.toContain("secret-key");
  });

  it("persists Ollama native provider kind without requiring an API key", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "helarc-provider-profile-store-"));
    const profilePath = join(rootPath, "provider-profile.json");
    const credentialStore = new ProviderCredentialStore(
      new MemoryCredentialPersistence(),
      new PlainTextCipher(),
    );
    const store = new FileHelarcProviderProfileStore(profilePath);

    const saved = await store.saveActiveProfile({
      providerKind: "ollama",
      displayName: "Local Gemma",
      baseUrl: "http://localhost:11434",
      model: "gemma3:4b",
      timeoutMs: 30_000,
      apiKeyUpdate: "clear",
      apiKey: "",
    }, credentialStore);

    expect(saved).toMatchObject({
      ok: true,
      config: {
        providerKind: "ollama",
        baseUrl: "http://localhost:11434/",
        apiKey: "",
      },
      profile: {
        providerKind: "ollama",
        baseUrl: "http://localhost:11434/",
        credentialStatus: "empty_allowed",
      },
    });
    await expect(readFile(profilePath, "utf8")).resolves.toContain("\"providerKind\": \"ollama\"");
  });

  it("serializes settings transactions across Store instances sharing one file", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "helarc-provider-profile-store-"));
    const profilePath = join(rootPath, "provider-profile.json");
    const credentialStore = new ProviderCredentialStore(
      new MemoryCredentialPersistence(),
      new PlainTextCipher(),
    );
    const firstStore = new FileHelarcProviderProfileStore(profilePath);
    const secondStore = new FileHelarcProviderProfileStore(profilePath);

    const [first, second] = await Promise.all([
      firstStore.saveActiveProfile(providerInput({
        displayName: "First",
        baseUrl: "https://first.provider/v1",
      }), credentialStore),
      secondStore.saveActiveProfile(providerInput({
        displayName: "Second",
        baseUrl: "https://second.provider/v1",
      }), credentialStore),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(JSON.parse(await readFile(profilePath, "utf8"))).toMatchObject({
      formatVersion: 1,
      activeProfile: {
        displayName: "Second",
        baseUrl: "https://second.provider/v1",
      },
    });
  });

  it("returns an explicit failure without replacing the prior profile", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "helarc-provider-profile-store-"));
    const profilePath = join(rootPath, "provider-profile.json");
    const credentialStore = new ProviderCredentialStore(
      new MemoryCredentialPersistence(),
      new PlainTextCipher(),
    );
    const workingStore = new FileHelarcProviderProfileStore(profilePath);
    await workingStore.saveActiveProfile(providerInput(), credentialStore);
    const before = await readFile(profilePath, "utf8");
    const failingStore = new FileHelarcProviderProfileStore(profilePath, {
      createTemporaryId: () => "injected-failure",
      operations: {
        async replace() {
          throw new Error("injected replacement failure");
        },
      },
    });

    const result = await failingStore.saveActiveProfile(providerInput({
      displayName: "Not persisted",
      apiKey: "new-secret",
    }), credentialStore);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "provider_profile_persistence_failed",
        message: "Provider profile could not be persisted.",
      },
    });
    expect(JSON.stringify(result)).not.toContain("new-secret");
    expect(await readFile(profilePath, "utf8")).toBe(before);
  });

  it("does not publish or persist profile metadata when credential storage fails", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "helarc-provider-profile-store-"));
    const profilePath = join(rootPath, "provider-profile.json");
    const persistence = new MemoryCredentialPersistence();
    const credentialStore = new ProviderCredentialStore(persistence, new PlainTextCipher());
    const store = new FileHelarcProviderProfileStore(profilePath);
    await store.saveActiveProfile(providerInput(), credentialStore);
    const before = await readFile(profilePath, "utf8");
    persistence.failWrites = true;

    const result = await store.saveActiveProfile(providerInput({
      displayName: "Not published",
      apiKey: "new-secret",
    }), credentialStore);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "provider_credential_persistence_failed",
        message: "Provider credential storage is unavailable.",
      },
    });
    expect(JSON.stringify(result)).not.toContain("new-secret");
    expect(await readFile(profilePath, "utf8")).toBe(before);
  });

  it("fails closed for invalid JSON, old versions, and malformed profiles", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "helarc-provider-profile-store-"));
    const profilePath = join(rootPath, "provider-profile.json");
    const credentialStore = new ProviderCredentialStore(
      new MemoryCredentialPersistence(),
      new PlainTextCipher(),
    );
    const store = new FileHelarcProviderProfileStore(profilePath);

    await writeFile(profilePath, "{invalid", "utf8");
    await expect(store.resolveActiveProfile(credentialStore)).rejects
      .toBeInstanceOf(HelarcProviderProfileStoreCorruptionError);

    await writeFile(profilePath, JSON.stringify({
      id: "desktop-provider",
      displayName: "Old shape",
    }), "utf8");
    await expect(store.resolveActiveProfile(credentialStore)).rejects
      .toBeInstanceOf(HelarcProviderProfileStoreCorruptionError);

    await writeFile(profilePath, JSON.stringify({
      formatVersion: 2,
      activeProfile: {},
    }), "utf8");
    await expect(store.resolveActiveProfile(credentialStore)).rejects
      .toBeInstanceOf(HelarcProviderProfileStoreCorruptionError);

    await writeFile(profilePath, JSON.stringify({
      formatVersion: 1,
      activeProfile: {
        id: "desktop-provider",
        providerKind: "unknown",
        displayName: "Malformed",
        baseUrl: "https://provider.local/v1",
        model: "model-a",
        timeoutMs: 30_000,
        updatedAt: "2026-08-04T00:00:00.000Z",
      },
    }), "utf8");
    await expect(store.saveActiveProfile(providerInput(), credentialStore)).rejects
      .toBeInstanceOf(HelarcProviderProfileStoreCorruptionError);
  });
});

class MemoryCredentialPersistence implements ProviderCredentialPersistence {
  private readonly records = new Map<string, PersistedProviderCredential>();
  failWrites = false;

  async read(profileId: string): Promise<PersistedProviderCredential | null> {
    return this.records.get(profileId) ?? null;
  }

  async write(record: PersistedProviderCredential): Promise<void> {
    if (this.failWrites) {
      throw new Error("injected credential write failure");
    }
    this.records.set(record.profileId, record);
  }

  async delete(profileId: string): Promise<void> {
    this.records.delete(profileId);
  }
}

function providerInput(overrides: Partial<{
  providerKind: "openai-compatible" | "ollama";
  displayName: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  apiKeyUpdate: "keep" | "set" | "clear";
  apiKey: string;
}> = {}) {
  return {
    providerKind: "openai-compatible" as const,
    displayName: "Provider",
    baseUrl: "https://provider.local/v1",
    model: "model-a",
    timeoutMs: 30_000,
    apiKeyUpdate: "set" as const,
    apiKey: "secret-key",
    ...overrides,
  };
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
