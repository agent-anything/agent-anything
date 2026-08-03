import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileProviderCredentialPersistence,
  ProviderCredentialStore,
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

  it("persists encrypted credential records to files", async () => {
    const directoryPath = await mkdtemp(join(tmpdir(), "helarc-provider-credentials-"));
    await mkdir(directoryPath, { recursive: true });
    const persistence = new FileProviderCredentialPersistence(directoryPath);
    const store = new ProviderCredentialStore(persistence, new PrefixCipher());

    await store.saveApiKey({ profileId: "provider/a", apiKey: "secret-key" });

    const rawRecord = await readFile(join(directoryPath, "provider%2Fa.json"), "utf8");
    expect(rawRecord).toContain("encrypted:c2VjcmV0LWtleQ==");
    expect(rawRecord).not.toContain("secret-key");
    await expect(store.resolveApiKey("provider/a")).resolves.toMatchObject({
      ok: true,
      apiKey: "secret-key",
    });
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
