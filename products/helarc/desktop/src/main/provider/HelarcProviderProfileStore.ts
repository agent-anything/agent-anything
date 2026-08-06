import {
  createHelarcProviderProfile,
  type HelarcProviderKind,
  type HelarcProviderProfile,
  type HelarcProviderProfileError,
} from "@agent-anything/helarc/configuration";
import {
  SerializedAtomicFile,
  type AtomicFileTransaction,
  type SerializedAtomicFileOptions,
} from "../persistence/SerializedAtomicFile.js";
import type { HelarcProviderConfig } from "./resolveHelarcProviderConfig.js";
import type {
  ProviderCredentialStore,
  ProviderCredentialStoreError,
} from "./ProviderCredentialStore.js";

const ACTIVE_PROVIDER_PROFILE_ID = "desktop-provider";

export interface SaveHelarcProviderProfileInput {
  providerKind: HelarcProviderKind;
  displayName: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  apiKeyUpdate: "keep" | "set" | "clear";
  apiKey: string;
}

export interface PersistedHelarcProviderProfile {
  readonly id: string;
  readonly providerKind: HelarcProviderKind;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly updatedAt: string;
}

export interface HelarcProviderProfileStoreDocumentV1 {
  readonly formatVersion: 1;
  readonly activeProfile: PersistedHelarcProviderProfile;
}

export interface HelarcProviderProfileStoreError {
  readonly code: "provider_profile_persistence_failed";
  readonly message: string;
}

export type ResolveHelarcStoredProviderProfileResult =
  | { ok: true; config: HelarcProviderConfig; profile: HelarcProviderProfile }
  | {
      ok: false;
      error:
        | HelarcProviderProfileError
        | ProviderCredentialStoreError
        | HelarcProviderProfileStoreError;
    };

export class HelarcProviderProfileStoreCorruptionError extends Error {
  readonly code = "provider_profile_store_corrupt";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HelarcProviderProfileStoreCorruptionError";
  }
}

export class FileHelarcProviderProfileStore {
  private readonly atomicFile: SerializedAtomicFile;

  constructor(
    filePath: string,
    options: SerializedAtomicFileOptions = {},
  ) {
    this.atomicFile = new SerializedAtomicFile(filePath, options);
  }

  async resolveActiveProfile(
    credentialStore: ProviderCredentialStore,
  ): Promise<ResolveHelarcStoredProviderProfileResult | null> {
    return this.atomicFile.transact(async (file) => {
      const document = await this.readDocument(file);
      if (document === null) {
        return null;
      }

      const credential = await credentialStore.resolveApiKey(document.activeProfile.id);
      if (!credential.ok) {
        return { ok: false, error: credential.error };
      }

      return createResolvedProfile(
        document.activeProfile,
        credential.credentialStatus,
        credential.apiKey ?? "",
      );
    });
  }

  async saveActiveProfile(
    input: SaveHelarcProviderProfileInput,
    credentialStore: ProviderCredentialStore,
  ): Promise<ResolveHelarcStoredProviderProfileResult> {
    return this.atomicFile.transact(async (file) => {
      await this.readDocument(file);

      const plannedCredential = await resolvePlannedCredential(input, credentialStore);
      if (!plannedCredential.ok) {
        return { ok: false, error: plannedCredential.error };
      }

      const updatedAt = new Date().toISOString();
      const validated = createStoredProfile(
        input,
        plannedCredential.credentialStatus,
        plannedCredential.apiKey,
        updatedAt,
      );
      if (!validated.ok) {
        return validated;
      }

      const credential = input.apiKeyUpdate === "keep"
        ? plannedCredential
        : await applyCredentialUpdate(input, credentialStore);
      if (!credential.ok) {
        return { ok: false, error: credential.error };
      }

      const completed = createStoredProfile(
        input,
        credential.credentialStatus,
        credential.apiKey,
        updatedAt,
      );
      if (!completed.ok) {
        return completed;
      }

      try {
        await file.replaceText(`${JSON.stringify({
          formatVersion: 1,
          activeProfile: completed.persisted,
        } satisfies HelarcProviderProfileStoreDocumentV1, null, 2)}\n`);
      } catch {
        return {
          ok: false,
          error: {
            code: "provider_profile_persistence_failed",
            message: "Provider profile could not be persisted.",
          },
        };
      }
      return completed.resolved;
    });
  }

  private async readDocument(
    file: AtomicFileTransaction,
  ): Promise<HelarcProviderProfileStoreDocumentV1 | null> {
    const contents = await file.readText();
    if (contents === null) {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      throw new HelarcProviderProfileStoreCorruptionError(
        "Provider Profile Store JSON is invalid.",
        { cause: error },
      );
    }
    if (!isStoreDocument(parsed)) {
      throw new HelarcProviderProfileStoreCorruptionError(
        "Provider Profile Store document version or shape is invalid.",
      );
    }

    return Object.freeze({
      formatVersion: 1,
      activeProfile: parseStoredProfile(parsed.activeProfile),
    });
  }
}

type ResolvedCredentialUpdate =
  | {
      ok: true;
      apiKey: string;
      credentialStatus: HelarcProviderProfile["credentialStatus"];
    }
  | { ok: false; error: ProviderCredentialStoreError };

