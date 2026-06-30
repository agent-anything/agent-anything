import type { HelarcProviderCredentialStatus } from "@agent-anything/helarc";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface PersistedProviderCredential {
  profileId: string;
  encryptedApiKey: string;
  updatedAt: string;
}

export interface ProviderCredentialPersistence {
  read(profileId: string): Promise<PersistedProviderCredential | null>;
  write(record: PersistedProviderCredential): Promise<void>;
  delete(profileId: string): Promise<void>;
}

export interface ProviderCredentialCipher {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): string;
  decryptString(value: string): string;
}

export type ProviderCredentialStoreErrorCode =
  | "provider_credential_profile_id_required"
  | "provider_credential_encryption_unavailable"
  | "provider_credential_decryption_failed";

export interface ProviderCredentialStoreError {
  code: ProviderCredentialStoreErrorCode;
  message: string;
}

export type SaveProviderCredentialResult =
  | { ok: true; credentialStatus: HelarcProviderCredentialStatus }
  | { ok: false; error: ProviderCredentialStoreError };

export type ResolveProviderCredentialResult =
  | {
      ok: true;
      apiKey: string | null;
      credentialStatus: Extract<HelarcProviderCredentialStatus, "present" | "missing">;
    }
  | { ok: false; error: ProviderCredentialStoreError };

export class ProviderCredentialStore {
  constructor(
    private readonly persistence: ProviderCredentialPersistence,
    private readonly cipher: ProviderCredentialCipher,
  ) {}

  async saveApiKey(input: { profileId: string; apiKey: string }): Promise<SaveProviderCredentialResult> {
    const profileId = normalizeProfileId(input.profileId);
    if (!profileId) {
      return reject("provider_credential_profile_id_required", "Provider profile id is required.");
    }

    const apiKey = input.apiKey.trim();
    if (apiKey.length === 0) {
      await this.persistence.delete(profileId);
      return { ok: true, credentialStatus: "empty_allowed" };
    }

    if (!this.cipher.isEncryptionAvailable()) {
      return reject(
        "provider_credential_encryption_unavailable",
        "Provider credential encryption is unavailable.",
      );
    }

    await this.persistence.write({
      profileId,
      encryptedApiKey: this.cipher.encryptString(apiKey),
      updatedAt: new Date().toISOString(),
    });

    return { ok: true, credentialStatus: "present" };
  }

  async resolveApiKey(profileIdValue: string): Promise<ResolveProviderCredentialResult> {
    const profileId = normalizeProfileId(profileIdValue);
    if (!profileId) {
      return reject("provider_credential_profile_id_required", "Provider profile id is required.");
    }

    const record = await this.persistence.read(profileId);
    if (!record) {
      return { ok: true, apiKey: null, credentialStatus: "missing" };
    }

    try {
      return {
        ok: true,
        apiKey: this.cipher.decryptString(record.encryptedApiKey),
        credentialStatus: "present",
      };
    } catch {
      return reject(
        "provider_credential_decryption_failed",
        "Provider credential could not be decrypted.",
      );
    }
  }

  async deleteApiKey(profileIdValue: string): Promise<SaveProviderCredentialResult> {
    const profileId = normalizeProfileId(profileIdValue);
    if (!profileId) {
      return reject("provider_credential_profile_id_required", "Provider profile id is required.");
    }

    await this.persistence.delete(profileId);
    return { ok: true, credentialStatus: "missing" };
  }
}

export class FileProviderCredentialPersistence implements ProviderCredentialPersistence {
  constructor(private readonly directoryPath: string) {}

  async read(profileId: string): Promise<PersistedProviderCredential | null> {
    try {
      const parsed = JSON.parse(await readFile(this.recordPath(profileId), "utf8")) as unknown;
      return isPersistedProviderCredential(parsed) ? parsed : null;
    } catch (error) {
      if (isMissingFileError(error)) {
        return null;
      }
      throw error;
    }
  }

  async write(record: PersistedProviderCredential): Promise<void> {
    await mkdir(this.directoryPath, { recursive: true });
    await writeFile(this.recordPath(record.profileId), JSON.stringify(record, null, 2), "utf8");
  }

  async delete(profileId: string): Promise<void> {
    await rm(this.recordPath(profileId), { force: true });
  }

  private recordPath(profileId: string): string {
    return join(this.directoryPath, `${encodeURIComponent(profileId)}.json`);
  }
}

function normalizeProfileId(value: string): string | null {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function reject(
  code: ProviderCredentialStoreErrorCode,
  message: string,
): { ok: false; error: ProviderCredentialStoreError } {
  return { ok: false, error: { code, message } };
}

function isPersistedProviderCredential(value: unknown): value is PersistedProviderCredential {
  if (!isRecord(value)) {
    return false;
  }

  return typeof value.profileId === "string" &&
    typeof value.encryptedApiKey === "string" &&
    typeof value.updatedAt === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
