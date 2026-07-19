import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import {
  evaluatePlatformProductionDependency,
  evaluateRepositoryDirection,
  expectedPlatformDependencies,
} from "./architecture/ArchitectureRules.mjs";
import {
  WorkspaceDiscoveryError,
  discoverWorkspacePackages,
} from "./architecture/WorkspaceDiscovery.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
let discoveredPackages;
try {
  discoveredPackages = discoverWorkspacePackages(repoRoot);
} catch (error) {
  if (!(error instanceof WorkspaceDiscoveryError)) throw error;
  printViolations(error.issues.map((item) => ({
    ...item,
    file: display(item.file),
  })));
  process.exit(1);
}

const packageRoots = discoveredPackages.map((item) => item.root);

const packageInfo = new Map();
const packageByName = new Map();
for (const discovered of discoveredPackages) {
  const { root, manifest: packageJson } = discovered;
  const info = {
    root,
    name: packageJson.name,
    kind: discovered.kind,
    exports: exportedSpecifiers(packageJson),
    dependencies: new Set(Object.keys(packageJson.dependencies ?? {})),
    devDependencies: new Set(Object.keys(packageJson.devDependencies ?? {})),
  };
  packageInfo.set(root, info);
  packageByName.set(info.name, info);
}

const violations = [];
for (const root of packageRoots) {
  for (const file of collectSourceFiles(root)) {
    checkFile(file);
  }
}
checkPackageExports();
checkPackageCycles();
checkReviewedManifests();
checkHelarcSourceCycles();

if (violations.length > 0) {
  printViolations(violations);
  process.exit(1);
}

console.log("Boundary check passed.");

function report(rule, { file = null, owner = null, imported = null, message }) {
  const resolvedOwner = typeof owner === "string"
    ? owner
    : owner?.name ?? (file ? owningPackage(file)?.name : null) ?? null;
  const resolvedImported = typeof imported === "string" ? imported : imported?.name ?? null;
  violations.push({
    rule,
    owner: resolvedOwner,
    imported: resolvedImported,
    file: file ? display(file) : null,
    message,
  });
}

function printViolations(items) {
  console.error("Boundary check failed:");
  for (const item of items) {
    console.error(
      `- [${item.rule}] owner=${item.owner ?? "-"} imported=${item.imported ?? "-"} file=${item.file ?? "-"}: ${item.message}`,
    );
  }
}

function checkFile(file) {
  const owner = owningPackage(file);
  if (!owner) {
    return;
  }

  const text = readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const isTestOnly = isTestFile(file) || normalized(file).includes("/src/testing/");
  checkArchitectureSource(file, text, isTestOnly);

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) {
      continue;
    }

    const moduleSpecifier = statement.moduleSpecifier;
    if (!moduleSpecifier || !ts.isStringLiteral(moduleSpecifier)) {
      continue;
    }

    const specifier = moduleSpecifier.text;
    if (specifier.startsWith("@agent-anything/")) {
      checkPublicApiImport(file, owner, statement, specifier);
      checkWorkspaceImport({
        file,
        owner,
        imported: parseWorkspaceSpecifier(specifier),
        isTestOnly,
      });
    } else if (specifier.startsWith(".")) {
      checkRelativeImport(file, owner, specifier);
    }
  }
}

