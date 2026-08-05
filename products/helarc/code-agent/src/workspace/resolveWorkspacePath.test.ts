import { basename, join, resolve } from "node:path";
import type { RunWorkspace, WorkspaceContext } from "@agent-anything/agent-core/run";
import { describe, expect, it } from "vitest";
import { resolveWorkspacePath } from "./resolveWorkspacePath.js";

const codeRoot = resolve("workspace-fixtures", "code");
const docsRoot = resolve("workspace-fixtures", "docs");

describe("resolveWorkspacePath", () => {
  it("selects an explicit additional Workspace by identity", () => {
    const result = resolveWorkspacePath({
      workspace: createRunWorkspace(
        createWorkspace("workspace-code", codeRoot),
        [createWorkspace("workspace-docs", docsRoot)],
      ),
      rootName: "workspace-docs",
      requestedPath: join("design", "..", "README.md"),
    });

    expect(result).toEqual({
      status: "resolved",
      rootName: "workspace-docs",
      workspaceId: "workspace-docs",
      trustState: "trusted",
      workspaceRoot: docsRoot,
      relativePath: "README.md",
      absolutePath: join(docsRoot, "README.md"),
    });
  });

  it("selects the primary Workspace when no identity is requested", () => {
    const result = resolveWorkspacePath({
      workspace: createRunWorkspace(
        createWorkspace("workspace-docs", docsRoot),
        [createWorkspace("workspace-code", codeRoot)],
      ),
      requestedPath: ".",
    });

    expect(result).toMatchObject({
      status: "resolved",
      rootName: "workspace-docs",
      workspaceId: "workspace-docs",
      relativePath: ".",
      absolutePath: docsRoot,
    });
  });

  it("preserves the selected Workspace trust state", () => {
    const result = resolveWorkspacePath({
      workspace: createRunWorkspace(createWorkspace("workspace-docs", docsRoot, {
        trustState: "restricted",
      })),
      requestedPath: "README.md",
    });

    expect(result).toMatchObject({
      status: "resolved",
      rootName: "workspace-docs",
      trustState: "restricted",
    });
  });

  it("rejects a Run without a Workspace", () => {
    expect(resolveWorkspacePath({
      workspace: null,
      requestedPath: "README.md",
    })).toMatchObject({
      status: "rejected",
      error: { code: "workspace_missing" },
    });
  });

  it("rejects an unknown explicitly requested Workspace", () => {
    expect(resolveWorkspacePath({
      workspace: createCodeWorkspace(),
      rootName: "workspace-docs",
      requestedPath: "README.md",
    })).toMatchObject({
      status: "rejected",
      error: {
        code: "workspace_root_not_found",
        rootName: "workspace-docs",
      },
    });
  });

  it("rejects an empty explicitly requested Workspace identity", () => {
    expect(resolveWorkspacePath({
      workspace: createCodeWorkspace(),
      rootName: " ",
      requestedPath: "README.md",
    })).toMatchObject({
      status: "rejected",
      error: { code: "workspace_root_name_invalid" },
    });
  });

  it.each([
    {
      name: "a missing selected Workspace root",
      workspace: createWorkspace("workspace-code", null),
      expectedCode: "workspace_root_missing",
    },
    {
      name: "a non-absolute selected Workspace root",
      workspace: createWorkspace("workspace-code", join("relative", "code")),
      expectedCode: "workspace_root_not_absolute",
    },
  ])("rejects $name", ({ workspace, expectedCode }) => {
    expect(resolveWorkspacePath({
      workspace: createRunWorkspace(workspace),
      requestedPath: "README.md",
    })).toMatchObject({
      status: "rejected",
      error: {
        code: expectedCode,
        rootName: "workspace-code",
        workspaceId: "workspace-code",
      },
    });
  });

  it("rejects a missing requested path", () => {
    expect(resolveWorkspacePath({
      workspace: createCodeWorkspace(),
      requestedPath: "   ",
    })).toMatchObject({
      status: "rejected",
      error: { code: "requested_path_missing" },
    });
  });

  it("rejects an absolute requested path", () => {
    const requestedPath = join(codeRoot, "README.md");
    expect(resolveWorkspacePath({
      workspace: createCodeWorkspace(),
      requestedPath,
    })).toMatchObject({
      status: "rejected",
      error: {
        code: "absolute_path_not_allowed",
        requestedPath,
      },
    });
  });

  it.each(currentPlatformAbsolutePaths())(
    "rejects the supported absolute path form $requestedPath",
    ({ requestedPath }) => {
      expect(resolveWorkspacePath({
        workspace: createCodeWorkspace(),
        requestedPath,
      })).toMatchObject({
        status: "rejected",
        error: {
          code: "absolute_path_not_allowed",
          requestedPath,
        },
      });
    },
  );

  it("rejects traversal written with the portable forward-slash separator", () => {
    expect(resolveWorkspacePath({
      workspace: createCodeWorkspace(),
      requestedPath: "../outside.txt",
    })).toMatchObject({
      status: "rejected",
      error: { code: "path_outside_workspace" },
    });
  });

  it("rejects traversal outside the selected Workspace", () => {
    expect(resolveWorkspacePath({
      workspace: createCodeWorkspace(),
      requestedPath: join("..", "outside.txt"),
    })).toMatchObject({
      status: "rejected",
      error: { code: "path_outside_workspace" },
    });
  });

  it("rejects a sibling path with the selected root name as a prefix", () => {
    expect(resolveWorkspacePath({
      workspace: createCodeWorkspace(),
      requestedPath: join("..", `${basename(codeRoot)}-backup`, "outside.txt"),
    })).toMatchObject({
      status: "rejected",
      error: { code: "path_outside_workspace" },
    });
  });
});

function createRunWorkspace(
  primary: WorkspaceContext,
  additional: readonly WorkspaceContext[] = [],
): RunWorkspace {
  return { primary, additional };
}

function createCodeWorkspace(): RunWorkspace {
  return createRunWorkspace(createWorkspace("workspace-code", codeRoot));
}

function createWorkspace(
  id: string,
  rootRef: string | null,
  overrides: Partial<WorkspaceContext> = {},
): WorkspaceContext {
  return {
    id,
    name: id,
    rootRef,
    trustState: "trusted",
    source: "test",
    policyRefs: [],
    metadata: {},
    ...overrides,
  };
}

function currentPlatformAbsolutePaths(): Array<{ requestedPath: string }> {
  return process.platform === "win32"
    ? [
        { requestedPath: "C:\\outside.txt" },
        { requestedPath: "\\\\server\\share\\outside.txt" },
        { requestedPath: "\\outside.txt" },
      ]
    : [
        { requestedPath: "/outside.txt" },
        { requestedPath: "//server/share/outside.txt" },
      ];
}
