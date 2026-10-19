import { describe, expect, it } from "vitest";
import type { CompositeNodeSettlement, CompositeResult } from "@agent-anything/operation-composition/result";
import { createHelarcShellComposite } from "./HelarcShellComposite.js";
import { HELARC_SHELL_COMPOSITE, HELARC_PROCESS_START_OPERATION, HELARC_INITIAL_OBSERVATION_OPERATION } from "./HelarcCommandIdentity.js";

const failure = { owner: "helarc-command", code: "process_observation_failed", message: "Observation failed", retryable: false, metadata: {} };
function child(nodeId: "start" | "observe", status: "succeeded" | "failed", output: unknown): CompositeNodeSettlement {
  const operation = nodeId === "start" ? HELARC_PROCESS_START_OPERATION : HELARC_INITIAL_OBSERVATION_OPERATION;
  const base = { ref: { id: `${nodeId}:result`, invocation: { id: nodeId, operation } }, binding: {operation, revision: "1"},
    semanticOwner: "helarc", startedAt: "2026-10-13T00:00:00.000Z", finishedAt: "2026-10-13T00:00:00.000Z", lowerRefs: [], metadata: {} };
  const result = status === "succeeded" ? {...base, status, output, failure: null} : {...base, status, output, failure};
  return {nodeId, instance: 1, runAction: null, status, result, failure: result.failure};
}
function reduce(children: readonly CompositeNodeSettlement[], aggregateStatus: CompositeResult["status"] = "succeeded") {
  return createHelarcShellComposite(10_000).resolve(HELARC_SHELL_COMPOSITE)!.execution.reducer.reduce({
    compositeInput: {}, children, aggregateStatus, aggregateFailure: aggregateStatus === "succeeded" ? null : failure,
  });
}

describe("Shell public result reduction", () => {
  it("returns nonzero exit diagnostics as failed output, not hidden metadata", () => {
    const observation = {task_id: "process", outcome: "failed", root_exit: {code: 1}, stderr: {text: "Error"}};
    expect(reduce([child("start", "succeeded", {task_id: "process", run_id: "run"}),
      child("observe", "succeeded", {observation, commandFailure: {code: "shell_exit_nonzero", message: "Exit 1"}})]))
      .toEqual({status: "failed", output: observation, failure: {code: "shell_exit_nonzero", message: "Exit 1", retryable: false, metadata: {}}});
  });
  it("preserves a started process handle when observation fails, without pretending it was observed", () => {
    expect(reduce([child("start", "succeeded", {task_id: "process", run_id: "run"}), child("observe", "failed", null)], "failed"))
      .toMatchObject({status: "failed", output: {task_id: "process", run_id: "run", observation: null, outcome: null}, failure});
  });
  it("does not fabricate a process handle for rejected startup or erase cancellation/uncertainty", () => {
    expect(reduce([child("start", "failed", null)], "failed")).toMatchObject({status: "failed", output: null});
    for (const aggregateStatus of ["cancelled", "unknown_effect"] as const) {
      expect(reduce([child("start", "succeeded", {task_id: "process", run_id: "run"})], aggregateStatus))
        .toMatchObject({status: aggregateStatus, output: {task_id: "process"}});
    }
  });
});