function checkPublicApiImport(file, owner, statement, specifier) {
  const executionPackages = new Set([
    "@agent-anything/agent-core",
    "@agent-anything/action-execution",
    "@agent-anything/agent-runtime",
    "@agent-anything/host",
  ]);
  const packageName = parseWorkspaceSpecifier(specifier).packageName;

  if (
    (specifier === "@agent-anything/code-agent" || specifier === "@agent-anything/extensions") &&
    owner.name !== packageName
  ) {
    report("capability_root_import", { file, owner, imported: packageName, message: `Must import a focused capability subpath instead of '${specifier}'.` });
  }

  if (
    ts.isExportDeclaration(statement) &&
    executionPackages.has(packageName) &&
    owner.name !== packageName
  ) {
    report("execution_api_reexport", { file, owner, imported: packageName, message: `Must not re-export API owned by '${packageName}'.` });
  }

  if (specifier !== "@agent-anything/agent-core" || !ts.isImportDeclaration(statement)) {
    return;
  }

  const allowedRootTypes = new Set([
    "Agent",
    "AgentTask",
    "Controller",
    "RunInput",
    "RunResult",
    "RuntimeEvent",
  ]);
  const clause = statement.importClause;
  if (!clause || clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) {
    report("agent_core_root_import", { file, owner, imported: packageName, message: "Must use named type imports from the agent-core root." });
    return;
  }

  for (const element of clause.namedBindings.elements) {
    const importedName = (element.propertyName ?? element.name).text;
    if (!allowedRootTypes.has(importedName)) {
      report("agent_core_root_import", { file, owner, imported: packageName, message: `Imports specialized Agent Core Contract '${importedName}' from the root.` });
    }
    if (!clause.isTypeOnly && !element.isTypeOnly) {
      report("agent_core_root_value_import", { file, owner, imported: packageName, message: `Imports runtime value '${importedName}' from the type-only agent-core root.` });
    }
  }
}

function checkReviewedManifests() {
  for (const info of packageInfo.values()) {
    if (info.kind !== "platform") continue;
    const expected = expectedPlatformDependencies(info.name);
    if (!expected) {
      report("platform_dependency_policy_missing", { file: join(info.root, "package.json"), owner: info, message: `Platform package '${info.name}' has no production dependency policy.` });
      continue;
    }
    const actual = [...info.dependencies].sort();
    const sortedExpected = [...expected].sort();
    if (JSON.stringify(actual) !== JSON.stringify(sortedExpected)) {
      report("platform_manifest_dependencies", {
        file: join(info.root, "package.json"),
        owner: info,
        message: `Production dependencies must be exactly: ${sortedExpected.join(", ") || "(none)"}.`,
      });
    }
  }
}

