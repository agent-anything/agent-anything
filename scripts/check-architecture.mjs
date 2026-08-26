import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import {
  evaluateProductionDependency,
  evaluateRepositoryDirection,
  expectedProductionDependencies,
} from "./architecture/ArchitectureRules.mjs";
import {
  WorkspaceDiscoveryError,
  discoverWorkspacePackages,
} from "./architecture/WorkspaceDiscovery.mjs";
import {
  evaluateRepositoryCommands,
} from "./architecture/RepositoryCommands.mjs";
import {
  evaluateSourceOwnershipRules,
} from "./architecture/SourceOwnershipRules.mjs";

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
    productId: discovered.productId,
    component: discovered.component,
    exports: exportedSpecifiers(packageJson),
    dependencies: new Set(Object.keys(packageJson.dependencies ?? {})),
    devDependencies: new Set(Object.keys(packageJson.devDependencies ?? {})),
  };
  packageInfo.set(root, info);
  packageByName.set(info.name, info);
}

const focusedPublicSubpaths = new Map([
  [
    "@agent-anything/test-support",
    new Set([
      "@agent-anything/test-support/context-continuity-evaluation",
      "@agent-anything/test-support/evaluation-targets/helarc",
    ]),
  ],
  [
    "@agent-anything/evaluation",
    new Set([
      "@agent-anything/evaluation/campaign",
      "@agent-anything/evaluation/capture",
      "@agent-anything/evaluation/definition",
      "@agent-anything/evaluation/grading",
      "@agent-anything/evaluation/metrics",
      "@agent-anything/evaluation/persistence",
      "@agent-anything/evaluation/report",
      "@agent-anything/evaluation/trial",
    ]),
  ],
  [
    "@agent-anything/action-execution",
    new Set([
      "@agent-anything/action-execution/enforcement",
      "@agent-anything/action-execution/execution",
      "@agent-anything/action-execution/registration",
      "@agent-anything/action-execution/sandbox",
      "@agent-anything/action-execution/coordination",
    ]),
  ],
  [
    "@agent-anything/workspace",
    new Set([
      "@agent-anything/workspace/identity",
      "@agent-anything/workspace/selection",
    ]),
  ],
  [
    "@agent-anything/validation",
    new Set([
      "@agent-anything/validation/assessment",
      "@agent-anything/validation/completion",
      "@agent-anything/validation/definition",
      "@agent-anything/validation/evidence",
      "@agent-anything/validation/execution",
      "@agent-anything/validation/persistence",
      "@agent-anything/validation/projection",
      "@agent-anything/validation/subject",
    ]),
  ],
  [
    "@agent-anything/operation-catalog",
    new Set([
      "@agent-anything/operation-catalog/identity",
      "@agent-anything/operation-catalog/catalog",
      "@agent-anything/operation-catalog/binding",
      "@agent-anything/operation-catalog/result",
    ]),
  ],
  [
    "@agent-anything/canonical-action",
    new Set([
      "@agent-anything/canonical-action/subject",
      "@agent-anything/canonical-action/assessment",
      "@agent-anything/canonical-action/settlement",
      "@agent-anything/canonical-action/registration",
      "@agent-anything/canonical-action/lifecycle",
    ]),
  ],
  [
    "@agent-anything/interaction",
    new Set([
      "@agent-anything/interaction/protocol",
      "@agent-anything/interaction/coordination",
      "@agent-anything/interaction/records",
    ]),
  ],
  [
    "@agent-anything/operation-composition",
    new Set([
      "@agent-anything/operation-composition/definition",
      "@agent-anything/operation-composition/execution",
      "@agent-anything/operation-composition/result",
    ]),
  ],
  [
    "@agent-anything/context",
    new Set([
      "@agent-anything/context/contract",
      "@agent-anything/context/contribution",
      "@agent-anything/context/active-context",
      "@agent-anything/context/projection",
      "@agent-anything/context/evidence",
      "@agent-anything/context/persistence",
    ]),
  ],
  [
    "@agent-anything/host",
    new Set([
      "@agent-anything/host/authority",
      "@agent-anything/host/composition",
      "@agent-anything/host/context",
      "@agent-anything/host/projection",
      "@agent-anything/host/run",
      "@agent-anything/host/transport",
    ]),
  ],
  [
    "@agent-anything/mcp",
    new Set([
      "@agent-anything/mcp/adapters",
      "@agent-anything/mcp/lifecycle",
      "@agent-anything/mcp/primitives",
      "@agent-anything/mcp/protocol",
      "@agent-anything/mcp/registration",
      "@agent-anything/mcp/transport",
    ]),
  ],
  [
    "@agent-anything/plugins",
    new Set([
      "@agent-anything/plugins/activation",
      "@agent-anything/plugins/admission",
      "@agent-anything/plugins/lifecycle",
      "@agent-anything/plugins/manifest",
    ]),
  ],
  [
    "@agent-anything/remote-integrations",
    new Set([
      "@agent-anything/remote-integrations/operation",
      "@agent-anything/remote-integrations/transport",
    ]),
  ],
  [
    "@agent-anything/provider-integrations",
    new Set([
      "@agent-anything/provider-integrations/http",
      "@agent-anything/provider-integrations/ollama",
      "@agent-anything/provider-integrations/openai-compatible",
    ]),
  ],
  [
    "@agent-anything/enterprise-storage",
    new Set([
      "@agent-anything/enterprise-storage/evidence",
    ]),
  ],
  [
    "@agent-anything/helarc",
    new Set([
      "@agent-anything/helarc",
      "@agent-anything/helarc/agent",
      "@agent-anything/helarc/artifacts",
      "@agent-anything/helarc/composition",
      "@agent-anything/helarc/configuration",
      "@agent-anything/helarc/controller",
      "@agent-anything/helarc/interaction",
      "@agent-anything/helarc/observability",
      "@agent-anything/helarc/prompt",
      "@agent-anything/helarc/result",
      "@agent-anything/helarc/review",
      "@agent-anything/helarc/run",
      "@agent-anything/helarc/task",
      "@agent-anything/helarc/thread",
      "@agent-anything/helarc/tools",
      "@agent-anything/helarc/validation",
      "@agent-anything/helarc/work-context",
    ]),
  ],
  [
    "@agent-anything/helarc-code-agent",
    new Set([
      "@agent-anything/helarc-code-agent/file-operation",
      "@agent-anything/helarc-code-agent/source",
      "@agent-anything/helarc-code-agent/validation",
      "@agent-anything/helarc-code-agent/workspace",
    ]),
  ],
  [
    "@agent-anything/helarc-local-environment",
    new Set([
      "@agent-anything/helarc-local-environment/command",
      "@agent-anything/helarc-local-environment/filesystem",
      "@agent-anything/helarc-local-environment/sandbox",
      "@agent-anything/helarc-local-environment/workspace",
    ]),
  ],
]);