async function resolvePlannedCredential(
  input: SaveHelarcProviderProfileInput,
  credentialStore: ProviderCredentialStore,
): Promise<ResolvedCredentialUpdate> {
  if (input.apiKeyUpdate === "keep") {
    const resolved = await credentialStore.resolveApiKey(ACTIVE_PROVIDER_PROFILE_ID);
    return resolved.ok
      ? {
          ok: true,
          apiKey: resolved.apiKey ?? "",
          credentialStatus: resolved.credentialStatus,
        }
      : resolved;
  }

  const apiKey = input.apiKeyUpdate === "set" ? input.apiKey.trim() : "";
  return {
    ok: true,
    apiKey,
    credentialStatus: apiKey.length > 0 ? "present" : "empty_allowed",
  };
}

async function applyCredentialUpdate(
  input: SaveHelarcProviderProfileInput,
  credentialStore: ProviderCredentialStore,
): Promise<ResolvedCredentialUpdate> {
  const apiKey = input.apiKeyUpdate === "set" ? input.apiKey : "";
  const saved = await credentialStore.saveApiKey({
    profileId: ACTIVE_PROVIDER_PROFILE_ID,
    apiKey,
  });
  return saved.ok
    ? {
        ok: true,
        apiKey: apiKey.trim(),
        credentialStatus: saved.credentialStatus,
      }
    : saved;
}

function createStoredProfile(
  input: SaveHelarcProviderProfileInput,
  credentialStatus: HelarcProviderProfile["credentialStatus"],
  apiKey: string,
  updatedAt: string,
):
  | {
      ok: true;
      persisted: PersistedHelarcProviderProfile;
      resolved: Extract<ResolveHelarcStoredProviderProfileResult, { ok: true }>;
    }
  | Extract<ResolveHelarcStoredProviderProfileResult, { ok: false }> {
  const profileResult = createHelarcProviderProfile({
    id: ACTIVE_PROVIDER_PROFILE_ID,
    providerKind: input.providerKind,
    displayName: input.displayName,
    baseUrl: input.baseUrl,
    model: input.model,
    timeoutMs: input.timeoutMs,
    credentialStatus,
    isActive: true,
  });
  if (!profileResult.ok) {
    return { ok: false, error: profileResult.error };
  }

  const persisted: PersistedHelarcProviderProfile = {
    id: profileResult.profile.id,
    providerKind: profileResult.profile.providerKind,
    displayName: profileResult.profile.displayName,
    baseUrl: profileResult.profile.baseUrl,
    model: profileResult.profile.model,
    timeoutMs: profileResult.profile.timeoutMs,
    updatedAt,
  };
  return {
    ok: true,
    persisted,
    resolved: {
      ok: true,
      config: {
        providerKind: persisted.providerKind,
        baseUrl: persisted.baseUrl,
        apiKey,
        model: persisted.model,
        timeoutMs: persisted.timeoutMs,
      },
      profile: profileResult.profile,
    },
  };
}

function createResolvedProfile(
  persisted: PersistedHelarcProviderProfile,
  credentialStatus: HelarcProviderProfile["credentialStatus"],
  apiKey: string,
): ResolveHelarcStoredProviderProfileResult {
  const result = createStoredProfile({
    providerKind: persisted.providerKind,
    displayName: persisted.displayName,
    baseUrl: persisted.baseUrl,
    model: persisted.model,
    timeoutMs: persisted.timeoutMs,
    apiKeyUpdate: "keep",
    apiKey: "",
  }, credentialStatus, apiKey, persisted.updatedAt);
  return result.ok ? result.resolved : result;
}

function parseStoredProfile(value: unknown): PersistedHelarcProviderProfile {
  if (!isRecord(value) || !hasExactKeys(value, [
    "id",
    "providerKind",
    "displayName",
    "baseUrl",
    "model",
    "timeoutMs",
    "updatedAt",
  ])) {
    throw invalidStoredProfile();
  }
  if (
    value.id !== ACTIVE_PROVIDER_PROFILE_ID ||
    !isProviderKind(value.providerKind) ||
    typeof value.displayName !== "string" ||
    typeof value.baseUrl !== "string" ||
    typeof value.model !== "string" ||
    !Number.isSafeInteger(value.timeoutMs) ||
    (value.timeoutMs as number) <= 0 ||
    typeof value.updatedAt !== "string" ||
    !isCanonicalIsoTimestamp(value.updatedAt)
  ) {
    throw invalidStoredProfile();
  }

  const candidate: PersistedHelarcProviderProfile = {
    id: value.id,
    providerKind: value.providerKind,
    displayName: value.displayName,
    baseUrl: value.baseUrl,
    model: value.model,
    timeoutMs: value.timeoutMs as number,
    updatedAt: value.updatedAt,
  };
  const resolved = createResolvedProfile(candidate, "missing", "");
  if (
    !resolved.ok ||
    resolved.profile.id !== candidate.id ||
    resolved.profile.providerKind !== candidate.providerKind ||
    resolved.profile.displayName !== candidate.displayName ||
    resolved.profile.baseUrl !== candidate.baseUrl ||
    resolved.profile.model !== candidate.model ||
    resolved.profile.timeoutMs !== candidate.timeoutMs
  ) {
    throw invalidStoredProfile();
  }
  return candidate;
}

function invalidStoredProfile(): HelarcProviderProfileStoreCorruptionError {
  return new HelarcProviderProfileStoreCorruptionError(
    "Provider Profile Store contains an invalid profile.",
  );
}

function isStoreDocument(value: unknown): value is {
  readonly formatVersion: 1;
  readonly activeProfile: unknown;
} {
  return isRecord(value) &&
    hasExactKeys(value, ["formatVersion", "activeProfile"]) &&
    value.formatVersion === 1;
}

function isProviderKind(value: unknown): value is HelarcProviderKind {
  return value === "openai-compatible" || value === "ollama";
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
