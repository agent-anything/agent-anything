import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createHelarcDesktopIdentityResolver,
  createHelarcDesktopWorkspaceResolver,
} from "./HelarcHostContext.js";

const testRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    testRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Helarc Desktop Host context adapters", () => {
  it("resolves one primary and additional Workspace from Thread references", async () => {
    const root = await mkdtemp(join(tmpdir(), "helarc-host-context-"));
    testRoots.push(root);
    const primaryPath = join(root, "primary");
    const docsPath = join(root, "docs");
    await mkdir(primaryPath);
    await mkdir(docsPath);
    const resolver = createHelarcDesktopWorkspaceResolver({
      primary: workspaceRef("workspace-primary", "Primary", primaryPath),
      additional: [workspaceRef("workspace-docs", "Docs", docsPath)],
    });

    const workspace = await resolver.resolve({
      sessionId: "thread-1",
      runId: "run-1",
      taskId: "task-1",
      selection: {
        kind: "references",
        primaryRef: "workspace-primary",
        additionalRefs: ["workspace-docs"],
      },
      metadata: {},
    });

    expect(workspace).toMatchObject({
      primary: {
        id: "workspace-primary",
        rootRef: await realpath(primaryPath),
      },
      additional: [{
        id: "workspace-docs",
        rootRef: await realpath(docsPath),
      }],
    });
    expect(Object.isFrozen(workspace?.additional)).toBe(true);
  });

  it("fails closed for a missing primary root and a mismatched selection", async () => {
    const root = await mkdtemp(join(tmpdir(), "helarc-host-missing-"));
    testRoots.push(root);
    const resolver = createHelarcDesktopWorkspaceResolver({
      primary: workspaceRef(
        "workspace-primary",
        "Primary",
        join(root, "missing-workspace"),
      ),
      additional: [],
    });
    const base = {
      sessionId: "thread-1",
      runId: "run-1",
      taskId: "task-1",
      metadata: {},
    };

    await expect(resolver.resolve({
      ...base,
      selection: {
        kind: "references",
        primaryRef: "workspace-primary",
        additionalRefs: [],
      },
    })).rejects.toMatchObject({
      code: "host_workspace_resolution_failed",
    });

    await expect(resolver.resolve({
      ...base,
      selection: {
        kind: "references",
        primaryRef: "other-workspace",
        additionalRefs: [],
      },
    })).rejects.toMatchObject({
      code: "host_workspace_resolution_invalid",
    });
  });

  it("resolves only the explicit anonymous Desktop Identity", async () => {
    const resolver = createHelarcDesktopIdentityResolver();
    const base = {
      sessionId: "thread-1",
      runId: "run-1",
      taskId: "task-1",
      metadata: {},
    };

    await expect(resolver.resolve({
      ...base,
      selection: { kind: "anonymous" },
    })).resolves.toMatchObject({
      id: "helarc-anonymous",
      kind: "anonymous",
    });
    await expect(resolver.resolve({
      ...base,
      selection: { kind: "reference", identityRef: "user-1" },
    })).rejects.toMatchObject({
      code: "host_identity_rejected",
    });
  });
});

function workspaceRef(
  profileId: string,
  displayName: string,
  path: string,
) {
  return { profileId, displayName, path };
}
