import { describe, expect, it } from "vitest";
import * as api from "./index.js";

describe("Context Continuity Evaluation public API", () => {
  it("exports only the focused Test Support operations", () => {
    expect(Object.keys(api).sort()).toEqual([
      "CONTEXT_CONTINUITY_EVALUATION_REVISION",
      "classifyContextContinuityFailure",
      "createContextContinuityEvaluationFixtures",
      "observeContextContinuityFixtures",
      "runContextContinuityEvaluationCandidate",
    ]);
  });
});
