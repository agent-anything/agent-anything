import { describe, expect, it } from "vitest";
import type { RegisteredOperation } from "@agent-anything/operation-catalog/catalog";
import { createOperationResult, type OperationResult } from "@agent-anything/operation-catalog/result";
import { commandResultContract } from "./HelarcCommandResultContract.js";
import { HELARC_SHELL_OPERATION, HELARC_INITIAL_OBSERVATION_OPERATION, HELARC_TASK_OUTPUT_OPERATION } from "./HelarcCommandIdentity.js";

const time = "2026-10-13T00:00:00.000Z";
function validate(operation: typeof HELARC_SHELL_OPERATION, output: unknown, status: OperationResult["status"] = "succeeded") {
  const contract = commandResultContract({operation: {ref: operation, resultSchemaRevision: operation.revision}} as RegisteredOperation);
  return contract.validateOutput(createOperationResult({ref: {id: "result-1", invocation: {id: "invocation-1", operation}},
    binding: {operation, revision: "1"}, semanticOwner: "helarc", startedAt: time, finishedAt: time, lowerRefs: [], metadata: {},
    status, output, failure: status === "succeeded" ? null : {owner: "command", code: "nonzero", message: "Nonzero exit", retryable: false, metadata: {}},
  } as OperationResult));
}
const stream = {text: "", encoding: null, encoding_source: "none", integrity: "unavailable", replacement_count: 0,
  byte_start: 0, byte_end: 0, received_bytes: 3, omitted_bytes: 0, projection_pending: true, segments: []};
const observation = {task_id: "process-1", run_id: "run-1", observation_id: "observation-1", invocation_id: "invocation-1",
  snapshot_revision: 2, action_id: "action-1", phase: "running", outcome: null,
  requested_wait_ms: 1000, effective_wait_ms: 1000, elapsed_wait_ms: 123.456, return_reason: "output_available",
  stdout: stream, stderr: stream, next_cursor: "cursor-1", has_more: false, containment: {}, output: {}, limitations: []};

describe("Command result contracts", () => {
  it("admits real fractional observation duration and unavailable text without implying command failure", () => {
    expect(validate(HELARC_TASK_OUTPUT_OPERATION, observation)).toBe(true);
    expect(validate(HELARC_INITIAL_OBSERVATION_OPERATION, {observation, commandFailure: null})).toBe(true);
    expect(validate(HELARC_SHELL_OPERATION, observation)).toBe(true);
  });
  it("retains command failure diagnostics and distinguishes a lost observation from a fabricated snapshot", () => {
    expect(validate(HELARC_SHELL_OPERATION, observation, "failed")).toBe(true);
    const receipt = {task_id: "process-1", run_id: "run-1", observation: null, outcome: null, limitations: ["initial_observation_unavailable"]};
    expect(validate(HELARC_SHELL_OPERATION, receipt, "failed")).toBe(true);
    expect(validate(HELARC_SHELL_OPERATION, receipt)).toBe(false);
    expect(validate(HELARC_TASK_OUTPUT_OPERATION, {task_id: "process-1"})).toBe(false);
  });
  it("rejects inconsistent byte ranges and missing public handles", () => {
    expect(validate(HELARC_TASK_OUTPUT_OPERATION, {...observation, task_id: null})).toBe(false);
    expect(validate(HELARC_TASK_OUTPUT_OPERATION, {...observation, stdout: {...stream, byte_start: 4, byte_end: 2}})).toBe(false);
  });
});
