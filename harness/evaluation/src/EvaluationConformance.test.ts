import { describe, expect, it } from "vitest";
import {
  assembleEvaluationCapture,
  createEvaluationCapturePolicy,
} from "./capture/index.js";
import {
  createEvaluationCase,
  createEvaluationFailure,
  createEvaluationObjective,
  createEvaluationSuite,
} from "./definition/index.js";
import {
  aggregateEvaluationMetric,
  createEvaluationMetricDefinition,
} from "./metrics/index.js";
import { createEvaluationReport } from "./report/index.js";

const TIME = "2026-08-01T00:00:00.000Z";

describe("Evaluation owner conformance", () => {
  it("produces equivalent definitions under shuffled set-like input", () => {
    const objectiveA = objective(["safety", "outcome_quality"]);
    const objectiveB = objective(["outcome_quality", "safety"]);
    const caseA = evaluationCase("case-a");
    const caseB = evaluationCase("case-b");
    const suiteA = createEvaluationSuite(suiteInput([caseB.ref, caseA.ref]), [caseA, caseB]);
    const suiteB = createEvaluationSuite(suiteInput([caseA.ref, caseB.ref]), [caseB, caseA]);

    expect(objectiveA.dimensions).toEqual(objectiveB.dimensions);
    expect(suiteA).toEqual(suiteB);
    expect(Object.isFrozen(suiteA.caseRefs)).toBe(true);
  });

  it("recomputes Metrics and Reports deterministically under shuffled samples", () => {
    const definition = createEvaluationMetricDefinition({
      ref: ref("metric-definition"),
      name: "Outcome rate",
      dimension: "outcome_quality",
      source: { kind: "grade", criterionRef: ref("criterion") },
      unit: "ratio",
      aggregation: "rate",
      requiredTrialStatuses: ["partial", "completed"],
      requiredCaptureStatuses: ["partial", "complete"],
      requiredGradingStatuses: ["graded"],
      uncertainty: { method: "wilson", confidence: 0.95, minimumSamples: 2 },
      exclusionCodes: ["known_exclusion"],
      pairedComparisonKey: "case-key",
      direction: "higher",
      role: "gate",
      gateThreshold: { comparison: "at_least", value: 0.5 },
      createdAt: TIME,
      metadata: {},
      limitations: [],
    });
    const samples = [sample("trial-c", true), sample("trial-a", true), sample("trial-b", false)];
    const metricA = aggregateEvaluationMetric({
      ref: ref("metric-result"),
      definition,
      targetSnapshotRef: ref("target"),
      inputs: samples.map((sampleValue) => ({ status: "included" as const, sample: sampleValue })),
      computedAt: TIME,
      limitations: [],
    });
    const metricB = aggregateEvaluationMetric({
      ref: ref("metric-result"),
      definition,
      targetSnapshotRef: ref("target"),
      inputs: [...samples].reverse().map((sampleValue) => ({
        status: "included" as const,
        sample: sampleValue,
      })),
      computedAt: TIME,
      limitations: [],
    });
    const reportInput = {
      ref: ref("report"),
      intent: "baseline" as const,
      objectiveRef: ref("objective"),
      targetSnapshotRefs: [ref("target")],
      suiteRef: ref("suite"),
      campaignRef: ref("campaign"),
      captureRefs: [ref("capture-b"), ref("capture-a")],
      graderRefs: [ref("grader")],
      gradeRefs: [ref("grade-b"), ref("grade-a")],
      metricRefs: [metricA.ref],
      metricSummaries: [{
        metricRef: metricA.ref,
        dimension: "outcome_quality" as const,
        distribution: metricA.distribution,
        uncertainty: metricA.uncertainty,
      }],
      dimensionSummaries: [{
        dimension: "outcome_quality" as const,
        interpretation: "stable" as const,
        metricRefs: [metricA.ref],
        rationale: "Baseline distribution.",
      }],
      gateOutcomes: [{
        metricRef: metricA.ref,
        dimension: "outcome_quality" as const,
        status: "passed" as const,
        observedValue: 2 / 3,
        threshold: { comparison: "at_least" as const, value: 0.5 },
        reason: "Gate passed.",
      }],
      disagreements: [{
        group: "grader-disagreement",
        gradeRefs: [ref("grade-b"), ref("grade-a")],
        status: "unresolved" as const,
        summary: "The two Graders disagree.",
        limitations: [],
      }],
      failures: [failure("evaluation_cleanup_failed", "cleanup")],
      exclusions: [{
        trialRef: ref("trial-z"),
        code: "known_exclusion",
        message: "Known exclusion.",
        details: {},
      }],
      missingData: [{
        code: "usage_unavailable",
        message: "Usage was not supplied.",
        recordRef: null,
        details: {},
      }],
      comparability: {
        status: "comparable" as const,
        basis: { target: "exact" },
        differences: [],
        reason: "Single admitted target.",
      },
      supersedes: null,
      createdAt: TIME,
      metadata: {},
      limitations: [],
    };

    expect(metricA).toEqual(metricB);
    expect(createEvaluationReport(reportInput)).toEqual(createEvaluationReport({
      ...reportInput,
      captureRefs: [...reportInput.captureRefs].reverse(),
      gradeRefs: [...reportInput.gradeRefs].reverse(),
    }));
  });

  it("settles every Capture slot exactly once without raw owner state", () => {
    const policy = createEvaluationCapturePolicy({
      ref: ref("policy"),
      slots: [
        slot("run-summary", true),
        slot("verification-summary", false),
      ],
      createdAt: TIME,
      metadata: {},
      limitations: [],
    });
    const result = assembleEvaluationCapture({
      ref: ref("capture"),
      trialRef: ref("trial"),
      targetSnapshotRef: ref("target"),
      caseRef: ref("case"),
      policy,
      environmentRef: ref("environment"),
      contributions: [{
        slotId: "run-summary",
        owner: "agent-core",
        schemaRef: schema("run-summary"),
        sensitivity: "internal",
        status: "captured",
        content: { kind: "inline", value: { runId: "run-1", status: "failed" } },
        reason: null,
      }, {
        slotId: "verification-summary",
        owner: "agent-core",
        schemaRef: schema("verification-summary"),
        sensitivity: "public",
        status: "unavailable",
        content: null,
        reason: {
          code: "owner_not_realized",
          message: "Verification owner is not available.",
          sourceOwner: "verification",
          details: {},
        },
      }],
      measurements: [],
      startedAt: TIME,
      completedAt: TIME,
      limitations: [],
      metadata: {},
    });

    expect(result.capture.slots).toHaveLength(policy.slots.length);
    expect(new Set(result.capture.slots.map((item) => item.slotId)).size).toBe(policy.slots.length);
    expect(JSON.stringify(result.capture)).not.toContain("runState");
    expect(result.capture.missingData.map((item) => item.status)).toEqual(["unavailable"]);
  });
});

