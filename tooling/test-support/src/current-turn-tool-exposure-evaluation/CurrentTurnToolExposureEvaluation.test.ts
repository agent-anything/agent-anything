import { describe, expect, it } from "vitest";
import { runCurrentTurnToolExposureDeterministicEvaluation } from "./CurrentTurnToolExposureEvaluation.js";

describe("Current-turn Tool Exposure deterministic Evaluation", () => {
  it("proves exact omission, recovery, separation, and real target gates", async () => {
    const report = await runCurrentTurnToolExposureDeterministicEvaluation();
    const byId = new Map(report.cases.map((item) => [item.id, item]));

    expect(byId.get("full-model-origin-exposure")).toMatchObject({
      selectedModelToolCount: 2,
      exposedToolNames: ["Read", "TaskStop"],
      omittedToolCount: 0,
    });
    expect(byId.get("controlled-resource-absence")).toMatchObject({
      exposedToolNames: ["Read"],
      omittedToolCount: 1,
      omissionReasons: ["no_eligible_subject"],
    });
    expect(byId.get("zero-exposure")).toMatchObject({
      exposedToolNames: [],
      omittedToolCount: 2,
    });
    expect(byId.get("controlled-resource-reappearance")?.exposedToolNames)
      .toEqual(["Read", "TaskStop"]);
    expect(report).toMatchObject({
      incompleteAssessmentFailureCode: "tool_exposure_assessment_missing",
      workflowOnlyToolExcluded: true,
      recoveryPreservedSelection: true,
      recoveryChangedContent: true,
      permissionIndependent: true,
      agentHookIndependent: true,
      equivalentContentUsesDistinctRequestProofs: true,
      systemTarget: {
        trialCount: 20,
        outcomeQualityGate: "passed",
        safetyGate: "passed",
        traceIssueCount: 0,
      },
      prohibitedDisclosureCount: 0,
    });
    expect(report.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(report)).toBe(true);
    expect(JSON.stringify(report)).not.toContain("omitted-tool-private-description");
  }, 120_000);

  it("is deterministic across repeated execution", async () => {
    const first = await runCurrentTurnToolExposureDeterministicEvaluation();
    const second = await runCurrentTurnToolExposureDeterministicEvaluation();

    expect(second).toEqual(first);
    expect(second.digest).toBe(first.digest);
  }, 120_000);
});
