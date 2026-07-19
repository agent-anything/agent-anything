import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export class WorkspaceDiscoveryError extends Error {
  constructor(issues) {
    super(issues.map((issue) => issue.message).join("\n"));
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
      issues.push(issue("workspace_package_root_duplicate", root, "Workspace package root is discovered more than once."));
      continue;
    }
    rootsSeen.add(normalizedRoot);

    const manifestPath = join(root, "package.json");
    if (!existsSync(manifestPath)) {
      issues.push(issue("workspace_package_manifest_missing", root, "Discovered workspace directory has no package.json."));
      continue;
    }

    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      issues.push(issue("workspace_package_manifest_invalid", manifestPath, "Workspace package.json is not valid JSON."));
      continue;
    }

    if (typeof manifest.name !== "string" || manifest.name.length === 0) {
      issues.push(issue("workspace_package_name_missing", manifestPath, "Workspace package.json must declare a non-empty name."));
      continue;
    }

    const existingRoot = namesSeen.get(manifest.name);
    if (existingRoot) {
      issues.push(issue("workspace_package_name_duplicate", manifestPath, `Package name '${manifest.name}' is already owned by '${display(repoRoot, existingRoot)}'.`));
      continue;
    }

    let kind;
    try {
      kind = classifyWorkspacePackage(repoRoot, root);
    } catch (error) {
      issues.push(issue("workspace_package_kind_unknown", root, error.message));
      continue;
    }

    namesSeen.set(manifest.name, root);
    packages.push({ root: normalizedRoot, name: manifest.name, kind, manifest });
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
      issue("workspace_patterns_missing", workspaceFile, "pnpm-workspace.yaml must declare at least one package pattern."),
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
    if (!pattern.endsWith("/*") || pattern.slice(0, -2).includes("*") || /[?{}[\]]/.test(pattern)) {
      throw new WorkspaceDiscoveryError([
        issue("workspace_pattern_unsupported", join(repoRoot, "pnpm-workspace.yaml"), `Unsupported workspace pattern '${pattern}'.`),
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
  const path = display(repoRoot, packageRoot);
  if (/^packages\/[^/]+$/.test(path)) return "platform";
  if (/^products\/[^/]+$/.test(path)) return "product";
  if (/^apps\/[^/]+$/.test(path)) return "app";
  throw new Error(`Workspace package location '${path}' is not a platform, product, or app package.`);
}

function issue(rule, file, message) {
  return { rule, file, owner: null, imported: null, message };
}

function display(repoRoot, file) {
  return relative(repoRoot, file).replaceAll("\\", "/");
}
