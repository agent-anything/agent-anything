import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import ts from "typescript";
import { discoverWorkspacePackages } from "./WorkspaceDiscovery.mjs";

export const PACKAGE_DEPENDENCY_GRAPH_SCHEMA_VERSION = 1;

export function buildPackageDependencyGraph(repoRoot) {
  const root = resolve(repoRoot);
  const discovered = discoverWorkspacePackages(root);
  const packageByName = new Map(discovered.map((item) => [item.name, item]));
  const nodes = discovered.map((item) => ({
    id: item.name,
    path: display(root, item.root),
    kind: item.kind,
    productId: item.productId,
    component: item.component,
    role: item.role,
  })).sort(compareNodes);
  const edges = new Map();
  const issues = [];

  for (const item of discovered) {
    const production = new Set(Object.keys(item.manifest.dependencies ?? {}));
    const development = new Set(Object.keys(item.manifest.devDependencies ?? {}));

    for (const dependencyName of production) {
      if (!packageByName.has(dependencyName)) continue;
      edges.set(edgeKey(item.name, dependencyName), createEdge(
        item.name,
        dependencyName,
        "production",
      ));
    }

    for (const dependencyName of development) {
      if (!packageByName.has(dependencyName)) continue;
      const key = edgeKey(item.name, dependencyName);
      if (edges.has(key)) {
        issues.push({
          code: "workspace_dependency_declared_twice",
          from: item.name,
          to: dependencyName,
          message: `${item.name} declares ${dependencyName} in both dependencies and devDependencies.`,
        });
        continue;
      }
      edges.set(key, createEdge(item.name, dependencyName, "development"));
    }
  }

  for (const item of discovered) {
    for (const file of collectSourceFiles(item.root)) {
      const usage = isDevelopmentSource(file) ? "development" : "production";
      const source = ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      for (const dependencyName of workspaceImports(source)) {
        if (!packageByName.has(dependencyName)) continue;
        if (dependencyName === item.name) {
          issues.push({
            code: "workspace_package_self_import",
            from: item.name,
            to: dependencyName,
            message: `${item.name} imports itself from ${display(root, file)}.`,
          });
          continue;
        }

        const key = edgeKey(item.name, dependencyName);
        let edge = edges.get(key);
        if (!edge) {
          edge = createEdge(item.name, dependencyName, "undeclared");
          edges.set(key, edge);
          issues.push({
            code: "workspace_dependency_undeclared",
            from: item.name,
            to: dependencyName,
            message: `${item.name} imports ${dependencyName} without a matching Workspace dependency declaration.`,
          });
        } else if (
          usage === "production" &&
          edge.declaration === "development" &&
          edge.observed.production === 0
        ) {
          issues.push({
            code: "workspace_dependency_dev_only",
            from: item.name,
            to: dependencyName,
            message: `${item.name} imports ${dependencyName} from production source but declares it only in devDependencies.`,
          });
        }
        edge.observed[usage] += 1;
      }
    }
  }

  return {
    schemaVersion: PACKAGE_DEPENDENCY_GRAPH_SCHEMA_VERSION,
    nodes,
    edges: [...edges.values()].map(finalizeEdge).sort(compareEdges),
    issues: issues.sort(compareIssues),
  };
}

export function selectPackageDependencyGraph(graph, options = {}) {
  const includeDevelopment = options.includeDevelopment === true;
  const scope = options.scope ?? null;
  const focus = options.focus ?? null;
  const reverse = options.reverse === true;
  const depth = normalizeDepth(options.depth);
  const allNodes = new Map(graph.nodes.map((node) => [node.id, node]));
  let selected = new Set(
    graph.nodes
      .filter((node) => scope === null || matchesScope(node, scope))
      .map((node) => node.id),
  );
  const eligibleEdges = graph.edges.filter((edge) =>
    (includeDevelopment || edge.declaration !== "development") &&
    selected.has(edge.from) &&
    selected.has(edge.to)
  );

  if (focus !== null) {
    if (!allNodes.has(focus)) {
      throw new Error(`Unknown Workspace package '${focus}'.`);
    }
    if (!selected.has(focus)) {
      throw new Error(`Package '${focus}' is outside scope '${scope}'.`);
    }
    selected = reachablePackages(focus, eligibleEdges, { reverse, depth });
  }

  return {
    schemaVersion: graph.schemaVersion,
    filters: {
      scope,
      focus,
      depth: Number.isFinite(depth) ? depth : null,
      reverse,
      includeDevelopment,
    },
    nodes: graph.nodes.filter((node) => selected.has(node.id)),
    edges: eligibleEdges.filter((edge) =>
      selected.has(edge.from) && selected.has(edge.to)
    ),
    issues: graph.issues.filter((issue) =>
      selected.has(issue.from) && selected.has(issue.to)
    ),
  };
}

