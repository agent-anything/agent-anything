import { describe, expect, it } from "vitest";
import { runRunStopReviewDeterministicEvaluation } from "./RunStopReviewEvaluation.js";

describe("Run Stop Review deterministic evaluation", () => {
  it("keeps required and advisory bounds independent", () => {
    const report = runRunStopReviewDeterministicEvaluation();
    expect(report).toMatchObject({
      requiredFeedbackRounds: 2,
      advisoryFeedbackRounds: 1,
      requiredExhaustionCode: "runtime_stop_feedback_exhausted",
      advisoryExhaustionAllowsStop: true,
    });
    expect(Object.isFrozen(report)).toBe(true);
  });
});
