import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileHelarcWorkspaceProfileStore,
  HelarcWorkspaceProfileStoreCorruptionError,
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
    const { filePath, store, workspacePath } = await createStoreWithWorkspace();

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
    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({
      formatVersion: 1,
      profiles: [{ id: workspaceProfileId(workspacePath) }],
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

  it("serializes updates across Store instances sharing one file", async () => {
    const { filePath, rootPath, store, workspacePath } = await createStoreWithWorkspace();
    const secondWorkspacePath = join(rootPath, "workspace-b");
    await mkdir(secondWorkspacePath);
    const secondStore = new FileHelarcWorkspaceProfileStore(filePath);

    const [first, second] = await Promise.all([
      store.rememberWorkspacePath(workspacePath),
      secondStore.rememberWorkspacePath(secondWorkspacePath),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    await expect(store.listProfiles()).resolves.toHaveLength(2);
  });

  it("preserves the prior document when atomic replacement fails", async () => {
    const { filePath, rootPath, store, workspacePath } = await createStoreWithWorkspace();
    await store.rememberWorkspacePath(workspacePath);
    const before = await readFile(filePath, "utf8");
    const secondWorkspacePath = join(rootPath, "workspace-b");
    await mkdir(secondWorkspacePath);
    const failingStore = new FileHelarcWorkspaceProfileStore(filePath, {
      createTemporaryId: () => "injected-failure",
      operations: {
        async replace() {
          throw new Error("injected replacement failure");
        },
      },
    });

    await expect(failingStore.rememberWorkspacePath(secondWorkspacePath)).rejects
      .toThrow("injected replacement failure");

    expect(await readFile(filePath, "utf8")).toBe(before);
    expect(await readdir(dirname(filePath))).toEqual(["workspaces.json"]);
  });

  it("fails closed for invalid JSON, old versions, malformed records, and duplicates", async () => {
    const { filePath, store, workspacePath } = await createStoreWithWorkspace();
    await mkdir(dirname(filePath), { recursive: true });

    await writeFile(filePath, "{invalid", "utf8");
    await expect(store.listProfiles()).rejects
      .toBeInstanceOf(HelarcWorkspaceProfileStoreCorruptionError);

    await writeFile(filePath, "[]", "utf8");
    await expect(store.listProfiles()).rejects
      .toBeInstanceOf(HelarcWorkspaceProfileStoreCorruptionError);

    await writeFile(filePath, JSON.stringify({ formatVersion: 2, profiles: [] }), "utf8");
    await expect(store.listProfiles()).rejects
      .toBeInstanceOf(HelarcWorkspaceProfileStoreCorruptionError);

    await writeFile(filePath, JSON.stringify({
      formatVersion: 1,
      profiles: [{ id: "incomplete" }],
    }), "utf8");
    await expect(store.listProfiles()).rejects
      .toBeInstanceOf(HelarcWorkspaceProfileStoreCorruptionError);

    await rm(filePath);
    await store.rememberWorkspacePath(workspacePath);
    const valid = JSON.parse(await readFile(filePath, "utf8"));
    await writeFile(filePath, JSON.stringify({
      ...valid,
      profiles: [valid.profiles[0], valid.profiles[0]],
    }), "utf8");
    await expect(store.listProfiles()).rejects
      .toBeInstanceOf(HelarcWorkspaceProfileStoreCorruptionError);
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