const violations = [];
checkRootCommands();
checkRepositoryTopology();
checkContextHostAndMcpSourceTopology();
checkIntegrationSourceTopology();
checkExecutionSourceTopology();
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

console.log("Architecture check passed.");

function checkRootCommands() {
  const manifestFile = join(repoRoot, "package.json");
  const rootManifest = readJson(manifestFile);
  for (const issue of evaluateRepositoryCommands(rootManifest)) {
    report(issue.rule, {
      file: manifestFile,
      owner: "agent-anything",
      message: issue.message,
    });
  }
}

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
  console.error("Architecture check failed:");
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
    "@agent-anything/action-execution",
    "@agent-anything/agent-runtime",
    "@agent-anything/host",
  ]);
  const packageName = parseWorkspaceSpecifier(specifier).packageName;
  const allowedSubpaths = focusedPublicSubpaths.get(packageName);

  if (specifier === "@agent-anything/helarc-code-agent" && owner.name !== packageName) {
    report("capability_root_import", { file, owner, imported: packageName, message: `Must import a focused capability subpath instead of '${specifier}'.` });
  }

  if (
    ts.isExportDeclaration(statement) &&
    executionPackages.has(packageName) &&
    owner.name !== packageName
  ) {
    report("execution_api_reexport", { file, owner, imported: packageName, message: `Must not re-export API owned by '${packageName}'.` });
  }

  if (
    specifier === "@agent-anything/agent-core" ||
    specifier === "@agent-anything/agent-runtime"
  ) {
    report("agent_core_root_import", {
      file,
      owner,
      imported: packageName,
      message: `Must import an explicit Agent Core semantic subpath instead of '${specifier}'.`,
    });
  }

  if (specifier === "@agent-anything/action-execution") {
    report("action_execution_root_import", {
      file,
      owner,
      imported: packageName,
      message:
        `Must import an explicit Action Execution semantic subpath instead of '${specifier}'.`,
    });
  }
  if (specifier === "@agent-anything/host") {
    report("host_root_import", {
      file,
      owner,
      imported: packageName,
      message:
        `Must import an explicit Host Interface semantic subpath instead of '${specifier}'.`,
    });
  }
  if (specifier === "@agent-anything/mcp") {
    report("mcp_root_import", {
      file,
      owner,
      imported: packageName,
      message:
        `Must import an explicit MCP semantic subpath instead of '${specifier}'.`,
    });
  }
  if (
    specifier === "@agent-anything/plugins" ||
    specifier === "@agent-anything/remote-integrations" ||
    specifier === "@agent-anything/provider-integrations" ||
    specifier === "@agent-anything/enterprise-storage"
  ) {
    report("integration_root_import", {
      file,
      owner,
      imported: packageName,
      message:
        `Must import an explicit Integration responsibility subpath instead of '${specifier}'.`,
    });
  }
  if (specifier === "@agent-anything/context") {
    report("context_root_import", {
      file,
      owner,
      imported: packageName,
      message:
        `Must import an explicit Context semantic subpath instead of '${specifier}'.`,
    });
  }
  if (
    allowedSubpaths !== undefined &&
    specifier !== packageName &&
    !allowedSubpaths.has(specifier)
  ) {
    report("focused_package_private_import", {
      file,
      owner,
      imported: packageName,
      message:
        `Consumers must use a reviewed public subpath of '${packageName}', not '${specifier}'.`,
    });
  }
}

