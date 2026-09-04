import { describe, expect, it } from "vitest";
import { runRunLifecycleHookDeterministicEvaluation } from "./RunLifecycleHookEvaluation.js";

describe("Run lifecycle Hook deterministic evaluation", () => {
  it("preserves bounded deterministic merge semantics", () => {
    expect(runRunLifecycleHookDeterministicEvaluation()).toMatchObject({
      matchingHookLimit: 32,
      blockingPrecedence: true,
      deterministicRegistrationOrder: true,
      nonBlockingErrorPreserved: true,
      maximumMergedFeedbackCharacters: 8_192,
    });
  });
});
