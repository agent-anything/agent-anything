import type { HelarcProviderCredentialStatus } from "@agent-anything/helarc/configuration";
import { join, resolve } from "node:path";
import {
  SerializedAtomicFile,
  type AtomicFileTransaction,
  type SerializedAtomicFileOptions,
} from "../persistence/SerializedAtomicFile.js";

export interface PersistedProviderCredential {
  readonly profileId: string;
  readonly encryptedApiKey: string;
  readonly updatedAt: string;
}

export interface ProviderCredentialStoreDocumentV1 {
  readonly formatVersion: 1;
  readonly credential: PersistedProviderCredential;
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
  | "provider_credential_encryption_failed"
  | "provider_credential_decryption_failed"
  | "provider_credential_persistence_failed";

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

export class ProviderCredentialStoreCorruptionError extends Error {
  readonly code = "provider_credential_store_corrupt";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProviderCredentialStoreCorruptionError";
  }
}

export class ProviderCredentialStore {
  constructor(
    private readonly persistence: ProviderCredentialPersistence,
    private readonly cipher: ProviderCredentialCipher,
  ) {}

  async saveApiKey(input: {
    profileId: string;
    apiKey: string;
  }): Promise<SaveProviderCredentialResult> {
    const profileId = normalizeProfileId(input.profileId);
    if (!profileId) {
      return reject("provider_credential_profile_id_required", "Provider profile id is required.");
    }

    const apiKey = input.apiKey.trim();
    if (apiKey.length === 0) {
      try {
        await this.persistence.delete(profileId);
      } catch (error) {
        rethrowCorruption(error);
        return persistenceFailure();
      }
      return { ok: true, credentialStatus: "empty_allowed" };
    }

    let encryptionAvailable: boolean;
    try {
      encryptionAvailable = this.cipher.isEncryptionAvailable();
    } catch {
      return reject(
        "provider_credential_encryption_failed",
        "Provider credential encryption availability could not be determined.",
      );
    }
    if (!encryptionAvailable) {
      return reject(
        "provider_credential_encryption_unavailable",
        "Provider credential encryption is unavailable.",
      );
    }

    let encryptedApiKey: string;
    try {
      encryptedApiKey = this.cipher.encryptString(apiKey);
    } catch {
      return reject(
        "provider_credential_encryption_failed",
        "Provider credential could not be encrypted.",
      );
    }
    if (encryptedApiKey.length === 0) {
      return reject(
        "provider_credential_encryption_failed",
        "Provider credential could not be encrypted.",
      );
    }

    try {
      await this.persistence.write({
        profileId,
        encryptedApiKey,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      rethrowCorruption(error);
      return persistenceFailure();
    }

    return { ok: true, credentialStatus: "present" };
  }

  async resolveApiKey(profileIdValue: string): Promise<ResolveProviderCredentialResult> {
    const profileId = normalizeProfileId(profileIdValue);
    if (!profileId) {
      return reject("provider_credential_profile_id_required", "Provider profile id is required.");
    }

    let record: PersistedProviderCredential | null;
    try {
      record = await this.persistence.read(profileId);
    } catch (error) {
      rethrowCorruption(error);
      return persistenceFailure();
    }
    if (!record) {
      return { ok: true, apiKey: null, credentialStatus: "missing" };
    }

    try {
      const apiKey = this.cipher.decryptString(record.encryptedApiKey);
      if (typeof apiKey !== "string" || apiKey.length === 0) {
        throw new TypeError("Decrypted Provider credential is empty.");
      }
      return {
        ok: true,
        apiKey,
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

    try {
      await this.persistence.delete(profileId);
    } catch (error) {
      rethrowCorruption(error);
      return persistenceFailure();
    }
    return { ok: true, credentialStatus: "missing" };
  }
}

export class FileProviderCredentialPersistence implements ProviderCredentialPersistence {
  private readonly directoryPath: string;

  constructor(
    directoryPath: string,
    private readonly atomicFileOptions: SerializedAtomicFileOptions = {},
  ) {
    if (directoryPath.trim().length === 0) {
      throw new TypeError("Provider Credential Store directory path is required.");
    }
    this.directoryPath = resolve(directoryPath);
  }

  async read(profileId: string): Promise<PersistedProviderCredential | null> {
    return this.fileFor(profileId).transact(async (file) =>
      this.readRecord(file, profileId)
    );
  }

  async write(record: PersistedProviderCredential): Promise<void> {
    await this.fileFor(record.profileId).transact(async (file) => {
      await this.readRecord(file, record.profileId);
      const validated = validateCredentialRecord(record, record.profileId);
      await file.replaceText(`${JSON.stringify({
        formatVersion: 1,
        credential: validated,
      } satisfies ProviderCredentialStoreDocumentV1, null, 2)}\n`);
    });
  }

  async delete(profileId: string): Promise<void> {
    await this.fileFor(profileId).transact(async (file) => {
      const current = await this.readRecord(file, profileId);
      if (current !== null) {
        await file.remove();
      }
    });
  }

  private async readRecord(
    file: AtomicFileTransaction,
    expectedProfileId: string,
  ): Promise<PersistedProviderCredential | null> {
    const contents = await file.readText();
    if (contents === null) {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch {
      throw new ProviderCredentialStoreCorruptionError(
        "Provider Credential Store JSON is invalid.",
      );
    }
    if (!isStoreDocument(parsed)) {
      throw new ProviderCredentialStoreCorruptionError(
        "Provider Credential Store document version or shape is invalid.",
      );
    }
    return validateCredentialRecord(parsed.credential, expectedProfileId);
  }

  private fileFor(profileId: string): SerializedAtomicFile {
    return new SerializedAtomicFile(
      join(this.directoryPath, `${encodeURIComponent(profileId)}.json`),
      this.atomicFileOptions,
    );
  }
}

function validateCredentialRecord(
  value: unknown,
  expectedProfileId: string,
): PersistedProviderCredential {
  if (!isRecord(value) || !hasExactKeys(value, [
    "profileId",
    "encryptedApiKey",
    "updatedAt",
  ])) {
    throw invalidCredentialRecord();
  }
  if (
    value.profileId !== expectedProfileId ||
    typeof value.profileId !== "string" ||
    value.profileId.trim() !== value.profileId ||
    value.profileId.length === 0 ||
    typeof value.encryptedApiKey !== "string" ||
    value.encryptedApiKey.length === 0 ||
    typeof value.updatedAt !== "string" ||
    !isCanonicalIsoTimestamp(value.updatedAt)
  ) {
    throw invalidCredentialRecord();
  }
  return Object.freeze({
    profileId: value.profileId,
    encryptedApiKey: value.encryptedApiKey,
    updatedAt: value.updatedAt,
  });
}

function invalidCredentialRecord(): ProviderCredentialStoreCorruptionError {
  return new ProviderCredentialStoreCorruptionError(
    "Provider Credential Store contains an invalid credential record.",
  );
}

function isStoreDocument(value: unknown): value is {
  readonly formatVersion: 1;
  readonly credential: unknown;
} {
  return isRecord(value) &&
    hasExactKeys(value, ["formatVersion", "credential"]) &&
    value.formatVersion === 1;
}

function normalizeProfileId(value: string): string | null {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function persistenceFailure(): {
  ok: false;
  error: ProviderCredentialStoreError;
} {
  return reject(
    "provider_credential_persistence_failed",
    "Provider credential storage is unavailable.",
  );
}

function rethrowCorruption(error: unknown): void {
  if (error instanceof ProviderCredentialStoreCorruptionError) {
    throw error;
  }
}

function reject(
  code: ProviderCredentialStoreErrorCode,
  message: string,
): { ok: false; error: ProviderCredentialStoreError } {
  return { ok: false, error: { code, message } };
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value);
  return actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key));
}

function isCanonicalIsoTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
