import { describe, expect, it } from "vitest";
import type { RunLimits } from "./RunConfig.js";
import { evaluateRunLoopLimits } from "./RunLoopLimits.js";

const limits: RunLimits = {
  maxIterations: 3,
  maxActions: 5,
  maxConsecutiveActionFailures: 1,
  maxDurationMs: 1_000,
  maxPendingInteractions: 2,
  maxDescendantRuns: 2,
  maxDescendantDepth: 1,
  plan: {
    maxSteps: 5,
    maxStepLength: 100,
    maxExplanationLength: 200,
  },
};

describe("RunLoopLimits", () => {
  it("reports duration, iteration, and consecutive failure violations", () => {
    expect(evaluateRunLoopLimits({
      counters: {
        controllerTurns: 0,
        runActions: 0,
        observations: 0,
        consecutiveActionFailures: 0,
      },
      limits,
      deadlineAt: "2026-07-13T00:00:01.000Z",
      now: "2026-07-13T00:00:01.000Z",
      cancellationRequested: false,
    })).toEqual({
      code: "runtime_deadline_exceeded",
      message: "Run deadline elapsed.",
      metadata: { deadlineAt: "2026-07-13T00:00:01.000Z" },
    });

    expect(evaluateRunLoopLimits({
      counters: {
        controllerTurns: 3,
        runActions: 0,
        observations: 0,
        consecutiveActionFailures: 0,
      },
      limits,
      deadlineAt: "2026-07-13T00:01:00.000Z",
      now: "2026-07-13T00:00:00.500Z",
      cancellationRequested: false,
    })).toEqual({
      code: "runtime_limit_exceeded",
      message: "Run exceeded maxIterations.",
      metadata: { maxIterations: 3 },
    });

    expect(evaluateRunLoopLimits({
      counters: {
        controllerTurns: 1,
        runActions: 2,
        observations: 2,
        consecutiveActionFailures: 2,
      },
      limits,
      deadlineAt: "2026-07-13T00:01:00.000Z",
      now: "2026-07-13T00:00:00.500Z",
      cancellationRequested: false,
    })).toEqual({
      code: "runtime_limit_exceeded",
      message: "Run exceeded maxConsecutiveActionFailures.",
      metadata: { maxConsecutiveActionFailures: 1 },
    });
  });

  it("leaves cancellation to the lifecycle owner", () => {
    expect(evaluateRunLoopLimits({
      counters: {
        controllerTurns: 99,
        runActions: 99,
        observations: 99,
        consecutiveActionFailures: 99,
      },
      limits,
      deadlineAt: "2026-07-13T00:00:01.000Z",
      now: "2026-07-13T00:10:00.000Z",
      cancellationRequested: true,
    })).toBeNull();
  });
});
