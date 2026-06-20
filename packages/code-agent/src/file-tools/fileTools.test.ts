import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TaskWorkspaceScope } from "@agent-anything/agent-core";
import type { WorkspaceContext } from "@agent-anything/governance";
import { ToolRegistry, type ToolCall } from "@agent-anything/tools";
import {
  CODE_AGENT_LIST_FILES_TOOL,
  CODE_AGENT_READ_FILE_TOOL,
  CODE_AGENT_SEARCH_FILES_TOOL,
  CODE_AGENT_WRITE_FILE_TOOL,
  registerCodeAgentFileTools,
} from "./index.js";

describe("code-agent file tools", () => {
  let testRoot: string;
  let codeRoot: string;
  let docsRoot: string;

  beforeEach(async () => {
    testRoot = await mkdtemp(join(tmpdir(), "agent-anything-file-tools-"));
    codeRoot = join(testRoot, "code");
    docsRoot = join(testRoot, "docs");
    await mkdir(join(codeRoot, "src"), { recursive: true });
    await mkdir(docsRoot, { recursive: true });
    await writeFile(join(codeRoot, "README.md"), "code readme");
    await writeFile(
      join(codeRoot, "src", "index.ts"),
      ["const needle = true;", ""].join(String.fromCharCode(10)),
    );
    await writeFile(join(docsRoot, "README.md"), "docs readme");
  });

  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  it("registers public definitions with the correct risk", () => {
    const registry = createRegistry();

    expect(registry.list().map((tool) => ({
      name: tool.name,
      risk: tool.risk,
    }))).toEqual([
      { name: CODE_AGENT_LIST_FILES_TOOL, risk: "safe" },
      { name: CODE_AGENT_READ_FILE_TOOL, risk: "safe" },
      { name: CODE_AGENT_SEARCH_FILES_TOOL, risk: "safe" },
      { name: CODE_AGENT_WRITE_FILE_TOOL, risk: "risky" },
    ]);
  });

  it("lists a selected root recursively without following links", async () => {
    const registry = createRegistry();

    const result = await registry.execute(createCall(
      CODE_AGENT_LIST_FILES_TOOL,
      {
        rootName: "code",
        path: ".",
        recursive: true,
      },
    ));

    expect(result).toMatchObject({
      status: "succeeded",
      output: {
        rootName: "code",
        workspaceId: "workspace-code",
        path: ".",
        truncated: false,
        entries: [
          { path: "README.md", kind: "file" },
          { path: "src", kind: "directory" },
          { path: "src/index.ts", kind: "file" },
        ],
      },
    });
  });

  it("bounds recursive listing output", async () => {
    const registry = createRegistry({ maxListEntries: 2 });

    const result = await registry.execute(createCall(
      CODE_AGENT_LIST_FILES_TOOL,
      { path: ".", recursive: true },
    ));

    expect(result).toMatchObject({
      status: "succeeded",
      output: {
        entries: [{}, {}],
        truncated: true,
      },
    });
  });

  it("reads UTF-8 content from the default root", async () => {
    const registry = createRegistry();

    const result = await registry.execute(createCall(
      CODE_AGENT_READ_FILE_TOOL,
      { path: "README.md" },
    ));

    expect(result).toMatchObject({
      status: "succeeded",
      output: {
        rootName: "code",
        workspaceId: "workspace-code",
        path: "README.md",
        content: "code readme",
        sizeBytes: 11,
      },
    });
  });

  it("rejects reads above the configured byte limit", async () => {
    const registry = createRegistry({ maxReadBytes: 4 });

    const result = await registry.execute(createCall(
      CODE_AGENT_READ_FILE_TOOL,
      { path: "README.md" },
    ));

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "file_read_limit_exceeded" },
    });
  });

  it("searches plain text and bounds matches", async () => {
    await writeFile(
      join(codeRoot, "src", "other.ts"),
      ["needle", "needle", ""].join(String.fromCharCode(10)),
    );
    const registry = createRegistry({ maxSearchMatches: 2 });

    const result = await registry.execute(createCall(
      CODE_AGENT_SEARCH_FILES_TOOL,
      { path: ".", query: "needle" },
    ));

    expect(result).toMatchObject({
      status: "succeeded",
      output: {
        rootName: "code",
        query: "needle",
        matches: [
          { path: "src/index.ts", line: 1, column: 7 },
          { path: "src/other.ts", line: 1, column: 1 },
        ],
        truncated: true,
        skippedFiles: 0,
      },
    });
  });

  it("creates and explicitly overwrites a file", async () => {
    const registry = createRegistry();

    const created = await registry.execute(createCall(
      CODE_AGENT_WRITE_FILE_TOOL,
      { rootName: "docs", path: "guide.md", content: "first" },
    ));
    const replaced = await registry.execute(createCall(
      CODE_AGENT_WRITE_FILE_TOOL,
      {
        rootName: "docs",
        path: "guide.md",
        content: "second",
        overwrite: true,
      },
    ));

    expect(created).toMatchObject({
      status: "succeeded",
      output: {
        rootName: "docs",
        path: "guide.md",
        bytesWritten: 5,
        created: true,
        replaced: false,
      },
    });
    expect(replaced).toMatchObject({
      status: "succeeded",
      output: {
        created: false,
        replaced: true,
      },
    });
    await expect(readFile(join(docsRoot, "guide.md"), "utf8"))
      .resolves.toBe("second");
  });

  it("rejects overwrite unless it is explicitly enabled", async () => {
    const registry = createRegistry();

    const result = await registry.execute(createCall(
      CODE_AGENT_WRITE_FILE_TOOL,
      { path: "README.md", content: "replacement" },
    ));

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "file_already_exists" },
    });
  });

  it("rejects writes above the configured byte limit", async () => {
    const registry = createRegistry({ maxWriteBytes: 4 });

    const result = await registry.execute(createCall(
      CODE_AGENT_WRITE_FILE_TOOL,
      { path: "small.txt", content: "12345" },
    ));

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "file_write_limit_exceeded" },
    });
  });

  it("returns structured errors for missing targets and parents", async () => {
    const registry = createRegistry();

    const missingRead = await registry.execute(createCall(
      CODE_AGENT_READ_FILE_TOOL,
      { path: "missing.txt" },
    ));
    const missingParent = await registry.execute(createCall(
      CODE_AGENT_WRITE_FILE_TOOL,
      { path: "missing/file.txt", content: "value" },
    ));

    expect(missingRead).toMatchObject({
      status: "failed",
      error: { code: "file_not_found" },
    });
    expect(missingParent).toMatchObject({
      status: "failed",
      error: { code: "file_parent_not_found" },
    });
  });

  it("rejects lexical traversal", async () => {
    const registry = createRegistry();

    const result = await registry.execute(createCall(
      CODE_AGENT_READ_FILE_TOOL,
      { path: join("..", "outside.txt") },
    ));

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "path_outside_workspace" },
    });
  });

  it("rejects canonical symlink escape and does not search through links", async () => {
    const outsideRoot = join(testRoot, "outside");
    await mkdir(outsideRoot);
    await writeFile(join(outsideRoot, "secret.txt"), "external needle");

    try {
      await symlink(
        outsideRoot,
        join(codeRoot, "escape"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "EPERM"
      ) {
        return;
      }
      throw error;
    }

    const registry = createRegistry();
    const escapedRead = await registry.execute(createCall(
      CODE_AGENT_READ_FILE_TOOL,
      { path: join("escape", "secret.txt") },
    ));
    const escapedWrite = await registry.execute(createCall(
      CODE_AGENT_WRITE_FILE_TOOL,
      { path: join("escape", "new.txt"), content: "blocked" },
    ));
    const search = await registry.execute(createCall(
      CODE_AGENT_SEARCH_FILES_TOOL,
      { path: ".", query: "external needle" },
    ));

    expect(escapedRead).toMatchObject({
      status: "failed",
      error: { code: "workspace_symlink_escape" },
    });
    expect(escapedWrite).toMatchObject({
      status: "failed",
      error: { code: "workspace_symlink_escape" },
    });
    expect(search).toMatchObject({
      status: "succeeded",
      output: {
        matches: [],
      },
    });
  });

  it("rejects invalid UTF-8 reads and skips unsuitable search files", async () => {
    await writeFile(
      join(codeRoot, "src", "invalid.bin"),
      new Uint8Array([255]),
    );
    await writeFile(
      join(codeRoot, "src", "oversized.txt"),
      "large needle",
    );
    const registry = createRegistry({ maxSearchFileBytes: 4 });

    const invalidRead = await registry.execute(createCall(
      CODE_AGENT_READ_FILE_TOOL,
      { path: join("src", "invalid.bin") },
    ));
    const search = await registry.execute(createCall(
      CODE_AGENT_SEARCH_FILES_TOOL,
      { path: "src", query: "needle" },
    ));

    expect(invalidRead).toMatchObject({
      status: "failed",
      error: { code: "file_not_utf8" },
    });
    expect(search).toMatchObject({
      status: "succeeded",
      output: {
        matches: [],
        skippedFiles: 3,
      },
    });
  });
  it("rejects missing trusted workspace scope", async () => {
    const registry = new ToolRegistry();
    registerCodeAgentFileTools(registry, {
      workspaceScope: undefined,
    });

    const result = await registry.execute(createCall(
      CODE_AGENT_READ_FILE_TOOL,
      { path: "README.md" },
    ));

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "workspace_scope_missing" },
    });
  });

  function createRegistry(
    limits: Parameters<typeof registerCodeAgentFileTools>[1]["limits"] = {},
  ): ToolRegistry {
    const registry = new ToolRegistry();
    registerCodeAgentFileTools(registry, {
      workspaceScope: createScope(),
      limits,
      now: () => "2026-06-20T00:00:00.000Z",
    });
    return registry;
  }

  function createScope(): TaskWorkspaceScope {
    return {
      roots: {
        code: createWorkspace("workspace-code", codeRoot),
        docs: createWorkspace("workspace-docs", docsRoot),
      },
      defaultRootName: "code",
    };
  }
});

function createWorkspace(
  id: string,
  rootRef: string,
): WorkspaceContext {
  return {
    id,
    name: id,
    rootRef,
    trustState: "trusted",
    source: "test",
    policyRefs: [],
    metadata: {},
  };
}

function createCall(
  toolName: string,
  input: unknown,
): ToolCall {
  return {
    id: "tool-call-1",
    toolName,
    input,
    risk: toolName === CODE_AGENT_WRITE_FILE_TOOL ? "risky" : "safe",
    metadata: {
      taskId: "task-1",
    },
  };
}