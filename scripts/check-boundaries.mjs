import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageRoots = [
  "packages/shared",
  "packages/tools",
  "packages/evidence",
  "packages/permission",
  "packages/governance",
  "packages/observability",
  "packages/providers",
  "packages/storage",
  "packages/agent-core",
  "packages/action-execution",
  "packages/agent-runtime",
  "packages/host",
  "packages/extensions",
  "packages/code-agent",
  "packages/testing",
  "products/helarc",
  "apps/helarc-desktop",
].map((item) => resolve(repoRoot, item));

const packageInfo = new Map();
const packageByName = new Map();
for (const root of packageRoots) {
  const packageJson = readJson(join(root, "package.json"));
  const info = {
    root,
    name: packageJson.name,
    kind: packageKind(root),
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
checkCapabilityManifests();
checkHelarcSourceCycles();

if (violations.length > 0) {
  console.error("Boundary check failed:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log("Boundary check passed.");

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
  const rel = display(file);
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
    violations.push(`${rel} must import a focused capability subpath instead of '${specifier}'.`);
  }

  if (
    ts.isExportDeclaration(statement) &&
    executionPackages.has(packageName) &&
    owner.name !== packageName
  ) {
    violations.push(`${rel} must not re-export API owned by '${packageName}'.`);
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
    violations.push(`${rel} must use named type imports from the agent-core root.`);
    return;
  }

  for (const element of clause.namedBindings.elements) {
    const importedName = (element.propertyName ?? element.name).text;
    if (!allowedRootTypes.has(importedName)) {
      violations.push(
        `${rel} imports specialized Agent Core Contract '${importedName}' from the root.`,
      );
    }
    if (!clause.isTypeOnly && !element.isTypeOnly) {
      violations.push(`${rel} imports runtime value '${importedName}' from the type-only agent-core root.`);
    }
  }
}

function checkCapabilityManifests() {
  const expectedDependencies = new Map([
    [
      "@agent-anything/code-agent",
      [
        "@agent-anything/action-execution",
        "@agent-anything/agent-core",
        "@agent-anything/governance",
        "@agent-anything/shared",
        "@agent-anything/tools",
      ],
    ],
    [
      "@agent-anything/extensions",
      [
        "@agent-anything/action-execution",
        "@agent-anything/shared",
        "@agent-anything/tools",
      ],
    ],
  ]);

  for (const [packageName, expected] of expectedDependencies) {
    const info = packageByName.get(packageName);
    if (!info) {
      violations.push(`Required capability package '${packageName}' is missing.`);
      continue;
    }
    const actual = [...info.dependencies].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      violations.push(
        `${packageName} production dependencies must be exactly: ${expected.join(", ")}.`,
      );
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
      violations.push(`${rel} retains removed execution symbol '${symbol}'.`);
    }
  }
  if (/\bCODE_AGENT_[A-Z0-9_]+_TOOL\b/.test(text)) {
    violations.push(`${rel} retains a removed code-agent Tool constant.`);
  }
  if (/\bwaiting_for_permission\b/.test(text)) {
    violations.push(`${rel} retains the removed waiting_for_permission status.`);
  }
  if (/helarc:(?:start|cancel)-session/.test(text)) {
    violations.push(`${rel} retains a removed Session-named IPC channel.`);
  }
  if (
    rel.startsWith("products/helarc/src/session-history/") ||
    rel.startsWith("apps/helarc-desktop/src/main/session-history/") ||
    rel === "apps/helarc-desktop/src/main/thread/HelarcThreadStore.ts"
  ) {
    violations.push(`${rel} restores a removed legacy history source path.`);
  }

  if (isTestOnly) {
    return;
  }
  const isGateway = normalized(file).endsWith(
    "/packages/action-execution/src/SandboxExecutionGateway.ts",
  );
  if (!isGateway && /\b(?:actionExecutor|executor|registered\.executor)\.execute\s*\(/i.test(text)) {
    violations.push(`${rel} invokes an ActionExecutor outside SandboxExecutionGateway.`);
  }
  if (/\b(?:ConformanceSandboxProvider|createConformanceSandboxProvider)\b/.test(text)) {
    violations.push(`${rel} retains a production conformance sandbox provider.`);
  }
  if (
    (rel.startsWith("apps/") || rel.startsWith("products/")) &&
    /\brunner\.run\s*\(/i.test(text)
  ) {
    violations.push(`${rel} invokes Runner directly instead of starting it through HostRuntime.`);
  }
}

function checkDesktopSafeSurface(rel, text) {
  const isRenderer = rel.startsWith("apps/helarc-desktop/src/renderer/");
  const isShared = rel.startsWith("apps/helarc-desktop/src/shared/");
  const isPreload = rel.startsWith("apps/helarc-desktop/src/preload/");
  if (!isRenderer && !isShared && !isPreload) return;

  if (/["']@agent-anything\//.test(text)) {
    violations.push(`${rel} Desktop safe surface must not import or require workspace packages.`);
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
      violations.push(`${rel} exposes trusted-only symbol '${symbol}' on the Desktop safe surface.`);
    }
  }
}

function checkWorkspaceImport({ file, owner, imported, isTestOnly }) {
  const rel = display(file);

  if (
    rel.startsWith("apps/helarc-desktop/src/renderer/") &&
    imported.packageName.startsWith("@agent-anything/")
  ) {
    violations.push(`${rel} Renderer must consume workspace contracts through Desktop shared IPC.`);
  }
  if (
    rel.startsWith("apps/helarc-desktop/src/shared/") &&
    imported.packageName.startsWith("@agent-anything/")
  ) {
    violations.push(`${rel} Desktop shared IPC must own its DTOs instead of importing '${imported.packageName}'.`);
  }

  if (imported.packageName === "@agent-anything/platform") {
    violations.push(`${rel} must consume concrete platform packages, not @agent-anything/platform.`);
    return;
  }

  const importedPackage = packageByName.get(imported.packageName);
  if (!importedPackage) {
    return;
  }

  if (!importedPackage.exports.has(imported.exportKey)) {
    violations.push(`${rel} imports non-public package path '${imported.raw}'.`);
  }

  const hasDependency = owner.dependencies.has(imported.packageName);
  const hasDevDependency = owner.devDependencies.has(imported.packageName);
  const isSelf = owner.name === imported.packageName;
  if (!isSelf) {
    checkRepositoryDirection(file, owner, importedPackage);
  }
  if (!isSelf && !hasDependency && !(isTestOnly && hasDevDependency)) {
    violations.push(`${rel} imports '${imported.packageName}' without declaring it in ${isTestOnly ? "dependencies or devDependencies" : "dependencies"}.`);
  }
  if (!isSelf && !isTestOnly && !hasDependency) {
    violations.push(`${rel} production import '${imported.packageName}' must be declared in dependencies, not only devDependencies.`);
  }

  if (!isTestOnly && imported.packageName === "@agent-anything/testing") {
    violations.push(`${rel} production code must not import @agent-anything/testing.`);
  }

  if (!isTestOnly) {
    checkLayerRule(file, owner.name, imported.packageName);
  }
}

function checkRepositoryDirection(file, owner, importedPackage) {
  const rel = display(file);

  if (owner.kind === "platform" && importedPackage.kind !== "platform") {
    violations.push(`${rel} platform package must not import ${importedPackage.kind} package '${importedPackage.name}'.`);
  }

  if (owner.kind === "product" && importedPackage.kind === "app") {
    violations.push(`${rel} product package must not import app package '${importedPackage.name}'.`);
  }

  if (
    owner.kind === "product" &&
    importedPackage.kind === "product" &&
    owner.name !== importedPackage.name
  ) {
    violations.push(`${rel} product package must not import another product package '${importedPackage.name}'.`);
  }
}

function checkLayerRule(file, ownerName, importedName) {
  const rel = display(file);
  const lowerLayerPackages = new Set([
    "@agent-anything/shared",
    "@agent-anything/tools",
    "@agent-anything/evidence",
    "@agent-anything/permission",
    "@agent-anything/governance",
    "@agent-anything/observability",
    "@agent-anything/providers",
    "@agent-anything/storage",
  ]);

  if (ownerName === "@agent-anything/shared" && importedName !== "@agent-anything/shared") {
    violations.push(`${rel} shared package must not import '${importedName}'.`);
  }

  if (lowerLayerPackages.has(ownerName)) {
    for (const forbidden of [
      "@agent-anything/agent-core",
      "@agent-anything/action-execution",
      "@agent-anything/agent-runtime",
      "@agent-anything/host",
      "@agent-anything/extensions",
      "@agent-anything/code-agent",
      "@agent-anything/testing",
    ]) {
      if (importedName === forbidden) {
        violations.push(`${rel} layer 1 package must not import '${forbidden}'.`);
      }
    }
  }

  if (ownerName === "@agent-anything/agent-core") {
    for (const forbidden of [
      "@agent-anything/extensions",
      "@agent-anything/agent-runtime",
      "@agent-anything/action-execution",
      "@agent-anything/code-agent",
      "@agent-anything/host",
      "@agent-anything/testing",
    ]) {
      if (importedName === forbidden) {
        violations.push(`${rel} agent-core production code must not import '${forbidden}'.`);
      }
    }
  }

  if (ownerName === "@agent-anything/action-execution") {
    for (const forbidden of [
      "@agent-anything/agent-runtime",
      "@agent-anything/host",
      "@agent-anything/extensions",
      "@agent-anything/code-agent",
      "@agent-anything/testing",
    ]) {
      if (importedName === forbidden) {
        violations.push(`${rel} action-execution production code must not import '${forbidden}'.`);
      }
    }
  }

  if (ownerName === "@agent-anything/extensions") {
    for (const forbidden of [
      "@agent-anything/agent-runtime",
      "@agent-anything/code-agent",
      "@agent-anything/host",
      "@agent-anything/testing",
    ]) {
      if (importedName === forbidden) {
        violations.push(`${rel} extensions production code must not import '${forbidden}'.`);
      }
    }
  }

  if (ownerName === "@agent-anything/code-agent") {
    for (const forbidden of [
      "@agent-anything/agent-runtime",
      "@agent-anything/extensions",
      "@agent-anything/host",
      "@agent-anything/testing",
    ]) {
      if (importedName === forbidden) {
        violations.push(`${rel} code-agent production code must not import '${forbidden}'.`);
      }
    }
  }

  if (ownerName === "@agent-anything/testing") {
    for (const forbidden of [
      "@agent-anything/agent-core",
      "@agent-anything/action-execution",
      "@agent-anything/agent-runtime",
      "@agent-anything/host",
      "@agent-anything/extensions",
      "@agent-anything/code-agent",
    ]) {
      if (importedName === forbidden) {
        violations.push(`${rel} testing package must not import '${forbidden}' to avoid package cycles.`);
      }
    }
  }

  if (ownerName === "@agent-anything/host") {
    for (const forbidden of [
      "@agent-anything/extensions",
      "@agent-anything/code-agent",
      "@agent-anything/testing",
    ]) {
      if (importedName === forbidden) {
        violations.push(`${rel} host production code must not import '${forbidden}'.`);
      }
    }
  }

  if (ownerName === "@agent-anything/agent-runtime") {
    for (const forbidden of [
      "@agent-anything/host",
      "@agent-anything/extensions",
      "@agent-anything/code-agent",
      "@agent-anything/testing",
    ]) {
      if (importedName === forbidden) {
        violations.push(`${rel} agent-runtime production code must not import '${forbidden}'.`);
      }
    }
  }
}

function checkRelativeImport(file, owner, specifier) {
  const resolved = resolve(dirname(file), specifier);
  const ownerRoot = `${owner.root}${sep}`;
  if (resolved !== owner.root && !resolved.startsWith(ownerRoot)) {
    violations.push(`${display(file)} uses a relative import that crosses package boundary: '${specifier}'.`);
  }

  const rel = display(file);
  const resolvedPath = normalized(resolved);
  const desktopSource = normalized(resolve(repoRoot, "apps/helarc-desktop/src"));
  if (
    rel.startsWith("apps/helarc-desktop/src/renderer/") &&
    !resolvedPath.startsWith(`${desktopSource}/renderer/`) &&
    !resolvedPath.startsWith(`${desktopSource}/shared/`)
  ) {
    violations.push(`${rel} Renderer relative import must remain in renderer or shared IPC: '${specifier}'.`);
  }
  if (
    rel.startsWith("apps/helarc-desktop/src/shared/") &&
    !resolvedPath.startsWith(`${desktopSource}/shared/`)
  ) {
    violations.push(`${rel} Desktop shared IPC relative import leaves the shared surface: '${specifier}'.`);
  }
  if (
    rel.startsWith("apps/helarc-desktop/src/preload/") &&
    !resolvedPath.startsWith(`${desktopSource}/preload/`) &&
    !resolvedPath.startsWith(`${desktopSource}/shared/`)
  ) {
    violations.push(`${rel} preload relative import must remain in preload or shared IPC: '${specifier}'.`);
  }
}

function checkPackageExports() {
  for (const info of packageInfo.values()) {
    const packageJson = readJson(join(info.root, "package.json"));
    for (const [exportKey, exportValue] of Object.entries(packageJson.exports ?? {})) {
      if (typeof exportValue !== "object" || exportValue === null || !("types" in exportValue)) {
        violations.push(`${display(join(info.root, "package.json"))} export '${exportKey}' must declare a types entry.`);
        continue;
      }

      const typesPath = resolve(info.root, exportValue.types);
      if (!exists(typesPath)) {
        violations.push(`${display(join(info.root, "package.json"))} export '${exportKey}' points to missing types file '${exportValue.types}'.`);
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
      violations.push(`Workspace dependency cycle detected: ${cycle}.`);
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
    violations.push("Required Helarc product package is missing.");
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
      violations.push(
        `Helarc production source cycle detected: ${component.map(display).join(" -> ")}.`,
      );
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

function packageKind(root) {
  const rel = relative(repoRoot, root).replaceAll("\\", "/");
  if (rel.startsWith("packages/")) {
    return "platform";
  }
  if (rel.startsWith("products/")) {
    return "product";
  }
  if (rel.startsWith("apps/")) {
    return "app";
  }
  throw new Error(`Unknown package root kind: ${rel}`);
}

function display(file) {
  return relative(repoRoot, file).replaceAll("\\", "/");
}

function normalized(file) {
  return resolve(file).replaceAll("\\", "/");
}
