import { basename, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { TaskWorkspaceScope } from "@agent-anything/agent-core/task";
import type { WorkspaceContext } from "@agent-anything/governance";
import { resolveWorkspacePath } from "./resolveWorkspacePath.js";

const codeRoot = resolve("workspace-fixtures", "code");
const docsRoot = resolve("workspace-fixtures", "docs");

describe("resolveWorkspacePath", () => {
  it("selects an explicit root from a multi-root task scope", () => {
    const result = resolveWorkspacePath({
      workspaceScope: createScope(
        {
          code: createWorkspace("workspace-code", codeRoot),
          docs: createWorkspace("workspace-docs", docsRoot),
        },
        "code",
      ),
      rootName: "docs",
      requestedPath: join("design", "..", "README.md"),
    });

    expect(result).toEqual({
      status: "resolved",
      rootName: "docs",
      workspaceId: "workspace-docs",
      trustState: "trusted",
      workspaceRoot: docsRoot,
      relativePath: "README.md",
      absolutePath: join(docsRoot, "README.md"),
    });
  });

  it("selects the default root when no root name is requested", () => {
    const result = resolveWorkspacePath({
      workspaceScope: createScope(
        {
          code: createWorkspace("workspace-code", codeRoot),
          docs: createWorkspace("workspace-docs", docsRoot),
        },
        "docs",
      ),
      requestedPath: ".",
    });

    expect(result).toMatchObject({
      status: "resolved",
      rootName: "docs",
      workspaceId: "workspace-docs",
      relativePath: ".",
      absolutePath: docsRoot,
    });
  });

  it("implicitly selects the only root", () => {
    const result = resolveWorkspacePath({
      workspaceScope: createScope({
        code: createWorkspace("workspace-code", codeRoot),
      }),
      requestedPath: "README.md",
    });

    expect(result).toMatchObject({
      status: "resolved",
      rootName: "code",
      workspaceId: "workspace-code",
    });
  });

  it("preserves the selected root trust state", () => {
    const restricted = createWorkspace("workspace-docs", docsRoot, {
      trustState: "restricted",
    });
    const result = resolveWorkspacePath({
      workspaceScope: createScope({ docs: restricted }),
      requestedPath: "README.md",
    });

    expect(result).toMatchObject({
      status: "resolved",
      rootName: "docs",
      trustState: "restricted",
    });
  });

  it.each([
    {
      name: "a missing scope",
      workspaceScope: undefined,
      expectedCode: "workspace_scope_missing",
    },
    {
      name: "an empty scope",
      workspaceScope: createScope({}),
      expectedCode: "workspace_scope_empty",
    },
    {
      name: "an empty declared root name",
      workspaceScope: createScope({
        " ": createWorkspace("workspace-code", codeRoot),
      }),
      expectedCode: "workspace_root_name_invalid",
    },
    {
      name: "an unknown default root",
      workspaceScope: createScope(
        { code: createWorkspace("workspace-code", codeRoot) },
        "docs",
      ),
      expectedCode: "workspace_root_not_found",
    },
  ])("rejects $name", ({ workspaceScope, expectedCode }) => {
    const result = resolveWorkspacePath({
      workspaceScope,
      requestedPath: "README.md",
    });

    expect(result).toMatchObject({
      status: "rejected",
      error: { code: expectedCode },
    });
  });

  it("requires a root name for multiple roots without a default", () => {
    const result = resolveWorkspacePath({
      workspaceScope: createScope({
        code: createWorkspace("workspace-code", codeRoot),
        docs: createWorkspace("workspace-docs", docsRoot),
      }),
      requestedPath: "README.md",
    });

    expect(result).toMatchObject({
      status: "rejected",
      error: { code: "workspace_root_name_required" },
    });
  });

  it("rejects an unknown explicitly requested root", () => {
    const result = resolveWorkspacePath({
      workspaceScope: createScope({
        code: createWorkspace("workspace-code", codeRoot),
      }),
      rootName: "docs",
      requestedPath: "README.md",
    });

    expect(result).toMatchObject({
      status: "rejected",
      error: {
        code: "workspace_root_not_found",
        rootName: "docs",
      },
    });
  });

  it("rejects an empty explicitly requested root name", () => {
    const result = resolveWorkspacePath({
      workspaceScope: createScope({
        code: createWorkspace("workspace-code", codeRoot),
      }),
      rootName: " ",
      requestedPath: "README.md",
    });

    expect(result).toMatchObject({
      status: "rejected",
      error: { code: "workspace_root_name_invalid" },
    });
  });

  it.each([
    {
      name: "a missing selected workspace root",
      workspace: createWorkspace("workspace-code", null),
      expectedCode: "workspace_root_missing",
    },
    {
      name: "a non-absolute selected workspace root",
      workspace: createWorkspace("workspace-code", join("relative", "code")),
      expectedCode: "workspace_root_not_absolute",
    },
  ])("rejects $name", ({ workspace, expectedCode }) => {
    const result = resolveWorkspacePath({
      workspaceScope: createScope({ code: workspace }),
      requestedPath: "README.md",
    });

    expect(result).toMatchObject({
      status: "rejected",
      error: {
        code: expectedCode,
        rootName: "code",
        workspaceId: "workspace-code",
      },
    });
  });

  it("rejects a missing requested path", () => {
    const result = resolveWorkspacePath({
      workspaceScope: createCodeScope(),
      requestedPath: "   ",
    });

    expect(result).toMatchObject({
      status: "rejected",
      error: { code: "requested_path_missing" },
    });
  });

  it("rejects an absolute requested path", () => {
    const requestedPath = join(codeRoot, "README.md");
    const result = resolveWorkspacePath({
      workspaceScope: createCodeScope(),
      requestedPath,
    });

    expect(result).toMatchObject({
      status: "rejected",
      error: {
        code: "absolute_path_not_allowed",
        requestedPath,
      },
    });
  });

  it("rejects traversal outside the selected root", () => {
    const result = resolveWorkspacePath({
      workspaceScope: createCodeScope(),
      requestedPath: join("..", "outside.txt"),
    });

    expect(result).toMatchObject({
      status: "rejected",
      error: { code: "path_outside_workspace" },
    });
  });

  it("rejects a sibling path with the selected root name as a prefix", () => {
    const result = resolveWorkspacePath({
      workspaceScope: createCodeScope(),
      requestedPath: join(
        "..",
        basename(codeRoot) + "-backup",
        "outside.txt",
      ),
    });

    expect(result).toMatchObject({
      status: "rejected",
      error: { code: "path_outside_workspace" },
    });
  });
});

function createScope(
  roots: Readonly<Record<string, WorkspaceContext>>,
  defaultRootName?: string,
): TaskWorkspaceScope {
  return {
    roots,
    ...(defaultRootName === undefined ? {} : { defaultRootName }),
  };
}

function createCodeScope(): TaskWorkspaceScope {
  return createScope({
    code: createWorkspace("workspace-code", codeRoot),
  });
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
