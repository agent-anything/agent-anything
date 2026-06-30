import {
  createHelarcWorkspaceProfile,
  selectHelarcWorkspaceProfile,
  type HelarcWorkspaceProfile,
} from "@agent-anything/helarc";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, normalize } from "node:path";

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

export class FileHelarcWorkspaceProfileStore implements HelarcWorkspaceProfileStore {
  constructor(private readonly filePath: string) {}

  async listProfiles(): Promise<HelarcWorkspaceProfile[]> {
    return sortProfiles(await this.readProfiles());
  }

  async rememberWorkspacePath(workspacePath: string): Promise<RememberHelarcWorkspaceResult> {
    const pathResult = await validateWorkspacePath(workspacePath);
    if (!pathResult.ok) {
      return pathResult;
    }

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

    const currentProfiles = await this.readProfiles();
    const nextProfiles = sortProfiles([
      profileResult.profile,
      ...currentProfiles.filter((profile) => profile.id !== profileResult.profile.id),
    ]);
    await this.writeProfiles(nextProfiles);

    return {
      ok: true,
      profile: profileResult.profile,
      profiles: nextProfiles,
    };
  }

  async resolveWorkspaceProfile(profileId: string): Promise<ResolveHelarcWorkspaceProfileResult> {
    const profiles = await this.readProfiles();
    const selected = selectHelarcWorkspaceProfile(profiles, profileId);
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
      ...profiles.filter((profile) => profile.id !== refreshedResult.profile.id),
    ]);
    await this.writeProfiles(nextProfiles);

    return {
      ok: true,
      profile: refreshedResult.profile,
      profiles: nextProfiles,
    };
  }

  private async readProfiles(): Promise<HelarcWorkspaceProfile[]> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed.flatMap((item) => {
        if (!isRecord(item)) {
          return [];
        }
        const trustState = readTrustState(item.trustState);
        if (!trustState) {
          return [];
        }

        const result = createHelarcWorkspaceProfile({
          id: readString(item.id),
          displayName: readString(item.displayName),
          path: readString(item.path),
          lastOpenedAt: readString(item.lastOpenedAt),
          trustState,
        });
        return result.ok ? [result.profile] : [];
      });
    } catch (error) {
      if (isMissingFileError(error)) {
        return [];
      }
      throw error;
    }
  }

  private async writeProfiles(profiles: readonly HelarcWorkspaceProfile[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(profiles, null, 2), "utf8");
  }
}

export function workspaceProfileId(workspacePath: string): string {
  return `workspace:${normalize(workspacePath).toLowerCase()}`;
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

function sortProfiles(profiles: readonly HelarcWorkspaceProfile[]): HelarcWorkspaceProfile[] {
  return [...profiles].sort((left, right) => right.lastOpenedAt.localeCompare(left.lastOpenedAt));
}

function reject(
  code: HelarcWorkspaceProfileStoreErrorCode,
  message: string,
): { ok: false; error: HelarcWorkspaceProfileStoreError } {
  return { ok: false, error: { code, message } };
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readTrustState(value: unknown): "trusted" | null {
  return value === "trusted" ? "trusted" : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
