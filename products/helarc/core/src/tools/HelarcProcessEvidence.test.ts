import {describe, it, expect} from "vitest";
import type {OperationResult} from "@agent-anything/operation-catalog/result";
import {helarcProcessEvidence, HELARC_PROCESS_EFFECT_SCHEMA} from "./HelarcProcessEvidence.js";
import {HELARC_SHELL_BINDING, HELARC_TASK_STOP_BINDING} from "./HelarcCommandIdentity.js";

describe("managed process compensation support", () => {
  const facts = {task_id: "process-1", run_id: "run-1", phase: "running", outcome: null,
    containment: {disposition: "active", confirmedAt: null}, limitations: [], next_cursor: "cursor-1",
    execution_descriptor: {command: "arbitrary command", shell: "Bash", cwd: "/work"}};
  function result(output: unknown, stop = false): OperationResult {
    const binding = stop ? HELARC_TASK_STOP_BINDING : HELARC_SHELL_BINDING;
    return {ref: {id: "result-1", invocation: {id: "invocation-1", operation: binding.operation}}, binding,
      semanticOwner: "helarc", startedAt: "2026-10-16T00:00:00.000Z", finishedAt: "2026-10-16T00:00:01.000Z",
      status: "failed", failure: {owner: "command", code: "observe_failed", message: "Observation failed", retryable: false, metadata: {}},
      output, lowerRefs: [], metadata: {}};
  }
  it("retains exact process and log locators without inventing command effects", () => {
    const evidence = helarcProcessEvidence(result(facts));
    expect(HELARC_PROCESS_EFFECT_SCHEMA.validate(evidence.effects[0]!.value)).toBe(true);
    expect(evidence.effects[0]!.value).toMatchObject({execution_descriptor: facts.execution_descriptor});
    expect(evidence.effects[0]!.coverage.extent).toBe("partial");
    expect(evidence.support[0]!.callables).toHaveLength(2);
    expect(evidence.support[0]!.materials).toEqual([]);
  });
  it("preserves a started process when Composite observation fails", () => {
    const evidence = helarcProcessEvidence(result({task_id: "process-1", run_id: "run-1", observation: null,
      snapshot: {ref: {runId: "run-1", executionId: "process-1"}, ...facts}, execution_descriptor: facts.execution_descriptor}));
    expect(evidence.effects).toHaveLength(1);
    expect(evidence.support[0]!.guidance.join(" ")).toContain("does not transfer process control");
  });
  it("retains already-empty stopping evidence without advertising a general undo", () => {
    const evidence = helarcProcessEvidence(result({task_id: "process-1", effect_certainty: "known_not_applied",
      snapshot: {ref: {runId: "run-1", executionId: "process-1"}, phase: "settled", containment: {disposition: "empty"}, limitations: []}}, true));
    expect(evidence.effects[0]!.value).toMatchObject({stop_effect_certainty: "known_not_applied"});
    expect(evidence.support[0]!.callables).toHaveLength(1);
    expect(helarcProcessEvidence(result(null))).toEqual({effects: [], support: []});
  });
});
