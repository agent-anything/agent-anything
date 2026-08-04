import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileProviderCredentialPersistence,
  ProviderCredentialStore,
  ProviderCredentialStoreCorruptionError,
  type PersistedProviderCredential,
  type ProviderCredentialCipher,
  type ProviderCredentialPersistence,
} from "./ProviderCredentialStore.js";

describe("ProviderCredentialStore", () => {
  it("stores encrypted credentials and resolves decrypted credentials in main", async () => {
    const persistence = new MemoryCredentialPersistence();
    const store = new ProviderCredentialStore(persistence, new PrefixCipher());

    await expect(store.saveApiKey({
      profileId: "provider-a",
      apiKey: " secret-key ",
    })).resolves.toEqual({
      ok: true,
      credentialStatus: "present",
    });

    expect(persistence.records.get("provider-a")).toMatchObject({
      profileId: "provider-a",
      encryptedApiKey: "encrypted:c2VjcmV0LWtleQ==",
    });
    expect(JSON.stringify(persistence.records.get("provider-a"))).not.toContain("secret-key");

    await expect(store.resolveApiKey("provider-a")).resolves.toEqual({
      ok: true,
      apiKey: "secret-key",
      credentialStatus: "present",
    });
  });

  it("reports missing credentials without exposing a raw key", async () => {
    const store = new ProviderCredentialStore(
      new MemoryCredentialPersistence(),
      new PrefixCipher(),
    );

    await expect(store.resolveApiKey("provider-a")).resolves.toEqual({
      ok: true,
      apiKey: null,
      credentialStatus: "missing",
    });
  });

  it("deletes credentials for empty or explicit delete requests", async () => {
    const persistence = new MemoryCredentialPersistence();
    const store = new ProviderCredentialStore(persistence, new PrefixCipher());

    await store.saveApiKey({ profileId: "provider-a", apiKey: "secret-key" });
    await expect(store.saveApiKey({ profileId: "provider-a", apiKey: " " })).resolves.toEqual({
      ok: true,
      credentialStatus: "empty_allowed",
    });
    await expect(store.resolveApiKey("provider-a")).resolves.toMatchObject({
      ok: true,
      credentialStatus: "missing",
    });

    await store.saveApiKey({ profileId: "provider-a", apiKey: "secret-key" });
    await expect(store.deleteApiKey("provider-a")).resolves.toEqual({
      ok: true,
      credentialStatus: "missing",
    });
    expect(persistence.records.has("provider-a")).toBe(false);
  });

  it("does not persist non-empty credentials when encryption is unavailable", async () => {
    const persistence = new MemoryCredentialPersistence();
    const store = new ProviderCredentialStore(persistence, new UnavailableCipher());

    await expect(store.saveApiKey({
      profileId: "provider-a",
      apiKey: "secret-key",
    })).resolves.toEqual({
      ok: false,
      error: {
        code: "provider_credential_encryption_unavailable",
        message: "Provider credential encryption is unavailable.",
      },
    });
    expect(persistence.records.size).toBe(0);
  });

  it("does not persist a credential when encryption throws", async () => {
    const persistence = new MemoryCredentialPersistence();
    const store = new ProviderCredentialStore(persistence, new ThrowingCipher());

    const result = await store.saveApiKey({
      profileId: "provider-a",
      apiKey: "secret-key",
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "provider_credential_encryption_failed",
        message: "Provider credential could not be encrypted.",
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret-key");
    expect(persistence.records.size).toBe(0);
  });

  it("persists encrypted credential records to files", async () => {
    const directoryPath = await mkdtemp(join(tmpdir(), "helarc-provider-credentials-"));
    await mkdir(directoryPath, { recursive: true });
    const persistence = new FileProviderCredentialPersistence(directoryPath);
    const store = new ProviderCredentialStore(persistence, new PrefixCipher());

    await store.saveApiKey({ profileId: "provider/a", apiKey: "secret-key" });

    const rawRecord = await readFile(join(directoryPath, "provider%2Fa.json"), "utf8");
    expect(rawRecord).toContain("encrypted:c2VjcmV0LWtleQ==");
    expect(rawRecord).not.toContain("secret-key");
    expect(JSON.parse(rawRecord)).toMatchObject({
      formatVersion: 1,
      credential: {
        profileId: "provider/a",
      },
    });
    await expect(store.resolveApiKey("provider/a")).resolves.toMatchObject({
      ok: true,
      apiKey: "secret-key",
    });
  });

  it("serializes credential writes across Persistence instances", async () => {
    const directoryPath = await mkdtemp(join(tmpdir(), "helarc-provider-credentials-"));
    const firstStore = new ProviderCredentialStore(
      new FileProviderCredentialPersistence(directoryPath),
      new PrefixCipher(),
    );
    const secondStore = new ProviderCredentialStore(
      new FileProviderCredentialPersistence(directoryPath),
      new PrefixCipher(),
    );

    const [first, second] = await Promise.all([
      firstStore.saveApiKey({ profileId: "provider-a", apiKey: "first-key" }),
      secondStore.saveApiKey({ profileId: "provider-a", apiKey: "second-key" }),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    await expect(firstStore.resolveApiKey("provider-a")).resolves.toEqual({
      ok: true,
      apiKey: "second-key",
      credentialStatus: "present",
    });
  });

  it("preserves the prior credential when replacement or removal fails", async () => {
    const directoryPath = await mkdtemp(join(tmpdir(), "helarc-provider-credentials-"));
    const workingStore = new ProviderCredentialStore(
      new FileProviderCredentialPersistence(directoryPath),
      new PrefixCipher(),
    );
    await workingStore.saveApiKey({ profileId: "provider-a", apiKey: "first-key" });
    const recordPath = join(directoryPath, "provider-a.json");
    const before = await readFile(recordPath, "utf8");

    const replacementFailure = new ProviderCredentialStore(
      new FileProviderCredentialPersistence(directoryPath, {
        createTemporaryId: () => "injected-replacement-failure",
        operations: {
          async replace() {
            throw new Error("injected replacement failure");
          },
        },
      }),
      new PrefixCipher(),
    );
    await expect(replacementFailure.saveApiKey({
      profileId: "provider-a",
      apiKey: "second-key",
    })).resolves.toMatchObject({
      ok: false,
      error: { code: "provider_credential_persistence_failed" },
    });
    expect(await readFile(recordPath, "utf8")).toBe(before);
    expect(await readdir(directoryPath)).toEqual(["provider-a.json"]);

    const removalFailure = new ProviderCredentialStore(
      new FileProviderCredentialPersistence(directoryPath, {
        operations: {
          async remove() {
            throw new Error("injected removal failure");
          },
        },
      }),
      new PrefixCipher(),
    );
    await expect(removalFailure.deleteApiKey("provider-a")).resolves.toMatchObject({
      ok: false,
      error: { code: "provider_credential_persistence_failed" },
    });
    expect(await readFile(recordPath, "utf8")).toBe(before);
  });

  it("fails closed for invalid JSON, old versions, malformed records, and identity mismatch", async () => {
    const directoryPath = await mkdtemp(join(tmpdir(), "helarc-provider-credentials-"));
    const recordPath = join(directoryPath, "provider-a.json");
    const secret = "secret-provider-key";
    const store = new ProviderCredentialStore(
      new FileProviderCredentialPersistence(directoryPath),
      new PrefixCipher(),
    );

    await writeFile(recordPath, `{invalid:${secret}`, "utf8");
    try {
      await store.resolveApiKey("provider-a");
      throw new Error("Expected credential corruption.");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderCredentialStoreCorruptionError);
      expect(String(error)).not.toContain(secret);
      expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    }

    await writeFile(recordPath, JSON.stringify({
      profileId: "provider-a",
      encryptedApiKey: "encrypted:value",
      updatedAt: "2026-08-04T00:00:00.000Z",
    }), "utf8");
    await expect(store.resolveApiKey("provider-a")).rejects
      .toBeInstanceOf(ProviderCredentialStoreCorruptionError);

    await writeFile(recordPath, JSON.stringify({
      formatVersion: 2,
      credential: {},
    }), "utf8");
    await expect(store.resolveApiKey("provider-a")).rejects
      .toBeInstanceOf(ProviderCredentialStoreCorruptionError);

    await writeFile(recordPath, JSON.stringify({
      formatVersion: 1,
      credential: {
        profileId: "provider-b",
        encryptedApiKey: "encrypted:value",
        updatedAt: "2026-08-04T00:00:00.000Z",
      },
    }), "utf8");
    await expect(store.saveApiKey({
      profileId: "provider-a",
      apiKey: "replacement-key",
    })).rejects.toBeInstanceOf(ProviderCredentialStoreCorruptionError);
  });
});

class MemoryCredentialPersistence implements ProviderCredentialPersistence {
  readonly records = new Map<string, PersistedProviderCredential>();

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

class PrefixCipher implements ProviderCredentialCipher {
  isEncryptionAvailable(): boolean {
    return true;
  }

  encryptString(value: string): string {
    return `encrypted:${Buffer.from(value, "utf8").toString("base64")}`;
  }

  decryptString(value: string): string {
    if (!value.startsWith("encrypted:")) {
      throw new Error("Invalid encrypted payload.");
    }
    return Buffer.from(value.slice("encrypted:".length), "base64").toString("utf8");
  }
}

class UnavailableCipher implements ProviderCredentialCipher {
  isEncryptionAvailable(): boolean {
    return false;
  }

  encryptString(_value: string): string {
    throw new Error("Encryption unavailable.");
  }

  decryptString(_value: string): string {
    throw new Error("Encryption unavailable.");
  }
}

class ThrowingCipher implements ProviderCredentialCipher {
  isEncryptionAvailable(): boolean {
    return true;
  }

  encryptString(_value: string): string {
    throw new Error("injected encryption failure");
  }

  decryptString(_value: string): string {
    throw new Error("not used");
  }
}