function objective(dimensions: ("safety" | "outcome_quality")[]) {
  return createEvaluationObjective({
    ref: ref("objective"),
    name: "Objective",
    decision: "Measure behavior.",
    dimensions,
    criterionRefs: [ref("criterion")],
    qualityGateRefs: [ref("quality-gate")],
    safetyGateRefs: [ref("safety-gate")],
    behaviorInputRequirements: [{
      key: "agent.revision",
      owner: "agent",
      required: true,
      schemaRef: schema("agent-revision"),
      maximumSensitivity: "public",
      description: "Agent revision.",
    }],
    suiteConstraints: {},
    comparisonBasis: {},
    acceptableExclusionCodes: [],
    createdAt: TIME,
    metadata: {},
    limitations: [],
  });
}

function evaluationCase(id: string) {
  return createEvaluationCase({
    ref: ref(id),
    name: id,
    targetInput: { task: id },
    fixtureRefs: [ref("fixture")],
    expectedClaimRefs: [ref("claim")],
    criterionRefs: [ref("criterion")],
    graderRefs: [ref("grader")],
    budget: {
      maximumDurationMs: 10_000,
      maximumCost: null,
      maximumTokens: 1_000,
      maximumOperations: 10,
    },
    distributionKey: "default",
    pairingKey: "pair",
    partition: { purpose: "regression", visibility: "public" },
    provenance: {
      source: "repository",
      sourceRevision: "r1",
      license: "Apache-2.0",
      metadata: {},
    },
    validity: { validFrom: TIME, validUntil: null },
    supersedes: null,
    createdAt: TIME,
    metadata: {},
    limitations: [],
  });
}

function suiteInput(caseRefs: ReturnType<typeof ref>[]) {
  return {
    ref: ref("suite"),
    name: "Suite",
    caseRefs,
    distribution: { kind: "declared" },
    selectionRules: { kind: "all" },
    validity: { validFrom: TIME, validUntil: null },
    provenance: {
      source: "repository",
      sourceRevision: "r1",
      license: "Apache-2.0",
      metadata: {},
    },
    supersedes: null,
    createdAt: TIME,
    metadata: {},
    limitations: [],
  };
}

function sample(trialId: string, value: boolean) {
  return {
    trialRef: ref(trialId),
    targetSnapshotRef: ref("target"),
    caseRef: ref("case"),
    pairingKey: "pair",
    captureRef: ref("capture"),
    trialStatus: "completed" as const,
    captureStatus: "complete" as const,
    source: {
      kind: "grade" as const,
      gradeRef: ref("grade"),
      criterionRef: ref("criterion"),
      gradingStatus: "graded" as const,
    },
    value,
  };
}

function slot(id: string, required: boolean) {
  return {
    id,
    owner: "agent-core",
    schemaRef: schema(id),
    required,
    maximumSensitivity: "internal" as const,
    contentMode: "inline" as const,
    retention: "campaign" as const,
    maximumBytes: 2_048,
    optionalOmission: required ? "complete" as const : "partial" as const,
    consumers: [{ kind: "grader" as const, ref: ref("grader") }],
  };
}

function failure(
  code: "evaluation_cleanup_failed",
  stage: "cleanup",
) {
  return createEvaluationFailure({
    code,
    stage,
    message: code,
    retryable: false,
    causeOwner: "environment",
    details: {},
  });
}

function ref(id: string) {
  return { id, revision: "v1" };
}

function schema(schemaId: string) {
  return { schemaId, revision: "v1" };
}
