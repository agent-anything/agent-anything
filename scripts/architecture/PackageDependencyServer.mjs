import { existsSync, watch } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import {
  buildPackageDependencyGraph,
  selectPackageDependencyGraph,
} from "./PackageDependencyGraph.mjs";
import {
  renderPackageDependencyHtml,
  renderPackageDependencyJson,
  renderPackageDependencyMermaid,
} from "./PackageDependencyReport.mjs";

export async function startPackageDependencyServer(input) {
  const repoRoot = resolve(input.repoRoot);
  const host = input.host ?? "127.0.0.1";
  const requestedPort = input.port ?? 4310;
  const defaultFilters = input.defaultFilters ?? {};
  const loadGraph = input.loadGraph ?? (() => buildPackageDependencyGraph(repoRoot));
  const logger = input.logger ?? console;
  const clients = new Set();
  let graph = loadGraph();
  let revision = 1;
  let rebuildError = null;
  let rebuildTimer = null;
  let closed = false;

  const server = createServer((request, response) => {
    try {
      handleRequest(request, response);
    } catch (error) {
      writeError(response, 400, error.message);
    }
  });
  await listen(server, requestedPort, host);
  const address = server.address();
  const port = typeof address === "object" && address !== null
    ? address.port
    : requestedPort;
  const baseUrl = `http://${host}:${port}`;

  let watchers;
  try {
    watchers = input.watchInputs === false
      ? []
      : watchRepositoryInputs(repoRoot, scheduleRebuild, reportWatchError);
  } catch (error) {
    await closeHttpServer(server);
    throw error;
  }
  const keepAlive = setInterval(() => {
    for (const client of clients) client.write(": keep-alive\n\n");
  }, 15_000);
  keepAlive.unref();

  return {
    url: initialUrl(baseUrl, defaultFilters),
    baseUrl,
    host,
    port,
    rebuild: rebuildGraph,
    close,
  };

  function handleRequest(request, response) {
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      writeError(response, 405, "Only GET is supported.");
      return;
    }
    const url = new URL(request.url ?? "/", baseUrl);
    if (url.pathname === "/events") {
      openEventStream(request, response);
      return;
    }
    if (url.pathname === "/health") {
      writeJson(response, {
        status: rebuildError === null ? "ok" : "degraded",
        revision,
        error: rebuildError,
      });
      return;
    }
    if (url.pathname === "/favicon.ico") {
      response.writeHead(204, securityHeaders());
      response.end();
      return;
    }

    const selected = selectPackageDependencyGraph(
      graph,
      filtersFromSearch(url.searchParams, defaultFilters),
    );
    if (url.pathname === "/") {
      writeContent(
        response,
        200,
        "text/html; charset=utf-8",
        renderPackageDependencyHtml(selected, {
          liveReloadPath: "/events",
          initialServerError: rebuildError,
          serverRevision: revision,
        }),
      );
    } else if (
      url.pathname === "/api/graph" ||
      url.pathname === "/package-dependencies.json"
    ) {
      writeContent(
        response,
        200,
        "application/json; charset=utf-8",
        renderPackageDependencyJson(selected),
      );
    } else if (url.pathname === "/package-dependencies.mmd") {
      writeContent(
        response,
        200,
        "text/plain; charset=utf-8",
        renderPackageDependencyMermaid(selected),
      );
    } else {
      writeError(response, 404, "Dependency Explorer route not found.");
    }
  }

  function openEventStream(request, response) {
    response.writeHead(200, {
      ...securityHeaders(),
      "Cache-Control": "no-cache, no-transform",
      "Content-Type": "text/event-stream; charset=utf-8",
      Connection: "keep-alive",
    });
    response.write(`event: ready\ndata: ${JSON.stringify({ revision })}\n\n`);
    clients.add(response);
    request.on("close", () => clients.delete(response));
  }

  function scheduleRebuild() {
    if (closed) return;
    if (rebuildTimer !== null) clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(rebuildGraph, input.debounceMs ?? 180);
  }

  function rebuildGraph() {
    rebuildTimer = null;
    try {
      const next = loadGraph();
      graph = next;
      revision += 1;
      rebuildError = null;
      broadcast("graph-updated", { revision });
      logger.log(`Package dependency graph rebuilt at revision ${revision}.`);
      return { ok: true, revision };
    } catch (error) {
      rebuildError = error instanceof Error ? error.message : String(error);
      broadcast("graph-error", { revision, message: rebuildError });
      logger.error(`Package dependency graph rebuild failed: ${rebuildError}`);
      return { ok: false, revision, error: rebuildError };
    }
  }

  function reportWatchError(error) {
    rebuildError = error instanceof Error ? error.message : String(error);
    broadcast("graph-error", { revision, message: rebuildError });
    logger.error(`Package dependency graph watch failed: ${rebuildError}`);
  }

  function broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) client.write(payload);
  }

  async function close() {
    if (closed) return;
    closed = true;
    if (rebuildTimer !== null) clearTimeout(rebuildTimer);
    clearInterval(keepAlive);
    for (const watcher of watchers) watcher.close();
    for (const client of clients) client.end();
    clients.clear();
    await closeHttpServer(server);
  }
}

