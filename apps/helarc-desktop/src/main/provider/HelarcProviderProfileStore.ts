import {
  createHelarcProviderProfile,
  type HelarcProviderProfile,
  type HelarcProviderProfileError,
} from "@agent-anything/helarc";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { HelarcProviderConfig } from "./resolveHelarcProviderConfig.js";
import type { ProviderCredentialStore, ProviderCredentialStoreError } from "./ProviderCredentialStore.js";

export interface SaveHelarcProviderProfileInput {
  displayName: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  apiKeyUpdate: "keep" | "set" | "clear";
  apiKey: string;
}

export interface PersistedHelarcProviderProfile {
  id: string;
  displayName: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  updatedAt: string;
}

export type ResolveHelarcStoredProviderProfileResult =
  | { ok: true; config: HelarcProviderConfig; profile: HelarcProviderProfile }
  | { ok: false; error: HelarcProviderProfileError | ProviderCredentialStoreError };

export class FileHelarcProviderProfileStore {
  constructor(private readonly filePath: string) {}

  async resolveActiveProfile(
    credentialStore: ProviderCredentialStore,
  ): Promise<ResolveHelarcStoredProviderProfileResult | null> {
    debugger;
    const persisted = await this.readProfile();
    if (!persisted) {
      return null;
    }

    const credential = await credentialStore.resolveApiKey(persisted.id);
    if (!credential.ok) {
      return { ok: false, error: credential.error };
    }

    return createResolvedProfile(persisted, credential.credentialStatus, credential.apiKey ?? "");
  }

  async saveActiveProfile(
    input: SaveHelarcProviderProfileInput,
    credentialStore: ProviderCredentialStore,
  ): Promise<ResolveHelarcStoredProviderProfileResult> {
    const persisted: PersistedHelarcProviderProfile = {
      id: "desktop-provider",
      displayName: input.displayName.trim(),
      baseUrl: input.baseUrl.trim(),
      model: input.model.trim(),
      timeoutMs: input.timeoutMs,
      updatedAt: new Date().toISOString(),
    };

    debugger;
    const credential = await resolveCredentialUpdate(persisted.id, input, credentialStore);
    if (!credential.ok) {
      return { ok: false, error: credential.error };
    }

    const resolved = createResolvedProfile(persisted, credential.credentialStatus, credential.apiKey);
    if (!resolved.ok) {
      return resolved;
    }

    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(persisted, null, 2), "utf8");
    return resolved;
  }

  private async readProfile(): Promise<PersistedHelarcProviderProfile | null> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      return isPersistedHelarcProviderProfile(parsed) ? parsed : null;
    } catch (error) {
      if (isMissingFileError(error)) {
        return null;
      }
      throw error;
    }
  }
}

async function resolveCredentialUpdate(
  profileId: string,
  input: SaveHelarcProviderProfileInput,
  credentialStore: ProviderCredentialStore,
) {
  if (input.apiKeyUpdate === "keep") {
    const resolved = await credentialStore.resolveApiKey(profileId);
    if (!resolved.ok) {
      return resolved;
    }
    return {
      ok: true as const,
      apiKey: resolved.apiKey ?? "",
      credentialStatus: resolved.credentialStatus,
    };
  }

  if (input.apiKeyUpdate === "clear") {
    const cleared = await credentialStore.saveApiKey({ profileId, apiKey: "" });
    return cleared.ok
      ? { ok: true as const, apiKey: "", credentialStatus: cleared.credentialStatus }
      : cleared;
  }

  const saved = await credentialStore.saveApiKey({
    profileId,
    apiKey: input.apiKey,
  });
  return saved.ok
    ? { ok: true as const, apiKey: input.apiKey.trim(), credentialStatus: saved.credentialStatus }
    : saved;
}

function createResolvedProfile(
  persisted: PersistedHelarcProviderProfile,
  credentialStatus: HelarcProviderProfile["credentialStatus"],
  apiKey: string,
): ResolveHelarcStoredProviderProfileResult {
  const profileResult = createHelarcProviderProfile({
    id: persisted.id,
    displayName: persisted.displayName,
    baseUrl: persisted.baseUrl,
    model: persisted.model,
    timeoutMs: persisted.timeoutMs,
    credentialStatus,
    isActive: true,
  });

  if (!profileResult.ok) {
    return { ok: false, error: profileResult.error };
  }

  return {
    ok: true,
    config: {
      baseUrl: persisted.baseUrl,
      apiKey,
      model: persisted.model,
      timeoutMs: persisted.timeoutMs,
    },
    profile: profileResult.profile,
  };
}

function isPersistedHelarcProviderProfile(value: unknown): value is PersistedHelarcProviderProfile {
  if (!isRecord(value)) {
    return false;
  }

  return typeof value.id === "string" &&
    typeof value.displayName === "string" &&
    typeof value.baseUrl === "string" &&
    typeof value.model === "string" &&
    typeof value.timeoutMs === "number" &&
    typeof value.updatedAt === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
