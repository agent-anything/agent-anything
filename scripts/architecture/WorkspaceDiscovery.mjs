import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export class WorkspaceDiscoveryError extends Error {
  constructor(issues) {
    super(issues.map((item) => item.message).join("\n"));
    this.name = "WorkspaceDiscoveryError";
    this.issues = issues;
  }
}

export function discoverWorkspacePackages(repoRoot) {
  const patterns = readWorkspacePatterns(join(repoRoot, "pnpm-workspace.yaml"));
  const roots = discoverPackageRoots(repoRoot, patterns);
  const issues = [];
  const packages = [];
  const rootsSeen = new Set();
  const namesSeen = new Map();

  for (const root of roots) {
    const normalizedRoot = resolve(root);
    if (rootsSeen.has(normalizedRoot)) {
      issues.push(issue(
        "workspace_package_root_duplicate",
        root,
        "Workspace package root is discovered more than once.",
      ));
      continue;
    }
    rootsSeen.add(normalizedRoot);

    const manifestPath = join(root, "package.json");
    if (!existsSync(manifestPath)) {
      issues.push(issue(
        "workspace_package_manifest_missing",
        root,
        "Discovered workspace directory has no package.json.",
      ));
      continue;
    }

    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      issues.push(issue(
        "workspace_package_manifest_invalid",
        manifestPath,
        "Workspace package.json is not valid JSON.",
      ));
      continue;
    }

    if (typeof manifest.name !== "string" || manifest.name.length === 0) {
      issues.push(issue(
        "workspace_package_name_missing",
        manifestPath,
        "Workspace package.json must declare a non-empty name.",
      ));
      continue;
    }

    const existingRoot = namesSeen.get(manifest.name);
    if (existingRoot) {
      issues.push(issue(
        "workspace_package_name_duplicate",
        manifestPath,
        `Package name '${manifest.name}' is already owned by '${display(repoRoot, existingRoot)}'.`,
      ));
      continue;
    }

    let expectedArchitecture;
    try {
      expectedArchitecture = expectedArchitectureForPath(repoRoot, root);
    } catch (error) {
      issues.push(issue("workspace_package_kind_unknown", root, error.message));
      continue;
    }

    const metadataIssue = validateArchitectureMetadata(
      manifest.agentAnything?.architecture,
      expectedArchitecture.metadata,
      manifestPath,
    );
    if (metadataIssue) {
      issues.push(metadataIssue);
      continue;
    }

    namesSeen.set(manifest.name, root);
    packages.push({
      root: normalizedRoot,
      name: manifest.name,
      kind: expectedArchitecture.kind,
      productId: expectedArchitecture.productId,
      component: expectedArchitecture.component,
      role: expectedArchitecture.role,
      manifest,
    });
  }

  if (issues.length > 0) {
    throw new WorkspaceDiscoveryError(issues);
  }

  return packages.sort((left, right) => left.root.localeCompare(right.root));
}

export function readWorkspacePatterns(workspaceFile) {
  const lines = readFileSync(workspaceFile, "utf8").split(/\r?\n/);
  const patterns = [];
  let inPackages = false;

  for (const line of lines) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    if (/^[^\s#]/.test(line)) break;

    const match = line.match(/^\s+-\s+["']?([^"'#]+?)["']?\s*(?:#.*)?$/);
    if (match) patterns.push(match[1].trim());
  }

  if (patterns.length === 0) {
    throw new WorkspaceDiscoveryError([
      issue(
        "workspace_patterns_missing",
        workspaceFile,
        "pnpm-workspace.yaml must declare at least one package pattern.",
      ),
    ]);
  }
  return patterns;
}

export function discoverPackageRoots(repoRoot, patterns) {
  const roots = [];
  for (const pattern of patterns) {
    const wildcardIndex = pattern.indexOf("*");
    if (wildcardIndex === -1) {
      roots.push(resolve(repoRoot, pattern));
      continue;
    }
    if (
      !pattern.endsWith("/*") ||
      pattern.slice(0, -2).includes("*") ||
      /[?{}[\]]/.test(pattern)
    ) {
      throw new WorkspaceDiscoveryError([
        issue(
          "workspace_pattern_unsupported",
          join(repoRoot, "pnpm-workspace.yaml"),
          `Unsupported workspace pattern '${pattern}'.`,
        ),
      ]);
    }

    const parent = resolve(repoRoot, pattern.slice(0, -2));
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (entry.isDirectory()) roots.push(join(parent, entry.name));
    }
  }
  return roots.sort((left, right) => left.localeCompare(right));
}

export function classifyWorkspacePackage(repoRoot, packageRoot) {
  return expectedArchitectureForPath(repoRoot, packageRoot).kind;
}

export function expectedArchitectureForPath(repoRoot, packageRoot) {
  const path = display(repoRoot, packageRoot);

  const agentCore = /^harness\/agent-core\/(contracts|runtime)$/.exec(path);
  if (agentCore) {
    return architecture("harness", "agent-core", null, agentCore[1]);
  }

  const directHarness = /^harness\/([^/]+)$/.exec(path);
  if (directHarness) {
    return architecture("harness", directHarness[1]);
  }

  const groupedHarness = /^harness\/(safety|integrations)\/([^/]+)$/.exec(path);
  if (groupedHarness) {
    return architecture(
      "harness",
      `${groupedHarness[1]}.${groupedHarness[2]}`,
    );
  }

  const product = /^products\/([^/]+)\/([^/]+)$/.exec(path);
  if (product) {
    return architecture("product", product[2], product[1]);
  }

  if (path === "tooling/test-support") {
    return architecture("tooling", "test-support");
  }

  throw new Error(
    `Workspace package location '${path}' is not an accepted Harness, Product, or Tooling package.`,
  );
}

function architecture(kind, component, productId = null, role = null) {
  const metadata = role !== null
    ? Object.freeze({ kind, component, role })
    : productId === null
      ? Object.freeze({ kind, component })
      : Object.freeze({ kind, productId, component });
  return Object.freeze({ kind, productId, component, role, metadata });
}

function validateArchitectureMetadata(actual, expected, manifestPath) {
  if (!isRecord(actual)) {
    return issue(
      "architecture_metadata_missing",
      manifestPath,
      "Workspace package must declare agentAnything.architecture metadata.",
    );
  }

  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (
    JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys) ||
    expectedKeys.some((key) => actual[key] !== expected[key])
  ) {
    return issue(
      "architecture_metadata_path_mismatch",
      manifestPath,
      `Architecture metadata must exactly match ${JSON.stringify(expected)}.`,
    );
  }

  return null;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issue(rule, file, message) {
  return { rule, file, owner: null, imported: null, message };
}

function display(repoRoot, file) {
  return relative(repoRoot, file).replaceAll("\\", "/");
}
