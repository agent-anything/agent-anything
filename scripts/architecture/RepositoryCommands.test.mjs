import assert from "node:assert/strict";
import test from "node:test";
import { evaluateRepositoryCommands } from "./RepositoryCommands.mjs";

const acceptedScripts = Object.freeze({
  test: "pnpm run architecture:check && pnpm build && pnpm -r run test",
  "test:conformance": "pnpm --filter conformance test",
  "test:evaluation": "pnpm --filter @agent-anything/test-support test:evaluation",
  "test:phase29": "pnpm --filter @agent-anything/test-support test:context-continuity",
  "evaluation:baseline:candidate": "pnpm --filter @agent-anything/test-support build && pnpm --filter @agent-anything/test-support evaluation:baseline:candidate",
});

test("accepts distinct unit, conformance, Evaluation, and candidate commands", () => {
  assert.deepEqual(evaluateRepositoryCommands({ scripts: acceptedScripts }), []);
});

test("rejects the removed alias and conflated test commands", () => {
  const issues = evaluateRepositoryCommands({
    scripts: {
      ...acceptedScripts,
      "conformance:test": acceptedScripts["test:conformance"],
      "test:evaluation": acceptedScripts["test:conformance"],
    },
  });
  assert.deepEqual(issues.map((issue) => issue.rule), [
    "removed_conformance_command",
    "repository_test_commands_conflated",
  ]);
});

test("rejects an Evaluation command that invokes Baseline candidate generation", () => {
  const issues = evaluateRepositoryCommands({
    scripts: {
      ...acceptedScripts,
      "test:evaluation": "pnpm run evaluation:baseline:candidate",
    },
  });
  assert.equal(issues[0]?.rule, "evaluation_test_writes_baseline");
});

test("rejects an incomplete candidate command", () => {
  const issues = evaluateRepositoryCommands({
    scripts: {
      ...acceptedScripts,
      "evaluation:baseline:candidate": "pnpm --filter @agent-anything/test-support... build",
    },
  });
  assert.equal(issues[0]?.rule, "evaluation_candidate_command_invalid");
});