export function inspectPackageDependencies(graph, packageName, options = {}) {
  if (!graph.nodes.some((node) => node.id === packageName)) {
    throw new Error(`Unknown Workspace package '${packageName}'.`);
  }
  const edges = graph.edges.filter((edge) =>
    options.includeDevelopment === true || edge.declaration !== "development"
  );
  const directDependencies = edges
    .filter((edge) => edge.from === packageName)
    .sort(compareEdges);
  const directConsumers = edges
    .filter((edge) => edge.to === packageName)
    .sort(compareEdges);
  const transitiveDependencies = transitiveNames(
    packageName,
    edges,
    false,
    directDependencies.map((edge) => edge.to),
  );
  const transitiveConsumers = transitiveNames(
    packageName,
    edges,
    true,
    directConsumers.map((edge) => edge.from),
  );

  return {
    package: graph.nodes.find((node) => node.id === packageName),
    directDependencies,
    directConsumers,
    transitiveDependencies,
    transitiveConsumers,
  };
}

function createEdge(from, to, declaration) {
  return {
    from,
    to,
    declaration,
    observed: { production: 0, development: 0 },
  };
}

function finalizeEdge(edge) {
  const production = edge.observed.production;
  const development = edge.observed.development;
  const usage = production > 0 && development > 0
    ? "production-and-development"
    : production > 0
      ? "production"
      : development > 0
        ? "development"
        : "not-observed";
  return {
    from: edge.from,
    to: edge.to,
    declaration: edge.declaration,
    usage,
    observedImports: { production, development },
  };
}

function workspaceImports(sourceFile) {
  const result = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) {
      continue;
    }
    const specifier = statement.moduleSpecifier;
    if (!specifier || !ts.isStringLiteral(specifier)) continue;
    const packageName = workspacePackageName(specifier.text);
    if (packageName !== null) result.add(packageName);
  }
  return result;
}

function workspacePackageName(specifier) {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.length === 0) {
    return null;
  }
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) {
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  }
  return parts[0];
}

function collectSourceFiles(root) {
  const result = [];
  walk(root, result);
  return result;
}

function walk(directory, result) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") {
      continue;
    }
    const fullPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, result);
    } else if (/\.(c|m)?[jt]sx?$/.test(entry.name) && statSync(fullPath).isFile()) {
      result.push(fullPath);
    }
  }
}

function isDevelopmentSource(file) {
  const normalized = file.replaceAll("\\", "/");
  return /\.(test|spec)\.(c|m)?[jt]sx?$/.test(normalized) ||
    normalized.includes("/src/testing/");
}

function matchesScope(node, rawScope) {
  const scope = rawScope.toLowerCase();
  return node.kind.toLowerCase() === scope ||
    node.productId?.toLowerCase() === scope ||
    node.component.toLowerCase() === scope ||
    node.component.toLowerCase().startsWith(`${scope}.`);
}

function reachablePackages(focus, edges, { reverse, depth }) {
  const selected = new Set([focus]);
  const queue = [{ name: focus, distance: 0 }];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current.distance >= depth) continue;
    const adjacent = edges
      .filter((edge) => reverse ? edge.to === current.name : edge.from === current.name)
      .map((edge) => reverse ? edge.from : edge.to);
    for (const name of adjacent) {
      if (selected.has(name)) continue;
      selected.add(name);
      queue.push({ name, distance: current.distance + 1 });
    }
  }
  return selected;
}

function transitiveNames(packageName, edges, reverse, directNames) {
  const reachable = reachablePackages(packageName, edges, {
    reverse,
    depth: Number.POSITIVE_INFINITY,
  });
  reachable.delete(packageName);
  for (const directName of directNames) reachable.delete(directName);
  return [...reachable].sort();
}

function normalizeDepth(depth) {
  if (depth === undefined || depth === null) return Number.POSITIVE_INFINITY;
  if (!Number.isInteger(depth) || depth < 0) {
    throw new Error("Dependency graph depth must be a non-negative integer.");
  }
  return depth;
}

function edgeKey(from, to) {
  return `${from}\u0000${to}`;
}

function compareNodes(left, right) {
  return left.path.localeCompare(right.path) || left.id.localeCompare(right.id);
}

function compareEdges(left, right) {
  return left.from.localeCompare(right.from) || left.to.localeCompare(right.to);
}

function compareIssues(left, right) {
  return left.code.localeCompare(right.code) ||
    left.from.localeCompare(right.from) ||
    left.to.localeCompare(right.to);
}

function display(repoRoot, file) {
  return relative(repoRoot, file).replaceAll("\\", "/");
}
