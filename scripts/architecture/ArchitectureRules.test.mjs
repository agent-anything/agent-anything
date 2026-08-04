import assert from "node:assert/strict";
import test from "node:test";
import {
  REVIEWED_PRODUCTION_DEPENDENCIES,
  evaluateProductionDependency,
  evaluateRepositoryDirection,
  expectedProductionDependencies,
} from "./ArchitectureRules.mjs";
import { repositoryDirectionFixtures } from "./fixtures/dependency-directions.mjs";

for (const fixture of repositoryDirectionFixtures) {
  test(`repository direction: ${fixture.name}`, () => {
    const violations = evaluateRepositoryDirection(fixture);
    assert.equal(violations.length === 0, fixture.accepted);
  });
}

for (const [ownerName, importedNames] of Object.entries(
  REVIEWED_PRODUCTION_DEPENDENCIES,
)) {
  test(`complete production dependency policy for ${ownerName}`, () => {
    for (const importedName of Object.keys(REVIEWED_PRODUCTION_DEPENDENCIES)) {
      if (ownerName === importedName) continue;
      const accepted = importedNames.includes(importedName);
      const violations = evaluateProductionDependency({
        owner: { name: ownerName },
        imported: { name: importedName },
      });
      assert.equal(
        violations.length === 0,
        accepted,
        `${ownerName} -> ${importedName}`,
      );
    }
  });
}

test("an unreviewed package owner fails closed", () => {
  assert.equal(expectedProductionDependencies("@agent-anything/new-package"), null);
  const violations = evaluateProductionDependency({
    owner: { name: "@agent-anything/new-package" },
    imported: { name: "@agent-anything/foundation" },
  });
  assert.equal(violations[0]?.rule, "dependency_policy_missing");
});

test("Test Support is accepted only from test sources", () => {
  const owner = { kind: "harness", name: "@agent-anything/runtime" };
  const imported = {
    kind: "tooling",
    name: "@agent-anything/test-support",
  };
  assert.equal(
    evaluateRepositoryDirection({ owner, imported }).length,
    1,
  );
  assert.deepEqual(
    evaluateRepositoryDirection({ owner, imported, isTestOnly: true }),
    [],
  );
});
