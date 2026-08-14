export const HARNESS_PRODUCTION_DEPENDENCIES = Object.freeze({
  "@agent-anything/workspace": [],
  "@agent-anything/agent-core": ["@agent-anything/workspace"],
  "@agent-anything/operation-catalog": ["@agent-anything/agent-core"],
  "@agent-anything/interaction": [
    "@agent-anything/agent-core",
    "@agent-anything/operation-catalog",
  ],
  "@agent-anything/canonical-action": [
    "@agent-anything/agent-core",
    "@agent-anything/operation-catalog",
  ],
  "@agent-anything/model-interaction": ["@agent-anything/agent-core"],
  "@agent-anything/tools": [
    "@agent-anything/agent-core",
    "@agent-anything/operation-catalog",
  ],
  "@agent-anything/governance": [
    "@agent-anything/agent-core",
    "@agent-anything/canonical-action",
  ],
  "@agent-anything/permission": [
    "@agent-anything/agent-core",
    "@agent-anything/canonical-action",
    "@agent-anything/governance",
    "@agent-anything/interaction",
  ],
  "@agent-anything/action-execution": [
    "@agent-anything/agent-core",
    "@agent-anything/canonical-action",
    "@agent-anything/governance",
    "@agent-anything/operation-catalog",
    "@agent-anything/permission",
  ],
  "@agent-anything/context": ["@agent-anything/agent-core"],
  "@agent-anything/observability": ["@agent-anything/agent-core"],
  "@agent-anything/operation-composition": [
    "@agent-anything/agent-core",
    "@agent-anything/operation-catalog",
  ],
  "@agent-anything/evaluation": ["@agent-anything/agent-core"],
  "@agent-anything/agent-runtime": [
    "@agent-anything/action-execution",
    "@agent-anything/agent-core",
    "@agent-anything/canonical-action",
    "@agent-anything/context",
    "@agent-anything/governance",
    "@agent-anything/interaction",
    "@agent-anything/model-interaction",
    "@agent-anything/observability",
    "@agent-anything/operation-catalog",
    "@agent-anything/operation-composition",
    "@agent-anything/permission",
    "@agent-anything/tools",
    "@agent-anything/workspace",
  ],
  "@agent-anything/remote-integrations": [
    "@agent-anything/action-execution",
    "@agent-anything/canonical-action",
    "@agent-anything/operation-catalog",
    "@agent-anything/tools",
  ],
  "@agent-anything/provider-integrations": [
    "@agent-anything/agent-core",
    "@agent-anything/model-interaction",
  ],
  "@agent-anything/mcp": [
    "@agent-anything/agent-core",
    "@agent-anything/remote-integrations",
    "@agent-anything/tools",
    "ajv",
  ],
  "@agent-anything/plugins": [
    "@agent-anything/agent-core",
    "semver",
  ],
  "@agent-anything/enterprise-storage": [
    "@agent-anything/context",
    "@agent-anything/agent-core",
  ],
  "@agent-anything/host": [
    "@agent-anything/action-execution",
    "@agent-anything/agent-core",
    "@agent-anything/governance",
    "@agent-anything/interaction",
    "@agent-anything/observability",
    "@agent-anything/permission",
    "@agent-anything/agent-runtime",
    "@agent-anything/workspace",
  ],
});

export const PRODUCT_PRODUCTION_DEPENDENCIES = Object.freeze({
  "@agent-anything/helarc-code-agent": [
    "@agent-anything/canonical-action",
    "@agent-anything/operation-catalog",
    "@agent-anything/tools",
    "@agent-anything/workspace",
  ],
  "@agent-anything/helarc": [
    "@agent-anything/action-execution",
    "@agent-anything/agent-core",
    "@agent-anything/canonical-action",
    "@agent-anything/context",
    "@agent-anything/helarc-code-agent",
    "@agent-anything/host",
    "@agent-anything/interaction",
    "@agent-anything/model-interaction",
    "@agent-anything/observability",
    "@agent-anything/operation-catalog",
    "@agent-anything/agent-runtime",
    "@agent-anything/tools",
    "@agent-anything/workspace",
  ],
  "@agent-anything/helarc-local-environment": [
    "@agent-anything/action-execution",
    "@agent-anything/agent-core",
    "@agent-anything/canonical-action",
    "@agent-anything/helarc-code-agent",
    "@agent-anything/operation-catalog",
    "@agent-anything/workspace",
  ],
  "@agent-anything/helarc-desktop": [
    "@agent-anything/action-execution",
    "@agent-anything/context",
    "@agent-anything/agent-core",
    "@agent-anything/canonical-action",
    "@agent-anything/governance",
    "@agent-anything/helarc",
    "@agent-anything/helarc-code-agent",
    "@agent-anything/helarc-local-environment",
    "@agent-anything/host",
    "@agent-anything/model-interaction",
    "@agent-anything/observability",
    "@agent-anything/permission",
    "@agent-anything/provider-integrations",
    "@agent-anything/agent-runtime",
    "@agent-anything/workspace",
    "lucide-react",
    "react",
    "react-dom",
  ],
});

