import { describe, expect, it, vi } from "vitest";
import { ActivityCheckpointError, type ActivityCheckpointPort } from "@agent-anything/agent-runtime/activity";
import { type TaskDecisionActivity, type AgentActivityExecutionContext, type TaskDecisionProposal, type TaskDecisionInputSources } from "@agent-anything/agent-runtime/decision";
import { HELARC_NATIVE_TOOL_PROTOCOL_REVISION } from "./HelarcController.js";
import { HelarcProtocolRecoveryController } from "./HelarcProtocolRecoveryController.js";
import { HELARC_PROTOCOL_RECOVERY_POLICY } from "./HelarcControllerProtocolComposition.js";
import type { ExecutionFlowObservation } from "@agent-anything/observability/execution-flow";

const key = HELARC_PROTOCOL_RECOVERY_POLICY.id;
function input(iteration: number, runId = "root"): TaskDecisionInputSources<string> {
  return {runId, iteration, toolExposure: {controllerRequestId: `${runId}:request:${iteration}`}} as TaskDecisionInputSources<string>;
}
function decision(i: TaskDecisionInputSources<string>, kind: "missing" | "advance" | "final" | "other" = "missing"): TaskDecisionProposal<string> {
  const modelItems = [{id: `item:${i.iteration}`, metadata: {}, kind: "model_turn_finish" as const,
    turnId: `${i.runId}:turn:${i.iteration}`, finish: {kind: "normal" as const}}];
  if (kind === "final") return {kind: "propose_completion", completionSource: {kind: "controller"}, candidates: [], output: "Done", modelItems};
  if (kind === "advance") return {kind: "advance", candidates: [{kind: "tool_request"}] as never, modelItems};
  return {kind: "continue_with_feedback", modelItems, feedback: {
    source: {owner: kind === "other" ? "another-owner" : "helarc", kind: "controller_protocol",
      id: HELARC_NATIVE_TOOL_PROTOCOL_REVISION, revision: "4"},
    code: "helarc_ending_signal_missing", message: `Different text ${i.iteration}`,
  }};
}
function fixture() {
  const saved = new Map<string, unknown>();
  const port: ActivityCheckpointPort = {
    read: key => structuredClone(saved.get(key) ?? null),
    commit: vi.fn(async (key, value) => {saved.set(key, structuredClone(value));}),
  };
  const context = {runCheckpoints: port, cancellation: {signal: new AbortController().signal}} as AgentActivityExecutionContext;
  const next = vi.fn(async (i: TaskDecisionInputSources<string>) => decision(i));
  const inner = {next, recover: next, resourceMetering: {
    modelInputTokens: "unavailable", modelOutputTokens: "unavailable", costUnits: "unavailable",
  }} satisfies TaskDecisionActivity<string>;
  return {saved, port, context, next, inner, controller: new HelarcProtocolRecoveryController(inner)};
}

