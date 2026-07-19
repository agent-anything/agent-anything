import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkspaceDiscoveryError, discoverWorkspacePackages } from "./WorkspaceDiscovery.mjs";

test("discovers a newly added package from workspace patterns", () => {
  withWorkspace((root) => {
    writeFileSync(join(root, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
    createPackage(root, "packages/first", "@test/first");
    assert.deepEqual(discoverWorkspacePackages(root).map((item) => item.name), ["@test/first"]);

    createPackage(root, "packages/second", "@test/second");
    assert.deepEqual(discoverWorkspacePackages(root).map((item) => item.name), ["@test/first", "@test/second"]);
  });
});

test("rejects unsupported workspace patterns", () => {
  withWorkspace((root) => {
    writeFileSync(join(root, "pnpm-workspace.yaml"), 'packages:\n  - "packages/**"\n');
    assert.throws(() => discoverWorkspacePackages(root), (error) =>
      error instanceof WorkspaceDiscoveryError && error.issues[0]?.rule === "workspace_pattern_unsupported");
  });
});

test("rejects workspace packages outside known repository kinds", () => {
  withWorkspace((root) => {
    writeFileSync(join(root, "pnpm-workspace.yaml"), 'packages:\n  - "other/*"\n');
    createPackage(root, "other/example", "@test/example");
    assert.throws(() => discoverWorkspacePackages(root), (error) =>
      error instanceof WorkspaceDiscoveryError && error.issues[0]?.rule === "workspace_package_kind_unknown");
  });
});

function withWorkspace(run) {
  const root = mkdtempSync(join(tmpdir(), "agent-anything-architecture-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function createPackage(root, path, name) {
  const packageRoot = join(root, path);
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name }));
}