function checkArchitectureSource(file, text, isTestOnly) {
  const rel = display(file);
  checkDesktopSafeSurface(rel, text);
  const legacySymbols = [
    "TemporaryToolActionBridge",
    "ToolExecutionBoundary",
    "ToolExecutionContextResolver",
    "ToolActionBridge",
    "ToolDefinition",
    "ToolInvocationContext",
    "ToolRegistry",
    "ToolRisk",
    "applyAcceptedPatch",
    "McpToolAdapter",
    "RemoteToolAdapter",
    "HelarcSessionHistoryRecord",
    "FileHelarcSessionHistoryStore",
    "LegacyHelarcThreadStore",
    "LegacyFileHelarcThreadStore",
    "HelarcRunTerminalSummary",
    "HelarcRunEventViewModel",
    "mapRuntimeEventToHelarcRunEvent",
    "mapHelarcActivityToRunEvent",
    "HelarcActiveRunController",
    "HostRuntimeAdapter",
    "runHelarcSession",
    "startSession",
    "cancelSession",
    "HelarcStartSessionInput",
    "HelarcStartSessionResult",
    "HelarcCancelSessionResult",
    "sessionHistory",
    "onSessionHistoryRecord",
    "sessionStatus",
  ];

  for (const symbol of legacySymbols) {
    if (new RegExp(`\\b${symbol}\\b`).test(text)) {
      report("removed_execution_contract", { file, message: `Retains removed execution symbol '${symbol}'.` });
    }
  }
  if (/\bCODE_AGENT_[A-Z0-9_]+_TOOL\b/.test(text)) {
    report("removed_tool_constant", { file, message: "Retains a removed code-agent Tool constant." });
  }
  if (/\bwaiting_for_permission\b/.test(text)) {
    report("removed_run_status", { file, message: "Retains the removed waiting_for_permission status." });
  }
  if (/helarc:(?:start|cancel)-session/.test(text)) {
    report("removed_session_ipc", { file, message: "Retains a removed Session-named IPC channel." });
  }
  if (
    rel.startsWith("products/helarc/src/session-history/") ||
    rel.startsWith("apps/helarc-desktop/src/main/session-history/") ||
    rel === "apps/helarc-desktop/src/main/thread/HelarcThreadStore.ts"
  ) {
    report("removed_history_path", { file, message: "Restores a removed legacy history source path." });
  }

  if (isTestOnly) {
    return;
  }
  const isGateway = normalized(file).endsWith(
    "/packages/action-execution/src/SandboxExecutionGateway.ts",
  );
  if (!isGateway && /\b(?:actionExecutor|executor|registered\.executor)\.execute\s*\(/i.test(text)) {
    report("action_executor_dispatch", { file, message: "Invokes an ActionExecutor outside SandboxExecutionGateway." });
  }
  if (/\b(?:ConformanceSandboxProvider|createConformanceSandboxProvider)\b/.test(text)) {
    report("conformance_sandbox_in_production", { file, message: "Retains a production conformance sandbox provider." });
  }
  if (
    (rel.startsWith("apps/") || rel.startsWith("products/")) &&
    /\brunner\.run\s*\(/i.test(text)
  ) {
    report("direct_runner_invocation", { file, message: "Invokes Runner directly instead of starting it through HostRuntime." });
  }
}

function checkDesktopSafeSurface(rel, text) {
  const isRenderer = rel.startsWith("apps/helarc-desktop/src/renderer/");
  const isShared = rel.startsWith("apps/helarc-desktop/src/shared/");
  const isPreload = rel.startsWith("apps/helarc-desktop/src/preload/");
  if (!isRenderer && !isShared && !isPreload) return;

  if (/["']@agent-anything\//.test(text)) {
    report("desktop_workspace_import", { file: resolve(repoRoot, rel), message: "Desktop safe surface must not import or require workspace packages." });
  }

  const trustedSymbols = [
    "Runner",
    "RunResult",
    "RunState",
    "RunCancellationController",
    "PendingApproval",
    "ActionEnforcementPipeline",
    "SandboxExecutionGateway",
    "ProviderCredentialStore",
    "SessionAuthorityPort",
    "PolicyAmendmentStore",
  ];
  for (const symbol of trustedSymbols) {
    if (new RegExp(`\\b${symbol}\\b`).test(text)) {
      report("desktop_trusted_symbol", { file: resolve(repoRoot, rel), message: `Exposes trusted-only symbol '${symbol}' on the Desktop safe surface.` });
    }
  }
}

function checkWorkspaceImport({ file, owner, imported, isTestOnly }) {
  const rel = display(file);

  if (
    rel.startsWith("apps/helarc-desktop/src/renderer/") &&
    imported.packageName.startsWith("@agent-anything/")
  ) {
    report("desktop_renderer_workspace_import", { file, owner, imported: imported.packageName, message: "Renderer must consume workspace contracts through Desktop shared IPC." });
  }
  if (
    rel.startsWith("apps/helarc-desktop/src/shared/") &&
    imported.packageName.startsWith("@agent-anything/")
  ) {
    report("desktop_shared_workspace_import", { file, owner, imported: imported.packageName, message: "Desktop shared IPC must own its DTOs instead of importing workspace Contracts." });
  }

  if (imported.packageName === "@agent-anything/platform") {
    report("platform_facade_import", { file, owner, imported: imported.packageName, message: "Must consume concrete platform packages, not @agent-anything/platform." });
    return;
  }

  const importedPackage = packageByName.get(imported.packageName);
  if (!importedPackage) {
    return;
  }

  if (!importedPackage.exports.has(imported.exportKey)) {
    report("package_subpath_private", { file, owner, imported: importedPackage, message: `Imports non-public package path '${imported.raw}'.` });
  }

  const hasDependency = owner.dependencies.has(imported.packageName);
  const hasDevDependency = owner.devDependencies.has(imported.packageName);
  const isSelf = owner.name === imported.packageName;
  if (!isSelf) {
    for (const result of evaluateRepositoryDirection({ owner, imported: importedPackage })) {
      report(result.rule, { file, owner, imported: importedPackage, message: result.message });
    }
  }
  if (!isSelf && !hasDependency && !(isTestOnly && hasDevDependency)) {
    report("dependency_undeclared", { file, owner, imported: importedPackage, message: `Import is not declared in ${isTestOnly ? "dependencies or devDependencies" : "dependencies"}.` });
  }
  if (!isSelf && !isTestOnly && !hasDependency) {
    report("dependency_dev_only", { file, owner, imported: importedPackage, message: "Production import must be declared in dependencies, not only devDependencies." });
  }

  if (!isTestOnly && imported.packageName === "@agent-anything/testing") {
    report("testing_import_in_production", { file, owner, imported: importedPackage, message: "Production code must not import @agent-anything/testing." });
  }

  if (!isTestOnly && !isSelf) {
    for (const result of evaluatePlatformProductionDependency({ owner, imported: importedPackage })) {
      report(result.rule, { file, owner, imported: importedPackage, message: result.message });
    }
  }
}

function checkRelativeImport(file, owner, specifier) {
  const resolved = resolve(dirname(file), specifier);
  const ownerRoot = `${owner.root}${sep}`;
  if (resolved !== owner.root && !resolved.startsWith(ownerRoot)) {
    report("relative_package_boundary", { file, owner, message: `Relative import crosses the package boundary: '${specifier}'.` });
  }

  const rel = display(file);
  const resolvedPath = normalized(resolved);
  const desktopSource = normalized(resolve(repoRoot, "apps/helarc-desktop/src"));
  if (
    rel.startsWith("apps/helarc-desktop/src/renderer/") &&
    !resolvedPath.startsWith(`${desktopSource}/renderer/`) &&
    !resolvedPath.startsWith(`${desktopSource}/shared/`)
  ) {
    report("desktop_renderer_relative_import", { file, owner, message: `Renderer relative import must remain in renderer or shared IPC: '${specifier}'.` });
  }
  if (
    rel.startsWith("apps/helarc-desktop/src/shared/") &&
    !resolvedPath.startsWith(`${desktopSource}/shared/`)
  ) {
    report("desktop_shared_relative_import", { file, owner, message: `Desktop shared IPC relative import leaves the shared surface: '${specifier}'.` });
  }
  if (
    rel.startsWith("apps/helarc-desktop/src/preload/") &&
    !resolvedPath.startsWith(`${desktopSource}/preload/`) &&
    !resolvedPath.startsWith(`${desktopSource}/shared/`)
  ) {
    report("desktop_preload_relative_import", { file, owner, message: `Preload relative import must remain in preload or shared IPC: '${specifier}'.` });
  }
}

function checkPackageExports() {
  for (const info of packageInfo.values()) {
    const packageJson = readJson(join(info.root, "package.json"));
    for (const [exportKey, exportValue] of Object.entries(packageJson.exports ?? {})) {
      if (typeof exportValue !== "object" || exportValue === null || !("types" in exportValue)) {
        report("package_export_types_missing", { file: join(info.root, "package.json"), owner: info, message: `Export '${exportKey}' must declare a types entry.` });
        continue;
      }

      const typesPath = resolve(info.root, exportValue.types);
      if (!exists(typesPath)) {
        report("package_export_types_file_missing", { file: join(info.root, "package.json"), owner: info, message: `Export '${exportKey}' points to missing types file '${exportValue.types}'.` });
      }
    }
  }
}

function checkPackageCycles() {
  const visiting = new Set();
  const visited = new Set();
  const stack = [];

  for (const info of packageInfo.values()) {
    visit(info);
  }

  function visit(info) {
    if (visited.has(info.name)) {
      return;
    }
    if (visiting.has(info.name)) {
      const cycleStart = stack.indexOf(info.name);
      const cycle = [...stack.slice(cycleStart), info.name].join(" -> ");
      report("package_dependency_cycle", { file: join(info.root, "package.json"), owner: info, message: `Workspace dependency cycle detected: ${cycle}.` });
      return;
    }

    visiting.add(info.name);
    stack.push(info.name);
    for (const dependencyName of info.dependencies) {
      const dependency = packageByName.get(dependencyName);
      if (dependency) {
        visit(dependency);
      }
    }
    stack.pop();
    visiting.delete(info.name);
    visited.add(info.name);
  }
}

function checkHelarcSourceCycles() {
  const helarc = packageByName.get("@agent-anything/helarc");
  if (!helarc) {
    report("helarc_package_missing", { file: join(repoRoot, "products/helarc/package.json"), owner: "@agent-anything/helarc", message: "Required Helarc product package is missing." });
    return;
  }

  const sourceRoot = resolve(helarc.root, "src");
  const files = collectSourceFiles(sourceRoot).filter((file) =>
    !isTestFile(file) && !file.endsWith(".d.ts")
  );
  const fileByPath = new Map(files.map((file) => [normalized(file), file]));
  const graph = new Map(files.map((file) => [file, []]));

  for (const file of files) {
    const sourceFile = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      const specifier = statement.moduleSpecifier;
      if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith(".")) {
        continue;
      }
      const dependency = resolveSourceDependency(file, specifier.text, fileByPath);
      if (dependency) graph.get(file).push(dependency);
    }
  }

  for (const component of stronglyConnectedComponents(graph)) {
    if (component.length > 1) {
      report("helarc_source_cycle", {
        file: component[0],
        owner: helarc,
        message: `Helarc production source cycle detected: ${component.map(display).join(" -> ")}.`,
      });
    }
  }
}

function resolveSourceDependency(file, specifier, fileByPath) {
  const unresolved = resolve(dirname(file), specifier);
  const withoutJs = unresolved.replace(/\.js$/, "");
  const candidates = [
    unresolved,
    `${withoutJs}.ts`,
    `${withoutJs}.tsx`,
    join(withoutJs, "index.ts"),
    join(withoutJs, "index.tsx"),
  ];
  for (const candidate of candidates) {
    const dependency = fileByPath.get(normalized(candidate));
    if (dependency) return dependency;
  }
  return null;
}

function stronglyConnectedComponents(graph) {
  let nextIndex = 0;
  const indexByNode = new Map();
  const lowLinkByNode = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];

  function visit(node) {
    indexByNode.set(node, nextIndex);
    lowLinkByNode.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const dependency of graph.get(node) ?? []) {
      if (!indexByNode.has(dependency)) {
        visit(dependency);
        lowLinkByNode.set(
          node,
          Math.min(lowLinkByNode.get(node), lowLinkByNode.get(dependency)),
        );
      } else if (onStack.has(dependency)) {
        lowLinkByNode.set(
          node,
          Math.min(lowLinkByNode.get(node), indexByNode.get(dependency)),
        );
      }
    }

    if (lowLinkByNode.get(node) !== indexByNode.get(node)) return;
    const component = [];
    let member;
    do {
      member = stack.pop();
      onStack.delete(member);
      component.push(member);
    } while (member !== node);
    components.push(component);
  }

  for (const node of graph.keys()) {
    if (!indexByNode.has(node)) visit(node);
  }
  return components;
}

