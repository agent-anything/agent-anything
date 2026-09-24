import { describe, expect, it } from "vitest";
import type { AgentStopEvent } from "@agent-anything/agent-hooks/events";
import { HelarcPlanSynchronizationHook, createHelarcPlanSynchronizationHookComposition } from "./HelarcPlanSynchronizationHook.js";

describe("HelarcPlanSynchronizationHook", () => {
  it.each(["pending", "in_progress"] as const)("returns one direct feedback for %s without changing the Plan", (status) => {
    const hook = new HelarcPlanSynchronizationHook();
    const initial = event();
    const input = { ...initial, plan: { ...initial.plan!, steps: [{ step: "Inspect results", status }] } };
    const before = structuredClone(input);
    const feedback = hook.handle(input, context());
    expect(feedback).toMatchObject({ disposition: "continue", code: "plan_synchronization_requested" });
    if (feedback.disposition !== "continue") throw new Error("Expected feedback");
    expect(feedback.message).toContain("do not mark them completed");
    expect(hook.handle(input, context())).toEqual({ disposition: "allow" });
    expect(input).toEqual(before);
  });

  it("does not renew the allowance when a Plan is updated, removed or replaced", () => {
    const hook = new HelarcPlanSynchronizationHook();
    const input = event();
    expect(hook.handle(input, context()).disposition).toBe("continue");
    for (const plan of [null, { ...input.plan!, version: 2 }, { ...input.plan!, id: "new-plan", version: 1 }]) {
      expect(hook.handle({ ...input, plan }, context())).toEqual({ disposition: "allow" });
    }
  });

  it("isolates the allowance between root and sibling Runs", () => {
    const hook = new HelarcPlanSynchronizationHook();
    for (const runId of ["root", "child-1", "child-2"]) {
      const input = event(runId, runId === "root" ? "root" : "descendant");
      expect(hook.handle(input, context()).disposition).toBe("continue");
      expect(hook.handle(input, context()).disposition).toBe("allow");
    }
  });

  it("allows absent, completed, abandoned or fully recorded Plans without consuming the allowance", () => {
    const hook = new HelarcPlanSynchronizationHook();
    const input = event();
    for (const plan of [null, { ...input.plan!, status: "completed" as const },
      { ...input.plan!, status: "abandoned" as const },
      { ...input.plan!, steps: [{ step: "Inspect results", status: "completed" as const }] }]) {
      expect(hook.handle({ ...input, plan }, context())).toEqual({ disposition: "allow" });
    }
    expect(hook.handle(input, context()).disposition).toBe("continue");
  });

  it("does not add feedback or consume the allowance after cancellation", () => {
    const hook = new HelarcPlanSynchronizationHook();
    expect(hook.handle(event(), { signal: AbortSignal.abort(), interruption: null }).disposition).toBe("allow");
    expect(hook.handle(event(), context()).disposition).toBe("continue");
  });

  it("registers only for normal Stop and owns independent state for each composition", () => {
    const first = createHelarcPlanSynchronizationHookComposition();
    const second = createHelarcPlanSynchronizationHookComposition();
    expect(first.registrations).toMatchObject([{ point: "Stop", mode: "blocking", runKinds: ["root", "descendant"] }]);
    expect(first.bindings[0]!.handler).not.toBe(second.bindings[0]!.handler);
  });
});

function context() { return { signal: new AbortController().signal, interruption: null }; }

function event(runId = "run-1", runKind: AgentStopEvent["runKind"] = "root"): AgentStopEvent {
  const run = { id: runId };
  return {
    ref: { run, id: "stop-1", sequence: 1, revision: "1" },
    point: "Stop", run, runKind,
    agent: { id: "helarc", revision: "1" },
    task: { id: "task-1", kind: "test", input: {}, createdAt: "2026-09-24T00:00:00.000Z", metadata: {} },
    controllerRequestId: "request-1", iteration: 1,
    candidate: { ref: { id: "candidate-1", revision: "1" }, kind: "complete", output: { summary: "Finished for now." } },
    interaction: { id: "interaction-1", revision: "1", messages: [], unsettledCalls: [], settledCallCount: 0 },
    plan: { id: "plan-1", version: 1, status: "active", steps: [{ step: "Inspect results", status: "in_progress" }] },
    pending: [], emittedAt: "2026-09-24T00:00:00.000Z",
  };
}
