import {describe, expect, it} from "vitest";
import type {PreparedDecisionSources} from "./DecisionActivityExecution.js";
import type {RunCommit} from "./RunCommitPort.js";
import {retainControllerOperation} from "./RunDecisionCheckpoint.js";
import {snapshotRunCommit} from "./RunCommitSnapshot.js";

describe("retained task-decision source ownership", () => {
  it("owns the original source once without retaining executable validation", () => {
    const context = {blocks: [{text: "original"}]};
    const prepared = {input: {agent: {id: "agent", revision: "1", output: {parse() {}}}, context}, context,
      manifest: {id: "manifest"}, deadlineAt: "2026-10-30T00:00:00Z"} as unknown as PreparedDecisionSources<unknown>;
    const retained = retainControllerOperation(prepared);
    context.blocks[0]!.text = "changed";
    expect(retained.input.agent).not.toHaveProperty("output");
    expect(retained.context).toEqual({blocks: [{text: "original"}]});
    expect(retained.input.context).toBe(retained.context);
    expect(Object.isFrozen(retained.context.blocks[0])).toBe(true);
    expect(() => {(retained.context.blocks[0] as unknown as {text: string}).text = "changed";}).toThrow();
  });

  it("shares the entire original prepared source through changing invocation and decision commits", () => {
    const history = Array.from({length: 2000}, (_, sequence) => ({sequence, content: {text: "original"}}));
    const prepared = retainControllerOperation({input: {agent: {id: "agent", revision: "1", output: {parse() {}}}, history},
      manifest: {id: "original"}} as unknown as PreparedDecisionSources<unknown>);
    const make = (revision: number, status: string) => snapshotRunCommit({state: {revision}, control: {
      controllerInvocation: {status, prepared}, decision: {status, prepared, calls: []},
    }} as unknown as RunCommit);
    const before = make(1, "pending"), after = make(2, "returned");
    expect(before.control.controllerInvocation!.prepared).toBe(prepared);
    expect(after.control.controllerInvocation!.prepared).toBe(prepared);
    expect(after.control.decision!.prepared).toBe(prepared);
    expect(after.control.controllerInvocation).not.toBe(before.control.controllerInvocation);
    expect(before.control.controllerInvocation!.status).toBe("pending");
    expect(after.control.controllerInvocation!.status).toBe("returned");
  });
});
