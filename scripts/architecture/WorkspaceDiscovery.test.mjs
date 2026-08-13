import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  WorkspaceDiscoveryError,
  discoverWorkspacePackages,
} from "./WorkspaceDiscovery.mjs";

test("discovers newly added packages from accepted workspace patterns", () => {
  withWorkspace((root) => {
    writeFileSync(
      join(root, "pnpm-workspace.yaml"),
      'packages:\n  - "harness/agent-core/contracts"\n',
    );
    createPackage(root, "harness/agent-core/contracts", "@test/agent-core-contracts", {
      kind: "harness",
      component: "agent-core",
      role: "contracts",
    });
    assert.deepEqual(
      discoverWorkspacePackages(root).map((item) => item.name),
      ["@test/agent-core-contracts"],
    );

    writeFileSync(
      join(root, "pnpm-workspace.yaml"),
      'packages:\n  - "harness/agent-core/contracts"\n  - "harness/agent-core/runtime"\n',
    );
    createPackage(root, "harness/agent-core/runtime", "@test/agent-core-runtime", {
      kind: "harness",
      component: "agent-core",
      role: "runtime",
    });
    assert.deepEqual(
      discoverWorkspacePackages(root).map((item) => item.name),
      ["@test/agent-core-contracts", "@test/agent-core-runtime"],
    );
  });
});

test("classifies direct and grouped Harness packages", () => {
  withWorkspace((root) => {
    writeFileSync(
      join(root, "pnpm-workspace.yaml"),
      'packages:\n  - "harness/agent-core/contracts"\n  - "harness/safety/*"\n',
    );
    createPackage(root, "harness/agent-core/contracts", "@test/agent-core-contracts", {
      kind: "harness",
      component: "agent-core",
      role: "contracts",
    });
    createPackage(root, "harness/safety/permission", "@test/permission", {
      kind: "harness",
      component: "safety.permission",
    });

    assert.deepEqual(
      discoverWorkspacePackages(root).map(({ kind, component, name, role }) => ({
        kind,
        component,
        name,
        role,
      })),
      [
        {
          kind: "harness",
          component: "agent-core",
          name: "@test/agent-core-contracts",
          role: "contracts",
        },
        {
          kind: "harness",
          component: "safety.permission",
          name: "@test/permission",
          role: null,
        },
      ],
    );
  });
});

test("discovers the Phase27 lower Contract package topology", () => {
  withWorkspace((root) => {
    writeFileSync(
      join(root, "pnpm-workspace.yaml"),
      [
        "packages:",
        '  - "harness/workspace"',
        '  - "harness/agent-core/contracts"',
        '  - "harness/operation-catalog"',
        '  - "harness/interaction"',
        '  - "harness/safety/*"',
        "",
      ].join("\n"),
    );
    createPackage(root, "harness/workspace", "@test/workspace", {
      kind: "harness",
      component: "workspace",
    });
    createPackage(root, "harness/agent-core/contracts", "@test/agent-core", {
      kind: "harness",
      component: "agent-core",
      role: "contracts",
    });
    createPackage(root, "harness/operation-catalog", "@test/operation-catalog", {
      kind: "harness",
      component: "operation-catalog",
    });
    createPackage(root, "harness/interaction", "@test/interaction", {
      kind: "harness",
      component: "interaction",
    });
    createPackage(root, "harness/safety/canonical-action", "@test/canonical-action", {
      kind: "harness",
      component: "safety.canonical-action",
    });

    assert.deepEqual(
      discoverWorkspacePackages(root).map(({ name, component, role }) => ({
        name,
        component,
        role,
      })),
      [
        { name: "@test/agent-core", component: "agent-core", role: "contracts" },
        { name: "@test/interaction", component: "interaction", role: null },
        { name: "@test/operation-catalog", component: "operation-catalog", role: null },
        { name: "@test/canonical-action", component: "safety.canonical-action", role: null },
        { name: "@test/workspace", component: "workspace", role: null },
      ],
    );
  });
});

test("classifies explicit packages under one Product grouping", () => {
  withWorkspace((root) => {
    writeFileSync(
      join(root, "pnpm-workspace.yaml"),
      'packages:\n  - "products/helarc/*"\n',
    );
    createPackage(root, "products/helarc/product", "@test/helarc", {
      kind: "product",
      productId: "helarc",
      component: "product",
    });
    createPackage(
      root,
      "products/helarc/desktop",
      "@test/helarc-desktop",
      {
        kind: "product",
        productId: "helarc",
        component: "desktop",
      },
    );

    assert.deepEqual(
      discoverWorkspacePackages(root).map(
        ({ kind, name, productId, component }) => ({
          kind,
          name,
          productId,
          component,
        }),
      ),
      [
        {
          kind: "product",
          name: "@test/helarc-desktop",
          productId: "helarc",
          component: "desktop",
        },
        {
          kind: "product",
          name: "@test/helarc",
          productId: "helarc",
          component: "product",
        },
      ],
    );
  });
});

test("admits only the explicit development Tooling package", () => {
  withWorkspace((root) => {
    writeFileSync(
      join(root, "pnpm-workspace.yaml"),
      'packages:\n  - "tooling/test-support"\n',
    );
    createPackage(
      root,
      "tooling/test-support",
      "@test/test-support",
      {
        kind: "tooling",
        component: "test-support",
      },
    );

    assert.deepEqual(
      discoverWorkspacePackages(root).map(({ kind, component }) => ({
        kind,
        component,
      })),
      [{ kind: "tooling", component: "test-support" }],
    );
  });
});

test("rejects missing, extra, and path-mismatched architecture metadata", () => {
  for (const [name, metadata] of [
    ["missing", undefined],
    ["extra", { kind: "harness", component: "agent-core", role: "runtime", extra: true }],
    ["mismatched", { kind: "harness", component: "runtime" }],
  ]) {
    withWorkspace((root) => {
      writeFileSync(
        join(root, "pnpm-workspace.yaml"),
        'packages:\n  - "harness/agent-core/runtime"\n',
      );
      createPackage(root, "harness/agent-core/runtime", `@test/${name}`, metadata);
      assert.throws(
        () => discoverWorkspacePackages(root),
        (error) =>
          error instanceof WorkspaceDiscoveryError &&
          (
            error.issues[0]?.rule === "architecture_metadata_missing" ||
            error.issues[0]?.rule === "architecture_metadata_path_mismatch"
          ),
      );
    });
  }
});

test("rejects unsupported workspace patterns", () => {
  withWorkspace((root) => {
    writeFileSync(
      join(root, "pnpm-workspace.yaml"),
      'packages:\n  - "harness/**"\n',
    );
    assert.throws(
      () => discoverWorkspacePackages(root),
      (error) =>
        error instanceof WorkspaceDiscoveryError &&
        error.issues[0]?.rule === "workspace_pattern_unsupported",
    );
  });
});

test("rejects workspace packages outside known repository kinds", () => {
  withWorkspace((root) => {
    writeFileSync(
      join(root, "pnpm-workspace.yaml"),
      'packages:\n  - "other/*"\n',
    );
    createPackage(root, "other/example", "@test/example", {
      kind: "harness",
      component: "example",
    });
    assert.throws(
      () => discoverWorkspacePackages(root),
      (error) =>
        error instanceof WorkspaceDiscoveryError &&
        error.issues[0]?.rule === "workspace_package_kind_unknown",
    );
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

function createPackage(root, path, name, architecture) {
  const packageRoot = join(root, path);
  mkdirSync(packageRoot, { recursive: true });
  const agentAnything = architecture === undefined
    ? undefined
    : { architecture };
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name, agentAnything }),
  );
}
