import { describe, expect, it } from "vitest";
import type { RunLimits } from "./RunConfig.js";
import { evaluateRunDeadline, evaluateRunNumericLimits } from "./RunLoopLimits.js";

const limits: RunLimits = {
  maxIterations: 3,
  maxActions: 5,
  maxConsecutiveActionFailures: 1,
  maxDurationMs: 1_000,
  maxPendingInteractions: 2,
  plan: {
    maxSteps: 5,
    maxStepLength: 100,
    maxExplanationLength: 200,
  },
  stopReview: {
    maxRequiredFeedbackRounds: 2,
    maxAdvisoryFeedbackRounds: 1,
  },
};

describe("RunLoopLimits", () => {
  it("reports duration, iteration, and consecutive failure violations", () => {
    expect(evaluateRunDeadline({
      deadlineAt: "2026-07-13T00:00:01.000Z",
      now: "2026-07-13T00:00:01.000Z",
    })).toEqual({
      code: "runtime_deadline_exceeded",
      message: "Run deadline elapsed.",
      metadata: { deadlineAt: "2026-07-13T00:00:01.000Z" },
    });

    expect(evaluateRunNumericLimits({
      counters: {
        controllerTurns: 3,
        runActions: 0,
        observations: 0,
        consecutiveActionFailures: 0,
      },
      limits,
    })).toEqual({
      code: "runtime_limit_exceeded",
      message: "Run exceeded maxIterations.",
      metadata: { maxIterations: 3 },
    });

    expect(evaluateRunNumericLimits({
      counters: {
        controllerTurns: 1,
        runActions: 2,
        observations: 2,
        consecutiveActionFailures: 2,
      },
      limits,
    })).toEqual({
      code: "runtime_limit_exceeded",
      message: "Run exceeded maxConsecutiveActionFailures.",
      metadata: { maxConsecutiveActionFailures: 1 },
    });
  });

  it("keeps deadline and numeric envelopes independently selectable", () => {
    expect(evaluateRunDeadline({
      deadlineAt: "2026-07-13T00:01:00.000Z",
      now: "2026-07-13T00:00:00.500Z",
    })).toBeNull();
    expect(evaluateRunNumericLimits({
      counters: {
        controllerTurns: 0,
        runActions: 0,
        observations: 0,
        consecutiveActionFailures: 0,
      },
      limits,
    })).toBeNull();
  });
});
