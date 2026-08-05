import { describe, expect, it } from "vitest";
import type { Plan, PlanLimits } from "./Plan.js";
import {
  abandonPlan,
  applyPlanUpdate,
  assertValidPlanLimits,
  projectPlan,
} from "./PlanTransition.js";

describe("Plan transitions", () => {
  it("creates and normalizes one active Plan", () => {
    const result = applyPlanUpdate({
      currentPlan: null,
      newPlanId: "plan-1",
      candidate: {
        explanation: "  Establish the execution path.  ",
        plan: [
          { step: "  Inspect current state  ", status: "completed" },
          { step: "Implement the transition", status: "in_progress" },
        ],
      },
      limits: createLimits(),
      now: "2026-07-13T00:00:00.000Z",
    });

    expect(result.status).toBe("applied");
    if (result.status !== "applied") {
      return;
    }
    expect(result.plan).toEqual({
      id: "plan-1",
      version: 1,
      status: "active",
      steps: [
        { step: "Inspect current state", status: "completed" },
        { step: "Implement the transition", status: "in_progress" },
      ],
      createdAt: "2026-07-13T00:00:00.000Z",
      updatedAt: "2026-07-13T00:00:00.000Z",
    });
    expect(result.observation.transition).toBe("created");
    expect(result.lifecycle).toEqual([{
      kind: "created",
      plan: projectPlan(result.plan),
      explanation: "Establish the execution path.",
    }]);
    expect(Object.isFrozen(result.plan)).toBe(true);
    expect(Object.isFrozen(result.plan.steps)).toBe(true);
  });

  it.each([
    [null, "Plan update must be an object."],
    [{ plan: [] }, "Plan must contain at least one step."],
    [{ plan: [{ step: "", status: "pending" }] }, "Plan step text must not be empty."],
    [{ plan: [{ step: "One", status: "unknown" }] }, "Plan step status is not supported."],
    [{ plan: [
      { step: "One", status: "in_progress" },
      { step: "Two", status: "in_progress" },
    ] }, "At most one Plan step may be in progress."],
  ])("rejects invalid model input without creating Plan state", (candidate, message) => {
    const result = applyPlanUpdate({
      currentPlan: null,
      newPlanId: "plan-1",
      candidate,
      limits: createLimits(),
      now: "2026-07-13T00:00:00.000Z",
    });

    expect(result).toMatchObject({
      status: "rejected",
      plan: null,
      observation: { status: "rejected", code: "plan_invalid", message },
      lifecycle: [],
    });
  });

  it("distinguishes Plan limits from invalid structure", () => {
    const result = applyPlanUpdate({
      currentPlan: null,
      newPlanId: "plan-1",
      candidate: {
        explanation: "123456",
        plan: [{ step: "One", status: "pending" }],
      },
      limits: { ...createLimits(), maxExplanationLength: 5 },
      now: "2026-07-13T00:00:00.000Z",
    });

    expect(result).toMatchObject({
      status: "rejected",
      observation: { status: "rejected", code: "plan_limit_exceeded" },
    });
  });

  it("returns no_change for the same normalized Plan and preserves version and timestamps", () => {
    const currentPlan = createActivePlan();
    const result = applyPlanUpdate({
      currentPlan,
      candidate: {
        explanation: "A different explanation is not Plan state.",
        plan: [{ step: "  Inspect current state  ", status: "in_progress" }],
      },
      limits: createLimits(),
      now: "2026-07-13T00:02:00.000Z",
    });

    expect(result).toEqual({
      status: "no_change",
      plan: currentPlan,
      observation: {
        status: "no_change",
        planId: "plan-1",
        version: 1,
      },
      lifecycle: [],
    });
    expect(result.plan).toBe(currentPlan);
  });

  it("keeps identity, increments version, and records completion in order", () => {
    const currentPlan = createActivePlan();
    const result = applyPlanUpdate({
      currentPlan,
      candidate: {
        explanation: "Inspection finished.",
        plan: [{ step: "Inspect current state", status: "completed" }],
      },
      limits: createLimits(),
      now: "2026-07-13T00:02:00.000Z",
    });

    expect(result.status).toBe("applied");
    if (result.status !== "applied") {
      return;
    }
    expect(result.plan).toMatchObject({ id: "plan-1", version: 2, status: "completed" });
    expect(result.observation.transition).toBe("completed");
    expect(result.lifecycle.map((change) => change.kind)).toEqual(["updated", "completed"]);
    expect(result.lifecycle[0]).toMatchObject({
      kind: "updated",
      previousVersion: 1,
      transition: "updated",
    });
  });

  it("reactivates the same completed Plan when new work is discovered", () => {
    const completed = applyPlanUpdate({
      currentPlan: createActivePlan(),
      candidate: { plan: [{ step: "Inspect current state", status: "completed" }] },
      limits: createLimits(),
      now: "2026-07-13T00:02:00.000Z",
    });
    if (completed.status !== "applied") {
      throw new Error("Expected Plan completion.");
    }

    const reactivated = applyPlanUpdate({
      currentPlan: completed.plan,
      candidate: {
        plan: [
          { step: "Inspect current state", status: "completed" },
          { step: "Handle new work", status: "in_progress" },
        ],
      },
      limits: createLimits(),
      now: "2026-07-13T00:03:00.000Z",
    });

    expect(reactivated.status).toBe("applied");
    if (reactivated.status !== "applied") {
      return;
    }
    expect(reactivated.plan).toMatchObject({ id: "plan-1", version: 3, status: "active" });
    expect(reactivated.observation.transition).toBe("reactivated");
    expect(reactivated.lifecycle).toHaveLength(1);
    expect(reactivated.lifecycle[0]).toMatchObject({
      kind: "updated",
      transition: "reactivated",
    });
  });

  it("records both creation and completion when the first Plan is already complete", () => {
    const result = applyPlanUpdate({
      currentPlan: null,
      newPlanId: "plan-1",
      candidate: { plan: [{ step: "Answer directly", status: "completed" }] },
      limits: createLimits(),
      now: "2026-07-13T00:00:00.000Z",
    });

    expect(result.status).toBe("applied");
    if (result.status !== "applied") {
      return;
    }
    expect(result.plan.status).toBe("completed");
    expect(result.observation.transition).toBe("created");
    expect(result.lifecycle.map((change) => change.kind)).toEqual(["created", "completed"]);
  });

  it("abandons only an active Plan and preserves a completed Plan", () => {
    const active = createActivePlan();
    const abandoned = abandonPlan({
      plan: active,
      terminalStatus: "failed",
      reasonCode: "runtime_limit_exceeded",
      now: "2026-07-13T00:04:00.000Z",
    });

    expect(abandoned.status).toBe("abandoned");
    expect(abandoned.plan).toMatchObject({ id: "plan-1", version: 2, status: "abandoned" });
    expect(abandoned.lifecycle[0]).toMatchObject({
      kind: "abandoned",
      terminalStatus: "failed",
      reasonCode: "runtime_limit_exceeded",
    });

    const completed = applyPlanUpdate({
      currentPlan: active,
      candidate: { plan: [{ step: "Inspect current state", status: "completed" }] },
      limits: createLimits(),
      now: "2026-07-13T00:02:00.000Z",
    });
    if (completed.status !== "applied") {
      throw new Error("Expected Plan completion.");
    }
    const unchanged = abandonPlan({
      plan: completed.plan,
      terminalStatus: "succeeded",
      reasonCode: null,
      now: "2026-07-13T00:04:00.000Z",
    });

    expect(unchanged).toEqual({
      status: "no_change",
      plan: completed.plan,
      lifecycle: [],
    });
  });

  it("rejects updates to an abandoned Plan", () => {
    const abandoned = abandonPlan({
      plan: createActivePlan(),
      terminalStatus: "blocked",
      reasonCode: "runtime_no_safe_path",
      now: "2026-07-13T00:04:00.000Z",
    });
    const result = applyPlanUpdate({
      currentPlan: abandoned.plan,
      candidate: { plan: [{ step: "Try again", status: "in_progress" }] },
      limits: createLimits(),
      now: "2026-07-13T00:05:00.000Z",
    });

    expect(result).toMatchObject({
      status: "rejected",
      observation: { code: "plan_invalid" },
      lifecycle: [],
    });
  });

  it("treats invalid trusted limits as configuration errors", () => {
    expect(() => assertValidPlanLimits({
      maxSteps: 0,
      maxStepLength: 100,
      maxExplanationLength: 100,
    })).toThrow("PlanLimits.maxSteps must be a positive integer");
  });
});

function createActivePlan(): Plan {
  const result = applyPlanUpdate({
    currentPlan: null,
    newPlanId: "plan-1",
    candidate: { plan: [{ step: "Inspect current state", status: "in_progress" }] },
    limits: createLimits(),
    now: "2026-07-13T00:01:00.000Z",
  });
  if (result.status !== "applied") {
    throw new Error("Expected Plan creation.");
  }
  return result.plan;
}

function createLimits(): PlanLimits {
  return {
    maxSteps: 10,
    maxStepLength: 200,
    maxExplanationLength: 500,
  };
}
