import { describe, expect, it } from "vitest";
import type { RunLimits } from "./RunConfig.js";
import {
  evaluateRunDurationLimit,
  evaluateRunLoopLimits,
} from "./RunLoopLimits.js";

const limits: RunLimits = {
  maxIterations: 3,
  maxActions: 5,
  maxConsecutiveActionFailures: 1,
  maxDurationMs: 1_000,
  plan: {
    maxSteps: 5,
    maxStepLength: 100,
    maxExplanationLength: 200,
  },
};

describe("RunLoopLimits", () => {
  it("reports duration, iteration, and consecutive failure violations", () => {
    expect(evaluateRunDurationLimit({
      limits,
      startedAtMs: 0,
      nowMs: 1_001,
    })).toEqual({
      message: "Run exceeded maxDurationMs.",
      metadata: { maxDurationMs: 1_000, elapsedMs: 1_001 },
    });

    expect(evaluateRunLoopLimits({
      counters: {
        iterations: 3,
        actions: 0,
        consecutiveActionFailures: 0,
      },
      limits,
      startedAtMs: 0,
      nowMs: 500,
      cancellationRequested: false,
    })).toEqual({
      message: "Run exceeded maxIterations.",
      metadata: { maxIterations: 3 },
    });

    expect(evaluateRunLoopLimits({
      counters: {
        iterations: 1,
        actions: 2,
        consecutiveActionFailures: 2,
      },
      limits,
      startedAtMs: 0,
      nowMs: 500,
      cancellationRequested: false,
    })).toEqual({
      message: "Run exceeded maxConsecutiveActionFailures.",
      metadata: {
        maxConsecutiveActionFailures: 1,
        actualConsecutiveActionFailures: 2,
      },
    });
  });

  it("leaves cancellation to the lifecycle owner", () => {
    expect(evaluateRunLoopLimits({
      counters: {
        iterations: 99,
        actions: 99,
        consecutiveActionFailures: 99,
      },
      limits,
      startedAtMs: 0,
      nowMs: 10_000,
      cancellationRequested: true,
    })).toBeNull();
  });
});
