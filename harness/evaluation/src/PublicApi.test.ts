import { describe, expect, it } from "vitest";
import * as campaign from "./campaign/index.js";
import * as capture from "./capture/index.js";
import * as definition from "./definition/index.js";
import * as grading from "./grading/index.js";
import * as metrics from "./metrics/index.js";
import * as persistence from "./persistence/index.js";
import * as report from "./report/index.js";
import * as trial from "./trial/index.js";

describe("Evaluation public API", () => {
  it("exposes only the eight focused value surfaces", () => {
    expect(Object.keys(definition).sort()).toEqual([
      "EvaluationContractError",
      "createEvaluationCase",
      "createEvaluationFailure",
      "createEvaluationObjective",
      "createEvaluationRecordRef",
      "createEvaluationSchemaRef",
      "createEvaluationSuite",
      "createEvaluationTargetSnapshot",
      "isEvaluationRefEqual",
      "snapshotEvaluationData",
    ]);
    expect(Object.keys(campaign).sort()).toEqual([
      "EvaluationCampaignExecution",
      "createEvaluationCampaign",
      "createInitialEvaluationCampaignSnapshot",
      "planEvaluationTrials",
    ]);
    expect(Object.keys(trial).sort()).toEqual([
      "EvaluationTrialExecution",
      "createEvaluationTargetObservation",
      "createEvaluationTrial",
      "createInitialEvaluationTrialSnapshot",
      "isEvaluationTrialTerminal",
      "projectEvaluationTrial",
    ]);
    expect(Object.keys(capture).sort()).toEqual([
      "assembleEvaluationCapture",
      "createEvaluationCapturePolicy",
      "projectEvaluationCapture",
    ]);
    expect(Object.keys(grading).sort()).toEqual([
      "DeterministicEvaluationGrader",
      "EvaluationGradingExecution",
      "ReferenceEvaluationGrader",
      "createEvaluationCriterion",
      "createEvaluationGrade",
      "createEvaluationGraderDefinition",
    ]);
    expect(Object.keys(metrics).sort()).toEqual([
      "aggregateEvaluationMetric",
      "comparePairedEvaluationSamples",
      "createEvaluationMetricDefinition",
      "evaluateEvaluationMetricGate",
    ]);
    expect(Object.keys(report).sort()).toEqual([
      "createEvaluationBaselineAcceptance",
      "createEvaluationReport",
      "projectEvaluationReportForPublication",
    ]);
    expect(Object.keys(persistence).sort()).toEqual([
      "EvaluationPersistenceError",
      "appendEvaluationRecord",
      "commitEvaluationSnapshot",
      "createEvaluationQueryProjection",
    ]);
  });
});