export function filtersFromSearch(search, defaults = {}) {
  return {
    scope: optionalText(search, "scope", defaults.scope ?? null),
    focus: optionalText(search, "focus", defaults.focus ?? null),
    depth: optionalDepth(search, defaults.depth ?? null),
    reverse: optionalBoolean(search, "reverse", defaults.reverse === true),
    includeDevelopment: optionalBoolean(
      search,
      "includeDev",
      defaults.includeDevelopment === true,
    ),
  };
}

function watchRepositoryInputs(repoRoot, onChange, onError) {
  const watchers = [];
  try {
    const rootWatcher = watch(repoRoot, { recursive: false }, (_event, filename) => {
      if (filename === null || filename.toString() === "pnpm-workspace.yaml") onChange();
    });
    rootWatcher.on("error", onError);
    watchers.push(rootWatcher);

    for (const name of ["harness", "products", "tooling"]) {
      const directory = join(repoRoot, name);
      if (!existsSync(directory)) continue;
      const watcher = watch(directory, { recursive: true }, (_event, filename) => {
        if (filename === null || isRelevantDependencyInput(filename.toString())) {
          onChange();
        }
      });
      watcher.on("error", onError);
      watchers.push(watcher);
    }
    return watchers;
  } catch (error) {
    for (const watcher of watchers) watcher.close();
    throw error;
  }
}

function isRelevantDependencyInput(filename) {
  const normalized = filename.replaceAll("\\", "/");
  if (
    normalized.includes("/node_modules/") ||
    normalized.includes("/dist/") ||
    normalized.includes("/.git/")
  ) {
    return false;
  }
  return normalized.endsWith("package.json") || /\.(c|m)?[jt]sx?$/.test(normalized);
}

function initialUrl(baseUrl, filters) {
  const url = new URL(baseUrl);
  if (filters.scope) url.searchParams.set("scope", filters.scope);
  if (filters.focus) url.searchParams.set("focus", filters.focus);
  if (filters.depth !== null && filters.depth !== undefined) {
    url.searchParams.set("depth", String(filters.depth));
  }
  if (filters.reverse === true) url.searchParams.set("reverse", "true");
  if (filters.includeDevelopment === true) url.searchParams.set("includeDev", "true");
  return url.toString();
}

function optionalText(search, name, fallback) {
  if (!search.has(name)) return fallback;
  const value = search.get(name)?.trim() ?? "";
  return value.length === 0 ? null : value;
}

function optionalDepth(search, fallback) {
  if (!search.has("depth")) return fallback;
  const raw = search.get("depth");
  if (!/^\d+$/.test(raw ?? "")) {
    throw new Error("Query parameter 'depth' must be a non-negative integer.");
  }
  return Number(raw);
}

function optionalBoolean(search, name, fallback) {
  if (!search.has(name)) return fallback;
  const value = search.get(name);
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`Query parameter '${name}' must be true, false, 1, or 0.`);
}

function listen(server, port, host) {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error) => {
      server.off("listening", onListening);
      if (error.code === "EADDRINUSE") {
        rejectListen(new Error(
          `Package Dependency Explorer port ${port} is already in use. Choose another port with --port.`,
        ));
      } else {
        rejectListen(error);
      }
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeHttpServer(server) {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}

function writeJson(response, value) {
  writeContent(
    response,
    200,
    "application/json; charset=utf-8",
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

function writeError(response, status, message) {
  writeContent(
    response,
    status,
    "application/json; charset=utf-8",
    `${JSON.stringify({ error: message })}\n`,
  );
}

function writeContent(response, status, contentType, content) {
  response.writeHead(status, {
    ...securityHeaders(),
    "Cache-Control": "no-store",
    "Content-Type": contentType,
  });
  response.end(content);
}

function securityHeaders() {
  return {
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}