export const TOOLING_PRODUCTION_DEPENDENCIES = Object.freeze({
  "@agent-anything/test-support": [
    "@agent-anything/action-execution",
    "@agent-anything/agent-runtime",
    "@agent-anything/canonical-action",
    "@agent-anything/context",
    "@agent-anything/agent-core",
    "@agent-anything/evaluation",
    "@agent-anything/governance",
    "@agent-anything/helarc",
    "@agent-anything/helarc-code-agent",
    "@agent-anything/helarc-local-environment",
    "@agent-anything/host",
    "@agent-anything/interaction",
    "@agent-anything/model-interaction",
    "@agent-anything/observability",
    "@agent-anything/operation-catalog",
    "@agent-anything/permission",
    "@agent-anything/tools",
    "@agent-anything/workspace",
  ],
});

const HELARC_EVALUATION_TARGET_SOURCE_PREFIX =
  "tooling/test-support/src/evaluation-targets/helarc/";
const HELARC_EVALUATION_TARGET_PRODUCT_DEPENDENCIES = new Set([
  "@agent-anything/helarc",
  "@agent-anything/helarc-code-agent",
  "@agent-anything/helarc-local-environment",
]);

export const REVIEWED_PRODUCTION_DEPENDENCIES = Object.freeze({
  ...HARNESS_PRODUCTION_DEPENDENCIES,
  ...PRODUCT_PRODUCTION_DEPENDENCIES,
  ...TOOLING_PRODUCTION_DEPENDENCIES,
});

const PRODUCT_COMPONENT_DEPENDENCIES = Object.freeze({
  "code-workspace": new Set(),
  core: new Set(["code-workspace"]),
  "local-environment": new Set(["code-workspace"]),
  desktop: new Set([
    "code-workspace",
    "core",
    "local-environment",
  ]),
});

export function evaluateRepositoryDirection({
  owner,
  imported,
  isTestOnly = false,
  sourcePath = "",
}) {
  if (owner.name === imported.name) return [];

  if (imported.kind === "tooling") {
    if (
      isTestOnly &&
      imported.name === "@agent-anything/test-support" &&
      (owner.kind === "harness" || owner.kind === "product")
    ) {
      return [];
    }
    return [violation(
      "tooling_dependency_forbidden",
      `${label(owner)} must not use Tooling package '${imported.name}' outside test sources.`,
    )];
  }

  if (owner.kind === "tooling") {
    if (imported.kind === "harness") return [];
    if (
      owner.name === "@agent-anything/test-support" &&
      imported.kind === "product" &&
      HELARC_EVALUATION_TARGET_PRODUCT_DEPENDENCIES.has(imported.name) &&
      normalizeSourcePath(sourcePath).startsWith(
        HELARC_EVALUATION_TARGET_SOURCE_PREFIX,
      )
    ) {
      return [];
    }
    return [violation(
      "tooling_direction",
      `Tooling package must not depend on ${imported.kind} package '${imported.name}' from '${normalizeSourcePath(sourcePath) || "an unspecified source"}'.`,
    )];
  }

  if (owner.kind === "harness") {
    if (imported.kind === "harness") return [];
    return [violation(
      "repository_direction",
      `Harness package must not depend on ${imported.kind} package '${imported.name}'.`,
    )];
  }

  if (owner.kind === "product") {
    if (imported.kind === "harness") return [];
    if (
      imported.kind === "product" &&
      owner.productId &&
      owner.productId === imported.productId
    ) {
      return evaluateProductComponentDirection(owner, imported);
    }
    return [violation(
      "repository_direction",
      `Product package must not depend on '${imported.name}' outside Product '${owner.productId ?? "unknown"}'.`,
    )];
  }

  return [violation(
    "repository_kind_unknown",
    `Package '${owner.name}' has unsupported repository kind '${owner.kind}'.`,
  )];
}

function evaluateProductComponentDirection(owner, imported) {
  const allowedDependencies = PRODUCT_COMPONENT_DEPENDENCIES[owner.component];
  if (
    allowedDependencies === undefined ||
    PRODUCT_COMPONENT_DEPENDENCIES[imported.component] === undefined
  ) {
    return [];
  }
  if (allowedDependencies.has(imported.component)) {
    return [];
  }
  return [violation(
    "product_component_direction",
    `Product component '${owner.component}' must not depend on component '${imported.component}'.`,
  )];
}

export function evaluateProductionDependency({ owner, imported }) {
  if (owner.name === imported.name) return [];

  const allowed = REVIEWED_PRODUCTION_DEPENDENCIES[owner.name];
  if (!allowed) {
    return [violation(
      "dependency_policy_missing",
      `Package '${owner.name}' has no reviewed production dependency policy.`,
    )];
  }
  if (!allowed.includes(imported.name)) {
    return [violation(
      "production_dependency_forbidden",
      `Package '${owner.name}' must not depend on '${imported.name}'.`,
    )];
  }
  return [];
}

export function expectedProductionDependencies(packageName) {
  return REVIEWED_PRODUCTION_DEPENDENCIES[packageName] ?? null;
}

function label(owner) {
  if (owner.kind === "harness") return "Harness package";
  if (owner.kind === "product") return "Product package";
  return `Package '${owner.name}'`;
}

function normalizeSourcePath(sourcePath) {
  return sourcePath.replaceAll("\\", "/").replace(/^\.\//, "");
}

function violation(rule, message) {
  return { rule, message };
}
