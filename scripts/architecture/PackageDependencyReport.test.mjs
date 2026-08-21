import assert from "node:assert/strict";
import test from "node:test";
import {
  renderPackageDependencyHtml,
  renderPackageDependencyJson,
  renderPackageDependencyMermaid,
  renderPackageInspection,
} from "./PackageDependencyReport.mjs";

const graph = {
  schemaVersion: 1,
  filters: {
    scope: null,
    focus: null,
    depth: null,
    reverse: false,
    includeDevelopment: false,
  },
  nodes: [
    { id: "@agent-anything/workspace", path: "harness/workspace", kind: "harness", productId: null, component: "workspace", role: null },
    { id: "@agent-anything/agent-core", path: "harness/agent-core/contracts", kind: "harness", productId: null, component: "agent-core", role: "contracts" },
  ],
  edges: [
    { from: "@agent-anything/agent-core", to: "@agent-anything/workspace", declaration: "production", usage: "production", observedImports: { production: 2, development: 1 } },
  ],
  issues: [],
};

test("renders machine-readable, Mermaid, and self-contained HTML reports", () => {
  assert.deepEqual(JSON.parse(renderPackageDependencyJson(graph)), graph);
  const mermaid = renderPackageDependencyMermaid(graph);
  assert.match(mermaid, /flowchart LR/);
  assert.match(mermaid, /agent-core/);
  assert.match(mermaid, /p1 --> p0/);

  const html = renderPackageDependencyHtml(graph);
  assert.match(html, /<!doctype html>/);
  assert.match(html, /Package Dependencies/);
  assert.match(html, /@agent-anything\/agent-core/);
  assert.doesNotMatch(html, /<script[^>]+src=/);
  assert.doesNotMatch(html, /<link[^>]+href=/);
});

test("renders terminal dependency inspection", () => {
  const text = renderPackageInspection({
    package: graph.nodes[1],
    directDependencies: graph.edges,
    directConsumers: [],
    transitiveDependencies: [],
    transitiveConsumers: ["@agent-anything/helarc"],
  });
  assert.match(text, /Package: @agent-anything\/agent-core/);
  assert.match(text, /@agent-anything\/workspace \[production; production\]/);
  assert.match(text, /Transitive consumers \(1\)/);
});
