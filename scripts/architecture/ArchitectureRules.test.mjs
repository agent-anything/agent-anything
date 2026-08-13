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
    imported: { name: "@agent-anything/agent-core" },
  });
  assert.equal(violations[0]?.rule, "dependency_policy_missing");
});

test("Phase27 lower Contract dependencies are exact and acyclic", () => {
  assert.deepEqual(expectedProductionDependencies("@agent-anything/workspace"), []);
  assert.deepEqual(
    expectedProductionDependencies("@agent-anything/agent-core"),
    ["@agent-anything/workspace"],
  );
  assert.deepEqual(
    expectedProductionDependencies("@agent-anything/operation-catalog"),
    ["@agent-anything/agent-core"],
  );
  assert.deepEqual(
    expectedProductionDependencies("@agent-anything/canonical-action"),
    [
      "@agent-anything/agent-core",
      "@agent-anything/operation-catalog",
    ],
  );
  assert.deepEqual(
    expectedProductionDependencies("@agent-anything/interaction"),
    ["@agent-anything/agent-core", "@agent-anything/operation-catalog"],
  );
});

test("Phase27 execution dependencies are exact and owner-directed", () => {
  assert.deepEqual(
    expectedProductionDependencies("@agent-anything/tools"),
    ["@agent-anything/agent-core", "@agent-anything/operation-catalog"],
  );
  assert.deepEqual(
    expectedProductionDependencies("@agent-anything/context"),
    ["@agent-anything/agent-core"],
  );
  assert.deepEqual(
    expectedProductionDependencies("@agent-anything/observability"),
    ["@agent-anything/agent-core"],
  );
  assert.deepEqual(
    expectedProductionDependencies("@agent-anything/operation-composition"),
    ["@agent-anything/agent-core", "@agent-anything/operation-catalog"],
  );
});

test("Test Support is accepted only from test sources", () => {
  const owner = { kind: "harness", name: "@agent-anything/agent-runtime" };
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

test("Test Support may import Helarc only from the exact Evaluation target source", () => {
  const owner = { kind: "tooling", name: "@agent-anything/test-support" };
  const imported = {
    kind: "product",
    name: "@agent-anything/helarc",
    productId: "helarc",
  };
  assert.deepEqual(evaluateRepositoryDirection({
    owner,
    imported,
    sourcePath: "tooling/test-support/src/evaluation-targets/helarc/HelarcEvaluationTarget.ts",
  }), []);
  assert.equal(evaluateRepositoryDirection({
    owner,
    imported,
    sourcePath: "tooling/test-support/src/FakeHelarcProduct.ts",
  })[0]?.rule, "tooling_direction");
});
