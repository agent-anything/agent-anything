import assert from "node:assert/strict";
import test from "node:test";
import {
  HARNESS_PACKAGE_NAMES,
  HARNESS_PRODUCTION_DEPENDENCIES,
  PHASE_19_HARNESS_MIGRATION_DEPENDENCIES,
  PHASE_19_HARNESS_TEST_DEPENDENCIES,
  PLATFORM_PACKAGE_NAMES,
  PLATFORM_PRODUCTION_DEPENDENCIES,
  evaluateHarnessProductionDependency,
  evaluatePlatformProductionDependency,
  evaluateRepositoryDirection,
} from "./ArchitectureRules.mjs";
import { repositoryDirectionFixtures } from "./fixtures/dependency-directions.mjs";

for (const fixture of repositoryDirectionFixtures) {
  test(`repository direction: ${fixture.name}`, () => {
    const violations = evaluateRepositoryDirection(fixture);
    assert.equal(violations.length === 0, fixture.accepted);
  });
}

for (const ownerName of PLATFORM_PACKAGE_NAMES) {
  test(`complete platform dependency policy for ${ownerName}`, () => {
    for (const importedName of PLATFORM_PACKAGE_NAMES) {
      if (ownerName === importedName) continue;
      const accepted = PLATFORM_PRODUCTION_DEPENDENCIES[ownerName].includes(importedName);
      const violations = evaluatePlatformProductionDependency({
        owner: { kind: "platform", name: ownerName },
        imported: { kind: "platform", name: importedName },
      });
      assert.equal(
        violations.length === 0,
        accepted,
        `${ownerName} -> ${importedName}`,
      );
    }
  });
}

for (const ownerName of HARNESS_PACKAGE_NAMES) {
  test(`complete Harness dependency policy for ${ownerName}`, () => {
    for (const importedName of HARNESS_PACKAGE_NAMES) {
      if (ownerName === importedName) continue;
      const accepted = HARNESS_PRODUCTION_DEPENDENCIES[ownerName].includes(importedName);
      const violations = evaluateHarnessProductionDependency({
        owner: { kind: "harness", name: ownerName },
        imported: { kind: "harness", name: importedName },
      });
      assert.equal(violations.length === 0, accepted, `${ownerName} -> ${importedName}`);
    }
  });
}

test("an unreviewed platform owner fails closed", () => {
  const violations = evaluatePlatformProductionDependency({
    owner: { kind: "platform", name: "@agent-anything/new-package" },
    imported: { kind: "platform", name: "@agent-anything/tools" },
  });
  assert.equal(violations[0]?.rule, "platform_dependency_policy_missing");
});

test("an unreviewed Harness owner fails closed", () => {
  const violations = evaluateHarnessProductionDependency({
    owner: { kind: "harness", name: "@agent-anything/new-package" },
    imported: { kind: "harness", name: "@agent-anything/foundation" },
  });
  assert.equal(violations[0]?.rule, "harness_dependency_policy_missing");
});

test("the exact Phase 19 Harness migration bridges are accepted", () => {
  for (const [ownerName, importedNames] of Object.entries(
    PHASE_19_HARNESS_MIGRATION_DEPENDENCIES,
  )) {
    for (const importedName of importedNames) {
      const directionViolations = evaluateRepositoryDirection({
        owner: { kind: "harness", name: ownerName },
        imported: { kind: "platform", name: importedName },
      });
      const policyViolations = evaluateHarnessProductionDependency({
        owner: { kind: "harness", name: ownerName },
        imported: { kind: "platform", name: importedName },
      });
      assert.deepEqual(directionViolations, [], `${ownerName} -> ${importedName}`);
      assert.deepEqual(policyViolations, [], `${ownerName} -> ${importedName}`);
    }
  }
});

test("an unlisted Harness-to-transitional edge still fails closed", () => {
  const violations = evaluateRepositoryDirection({
    owner: { kind: "harness", name: "@agent-anything/runtime" },
    imported: { kind: "platform", name: "@agent-anything/host" },
  });
  assert.equal(violations[0]?.rule, "repository_direction");
});

test("the exact Phase 19 Runtime test-support bridge is accepted", () => {
  for (const importedName of PHASE_19_HARNESS_TEST_DEPENDENCIES[
    "@agent-anything/runtime"
  ]) {
    const violations = evaluateRepositoryDirection({
      owner: { kind: "harness", name: "@agent-anything/runtime" },
      imported: { kind: "platform", name: importedName },
    });
    assert.deepEqual(violations, [], importedName);
  }
});
