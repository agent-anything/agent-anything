import {
  createHelarcWorkspaceProfile,
  selectHelarcWorkspaceProfile,
  type HelarcWorkspaceProfile,
} from "@agent-anything/helarc";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { basename, isAbsolute, normalize } from "node:path";
import {
  SerializedAtomicFile,
  type AtomicFileTransaction,
  type SerializedAtomicFileOptions,
} from "../persistence/SerializedAtomicFile.js";

export interface HelarcWorkspaceProfileStoreDocumentV1 {
  readonly formatVersion: 1;
  readonly profiles: readonly HelarcWorkspaceProfile[];
}

export interface HelarcWorkspaceProfileStore {
  listProfiles(): Promise<HelarcWorkspaceProfile[]>;
  rememberWorkspacePath(workspacePath: string): Promise<RememberHelarcWorkspaceResult>;
  resolveWorkspaceProfile(profileId: string): Promise<ResolveHelarcWorkspaceProfileResult>;
}

export type HelarcWorkspaceProfileStoreErrorCode =
  | "workspace_path_required"
  | "workspace_path_not_absolute"
  | "workspace_path_not_found"
  | "workspace_path_not_directory"
  | "workspace_profile_not_found"
  | "workspace_profile_invalid";

export interface HelarcWorkspaceProfileStoreError {
  code: HelarcWorkspaceProfileStoreErrorCode;
  message: string;
}

export type RememberHelarcWorkspaceResult =
  | { ok: true; profile: HelarcWorkspaceProfile; profiles: HelarcWorkspaceProfile[] }
  | { ok: false; error: HelarcWorkspaceProfileStoreError };

export type ResolveHelarcWorkspaceProfileResult =
  | { ok: true; profile: HelarcWorkspaceProfile; profiles: HelarcWorkspaceProfile[] }
  | { ok: false; error: HelarcWorkspaceProfileStoreError };

export class HelarcWorkspaceProfileStoreCorruptionError extends Error {
  readonly code = "workspace_profile_store_corrupt";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HelarcWorkspaceProfileStoreCorruptionError";
  }
}

export class FileHelarcWorkspaceProfileStore implements HelarcWorkspaceProfileStore {
  private readonly atomicFile: SerializedAtomicFile;

  constructor(
    filePath: string,
    options: SerializedAtomicFileOptions = {},
  ) {
    this.atomicFile = new SerializedAtomicFile(filePath, options);
  }

  async listProfiles(): Promise<HelarcWorkspaceProfile[]> {
    return this.atomicFile.transact(async (file) =>
      sortProfiles((await this.readDocument(file)).profiles)
    );
  }

  async rememberWorkspacePath(workspacePath: string): Promise<RememberHelarcWorkspaceResult> {
    const pathResult = await validateWorkspacePath(workspacePath);
    if (!pathResult.ok) {
      return pathResult;
    }

    return this.atomicFile.transact(async (file) => {
      const document = await this.readDocument(file);
      const profileResult = createHelarcWorkspaceProfile({
        id: workspaceProfileId(pathResult.path),
        displayName: basename(pathResult.path) || pathResult.path,
        path: pathResult.path,
        lastOpenedAt: new Date().toISOString(),
        trustState: "trusted",
      });
      if (!profileResult.ok) {
        return reject("workspace_profile_invalid", profileResult.error.message);
      }

      const nextProfiles = sortProfiles([
        profileResult.profile,
        ...document.profiles.filter((profile) => profile.id !== profileResult.profile.id),
      ]);
      await this.writeDocument(file, {
        formatVersion: 1,
        profiles: nextProfiles,
      });

      return {
        ok: true,
        profile: profileResult.profile,
        profiles: nextProfiles,
      };
    });
  }

  async resolveWorkspaceProfile(profileId: string): Promise<ResolveHelarcWorkspaceProfileResult> {
    return this.atomicFile.transact(async (file) => {
      const document = await this.readDocument(file);
      const selected = selectHelarcWorkspaceProfile(document.profiles, profileId);
      if (!selected.ok) {
        return reject("workspace_profile_not_found", selected.error.message);
      }

      const pathResult = await validateWorkspacePath(selected.profile.path);
      if (!pathResult.ok) {
        return pathResult;
      }

      const refreshedResult = createHelarcWorkspaceProfile({
        ...selected.profile,
        path: pathResult.path,
        lastOpenedAt: new Date().toISOString(),
      });
      if (!refreshedResult.ok) {
        return reject("workspace_profile_invalid", refreshedResult.error.message);
      }

      const nextProfiles = sortProfiles([
        refreshedResult.profile,
        ...document.profiles.filter((profile) => profile.id !== refreshedResult.profile.id),
      ]);
      await this.writeDocument(file, {
        formatVersion: 1,
        profiles: nextProfiles,
      });

      return {
        ok: true,
        profile: refreshedResult.profile,
        profiles: nextProfiles,
      };
    });
  }

