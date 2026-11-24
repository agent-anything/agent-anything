import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { planCase, runPreparedCase } from "../run-responses-case.mjs";

const target = "Helarc-Responses-Test/acceptance";
test("new cases use fresh directories and their own dispatch authority", () => {
  for (const [id, authority] of [
    ["tool-roundtrip", "--authorize-live"], ["delegated-material", "--authorize-live"],
    ["stored-continuation", "--authorize-stored-live"], ["background-observation", "--authorize-background-stored-live"],
    ["standalone-compaction", "--authorize-live"],
  ]) {
    const p = planCase([id, authority], target);
    assert.equal(p.setup, "prepare-live");
    assert.notEqual(planCase([id, authority], target).directory, p.directory);
    assert.deepEqual(p.args, [p.directory, authority, ...(id === "standalone-compaction" ? ["seed"] : [])]);
  }
});

test("resuming, settling, and following up require the original directory, not a new credential", () => {
  for (const [id, flags, args] of [
    ["standalone-compaction", ["--recover", "--authorize-live"], ["--authorize-live", "recover"]],
    ["delegated-material", ["--date-only", "--authorize-live"], ["--authorize-live", "--date-only"]],
    ["tool-roundtrip", ["--settle-original"], ["--settle-original"]],
  ]) {
    assert.throws(() => planCase([id, ...flags]), /original --directory/);
    const p = planCase([id, ...flags, "--directory", "retained"]);
    assert.equal(p.setup, "reopen");
    assert.deepEqual(p.args, [resolve("retained"), ...args]);
  }
});

test("blocked, unauthorized and invalid combinations fail before setup", () => {
  for (const args of [
    ["in-request-compaction", "--authorize-live"], ["stored-continuation", "--authorize-live"],
    ["background-observation", "--authorize-stored-live"], ["tool-roundtrip"],
    ["tool-roundtrip", "--authorize-live", "--settle-original"], ["delegated-material", "--recover"],
    ["tool-roundtrip", "--authorize-live", "--authorize-live"], ["other", "--authorize-live"],
  ]) assert.throws(() => planCase(args, target));
  assert.throws(() => planCase(["tool-roundtrip", "--authorize-live"]), /dedicated test credential/);
});

test("setup precedes the body, setup failure stops it, and an interrupted body is not retried", () => {
  const p = planCase(["standalone-compaction", "--authorize-live"], target), calls = [];
  assert.equal(runPreparedCase(p, () => 2, () => assert.fail("unexpected dispatch")), 2);
  assert.equal(runPreparedCase(p, (...args) => { calls.push(args); return 0; }, plan => { calls.push(plan.args); return 73; }), 73);
  assert.deepEqual(calls, [["prepare-live", p.caseId, p.directory], [p.directory, "--authorize-live", "seed"]]);
});
