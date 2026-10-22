import {describe, expect, it, vi} from "vitest";
import type {ToolRegistrationSnapshot} from "@agent-anything/tools/registration";
import type {OperationResult} from "@agent-anything/operation-catalog/result";
import type {ToolResultPresenter} from "@agent-anything/agent-runtime/runner";
import {createHelarcToolResultPresenters} from "./HelarcToolResultPresenters.js";
import {HELARC_SHELL_OPERATION, HELARC_TASK_OUTPUT_OPERATION} from "./HelarcCommandIdentity.js";

function setup(operation = HELARC_SHELL_OPERATION) {
  const commitInitialDelivery = vi.fn();
  const tool = {tool: {namespace: "test", name: "renamed-command"}, revision: "7"};
  const registrations = [{descriptor: {ref: tool, binding: {kind: "operation", operation}}}] as unknown as ToolRegistrationSnapshot["registrations"];
  const presenter = createHelarcToolResultPresenters(registrations, {commitInitialDelivery})[0]!;
  return {presenter, commitInitialDelivery, tool};
}

describe("Helarc Tool result presentation", () => {
  it("selects by bound operation and removes duplicate segment text without losing ranges or diagnostics", () => {
    const {presenter, tool} = setup();
    const stream = {text: "error", segments: [{text: "error"}], byte_start: 0, byte_end: 5,
      encoding: "utf8", integrity: "lossy"};
    const output = {stdout: stream, stderr: stream, next_cursor: "cursor", has_more: true,
      observation_id: "observation", outcome: "failed"};
    const result = {output, status: "failed"} as unknown as OperationResult;
    expect(presenter.tool).toEqual(tool);
    expect(presenter.present(result)).toEqual({disposition: "bounded", output: {...output,
      stdout: {text: "error", byte_start: 0, byte_end: 5, encoding: "utf8", integrity: "lossy"},
      stderr: {text: "error", byte_start: 0, byte_end: 5, encoding: "utf8", integrity: "lossy"}}});
    expect(result.output).toBe(output);
    expect(stream.segments).toHaveLength(1);
  });

  it.each(["complete", "unavailable"])("commits only ranges in the actual %s initial presentation", disposition => {
    const {presenter, commitInitialDelivery} = setup();
    presenter.committed!({runId: "run", call: {parentRunAction: {id: "action"}}, result: {output: {task_id: "process"}},
      presentation: {modelCallRef: {id: "call"}, presentation: {disposition},
        content: {output: {observation_id: "observation", next_cursor: "cursor"}}}} as unknown as Parameters<NonNullable<ToolResultPresenter["committed"]>>[0]);
    expect(commitInitialDelivery).toHaveBeenCalledTimes(1);
    expect(commitInitialDelivery).toHaveBeenCalledWith({runId: "run", executionId: "process", runActionId: "action", settlementId: "call",
      observationId: disposition === "complete" ? "observation" : null,
      cursor: disposition === "complete" ? "cursor" : null});
  });

  it("does not let an explicit TaskOutput read acknowledge initial Shell delivery", () => {
    expect(setup(HELARC_TASK_OUTPUT_OPERATION).presenter.committed).toBeUndefined();
  });
});