function parseWorkspaceSpecifier(raw) {
  const parts = raw.split("/");
  const packageName = `${parts[0]}/${parts[1]}`;
  const exportKey = parts.length === 2 ? "." : `./${parts.slice(2).join("/")}`;
  return { raw, packageName, exportKey };
}

function exportedSpecifiers(packageJson) {
  const exports = packageJson.exports ?? {};
  if (typeof exports === "string") {
    return new Set(["."]);
  }
  return new Set(Object.keys(exports));
}

function collectSourceFiles(root) {
  const result = [];
  walk(root, result);
  return result;
}

function walk(dir, result) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") {
      continue;
    }

    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      walk(fullPath, result);
    } else if (/\.(c|m)?[jt]sx?$/.test(entry)) {
      result.push(fullPath);
    }
  }
}

function owningPackage(file) {
  const normalizedFile = `${resolve(file)}${sep}`;
  return [...packageInfo.values()]
    .filter((info) => normalizedFile.startsWith(`${info.root}${sep}`))
    .sort((a, b) => b.root.length - a.root.length)[0] ?? null;
}

function isTestFile(file) {
  return /\.(test|spec)\.(c|m)?tsx?$/.test(file);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function exists(file) {
  try {
    statSync(file);
    return true;
  } catch {
    return false;
  }
}

function display(file) {
  return relative(repoRoot, file).replaceAll("\\", "/");
}

function normalized(file) {
  return resolve(file).replaceAll("\\", "/");
}
