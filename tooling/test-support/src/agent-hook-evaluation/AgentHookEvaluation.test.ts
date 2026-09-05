import { describe, expect, it } from "vitest";
import { runAgentHookDeterministicEvaluation } from "./AgentHookEvaluation.js";

describe("Agent Hook deterministic evaluation", () => {
  it("preserves deterministic continuation and background non-authority", async () => {
    await expect(runAgentHookDeterministicEvaluation()).resolves.toMatchObject({
      matchingHookCount: 32,
      continuationPrecedence: true,
      deterministicRegistrationOrder: true,
      backgroundNonAuthority: true,
      backgroundFailureRecorded: true,
      maximumMergedFeedbackCharacters: 8_192,
    });
  });
});