describe("Helarc protocol recovery", () => {
  it("fails on the third missing signal, without another call on recovered exhaustion", async () => {
    const f = fixture();
    for (let n = 1; n < 3; n++) expect((await f.controller.next(input(n), f.context)).kind).toBe("continue_with_feedback");
    await expect(f.controller.next(input(3), f.context)).rejects.toMatchObject({
      operationSettlement: "settled_failure", failure: {kind: "model", failure: {code: "model_protocol_recovery_exhausted",
        metadata: {consecutiveMissing: 3, maximumConsecutiveMissing: 3, requestId: "root:request:3"}}},
    });
    const fresh = new HelarcProtocolRecoveryController(f.inner);
    await expect(fresh.recover(input(3), f.context)).rejects.toMatchObject({failure: {failure: {code: "model_protocol_recovery_exhausted"}}});
    await expect(fresh.next(input(4), f.context)).rejects.toThrow();
    expect(f.next).toHaveBeenCalledTimes(3);
  });

  it.each(["advance", "final"] as const)("resets only after an admitted %s decision", async kind => {
    const f = fixture();
    await f.controller.next(input(1), f.context);
    await f.controller.next(input(2), f.context);
    f.next.mockImplementationOnce(async i => decision(i, kind));
    expect((await f.controller.next(input(3), f.context)).kind).toBe(kind === "final" ? "propose_completion" : "advance");
    await f.controller.next(input(4), f.context);
    expect(f.saved.get(key)).toMatchObject({consecutiveMissing: 1});
  });

  it("does not spend or reset the allowance for unrelated feedback or Provider failures", async () => {
    const f = fixture();
    await f.controller.next(input(1), f.context);
    f.next.mockImplementationOnce(async i => decision(i, "other"));
    await f.controller.next(input(2), f.context);
    f.next.mockRejectedValueOnce(new Error("Provider failure"));
    await expect(f.controller.next(input(3), f.context)).rejects.toThrow("Provider failure");
    expect(f.saved.get(key)).toMatchObject({consecutiveMissing: 1});
    await f.controller.next(input(4), f.context);
    await expect(f.controller.next(input(5), f.context)).rejects.toMatchObject({failure: {failure: {code: "model_protocol_recovery_exhausted"}}});
  });

  it("replays retained correction once after recreation, without charging it twice", async () => {
    const f = fixture();
    await f.controller.next(input(1), f.context);
    await f.controller.next(input(2), f.context);
    const fresh = new HelarcProtocolRecoveryController(f.inner);
    await fresh.recover(input(2), f.context);
    expect(f.port.commit).toHaveBeenCalledTimes(2);
    expect(f.saved.get(key)).toMatchObject({consecutiveMissing: 2});
    f.next.mockImplementationOnce(async i => decision(i, "final"));
    expect((await fresh.next(input(3), f.context)).kind).toBe("propose_completion");
  });

  it("retains a committed correction after lost ACK without exposing unconfirmed state", async () => {
    const f = fixture();
    const commit = f.port.commit;
    f.port.commit = vi.fn(async (key, value) => {await commit(key, value); throw new Error("lost ACK");});
    await expect(f.controller.next(input(1), f.context)).rejects.toBeInstanceOf(ActivityCheckpointError);
    f.port.commit = commit;
    await new HelarcProtocolRecoveryController(f.inner).recover(input(1), f.context);
    expect(f.saved.get(key)).toMatchObject({consecutiveMissing: 1});
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("does not retain uncommitted counts and keeps in-memory Runs independent", async () => {
    const f = fixture();
    f.port.commit = async () => {throw new Error("not committed");};
    await expect(f.controller.next(input(1), f.context)).rejects.toBeInstanceOf(ActivityCheckpointError);
    expect(f.saved.size).toBe(0);
    const context = {...f.context, runCheckpoints: undefined};
    await f.controller.next(input(1), context);
    await f.controller.next(input(2), context);
    await f.controller.next(input(1, "child"), context);
    await expect(f.controller.next(input(3), context)).rejects.toMatchObject({failure: {failure: {code: "model_protocol_recovery_exhausted"}}});
    await f.controller.next(input(2, "child"), context);
  });

  it.each([
    {version: 2}, {runId: "another"}, {maximumConsecutiveMissing: 100}, {consecutiveMissing: -1}, {consecutiveMissing: 2},
    {policyRevision: "changed"}, {disposition: "reset"}, {iteration: 10}, {requestId: "another"},
  ])("rejects malformed or mismatched recovery state before calling the model: %j", async change => {
    const f = fixture();
    await f.controller.next(input(1), f.context);
    f.saved.set(key, {...f.saved.get(key) as object, ...change});
    await expect(new HelarcProtocolRecoveryController(f.inner).recover(input(1), f.context)).rejects.toBeInstanceOf(ActivityCheckpointError);
    expect(f.next).toHaveBeenCalledTimes(1);
  });

  it("rejects changed response identity on replay", async () => {
    const f = fixture();
    await f.controller.next(input(1), f.context);
    f.next.mockImplementationOnce(async i => ({...decision(i), modelItems: [{id: "changed", kind: "model_turn_finish",
      turnId: "another-turn", finish: {kind: "normal"}, metadata: {}}]}));
    await expect(new HelarcProtocolRecoveryController(f.inner).recover(input(1), f.context)).rejects.toBeInstanceOf(ActivityCheckpointError);
  });

  it("records actual correction counts and exhaustion for Inspector", async () => {
    const f = fixture(), observations: ExecutionFlowObservation[] = [];
    const context = {...f.context, executionFlow: {observer: {observe: (value: ExecutionFlowObservation) => {observations.push(value);}}}};
    for (let n = 1; n < 3; n++) await f.controller.next(input(n), context);
    await expect(f.controller.next(input(3), context)).rejects.toThrow();
    expect(observations.filter(value => value.kind === "constraint").slice(-2)).toMatchObject([
      {disposition: "passed", basis: {consecutiveMissing: 2, maximumConsecutiveMissing: 3, replayed: false}},
      {disposition: "not_satisfied", basis: {consecutiveMissing: 3, maximumConsecutiveMissing: 3, requestId: "root:request:3"}},
    ]);
    expect(observations.filter(value => value.kind === "invocation_exited").at(-1)).toMatchObject({disposition: "failed"});
  });
});
