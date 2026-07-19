import assert from "node:assert/strict";
import test from "node:test";
import {
  PLATFORM_PACKAGE_NAMES,
  PLATFORM_PRODUCTION_DEPENDENCIES,
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

test("an unreviewed platform owner fails closed", () => {
  const violations = evaluatePlatformProductionDependency({
    owner: { kind: "platform", name: "@agent-anything/new-package" },
    imported: { kind: "platform", name: "@agent-anything/shared" },
  });
  assert.equal(violations[0]?.rule, "platform_dependency_policy_missing");
});
