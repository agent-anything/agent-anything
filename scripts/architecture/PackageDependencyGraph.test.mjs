import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildPackageDependencyGraph,
  inspectPackageDependencies,
  selectPackageDependencyGraph,
} from "./PackageDependencyGraph.mjs";

test("builds declared Workspace edges and observes production and test imports", () => {
  withFixture((root) => {
    const graph = buildPackageDependencyGraph(root);

    assert.deepEqual(graph.nodes.map((node) => node.id), [
      "@test/agent-core",
      "@test/workspace",
      "@test/helarc",
    ]);
    assert.deepEqual(graph.edges, [
      {
        from: "@test/agent-core",
        to: "@test/workspace",
        declaration: "production",
        usage: "production",
        observedImports: { production: 1, development: 0 },
      },
      {
        from: "@test/helarc",
        to: "@test/agent-core",
        declaration: "production",
        usage: "production",
        observedImports: { production: 1, development: 0 },
      },
      {
        from: "@test/helarc",
        to: "@test/workspace",
        declaration: "development",
        usage: "development",
        observedImports: { production: 0, development: 1 },
      },
    ]);
    assert.deepEqual(graph.issues, []);
  });
});

test("filters by scope, focus, direction, depth, and development edges", () => {
  withFixture((root) => {
    const graph = buildPackageDependencyGraph(root);
    const dependencies = selectPackageDependencyGraph(graph, {
      focus: "@test/helarc",
      depth: 1,
    });
    assert.deepEqual(
      dependencies.nodes.map((node) => node.id),
      ["@test/agent-core", "@test/helarc"],
    );

    const includingDevelopment = selectPackageDependencyGraph(graph, {
      focus: "@test/helarc",
      depth: 1,
      includeDevelopment: true,
    });
    assert.deepEqual(
      includingDevelopment.nodes.map((node) => node.id),
      ["@test/agent-core", "@test/workspace", "@test/helarc"],
    );

    const consumers = selectPackageDependencyGraph(graph, {
      focus: "@test/workspace",
      depth: 1,
      reverse: true,
    });
    assert.deepEqual(
      consumers.nodes.map((node) => node.id),
      ["@test/agent-core", "@test/workspace"],
    );

    const harness = selectPackageDependencyGraph(graph, { scope: "harness" });
    assert.deepEqual(
      harness.nodes.map((node) => node.id),
      ["@test/agent-core", "@test/workspace"],
    );
  });
});

test("reports direct and transitive dependencies and consumers", () => {
  withFixture((root) => {
    const inspection = inspectPackageDependencies(
      buildPackageDependencyGraph(root),
      "@test/workspace",
    );
    assert.deepEqual(
      inspection.directConsumers.map((edge) => edge.from),
      ["@test/agent-core"],
    );
    assert.deepEqual(inspection.transitiveConsumers, ["@test/helarc"]);
  });
});

test("retains an undeclared import as a visible graph issue", () => {
  withFixture((root) => {
    const manifestPath = join(root, "products/helarc/core/package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    delete manifest.devDependencies;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    writeFileSync(
      join(root, "products/helarc/core/src/index.ts"),
      'import "@test/workspace/identity";\n',
    );
    const invalid = buildPackageDependencyGraph(root);
    assert.equal(
      invalid.edges.find((edge) =>
        edge.from === "@test/helarc" && edge.to === "@test/workspace"
      )?.declaration,
      "undeclared",
    );
    assert.equal(invalid.issues[0]?.code, "workspace_dependency_undeclared");
  });
});

test("reports production use of a development-only Workspace dependency", () => {
  withFixture((root) => {
    writeFileSync(
      join(root, "products/helarc/core/src/index.ts"),
      'import "@test/workspace/identity";\n',
    );
    const graph = buildPackageDependencyGraph(root);
    const edge = graph.edges.find((item) =>
      item.from === "@test/helarc" && item.to === "@test/workspace"
    );
    assert.equal(edge?.declaration, "development");
    assert.equal(edge?.usage, "production-and-development");
    assert.equal(graph.issues[0]?.code, "workspace_dependency_dev_only");
  });
});

function withFixture(run) {
  const root = mkdtempSync(join(tmpdir(), "agent-anything-package-graph-"));
  try {
    writeFileSync(
      join(root, "pnpm-workspace.yaml"),
      [
        "packages:",
        '  - "harness/workspace"',
        '  - "harness/agent-core/contracts"',
        '  - "products/helarc/core"',
        "",
      ].join("\n"),
    );
    createPackage(root, "harness/workspace", {
      name: "@test/workspace",
      architecture: { kind: "harness", component: "workspace" },
      source: "export const workspace = true;\n",
    });
    createPackage(root, "harness/agent-core/contracts", {
      name: "@test/agent-core",
      architecture: { kind: "harness", component: "agent-core", role: "contracts" },
      dependencies: { "@test/workspace": "workspace:*" },
      source: 'export { workspace } from "@test/workspace/identity";\n',
    });
    createPackage(root, "products/helarc/core", {
      name: "@test/helarc",
      architecture: { kind: "product", productId: "helarc", component: "core" },
      dependencies: { "@test/agent-core": "workspace:*" },
      devDependencies: { "@test/workspace": "workspace:*" },
      source: 'import "@test/agent-core/run";\n',
      testSource: 'import "@test/workspace/identity";\n',
    });
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function createPackage(root, path, input) {
  const packageRoot = join(root, path);
  const sourceRoot = join(packageRoot, "src");
  mkdirSync(sourceRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: input.name,
      dependencies: input.dependencies,
      devDependencies: input.devDependencies,
      agentAnything: { architecture: input.architecture },
    }, null, 2),
  );
  writeFileSync(join(sourceRoot, "index.ts"), input.source);
  if (input.testSource) {
    writeFileSync(join(sourceRoot, "index.test.ts"), input.testSource);
  }
}