function checkReviewedManifests() {
  for (const info of packageInfo.values()) {
    const expected = expectedProductionDependencies(info.name);
    if (!expected) {
      report("dependency_policy_missing", {
        file: join(info.root, "package.json"),
        owner: info,
        message: `Package '${info.name}' has no reviewed production dependency policy.`,
      });
      continue;
    }
    const actual = [...info.dependencies].sort();
    const sortedExpected = [...expected].sort();
    if (JSON.stringify(actual) !== JSON.stringify(sortedExpected)) {
      report("manifest_dependencies", {
        file: join(info.root, "package.json"),
        owner: info,
        message: `Production dependencies must be exactly: ${sortedExpected.join(", ") || "(none)"}.`,
      });
    }
  }
}

function checkArchitectureSource(file, text, isTestOnly) {
  const rel = display(file);
  for (const violation of evaluateSourceOwnershipRules({
    sourcePath: rel,
    text,
    isTestOnly,
  })) {
    report(violation.rule, { file, message: violation.message });
  }
  checkDesktopSafeSurface(rel, text);
  if (rel.includes("/src/common/")) {
    report("temporary_common_source", {
      file,
      message:
        "A common source area is temporary migration staging and must not remain after Phase 22.",
    });
  }
  if (
    rel.startsWith("harness/agent-core/contracts/src/internal/") ||
    rel.startsWith("harness/agent-core/contracts/src/result/")
  ) {
    report("ambiguous_agent_core_contract_owner", {
      file,
      message:
        "Agent Core Contracts must use an explicit semantic owner instead of internal or result.",
    });
  }
  if (
    !isTestOnly &&
    rel.startsWith("harness/agent-core/runtime/src/runner/") &&
    rel !== "harness/agent-core/runtime/src/runner/RunExecution.ts" &&
    rel !== "harness/agent-core/runtime/src/runner/RunStateWriter.ts" &&
    (
      /\bthis\.state\s*=/.test(text) ||
      /\breplaceState\s*\(/.test(text)
    )
  ) {
    report("run_state_writer", {
      file,
      message:
        "Only RunExecution and its private invocation-local RunStateWriter may replace authoritative RunState inside Agent Core Runtime.",
    });
  }
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
    "HostRuntime",
    "createHostRuntime",
    "CreateHostRuntimeInput",
    "runHelarcSession",
    "startSession",
    "cancelSession",
    "HelarcStartSessionInput",
    "HelarcStartSessionResult",
    "HelarcCancelSessionResult",
    "StoragePort",
    "StoredArtifact",
    "InMemoryStorage",
    "sessionHistory",
    "onSessionHistoryRecord",
    "sessionStatus",
  ];

  for (const symbol of legacySymbols) {
    if (new RegExp(`\\b${symbol}\\b`).test(text)) {
      report("removed_execution_contract", { file, message: `Retains removed execution symbol '${symbol}'.` });
    }
  }
  const codeAgentToolConstants = text.match(/\bCODE_AGENT_[A-Z0-9_]+_TOOL\b/g) ?? [];
  const retainedCodeWorkspaceToolConstants = new Set([
    "CODE_AGENT_READ_TOOL",
    "CODE_AGENT_GLOB_TOOL",
    "CODE_AGENT_GREP_TOOL",
    "CODE_AGENT_EDIT_TOOL",
    "CODE_AGENT_WRITE_TOOL",
  ]);
  const removedCodeAgentToolConstant = codeAgentToolConstants.find(
    (symbol) => !retainedCodeWorkspaceToolConstants.has(symbol),
  );
  if (removedCodeAgentToolConstant !== undefined) {
    report("removed_tool_constant", {
      file,
      message: `Retains removed code-agent Tool constant '${removedCodeAgentToolConstant}'.`,
    });
  }
  if (/\bwaiting_for_permission\b/.test(text)) {
    report("removed_run_status", { file, message: "Retains the removed waiting_for_permission status." });
  }
  const removedArchitectureOwner = "plat" + "form";
  if (new RegExp(
    `requestRetryScheduler[\\s\\S]{0,200}?kind\\s*:\\s*["']${removedArchitectureOwner}["']`,
  ).test(text)) {
    report("removed_provider_retry_owner", {
      file,
      message: "Retains a removed architectural Provider Retry owner.",
    });
  }
  if (
    /@agent-anything\/(?:evidence|storage)(?:\/|["'])|@agent-anything\/agent-core\/context/.test(
      text,
    )
  ) {
    report("removed_context_owner", {
      file,
      message:
        "Retains a removed Evidence, Storage, or agent-core Context package path.",
    });
  }
  if (/\bevidenceStorage\b/.test(text)) {
    report("removed_storage_facade", {
      file,
      message: "Retains the removed generic Evidence storage dependency name.",
    });
  }
  if (/helarc:(?:start|cancel)-session/.test(text)) {
    report("removed_session_ipc", { file, message: "Retains a removed Session-named IPC channel." });
  }
  if (
    rel.startsWith("products/helarc/desktop/src/main/session-history/") ||
    rel === "products/helarc/desktop/src/main/thread/HelarcThreadStore.ts"
  ) {
    report("removed_history_path", { file, message: "Restores a removed legacy history source path." });
  }
  if (
    rel.startsWith("harness/validation/src/") &&
    /\/src\/(?:internal|common|shared)\//.test(rel)
  ) {
    report("validation_ambiguous_source_owner", {
      file,
      owner,
      message: "Validation source must belong to one of its eight explicit Contract families.",
    });
  }
  if (
    rel.startsWith("products/helarc/") &&
    /\b(?:HelarcConversation|createHelarcConversation|conversationId|activeConversationId)\b/.test(text)
  ) {
    report("removed_helarc_conversation", {
      file,
      message: "Retains removed mandatory Helarc Conversation identity.",
    });
  }

  if (isTestOnly) {
    return;
  }
  const isGateway = normalized(file).endsWith(
    "/harness/safety/action-execution/src/sandbox/SandboxExecutionGateway.ts",
  );
  if (!isGateway && /\b(?:actionExecutor|executor|registered\.executor)\.execute\s*\(/i.test(text)) {
    report("action_executor_dispatch", { file, message: "Invokes an ActionExecutor outside SandboxExecutionGateway." });
  }
  if (/\b(?:ConformanceSandboxProvider|createConformanceSandboxProvider)\b/.test(text)) {
    report("conformance_sandbox_in_production", { file, message: "Retains a production conformance sandbox provider." });
  }
  if (
    rel.startsWith("products/") &&
    /\brunner\.run\s*\(/i.test(text)
  ) {
    report("direct_runner_invocation", { file, message: "Invokes Runner directly instead of starting it through HostRunManager." });
  }
}

function checkDesktopSafeSurface(rel, text) {
  const isRenderer = rel.startsWith("products/helarc/desktop/src/renderer/");
  const isShared = rel.startsWith("products/helarc/desktop/src/shared/");
  const isPreload = rel.startsWith("products/helarc/desktop/src/preload/");
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
    rel.startsWith("products/helarc/desktop/src/renderer/") &&
    imported.packageName.startsWith("@agent-anything/")
  ) {
    report("desktop_renderer_workspace_import", { file, owner, imported: imported.packageName, message: "Renderer must consume workspace contracts through Desktop shared IPC." });
  }
  if (
    rel.startsWith("products/helarc/desktop/src/shared/") &&
    imported.packageName.startsWith("@agent-anything/")
  ) {
    report("desktop_shared_workspace_import", { file, owner, imported: imported.packageName, message: "Desktop shared IPC must own its DTOs instead of importing workspace Contracts." });
  }

  const removedFacadeName = `@agent-anything/${"plat" + "form"}`;
  if (imported.packageName === removedFacadeName) {
    report("removed_facade_import", {
      file,
      owner,
      imported: imported.packageName,
      message: "Must consume the exact Harness component owner.",
    });
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
  if (isSelf) {
    report("package_self_import", {
      file,
      owner,
      imported: importedPackage,
      message: "Package source must use relative imports for modules owned by the same package.",
    });
  }
  if (!isSelf) {
    for (const result of evaluateRepositoryDirection({
      owner,
      imported: importedPackage,
      isTestOnly,
      sourcePath: rel,
    })) {
      report(result.rule, { file, owner, imported: importedPackage, message: result.message });
    }
  }
  if (!isSelf && !hasDependency && !(isTestOnly && hasDevDependency)) {
    report("dependency_undeclared", { file, owner, imported: importedPackage, message: `Import is not declared in ${isTestOnly ? "dependencies or devDependencies" : "dependencies"}.` });
  }
  if (!isSelf && !isTestOnly && !hasDependency) {
    report("dependency_dev_only", { file, owner, imported: importedPackage, message: "Production import must be declared in dependencies, not only devDependencies." });
  }

  if (!isTestOnly && imported.packageName === "@agent-anything/test-support") {
    report("test_support_import_in_production", {
      file,
      owner,
      imported: importedPackage,
      message: "Production code must not import Test Support.",
    });
  }

  if (!isTestOnly && !isSelf) {
    for (const result of evaluateProductionDependency({
      owner,
      imported: importedPackage,
    })) {
      report(result.rule, { file, owner, imported: importedPackage, message: result.message });
    }
  }
}

function checkRepositoryTopology() {
  for (const rootName of ["packages", "apps", "extensions"]) {
    const root = join(repoRoot, rootName);
    if (exists(root)) {
      report("generic_repository_root", {
        file: root,
        message: `Generic repository root '${rootName}' is prohibited.`,
      });
    }
  }
  for (const info of packageInfo.values()) {
    const ownerName = basename(info.root).toLowerCase();
    if (ownerName === "common") {
      report("temporary_common_package", {
        file: info.root,
        owner: info,
        message:
          "A common package is temporary migration staging and must not remain after Phase 22.",
      });
    }
    const isAcceptedHelarcCore =
      ownerName === "core" &&
      info.name === "@agent-anything/helarc" &&
      info.kind === "product" &&
      info.productId === "helarc" &&
      info.component === "core";
    if ((ownerName === "core" && !isAcceptedHelarcCore) || ownerName === "shared") {
      report("generic_semantic_owner_unreviewed", {
        file: info.root,
        owner: info,
        message:
          `Generic package '${ownerName}' requires an accepted semantic scope and an explicit architecture rule before it can enter the workspace.`,
      });
    }
  }
}

function checkContextHostAndMcpSourceTopology() {
  const areas = [
    {
      packagePath: "harness/context",
      sourceAreas: [
        "active-context",
        "contract",
        "contribution",
        "evidence",
        "persistence",
        "projection",
      ],
      allowedSourceEntries: [
        "PublicApi.test.ts",
        "active-context",
        "contract",
        "contribution",
        "evidence",
        "persistence",
        "projection",
      ],
      forbiddenPaths: ["src/index.ts", "src/context", "src/observation"],
    },
    {
      packagePath: "harness/host",
      sourceAreas: [
        "authority",
        "composition",
        "context",
        "projection",
        "run",
        "transport",
      ],
      forbiddenPaths: ["src/index.ts", "src/HostRuntime.ts"],
    },
    {
      packagePath: "harness/integrations/mcp",
      sourceAreas: [
        "adapters",
        "lifecycle",
        "primitives",
        "protocol",
        "registration",
        "transport",
      ],
      allowedSourceEntries: [
        "PublicApi.test.ts",
        "adapters",
        "lifecycle",
        "primitives",
        "protocol",
        "registration",
        "transport",
      ],
      forbiddenPaths: ["src/index.ts"],
    },
  ];

  for (const area of areas) {
    for (const sourceArea of area.sourceAreas) {
      const path = join(repoRoot, area.packagePath, "src", sourceArea);
      if (!exists(path)) {
        report("harness_source_area_missing", {
          file: path,
          message:
            `Required Harness source area '${area.packagePath}/src/${sourceArea}' is missing.`,
        });
      }
    }
    for (const forbiddenPath of area.forbiddenPaths) {
      const path = join(repoRoot, area.packagePath, forbiddenPath);
      if (exists(path)) {
        report("harness_superseded_source_path", {
          file: path,
          message:
            `Superseded Harness source path '${area.packagePath}/${forbiddenPath}' must not exist.`,
        });
      }
    }
    if (area.allowedSourceEntries !== undefined) {
      const sourceRoot = join(repoRoot, area.packagePath, "src");
      const actualEntries = sourceTopologyEntries(sourceRoot);
      const allowedEntries = [...area.allowedSourceEntries].sort();
      if (JSON.stringify(actualEntries) !== JSON.stringify(allowedEntries)) {
        report("harness_source_topology_changed", {
          file: sourceRoot,
          message:
            `Reviewed source entries must be exactly: ${allowedEntries.join(", ")}.`,
        });
      }
    }
  }
}

function checkIntegrationSourceTopology() {
  const areas = [
    {
      packagePath: "harness/integrations/plugins",
      sourceAreas: ["activation", "admission", "lifecycle", "manifest"],
      allowedSourceEntries: [
        "activation",
        "admission",
        "lifecycle",
        "manifest",
      ],
      forbiddenPaths: [
        "src/index.ts",
        "src/PluginActivation.ts",
        "src/PluginAdmission.ts",
        "src/PluginContribution.ts",
        "src/PluginData.ts",
        "src/PluginManifest.ts",
        "src/PluginRegistry.ts",
        "src/PluginRegistryError.ts",
      ],
    },
    {
      packagePath: "harness/integrations/remote",
      sourceAreas: ["operation", "transport"],
      allowedSourceEntries: ["operation", "transport"],
      forbiddenPaths: ["src/index.ts"],
    },
    {
      packagePath: "harness/integrations/enterprise-storage",
      sourceAreas: ["evidence"],
      allowedSourceEntries: ["evidence"],
      forbiddenPaths: ["src/index.ts"],
    },
  ];

  for (const area of areas) {
    for (const sourceArea of area.sourceAreas) {
      const path = join(repoRoot, area.packagePath, "src", sourceArea);
      if (!exists(path)) {
        report("integration_source_area_missing", {
          file: path,
          message:
            `Required Integration source area '${area.packagePath}/src/${sourceArea}' is missing.`,
        });
      }
    }
    for (const forbiddenPath of area.forbiddenPaths) {
      const path = join(repoRoot, area.packagePath, forbiddenPath);
      if (exists(path)) {
        report("integration_superseded_source_path", {
          file: path,
          message:
            `Superseded Integration source path '${area.packagePath}/${forbiddenPath}' must not exist.`,
        });
      }
    }
    const sourceRoot = join(repoRoot, area.packagePath, "src");
    const actualEntries = sourceTopologyEntries(sourceRoot);
    const allowedEntries = [...area.allowedSourceEntries].sort();
    if (JSON.stringify(actualEntries) !== JSON.stringify(allowedEntries)) {
      report("integration_source_topology_changed", {
        file: sourceRoot,
        message:
          `Reviewed Integration source entries must be exactly: ${allowedEntries.join(", ")}.`,
      });
    }
  }
}

function checkExecutionSourceTopology() {
  const removedProductPath = join(repoRoot, "products/helarc/product");
  if (exists(removedProductPath)) {
    report("helarc_superseded_product_path", {
      file: removedProductPath,
      message: "Superseded Helarc Product directory must not exist after the Core move.",
    });
  }
  const areas = [
    {
      packagePath: "harness/workspace",
      allowedSourceEntries: [
        "WorkspaceContracts.test.ts",
        "identity",
        "internal",
        "selection",
      ],
    },
    {
      packagePath: "harness/agent-core/contracts",
      allowedSourceEntries: [
        "AgentCoreContracts.test.ts",
        "agent",
        "control",
        "delegation",
        "input",
        "run",
        "run-action",
        "run-item",
        "run-tree",
        "task",
        "validation.ts",
      ],
      forbiddenPaths: ["src/action", "src/run/InvocationInterruption.ts", "src/run/Workspace.ts"],
    },
    {
      packagePath: "harness/operation-catalog",
      allowedSourceEntries: [
        "OperationCatalog.test.ts",
        "binding",
        "catalog",
        "identity",
        "internal",
        "result",
      ],
    },
    {
      packagePath: "harness/safety/canonical-action",
      allowedSourceEntries: ["assessment", "lifecycle", "registration", "settlement", "subject"],
    },
    {
      packagePath: "harness/interaction",
      allowedSourceEntries: [
        "InteractionContracts.test.ts",
        "coordination",
        "internal",
        "protocol",
        "records",
      ],
    },
    {
      packagePath: "harness/tools",
      allowedSourceEntries: [
        "PublicApi.test.ts",
        "activation",
        "catalog",
        "identity",
        "invocation",
        "registration",
        "result",
        "selection",
      ],
      forbiddenPaths: ["src/index.ts", "src/ToolFailure.ts"],
    },
    {
      packagePath: "harness/safety/action-execution",
      allowedSourceEntries: [
        "PublicApi.test.ts",
        "coordination",
        "enforcement",
        "execution",
        "internal",
        "registration",
        "sandbox",
      ],
      forbiddenPaths: ["src/canonical", "src/preparation", "src/index.ts"],
    },
    {
      packagePath: "harness/operation-composition",
      allowedSourceEntries: ["definition", "execution", "result"],
    },
    {
      packagePath: "harness/integrations/providers",
      allowedSourceEntries: ["http", "ollama", "openai-compatible"],
      forbiddenPaths: ["src/index.ts"],
    },
    {
      packagePath: "harness/agent-core/runtime",
      allowedSourceEntries: [
        "PublicApi.test.ts",
        "context-contribution",
        "controller",
        "delegation",
        "instructions",
        "plan",
        "progress",
        "retry",
        "run",
        "runner",
      ],
      forbiddenPaths: [
        "src/runner/PermissionRequestAction.ts",
        "src/runner/RunActionRouter.ts",
        "src/runner/RunApprovalLifecycle.ts",
        "src/runner/RuntimeActionRecord.ts",
      ],
    },
    {
      packagePath: "products/helarc/core",
      allowedSourceEntries: [
        "HelarcProduct.test.ts",
        "HelarcProduct.ts",
        "PublicApi.test.ts",
        "agent",
        "artifacts",
        "composition",
        "configuration",
        "controller",
        "index.ts",
        "interaction",
        "instructions",
        "observability",
        "prompt",
        "result",
        "run",
        "task",
        "thread",
        "tools",
        "validation",
        "work-context",
      ],
      forbiddenPaths: ["src/review"],
    },
    {
      packagePath: "products/helarc/code-agent",
      allowedSourceEntries: [
        "PublicApi.test.ts",
        "file-operation",
        "source",
        "validation",
        "workspace",
      ],
      forbiddenPaths: [
        "src/command",
        "src/controller",
        "src/file-actions",
        "src/filesystem",
        "src/observability",
        "src/patch",
        "src/prompt",
        "src/task",
        "src/task-templates",
        "src/tools",
      ],
    },
    {
      packagePath: "products/helarc/local-environment",
      allowedSourceEntries: ["command", "filesystem", "sandbox", "workspace"],
    },
  ];

  for (const area of areas) {
    for (const forbiddenPath of area.forbiddenPaths ?? []) {
      const path = join(repoRoot, area.packagePath, forbiddenPath);
      if (
        exists(path) &&
        (!statSync(path).isDirectory() || directoryContainsEntries(path))
      ) {
        report("execution_superseded_source_path", {
          file: path,
          message: `Superseded execution source path '${area.packagePath}/${forbiddenPath}' must not exist.`,
        });
      }
    }
    const sourceRoot = join(repoRoot, area.packagePath, "src");
    const actualEntries = sourceTopologyEntries(sourceRoot);
    const allowedEntries = [...area.allowedSourceEntries].sort();
    if (JSON.stringify(actualEntries) !== JSON.stringify(allowedEntries)) {
      report("execution_source_topology_changed", {
        file: sourceRoot,
        message: `Reviewed execution source entries must be exactly: ${allowedEntries.join(", ")}.`,
      });
    }
  }
}

function sourceTopologyEntries(sourceRoot) {
  return readdirSync(sourceRoot, { withFileTypes: true })
    .filter((entry) =>
      !entry.isDirectory() || directoryContainsEntries(join(sourceRoot, entry.name)))
    .map((entry) => entry.name)
    .sort();
}

function directoryContainsEntries(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      return true;
    }
    if (directoryContainsEntries(join(directory, entry.name))) {
      return true;
    }
  }
  return false;
}

function checkRelativeImport(file, owner, specifier) {
  const resolved = resolve(dirname(file), specifier);
  const ownerRoot = `${owner.root}${sep}`;
  if (resolved !== owner.root && !resolved.startsWith(ownerRoot)) {
    report("relative_package_boundary", { file, owner, message: `Relative import crosses the package boundary: '${specifier}'.` });
  }

  const rel = display(file);
  const resolvedPath = normalized(resolved);
  const desktopSource = normalized(resolve(repoRoot, "products/helarc/desktop/src"));
  if (
    rel.startsWith("products/helarc/desktop/src/renderer/") &&
    !resolvedPath.startsWith(`${desktopSource}/renderer/`) &&
    !resolvedPath.startsWith(`${desktopSource}/shared/`)
  ) {
    report("desktop_renderer_relative_import", { file, owner, message: `Renderer relative import must remain in renderer or shared IPC: '${specifier}'.` });
  }
  if (
    rel.startsWith("products/helarc/desktop/src/shared/") &&
    !resolvedPath.startsWith(`${desktopSource}/shared/`)
  ) {
    report("desktop_shared_relative_import", { file, owner, message: `Desktop shared IPC relative import leaves the shared surface: '${specifier}'.` });
  }
  if (
    rel.startsWith("products/helarc/desktop/src/preload/") &&
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
    report("helarc_package_missing", { file: join(repoRoot, "products/helarc/core/package.json"), owner: "@agent-anything/helarc", message: "Required Helarc Core package is missing." });
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