  private async readDocument(
    file: AtomicFileTransaction,
  ): Promise<HelarcWorkspaceProfileStoreDocumentV1> {
    const contents = await file.readText();
    if (contents === null) {
      return Object.freeze({
        formatVersion: 1,
        profiles: Object.freeze([]),
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      throw new HelarcWorkspaceProfileStoreCorruptionError(
        "Workspace Profile Store JSON is invalid.",
        { cause: error },
      );
    }
    if (!isStoreDocument(parsed)) {
      throw new HelarcWorkspaceProfileStoreCorruptionError(
        "Workspace Profile Store document version or shape is invalid.",
      );
    }

    const profiles: HelarcWorkspaceProfile[] = [];
    const profileIds = new Set<string>();
    for (const candidate of parsed.profiles) {
      const profile = parseStoredProfile(candidate);
      if (profileIds.has(profile.id)) {
        throw new HelarcWorkspaceProfileStoreCorruptionError(
          "Workspace Profile Store contains a duplicate profile identity.",
        );
      }
      profileIds.add(profile.id);
      profiles.push(profile);
    }

    return Object.freeze({
      formatVersion: 1,
      profiles: Object.freeze(profiles),
    });
  }

  private async writeDocument(
    file: AtomicFileTransaction,
    document: HelarcWorkspaceProfileStoreDocumentV1,
  ): Promise<void> {
    await file.replaceText(`${JSON.stringify(document, null, 2)}\n`);
  }
}

export function workspaceProfileId(workspacePath: string): string {
  const normalizedPath = normalize(workspacePath.trim());
  const comparisonPath = process.platform === "win32"
    ? normalizedPath.toLowerCase()
    : normalizedPath;
  const digest = createHash("sha256").update(comparisonPath, "utf8").digest("hex");
  return `workspace-${digest}`;
}

async function validateWorkspacePath(
  workspacePath: string,
): Promise<{ ok: true; path: string } | { ok: false; error: HelarcWorkspaceProfileStoreError }> {
  const normalizedPath = normalize(workspacePath.trim());
  if (normalizedPath.length === 0) {
    return reject("workspace_path_required", "Workspace path is required.");
  }

  if (!isAbsolute(normalizedPath)) {
    return reject("workspace_path_not_absolute", "Workspace path must be absolute.");
  }

  try {
    const stats = await stat(normalizedPath);
    if (!stats.isDirectory()) {
      return reject("workspace_path_not_directory", "Workspace path must be a directory.");
    }
  } catch (error) {
    if (isMissingFileError(error)) {
      return reject("workspace_path_not_found", "Workspace path no longer exists.");
    }
    throw error;
  }

  return { ok: true, path: normalizedPath };
}

function parseStoredProfile(value: unknown): HelarcWorkspaceProfile {
  if (!isRecord(value) || !hasExactKeys(value, [
    "id",
    "displayName",
    "path",
    "lastOpenedAt",
    "trustState",
  ])) {
    throw invalidStoredProfile();
  }
  if (
    typeof value.id !== "string" ||
    typeof value.displayName !== "string" ||
    typeof value.path !== "string" ||
    typeof value.lastOpenedAt !== "string" ||
    value.trustState !== "trusted" ||
    !isAbsolute(value.path) ||
    normalize(value.path) !== value.path ||
    !isCanonicalIsoTimestamp(value.lastOpenedAt) ||
    workspaceProfileId(value.path) !== value.id
  ) {
    throw invalidStoredProfile();
  }

  const result = createHelarcWorkspaceProfile({
    id: value.id,
    displayName: value.displayName,
    path: value.path,
    lastOpenedAt: value.lastOpenedAt,
    trustState: value.trustState,
  });
  if (
    !result.ok ||
    result.profile.id !== value.id ||
    result.profile.displayName !== value.displayName ||
    result.profile.path !== value.path
  ) {
    throw invalidStoredProfile();
  }
  return result.profile;
}

function invalidStoredProfile(): HelarcWorkspaceProfileStoreCorruptionError {
  return new HelarcWorkspaceProfileStoreCorruptionError(
    "Workspace Profile Store contains an invalid profile.",
  );
}

function isStoreDocument(value: unknown): value is {
  readonly formatVersion: 1;
  readonly profiles: readonly unknown[];
} {
  return isRecord(value) &&
    hasExactKeys(value, ["formatVersion", "profiles"]) &&
    value.formatVersion === 1 &&
    Array.isArray(value.profiles);
}

function sortProfiles(profiles: readonly HelarcWorkspaceProfile[]): HelarcWorkspaceProfile[] {
  return [...profiles].sort((left, right) =>
    right.lastOpenedAt.localeCompare(left.lastOpenedAt) ||
    left.id.localeCompare(right.id)
  );
}

function reject(
  code: HelarcWorkspaceProfileStoreErrorCode,
  message: string,
): { ok: false; error: HelarcWorkspaceProfileStoreError } {
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

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
