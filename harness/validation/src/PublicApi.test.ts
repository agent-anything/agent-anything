import { describe, expect, it } from "vitest";
import * as assessment from "./assessment/index.js";
import * as completion from "./completion/index.js";
import * as definition from "./definition/index.js";
import * as evidence from "./evidence/index.js";
import * as execution from "./execution/index.js";
import * as persistence from "./persistence/index.js";
import * as projection from "./projection/index.js";
import * as subject from "./subject/index.js";

describe("Validation public API", () => {
  it("exposes only the eight focused value surfaces", () => {
    expect(Object.keys(definition).sort()).toEqual([
      "createValidationFailure",
      "snapshotValidationRequirement",
      "snapshotValidationSpecification",
    ]);
    expect(Object.keys(subject).sort()).toEqual(["snapshotValidationSubjectSnapshot"]);
    expect(Object.keys(execution).sort()).toEqual([
      "DefaultValidationExecutionFactory",
      "ValidationExecution",
      "ValidationExecutionError",
      "snapshotCheckAttempt",
      "snapshotCheckDefinition",
      "snapshotCheckResult",
    ]);
    expect(Object.keys(evidence).sort()).toEqual(["snapshotValidationEvidence"]);
    expect(Object.keys(assessment).sort()).toEqual([
      "snapshotValidationAssessment",
      "snapshotValidationCurrentRequirementState",
      "snapshotValidationCurrentSnapshot",
    ]);
    expect(Object.keys(completion).sort()).toEqual([
      "snapshotCompletionGateDecision",
      "snapshotCompletionGateInput",
    ]);
    expect(Object.keys(projection).sort()).toEqual([
      "snapshotValidationContextProjection",
      "snapshotValidationEvaluationProjection",
      "snapshotValidationHostProjection",
      "snapshotValidationObservabilityProjection",
      "snapshotValidationRunnerProjection",
    ]);
    expect(Object.keys(persistence).sort()).toEqual(["snapshotValidationPersistenceReceipt"]);
  });
});
