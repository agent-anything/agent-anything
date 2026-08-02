export const PLATFORM_PRODUCTION_DEPENDENCIES = Object.freeze({
  "@agent-anything/tools": ["@agent-anything/foundation"],
  "@agent-anything/evidence": ["@agent-anything/foundation", "@agent-anything/tools"],
  "@agent-anything/governance": ["@agent-anything/foundation"],
  "@agent-anything/permission": ["@agent-anything/foundation", "@agent-anything/governance"],
  "@agent-anything/observability": ["@agent-anything/evidence", "@agent-anything/foundation"],
  "@agent-anything/storage": ["@agent-anything/evidence", "@agent-anything/foundation"],
  "@agent-anything/testing": [
    "@agent-anything/foundation",
    "@agent-anything/observability",
    "@agent-anything/permission",
    "@agent-anything/model-interaction",
  ],
  "@agent-anything/agent-core": [
    "@agent-anything/foundation",
    "@agent-anything/permission",
    "@agent-anything/tools",
  ],
  "@agent-anything/action-execution": [
    "@agent-anything/foundation",
    "@agent-anything/governance",
    "@agent-anything/permission",
    "@agent-anything/tools",
  ],
  "@agent-anything/host": [
    "@agent-anything/action-execution",
    "@agent-anything/agent-core",
    "@agent-anything/runtime",
    "@agent-anything/foundation",
    "@agent-anything/governance",
    "@agent-anything/permission",
  ],
  "@agent-anything/code-agent": [
    "@agent-anything/action-execution",
    "@agent-anything/foundation",
    "@agent-anything/governance",
    "@agent-anything/tools",
  ],
  "@agent-anything/extensions": [
    "@agent-anything/action-execution",
    "@agent-anything/foundation",
    "@agent-anything/tools",
  ],
});

export const PLATFORM_PACKAGE_NAMES = Object.freeze(Object.keys(PLATFORM_PRODUCTION_DEPENDENCIES));
export const HARNESS_PRODUCTION_DEPENDENCIES = Object.freeze({
  "@agent-anything/foundation": [],
  "@agent-anything/model-interaction": ["@agent-anything/foundation"],
  "@agent-anything/runtime": [
    "@agent-anything/foundation",
    "@agent-anything/model-interaction",
  ],
});
export const HARNESS_PACKAGE_NAMES = Object.freeze(Object.keys(HARNESS_PRODUCTION_DEPENDENCIES));
export const PHASE_19_HARNESS_MIGRATION_DEPENDENCIES = Object.freeze({
  "@agent-anything/runtime": Object.freeze([
    "@agent-anything/action-execution",
    "@agent-anything/agent-core",
    "@agent-anything/evidence",
    "@agent-anything/governance",
    "@agent-anything/observability",
    "@agent-anything/permission",
    "@agent-anything/storage",
    "@agent-anything/tools",
  ]),
});
export const PHASE_19_HARNESS_TEST_DEPENDENCIES = Object.freeze({
  "@agent-anything/runtime": Object.freeze([
    "@agent-anything/testing",
  ]),
});

export function evaluateRepositoryDirection({ owner, imported }) {
  if (owner.name === imported.name) return [];

  if (
    owner.kind === "harness" &&
    imported.kind === "platform" &&
    (
      isPhase19HarnessMigrationDependency(owner.name, imported.name) ||
      isPhase19HarnessTestDependency(owner.name, imported.name)
    )
  ) {
    return [];
  }
  if (owner.kind === "harness" && imported.kind !== "harness") {
    return [violation("repository_direction", `Harness package must not depend on ${imported.kind} package '${imported.name}'.`)];
  }
  if (
    owner.kind === "platform" &&
    imported.kind !== "platform" &&
    imported.kind !== "harness"
  ) {
    return [violation("repository_direction", `Transitional package must not depend on ${imported.kind} package '${imported.name}'.`)];
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

export function evaluateHarnessProductionDependency({ owner, imported }) {
  if (owner.kind !== "harness" || owner.name === imported.name) {
    return [];
  }

  const allowed = HARNESS_PRODUCTION_DEPENDENCIES[owner.name];
  if (!allowed) {
    return [violation("harness_dependency_policy_missing", `Harness package '${owner.name}' has no production dependency policy.`)];
  }
  if (
    !allowed.includes(imported.name) &&
    !isPhase19HarnessMigrationDependency(owner.name, imported.name)
  ) {
    return [violation("harness_dependency_forbidden", `Harness package '${owner.name}' must not depend on '${imported.name}'.`)];
  }
  return [];
}

export function expectedHarnessDependencies(packageName) {
  const permanent = HARNESS_PRODUCTION_DEPENDENCIES[packageName];
  if (!permanent) return null;
  return [
    ...permanent,
    ...(PHASE_19_HARNESS_MIGRATION_DEPENDENCIES[packageName] ?? []),
  ];
}

function isPhase19HarnessMigrationDependency(ownerName, importedName) {
  return (
    PHASE_19_HARNESS_MIGRATION_DEPENDENCIES[ownerName]?.includes(importedName) ??
    false
  );
}

function isPhase19HarnessTestDependency(ownerName, importedName) {
  return (
    PHASE_19_HARNESS_TEST_DEPENDENCIES[ownerName]?.includes(importedName) ??
    false
  );
}

function violation(rule, message) {
  return { rule, message };
}
