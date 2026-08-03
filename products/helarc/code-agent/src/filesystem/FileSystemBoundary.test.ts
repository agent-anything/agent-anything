import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunWorkspace } from "@agent-anything/foundation";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveExistingTarget,
  resolveWritableTarget,
} from "./FileSystemBoundary.js";

const testRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    testRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("FileSystemBoundary canonical containment", () => {
  it("rejects file, directory, and writable targets through an escaping directory link", async () => {
    const fixture = await createLinkedFixture();

    await expect(resolveExistingTarget({
      workspace: fixture.workspace,
      path: "outside-link/secret.txt",
      expectedKind: "file",
    })).rejects.toMatchObject({ code: "workspace_symlink_escape" });

    await expect(resolveExistingTarget({
      workspace: fixture.workspace,
      path: "outside-link",
      expectedKind: "directory",
    })).rejects.toMatchObject({ code: "workspace_symlink_escape" });

    await expect(resolveWritableTarget({
      workspace: fixture.workspace,
      path: "outside-link/new.txt",
      overwrite: false,
    })).rejects.toMatchObject({ code: "workspace_symlink_escape" });
  });

  it("canonicalizes a selected root alias without weakening containment", async () => {
    const root = await mkdtemp(join(tmpdir(), "code-agent-root-alias-"));
    testRoots.push(root);
    const workspaceRoot = join(root, "workspace");
    const workspaceAlias = join(root, "workspace-alias");
    await mkdir(workspaceRoot);
    await writeFile(join(workspaceRoot, "README.md"), "safe\n");
    await createDirectoryLink(workspaceRoot, workspaceAlias);

    const target = await resolveExistingTarget({
      workspace: runWorkspace(workspaceAlias),
      path: "README.md",
      expectedKind: "file",
    });
    const canonicalWorkspaceRoot = await realpath(workspaceRoot);

    expect(target.canonicalRoot).toBe(canonicalWorkspaceRoot);
    expect(target.canonicalTarget).toBe(
      join(canonicalWorkspaceRoot, "README.md"),
    );
  });
});

async function createLinkedFixture() {
  const root = await mkdtemp(join(tmpdir(), "code-agent-boundary-"));
  testRoots.push(root);
  const workspaceRoot = join(root, "workspace");
  const outsideRoot = join(root, "outside");
  await mkdir(workspaceRoot);
  await mkdir(outsideRoot);
  await writeFile(join(outsideRoot, "secret.txt"), "outside\n");
  await createDirectoryLink(outsideRoot, join(workspaceRoot, "outside-link"));
  return {
    workspace: runWorkspace(workspaceRoot),
  };
}

function runWorkspace(rootRef: string): RunWorkspace {
  return {
    primary: {
      id: "workspace-primary",
      name: "Primary",
      rootRef,
      trustState: "trusted",
      source: "test",
      policyRefs: [],
      metadata: {},
    },
    additional: [],
  };
}

function createDirectoryLink(target: string, path: string): Promise<void> {
  return symlink(target, path, process.platform === "win32" ? "junction" : "dir");
}
