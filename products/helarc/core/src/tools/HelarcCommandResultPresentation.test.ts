import {describe, expect, it} from "vitest";
import type {OperationResult} from "@agent-anything/operation-catalog/result";
import {presentHelarcCommandResult} from "./HelarcCommandResultPresentation.js";

function result(output: unknown, options: {code?: string; certainty?: string; extent?: string} = {}): OperationResult {
  return {output, status: options.code ? "failed" : "succeeded",
    failure: options.code ? {owner: "command", code: options.code, message: options.code} : null,
    metadata: {compositeSettlement: {compositeId: "shell", status: options.code ? "failed" : "succeeded", childCount: 1,
      children: [{nodeId: "start", instance: 1, status: "invalid", resultId: "start-result",
        effectCertainty: options.certainty ?? null, completionExtent: options.extent ?? null, failure: null}]}},
  } as unknown as OperationResult;
}

describe("Command public result", () => {
  it("projects lifecycle and output without execution internals or duplicate segments", () => {
    const source = result({task_id: "task", phase: "running", outcome: "succeeded", root_exit: {code: 0},
      containment: {disposition: "active"}, next_cursor: "cursor", has_more: true,
      stdout: {text: "answer", segments: [{text: "answer"}], integrity: "lossy", omitted_bytes: 4, replacement_count: 1},
      stderr: {text: "", segments: []}, initial_cwd: "/a", final_cwd: "/b", cwd_disposition: "committed",
      execution_descriptor: {command: "example", cwd: "/a", environment_digest: "private", executable: {baseline: "private"}},
      helper_process_id: 123, invocation_id: "internal"});
    const before = structuredClone(source);
    const presented = presentHelarcCommandResult(source, true);
    expect(presented).toEqual({disposition: "bounded", output: {task_id: "task", execution: "started",
      phase: "running", outcome: "succeeded", root_exit: {code: 0}, containment: {disposition: "active"},
      has_more: true, stdout: {text: "answer", integrity: "lossy", omitted_bytes: 4, replacement_count: 1},
      stderr: {text: ""}, initial_cwd: "/a", final_cwd: "/b", cwd_disposition: "committed", command: "example", cwd: "/a"}});
    expect(source).toEqual(before);
  });
  it("explains approval expiry only when startup is confirmed effect-free", () => {
    const value = presentHelarcCommandResult(result(null, {code: "interaction_expired", certainty: "none", extent: "none"}), true);
    expect(value).toMatchObject({output: {execution: "not_started"}, failureMessage: expect.stringContaining("approval request expired")});
    expect(value.failureMessage).toContain("was not executed");
  });
  it.each([{}, {certainty: "unknown", extent: "unknown"}, {certainty: "partial", extent: "partial"},
    {certainty: "none", extent: "unknown"}])("does not infer non-execution from missing output: %j", facts => {
    expect(presentHelarcCommandResult(result(null, {code: "interaction_expired", ...facts}), true))
      .toEqual({output: {execution: "unknown"}, disposition: "complete"});
  });
  it("retains startup handle when initial observation failed", () => {
    const value = presentHelarcCommandResult(result({task_id: "task", observation: null, outcome: null,
      snapshot: {phase: "running", processId: 99, containment: {disposition: "active"}},
      limitations: ["initial_observation_unavailable"]}, {code: "observation_failed"}), true);
    expect(value).toMatchObject({output: {task_id: "task", execution: "started", observation: null,
      outcome: null, snapshot: {phase: "running", containment: {disposition: "active"}}}});
    expect(value.failureMessage).toContain("Use the returned task_id");
    expect(JSON.stringify(value)).not.toContain("processId");
  });
  it("keeps nonzero-exit diagnostics in their streams only", () => {
    const value = presentHelarcCommandResult(result({task_id: "task", root_exit: {code: 7},
      stdout: {text: "original diagnostic"}, stderr: {text: ""}}, {code: "command_exit_nonzero"}), true);
    expect(value.failureMessage).toContain("code 7");
    expect(JSON.stringify(value).split("original diagnostic")).toHaveLength(2);
  });
  it("preserves output references, observation conditions and explicit stop effects", () => {
    const observed = {task_id:"task",until:"change",after:"prior",output_materials:[{reference:{id:"stdout",revision:"v1"}}]};
    expect(presentHelarcCommandResult(result(observed), false).output).toEqual(observed);
    expect(presentHelarcCommandResult(result({task_id: "task", effect_certainty: "known_not_applied",
      snapshot: {phase: "settled", outcome: "failed", termination: {reason: "deadline"}}}), false).output)
      .toEqual({task_id: "task", effect_certainty: "known_not_applied", snapshot: {phase: "settled", outcome: "failed", termination: {reason: "deadline"}}});
  });
});
