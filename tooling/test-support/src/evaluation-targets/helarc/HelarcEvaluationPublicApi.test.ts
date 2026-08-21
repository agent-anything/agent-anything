import { describe, expect, it } from "vitest";
import * as api from "./index.js";

describe("Helarc Evaluation target public API", () => {
  it("exposes the focused deterministic target and effectiveness definition surface", () => {
    expect(Object.keys(api).sort()).toEqual([
      "HELARC_CONTEXT_CONTINUITY_ACCEPTED_BASELINE",
      "HELARC_CONTEXT_CONTINUITY_BASELINE_ACCEPTANCE",
      "HELARC_EVALUATION_CORPUS_REVISION",
      "HELARC_EVALUATION_TARGET_ADAPTER_REVISION",
      "HELARC_EVALUATION_TIME",
      "HELARC_FILE_TOOLS_ACCEPTED_BASELINE",
      "HELARC_FILE_TOOLS_BASELINE_ACCEPTANCE",
      "HELARC_PHASE26_ACCEPTED_BASELINE",
      "HELARC_PHASE27_ACCEPTED_BASELINE",
      "HELARC_PHASE27_BASELINE_ACCEPTANCE",
      "HELARC_PRODUCT_EFFECTIVENESS_PROTOCOL",
      "HELARC_PRODUCT_EFFECTIVENESS_TARGET_INPUTS",
      "HELARC_VALIDATION_GATE_ACCEPTED_BASELINE",
      "HELARC_VALIDATION_GATE_BASELINE_ACCEPTANCE",
      "HELARC_VALIDATION_PROFILE_ACCEPTED_BASELINE",
      "HELARC_VALIDATION_PROFILE_BASELINE_ACCEPTANCE",
      "adaptHelarcExternalBenchmarkManifest",
      "compareHelarcEvaluationBaseline",
      "createHelarcEvaluationCorpus",
      "createHelarcEvaluationTargetAdapter",
      "createHelarcProductEffectivenessObjective",
      "createHelarcProductEffectivenessTargetSnapshot",
      "projectHelarcEvaluationBaselineSignature",
      "runHelarcEvaluationBaselineCandidate",
    ]);
  });
});
