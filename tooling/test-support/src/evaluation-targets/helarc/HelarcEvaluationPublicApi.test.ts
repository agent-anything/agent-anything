import { describe, expect, it } from "vitest";
import * as api from "./index.js";

describe("Helarc Evaluation target public API", () => {
  it("exposes only the focused deterministic target surface", () => {
    expect(Object.keys(api).sort()).toEqual([
      "HELARC_EVALUATION_CORPUS_REVISION",
      "HELARC_EVALUATION_TARGET_ADAPTER_REVISION",
      "HELARC_EVALUATION_TIME",
      "HELARC_PHASE26_ACCEPTED_BASELINE",
      "HELARC_PHASE27_ACCEPTED_BASELINE",
      "HELARC_PHASE27_BASELINE_ACCEPTANCE",
      "adaptHelarcExternalBenchmarkManifest",
      "compareHelarcEvaluationBaseline",
      "createHelarcEvaluationCorpus",
      "createHelarcEvaluationTargetAdapter",
      "projectHelarcEvaluationBaselineSignature",
      "runHelarcEvaluationBaselineCandidate",
    ]);
  });
});
