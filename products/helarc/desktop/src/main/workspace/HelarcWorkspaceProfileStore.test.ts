import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileHelarcWorkspaceProfileStore,
  workspaceProfileId,
} from "./HelarcWorkspaceProfileStore.js";

describe("FileHelarcWorkspaceProfileStore", () => {
  it("creates stable opaque profile ids compatible with workspace-root identity", () => {
    const workspacePath = join("D:\\", "private", "workspace-a");
    const first = workspaceProfileId(workspacePath);

    expect(first).toMatch(/^workspace-[a-f0-9]{64}$/);
    expect(first).not.toContain("private");
    expect(first).not.toContain("workspace-a");
    expect(workspaceProfileId(workspacePath)).toBe(first);
  });

  it("remembers trusted workspace directories", async () => {
    const { store, workspacePath } = await createStoreWithWorkspace();

    const result = await store.rememberWorkspacePath(workspacePath);

    expect(result).toMatchObject({
      ok: true,
      profile: {
        id: workspaceProfileId(workspacePath),
        displayName: basename(workspacePath),
        path: workspacePath,
        trustState: "trusted",
      },
      profiles: [
        {
          id: workspaceProfileId(workspacePath),
        },
      ],
    });
  });

  it("restores profiles after store recreation", async () => {
    const { filePath, store, workspacePath } = await createStoreWithWorkspace();
    const remembered = await store.rememberWorkspacePath(workspacePath);
    if (!remembered.ok) {
      throw new Error(remembered.error.message);
    }

    const restoredStore = new FileHelarcWorkspaceProfileStore(filePath);
    await expect(restoredStore.listProfiles()).resolves.toMatchObject([
      {
        id: workspaceProfileId(workspacePath),
        path: workspacePath,
      },
    ]);

    await expect(restoredStore.resolveWorkspaceProfile(remembered.profile.id)).resolves.toMatchObject({
      ok: true,
      profile: {
        id: remembered.profile.id,
        path: workspacePath,
      },
    });
  });

  it("rejects stale workspace profile paths", async () => {
    const { store, workspacePath } = await createStoreWithWorkspace();
    const remembered = await store.rememberWorkspacePath(workspacePath);
    if (!remembered.ok) {
      throw new Error(remembered.error.message);
    }
    await rm(workspacePath, { recursive: true, force: true });

    await expect(store.resolveWorkspaceProfile(remembered.profile.id)).resolves.toEqual({
      ok: false,
      error: {
        code: "workspace_path_not_found",
        message: "Workspace path no longer exists.",
      },
    });
  });

  it("rejects unknown profile ids and non-directory paths", async () => {
    const { store, rootPath } = await createStoreWithWorkspace();
    const filePath = join(rootPath, "not-directory.txt");
    await writeFile(filePath, "content", "utf8");

    await expect(store.resolveWorkspaceProfile("missing")).resolves.toMatchObject({
      ok: false,
      error: { code: "workspace_profile_not_found" },
    });
    await expect(store.rememberWorkspacePath(filePath)).resolves.toMatchObject({
      ok: false,
      error: { code: "workspace_path_not_directory" },
    });
  });
});

async function createStoreWithWorkspace() {
  const rootPath = await mkdtemp(join(tmpdir(), "helarc-workspace-profile-store-"));
  const workspacePath = join(rootPath, "workspace-a");
  await mkdir(workspacePath, { recursive: true });
  const filePath = join(rootPath, "profiles", "workspaces.json");

  return {
    filePath,
    rootPath,
    workspacePath,
    store: new FileHelarcWorkspaceProfileStore(filePath),
  };
}
