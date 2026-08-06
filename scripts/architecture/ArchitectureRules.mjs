export const HARNESS_PRODUCTION_DEPENDENCIES = Object.freeze({
  "@agent-anything/agent-core": [],
  "@agent-anything/model-interaction": ["@agent-anything/agent-core"],
  "@agent-anything/tools": ["@agent-anything/agent-core"],
  "@agent-anything/governance": ["@agent-anything/agent-core"],
  "@agent-anything/permission": [
    "@agent-anything/agent-core",
    "@agent-anything/governance",
  ],
  "@agent-anything/action-execution": [
    "@agent-anything/agent-core",
    "@agent-anything/governance",
    "@agent-anything/permission",
    "@agent-anything/tools",
  ],
  "@agent-anything/context": [
    "@agent-anything/agent-core",
    "@agent-anything/tools",
  ],
  "@agent-anything/observability": [
    "@agent-anything/context",
    "@agent-anything/agent-core",
  ],
  "@agent-anything/agent-runtime": [
    "@agent-anything/action-execution",
    "@agent-anything/context",
    "@agent-anything/agent-core",
    "@agent-anything/governance",
    "@agent-anything/model-interaction",
    "@agent-anything/observability",
    "@agent-anything/permission",
    "@agent-anything/tools",
  ],
  "@agent-anything/remote-integrations": [
    "@agent-anything/action-execution",
    "@agent-anything/agent-core",
    "@agent-anything/tools",
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
    "@agent-anything/observability",
    "@agent-anything/permission",
    "@agent-anything/agent-runtime",
  ],
});

export const PRODUCT_PRODUCTION_DEPENDENCIES = Object.freeze({
  "@agent-anything/helarc-code-agent": [
    "@agent-anything/action-execution",
    "@agent-anything/agent-core",
    "@agent-anything/context",
    "@agent-anything/governance",
    "@agent-anything/model-interaction",
    "@agent-anything/observability",
    "@agent-anything/agent-runtime",
    "@agent-anything/tools",
  ],
  "@agent-anything/helarc": [
    "@agent-anything/action-execution",
    "@agent-anything/agent-core",
    "@agent-anything/helarc-code-agent",
    "@agent-anything/host",
    "@agent-anything/model-interaction",
    "@agent-anything/observability",
    "@agent-anything/agent-runtime",
    "@agent-anything/tools",
  ],
  "@agent-anything/helarc-desktop": [
    "@agent-anything/action-execution",
    "@agent-anything/context",
    "@agent-anything/agent-core",
    "@agent-anything/governance",
    "@agent-anything/helarc",
    "@agent-anything/helarc-code-agent",
    "@agent-anything/host",
    "@agent-anything/model-interaction",
    "@agent-anything/observability",
    "@agent-anything/permission",
    "@agent-anything/agent-runtime",
    "lucide-react",
    "react",
    "react-dom",
  ],
});

export const TOOLING_PRODUCTION_DEPENDENCIES = Object.freeze({
  "@agent-anything/test-support": [
    "@agent-anything/context",
    "@agent-anything/agent-core",
    "@agent-anything/model-interaction",
    "@agent-anything/observability",
    "@agent-anything/permission",
  ],
});

export const REVIEWED_PRODUCTION_DEPENDENCIES = Object.freeze({
  ...HARNESS_PRODUCTION_DEPENDENCIES,
  ...PRODUCT_PRODUCTION_DEPENDENCIES,
  ...TOOLING_PRODUCTION_DEPENDENCIES,
});

const PRODUCT_COMPONENT_ORDER = Object.freeze({
  "code-agent": 0,
  product: 1,
  desktop: 2,
});

export function evaluateRepositoryDirection({
  owner,
  imported,
  isTestOnly = false,
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
    return [violation(
      "tooling_direction",
      `Tooling package must not depend on ${imported.kind} package '${imported.name}'.`,
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
  const ownerOrder = PRODUCT_COMPONENT_ORDER[owner.component];
  const importedOrder = PRODUCT_COMPONENT_ORDER[imported.component];
  if (ownerOrder === undefined || importedOrder === undefined) {
    return [];
  }
  if (importedOrder <= ownerOrder) {
    return [];
  }
  return [violation(
    "product_component_direction",
    `Product component '${owner.component}' must not depend on higher component '${imported.component}'.`,
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

function violation(rule, message) {
  return { rule, message };
}
