export const PLATFORM_PRODUCTION_DEPENDENCIES = Object.freeze({
  "@agent-anything/shared": [],
  "@agent-anything/tools": ["@agent-anything/shared"],
  "@agent-anything/evidence": ["@agent-anything/shared", "@agent-anything/tools"],
  "@agent-anything/governance": ["@agent-anything/shared"],
  "@agent-anything/permission": ["@agent-anything/governance", "@agent-anything/shared"],
  "@agent-anything/observability": ["@agent-anything/evidence", "@agent-anything/shared"],
  "@agent-anything/providers": ["@agent-anything/shared"],
  "@agent-anything/storage": ["@agent-anything/evidence", "@agent-anything/shared"],
  "@agent-anything/testing": [
    "@agent-anything/governance",
    "@agent-anything/observability",
    "@agent-anything/permission",
    "@agent-anything/providers",
    "@agent-anything/shared",
  ],
  "@agent-anything/agent-core": [
    "@agent-anything/governance",
    "@agent-anything/permission",
    "@agent-anything/shared",
    "@agent-anything/tools",
  ],
  "@agent-anything/action-execution": [
    "@agent-anything/agent-core",
    "@agent-anything/governance",
    "@agent-anything/permission",
    "@agent-anything/shared",
    "@agent-anything/tools",
  ],
  "@agent-anything/agent-runtime": [
    "@agent-anything/action-execution",
    "@agent-anything/agent-core",
    "@agent-anything/evidence",
    "@agent-anything/governance",
    "@agent-anything/observability",
    "@agent-anything/permission",
    "@agent-anything/providers",
    "@agent-anything/shared",
    "@agent-anything/storage",
    "@agent-anything/tools",
  ],
  "@agent-anything/host": [
    "@agent-anything/action-execution",
    "@agent-anything/agent-core",
    "@agent-anything/agent-runtime",
    "@agent-anything/governance",
    "@agent-anything/permission",
    "@agent-anything/shared",
  ],
  "@agent-anything/code-agent": [
    "@agent-anything/action-execution",
    "@agent-anything/agent-core",
    "@agent-anything/governance",
    "@agent-anything/shared",
    "@agent-anything/tools",
  ],
  "@agent-anything/extensions": [
    "@agent-anything/action-execution",
    "@agent-anything/shared",
    "@agent-anything/tools",
  ],
});

export const PLATFORM_PACKAGE_NAMES = Object.freeze(Object.keys(PLATFORM_PRODUCTION_DEPENDENCIES));

export function evaluateRepositoryDirection({ owner, imported }) {
  if (owner.name === imported.name) return [];

  if (owner.kind === "platform" && imported.kind !== "platform") {
    return [violation("repository_direction", `Platform package must not depend on ${imported.kind} package '${imported.name}'.`)];
  }
  if (owner.kind === "product" && imported.kind === "app") {
    return [violation("repository_direction", `Product package must not depend on app package '${imported.name}'.`)];
  }
  if (owner.kind === "product" && imported.kind === "product") {
    return [violation("repository_direction", `Product package must not depend on another product package '${imported.name}'.`)];
  }
  if (owner.kind === "app" && imported.kind === "app") {
    return [violation("repository_direction", `App package must not depend on another app package '${imported.name}'.`)];
  }
  return [];
}

export function evaluatePlatformProductionDependency({ owner, imported }) {
  if (owner.kind !== "platform" || imported.kind !== "platform" || owner.name === imported.name) {
    return [];
  }

  const allowed = PLATFORM_PRODUCTION_DEPENDENCIES[owner.name];
  if (!allowed) {
    return [violation("platform_dependency_policy_missing", `Platform package '${owner.name}' has no production dependency policy.`)];
  }
  if (!allowed.includes(imported.name)) {
    return [violation("platform_dependency_forbidden", `Platform package '${owner.name}' must not depend on '${imported.name}'.`)];
  }
  return [];
}

export function expectedPlatformDependencies(packageName) {
  return PLATFORM_PRODUCTION_DEPENDENCIES[packageName] ?? null;
}

function violation(rule, message) {
  return { rule, message };
}
