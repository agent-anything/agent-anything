import assert from "node:assert/strict";
import test from "node:test";
import {
  filtersFromSearch,
  startPackageDependencyServer,
} from "./PackageDependencyServer.mjs";

test("serves filtered HTML, JSON, Mermaid, health, and method failures", async () => {
  const service = await startTestServer(() => graphFixture());
  try {
    const htmlResponse = await fetch(`${service.baseUrl}/?scope=product`);
    assert.equal(htmlResponse.status, 200);
    assert.match(htmlResponse.headers.get("content-type"), /text\/html/);
    const html = await htmlResponse.text();
    assert.match(html, /helarc/);
    assert.doesNotMatch(html, /agent-runtime/);
    assert.match(html, /new EventSource\(liveReloadPath\)/);

    const jsonResponse = await fetch(
      `${service.baseUrl}/api/graph?focus=${encodeURIComponent("@agent-anything/agent-runtime")}&depth=1`,
    );
    assert.equal(jsonResponse.status, 200);
    const graph = await jsonResponse.json();
    assert.deepEqual(
      graph.nodes.map((node) => node.id),
      ["@agent-anything/agent-core", "@agent-anything/agent-runtime"],
    );

    const mermaid = await fetch(`${service.baseUrl}/package-dependencies.mmd`);
    assert.equal(mermaid.status, 200);
    assert.match(await mermaid.text(), /flowchart LR/);

    const health = await fetch(`${service.baseUrl}/health`);
    assert.deepEqual(await health.json(), {
      status: "ok",
      revision: 1,
      error: null,
    });

    const rejected = await fetch(service.baseUrl, { method: "POST" });
    assert.equal(rejected.status, 405);
    assert.equal(rejected.headers.get("allow"), "GET");

    const invalid = await fetch(`${service.baseUrl}/?includeDev=perhaps`);
    assert.equal(invalid.status, 400);
  } finally {
    await service.close();
  }
});

test("keeps the last successful graph when a rebuild fails", async () => {
  let fail = false;
  let current = graphFixture();
  const messages = [];
  const service = await startTestServer(() => {
    if (fail) throw new Error("fixture rebuild failed");
    return current;
  }, {
    logger: {
      log: (message) => messages.push(message),
      error: (message) => messages.push(message),
    },
  });
  try {
    current = {
      ...current,
      nodes: current.nodes.slice(0, 2),
      edges: current.edges.slice(0, 1),
    };
    assert.deepEqual(service.rebuild(), { ok: true, revision: 2 });
    assert.equal(
      (await (await fetch(`${service.baseUrl}/api/graph`)).json()).nodes.length,
      2,
    );

    fail = true;
    assert.deepEqual(service.rebuild(), {
      ok: false,
      revision: 2,
      error: "fixture rebuild failed",
    });
    const retained = await (await fetch(`${service.baseUrl}/api/graph`)).json();
    assert.equal(retained.nodes.length, 2);
    const health = await (await fetch(`${service.baseUrl}/health`)).json();
    assert.deepEqual(health, {
      status: "degraded",
      revision: 2,
      error: "fixture rebuild failed",
    });
    assert.equal(messages.length, 2);
  } finally {
    await service.close();
  }
});

test("emits graph update events and fails clearly on a busy port", async () => {
  const service = await startTestServer(() => graphFixture());
  const abort = new AbortController();
  try {
    const events = await fetch(`${service.baseUrl}/events`, { signal: abort.signal });
    assert.equal(events.status, 200);
    const reader = events.body.getReader();
    const decoder = new TextDecoder();
    const ready = decoder.decode((await reader.read()).value);
    assert.match(ready, /event: ready/);

    service.rebuild();
    const updated = decoder.decode((await reader.read()).value);
    assert.match(updated, /event: graph-updated/);
    abort.abort();

    await assert.rejects(
      startPackageDependencyServer({
        repoRoot: process.cwd(),
        port: service.port,
        watchInputs: false,
        loadGraph: () => graphFixture(),
        logger: quietLogger(),
      }),
      /port .* is already in use/,
    );
  } finally {
    abort.abort();
    await service.close();
  }
});

test("parses bookmarkable query filters", () => {
  const filters = filtersFromSearch(new URLSearchParams({
    scope: "harness",
    focus: "@agent-anything/context",
    depth: "2",
    reverse: "1",
    includeDev: "true",
  }));
  assert.deepEqual(filters, {
    scope: "harness",
    focus: "@agent-anything/context",
    depth: 2,
    reverse: true,
    includeDevelopment: true,
  });
});

function startTestServer(loadGraph, overrides = {}) {
  return startPackageDependencyServer({
    repoRoot: process.cwd(),
    port: 0,
    watchInputs: false,
    loadGraph,
    logger: quietLogger(),
    ...overrides,
  });
}

function quietLogger() {
  return { log() {}, error() {} };
}

function graphFixture() {
  return {
    schemaVersion: 1,
    nodes: [
      {
        id: "@agent-anything/agent-core",
        path: "harness/agent-core/contracts",
        kind: "harness",
        productId: null,
        component: "agent-core",
        role: "contracts",
      },
      {
        id: "@agent-anything/agent-runtime",
        path: "harness/agent-core/runtime",
        kind: "harness",
        productId: null,
        component: "agent-core",
        role: "runtime",
      },
      {
        id: "@agent-anything/helarc",
        path: "products/helarc/core",
        kind: "product",
        productId: "helarc",
        component: "core",
        role: null,
      },
    ],
    edges: [
      {
        from: "@agent-anything/agent-runtime",
        to: "@agent-anything/agent-core",
        declaration: "production",
        usage: "production",
        observedImports: { production: 1, development: 0 },
      },
      {
        from: "@agent-anything/helarc",
        to: "@agent-anything/agent-runtime",
        declaration: "production",
        usage: "production",
        observedImports: { production: 1, development: 0 },
      },
    ],
    issues: [],
  };
}
