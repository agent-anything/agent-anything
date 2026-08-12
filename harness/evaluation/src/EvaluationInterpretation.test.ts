import { describe, expect, it } from "vitest";
import {
  assembleEvaluationCapture,
  createEvaluationCapturePolicy,
  type EvaluationCapture,
} from "./capture/index.js";
import {
  createEvaluationFailure,
  type EvaluationFailure,
} from "./definition/index.js";
import {
  DeterministicEvaluationGrader,
  EvaluationGradingExecution,
  ReferenceEvaluationGrader,
  createEvaluationCriterion,
  createEvaluationGraderDefinition,
  type EvaluationGrade,
  type EvaluationGradeCandidate,
  type EvaluationGradeRequest,
  type EvaluationGraderPort,
} from "./grading/index.js";
import {
  aggregateEvaluationMetric,
  comparePairedEvaluationSamples,
  createEvaluationMetricDefinition,
  evaluateEvaluationMetricGate,
  type EvaluationMetricSample,
} from "./metrics/index.js";
import type {
  EvaluationAppendResult,
  EvaluationImmutableRecordStore,
} from "./persistence/index.js";
import {
  createEvaluationBaselineAcceptance,
  createEvaluationReport,
  projectEvaluationReportForPublication,
} from "./report/index.js";
import type { EvaluationDeadlinePort } from "./trial/index.js";

const TIME = "2026-08-01T00:00:00.000Z";

describe("Evaluation grading", () => {
  it("persists independently repeatable deterministic and reference Grades", async () => {
    const store = new MemoryRecordStore<EvaluationGrade>();
    const execution = gradingExecution(store);
    const request = gradeRequest("deterministic");
    const deterministic = new DeterministicEvaluationGrader({
      evaluate: () => passingCandidate("deterministic"),
    });
    const first = await execution.grade(request, deterministic, control());
    const referenceRequest = {
      ...gradeRequest("reference"),
      gradeRef: ref("grade-reference"),
    };
    const reference = new ReferenceEvaluationGrader({
      evaluate: () => passingCandidate("reference"),
    });
    const second = await execution.grade(referenceRequest, reference, control());

    expect(first.status).toBe("graded");
    expect(second.status).toBe("graded");
    expect(store.records.map((grade) => grade.ref.id)).toEqual([
      "grade-deterministic",
      "grade-reference",
    ]);
    expect(first.grade).toMatchObject({
      captureRef: request.capture.ref,
      criterionRef: request.criterion.ref,
      graderRef: request.grader.ref,
    });
  });

  it.each([
    ["invalid", "evaluation_grader_invalid"],
    ["unavailable", "evaluation_grader_unavailable"],
    ["failed", "evaluation_grader_failed"],
    ["cancelled", "evaluation_cancelled"],
    ["timed_out", "evaluation_timed_out"],
  ] as const)("retains %s without fabricating a Grade", async (status, code) => {
    const store = new MemoryRecordStore<EvaluationGrade>();
    const port: EvaluationGraderPort = {
      kind: "human_input",
      async grade() {
        return {
          status,
          failure: failure(code),
        };
      },
    };
    const result = await gradingExecution(store).grade(
      gradeRequest("human_input"),
      port,
      control(),
    );

    expect(result.status).toBe(status);
    expect(result.grade).toBeNull();
    expect(store.records).toEqual([]);
  });

  it("classifies output outside the Criterion Contract as invalid", async () => {
    const store = new MemoryRecordStore<EvaluationGrade>();
    const port: EvaluationGraderPort = {
      kind: "hosted_model",
      async grade() {
        return {
          status: "graded",
          candidate: {
            ...passingCandidate("hosted"),
            value: { kind: "scalar", value: 1, minimum: 0, maximum: 2, unit: "score" },
          },
        };
      },
    };
    const result = await gradingExecution(store).grade(
      gradeRequest("hosted_model"),
      port,
      control(),
    );

    expect(result.status).toBe("invalid");
    expect(store.records).toEqual([]);
  });

  it("rejects contradictory Grade outcomes and inactive Grader revisions", async () => {
    const store = new MemoryRecordStore<EvaluationGrade>();
    const request = gradeRequest("deterministic");
    const contradictory = new DeterministicEvaluationGrader({
      evaluate: () => ({
        ...passingCandidate("deterministic"),
        criterionOutcome: "not_satisfied",
      }),
    });
    const contradictoryResult = await gradingExecution(store).grade(
      request,
      contradictory,
      control(),
    );
    const expiredRequest = {
      ...request,
      grader: createEvaluationGraderDefinition({
        ...request.grader,
        validity: {
          validFrom: "2026-07-01T00:00:00.000Z",
          validUntil: "2026-07-31T00:00:00.000Z",
        },
      }),
    };
    const expiredResult = await gradingExecution(store).grade(
      expiredRequest,
      contradictory,
      control(),
    );

    expect(contradictoryResult.status).toBe("invalid");
    expect(expiredResult.status).toBe("invalid");
    expect(store.records).toEqual([]);
  });

  it("requires explicit Grader inputs and calibration evidence", () => {
    const grader = gradeRequest("deterministic").grader;

    expect(() => createEvaluationGraderDefinition({
      ...grader,
      requiredSlots: [],
    })).toThrow(/requiredSlots/);
    expect(() => createEvaluationGraderDefinition({
      ...grader,
      calibrationRefs: [],
    })).toThrow(/calibrationRefs/);
  });

  it("ignores a Grader result that arrives after cancellation", async () => {
    const store = new MemoryRecordStore<EvaluationGrade>();
    let release!: (candidate: EvaluationGradeCandidate) => void;
    let started!: () => void;
    const gradingStarted = new Promise<void>((resolve) => { started = resolve; });
    const port: EvaluationGraderPort = {
      kind: "human_input",
      async grade() {
        started();
        return new Promise((resolve) => {
          release = (candidate) => resolve({ status: "graded", candidate });
        });
      },
    };
    const controller = new AbortController();
    const pending = gradingExecution(store).grade(
      gradeRequest("human_input"),
      port,
      { signal: controller.signal, deadlineAt: null },
    );
    await gradingStarted;
    controller.abort();
    const result = await pending;
    release(passingCandidate("late-human"));
    await Promise.resolve();

    expect(result.status).toBe("cancelled");
    expect(store.records).toEqual([]);
  });
});

describe("Evaluation metrics and reports", () => {
  it("retains repeated samples, explicit uncertainty, and invalid exclusions", () => {
    const definition = qualityMetricDefinition();
    const target = ref("target");
    const metric = aggregateEvaluationMetric({
      ref: ref("quality-metric-result"),
      definition,
      targetSnapshotRef: target,
      inputs: [
        included(sample("trial-b", target, false, "pair-b")),
        included(sample("trial-a", target, true, "pair-a")),
        included({ ...sample("trial-invalid", target, true, "pair-c"), value: 1 } as never),
      ],
      computedAt: TIME,
      limitations: [],
    });

    expect(metric.samples.map((item) => item.trialRef.id)).toEqual(["trial-a", "trial-b"]);
    expect(metric.distribution).toMatchObject({
      kind: "rate",
      sampleCount: 2,
      positiveCount: 1,
      value: 0.5,
    });
    expect(metric.uncertainty.status).toBe("available");
    expect(metric.exclusions.map((item) => item.code)).toEqual(["metric_sample_invalid"]);
    expect(evaluateEvaluationMetricGate(definition, metric).status).toBe("failed");
  });

  it("does not replace an absent numeric sample or uncertainty with zero", () => {
    const definition = createEvaluationMetricDefinition({
      ...qualityMetricDefinition(),
      ref: ref("latency-definition"),
      name: "Latency",
      dimension: "efficiency",
      source: { kind: "measurement", measurementId: "latency", owner: "runtime" },
      unit: "ms",
      aggregation: "numeric_distribution",
      requiredGradingStatuses: [],
      uncertainty: { method: "standard_error", confidence: 0.95, minimumSamples: 3 },
      direction: "lower",
      role: "informational",
      gateThreshold: null,
    });
    const metric = aggregateEvaluationMetric({
      ref: ref("latency-result"),
      definition,
      targetSnapshotRef: ref("target"),
      inputs: [],
      computedAt: TIME,
      limitations: [],
    });

    expect(metric.distribution).toMatchObject({ sampleCount: 0, mean: null });
    expect(metric.uncertainty).toMatchObject({ status: "unavailable" });
  });

  it("excludes duplicate Trial samples and undeclared exclusion reasons", () => {
    const definition = qualityMetricDefinition();
    const target = ref("target");
    const duplicate = sample("trial-duplicate", target, true, "pair-duplicate");
    const metric = aggregateEvaluationMetric({
      ref: ref("quality-duplicate-result"),
      definition,
      targetSnapshotRef: target,
      inputs: [
        included(duplicate),
        included({ ...duplicate, value: false }),
        {
          status: "excluded",
          exclusion: {
            trialRef: ref("trial-excluded"),
            code: "not_declared",
            message: "Caller supplied exclusion.",
            details: {},
          },
        },
      ],
      computedAt: TIME,
      limitations: [],
    });

    expect(metric.samples).toEqual([]);
    expect(metric.exclusions.map((item) => item.code)).toEqual([
      "metric_exclusion_undeclared",
      "metric_trial_duplicated",
    ]);
  });

  it("admits only samples with the declared state and typed source", () => {
    const definition = qualityMetricDefinition();
    const target = ref("target");
    const wrongCaptureState = {
      ...sample("trial-capture-failed", target, true, "pair-a"),
      captureStatus: "failed" as const,
    };
    const wrongCriterion = {
      ...sample("trial-wrong-criterion", target, true, "pair-b"),
      source: {
        kind: "grade" as const,
        gradeRef: ref("grade"),
        criterionRef: ref("other-criterion"),
        gradingStatus: "graded" as const,
      },
    };
    const metric = aggregateEvaluationMetric({
      ref: ref("invalid-provenance-result"),
      definition,
      targetSnapshotRef: target,
      inputs: [included(wrongCaptureState), included(wrongCriterion)],
      computedAt: TIME,
      limitations: [],
    });

    expect(metric.samples).toEqual([]);
    expect(metric.exclusions.map((item) => item.code)).toEqual([
      "metric_sample_invalid",
      "metric_sample_invalid",
    ]);
  });

  it("uses sample variance and computes declared non-catalog confidence", () => {
    const definition = createEvaluationMetricDefinition({
      ...qualityMetricDefinition(),
      ref: ref("numeric-definition"),
      name: "Latency",
      dimension: "efficiency",
      source: { kind: "measurement", measurementId: "latency", owner: "runtime" },
      unit: "ms",
      aggregation: "numeric_distribution",
      requiredGradingStatuses: [],
      uncertainty: { method: "standard_error", confidence: 0.92, minimumSamples: 2 },
      direction: "lower",
      role: "informational",
      gateThreshold: null,
    });
    const target = ref("target");
    const metric = aggregateEvaluationMetric({
      ref: ref("numeric-result"),
      definition,
      targetSnapshotRef: target,
      inputs: [
        included(sample("trial-a", target, 1, "pair-a")),
        included(sample("trial-b", target, 3, "pair-b")),
      ],
      computedAt: TIME,
      limitations: [],
    });

    expect(metric.distribution).toMatchObject({
      variance: 2,
      varianceMethod: "sample",
    });
    expect(metric.uncertainty).toMatchObject({
      status: "available",
      confidence: 0.92,
    });
  });

  it("pairs only exact Case and pairing keys and excludes unmatched samples", () => {
    const baselineTarget = ref("baseline-target");
    const candidateTarget = ref("candidate-target");
    const comparison = comparePairedEvaluationSamples({
      baselineTargetRef: baselineTarget,
      candidateTargetRef: candidateTarget,
      baseline: [
        sample("baseline-1", baselineTarget, 10, "pair-1"),
        sample("baseline-2", baselineTarget, 20, "pair-2"),
      ],
      candidate: [sample("candidate-1", candidateTarget, 8, "pair-1")],
    });

    expect(comparison.pairs).toMatchObject([{ difference: -2 }]);
    expect(comparison.exclusions.map((item) => item.code)).toEqual([
      "paired_sample_unmatched",
    ]);
  });

  it("turns invalid and duplicate paired inputs into explicit exclusions", () => {
    const baselineTarget = ref("baseline-target");
    const candidateTarget = ref("candidate-target");
    const duplicate = sample("baseline-1", baselineTarget, 10, "pair-1");
    const comparison = comparePairedEvaluationSamples({
      baselineTargetRef: baselineTarget,
      candidateTargetRef: candidateTarget,
      baseline: [duplicate, { ...duplicate, trialRef: ref("baseline-2") }],
      candidate: [
        sample("candidate-wrong-target", baselineTarget, 8, "pair-1"),
      ],
    });

    expect(comparison.pairs).toEqual([]);
    expect(comparison.exclusions.map((item) => item.code)).toEqual([
      "metric_sample_invalid",
      "paired_sample_duplicated",
    ]);
  });

  it("gates an efficiency improvement behind quality and safety", () => {
    const report = createEvaluationReport({
      ref: ref("report"),
      intent: "regression",
      objectiveRef: ref("objective"),
      targetSnapshotRefs: [ref("candidate-target"), ref("baseline-target")],
      suiteRef: ref("suite"),
      campaignRef: ref("campaign"),
      captureRefs: [ref("capture")],
      graderRefs: [ref("grader")],
      gradeRefs: [ref("grade")],
      metricRefs: [ref("quality-result"), ref("efficiency-result")],
      metricSummaries: [
        {
          metricRef: ref("quality-result"),
          dimension: "outcome_quality",
          distribution: { kind: "rate", sampleCount: 2, positiveCount: 1, value: 0.5 },
          uncertainty: { status: "unavailable", method: "wilson", reason: "Test summary." },
        },
        {
          metricRef: ref("efficiency-result"),
          dimension: "efficiency",
          distribution: {
            kind: "numeric_distribution",
            sampleCount: 1,
            minimum: 10,
            maximum: 10,
            mean: 10,
            variance: null,
            varianceMethod: "sample",
            p50: 10,
            p90: 10,
            p95: 10,
          },
          uncertainty: {
            status: "unavailable",
            method: "standard_error",
            reason: "Insufficient samples.",
          },
        },
      ],
      dimensionSummaries: [
        {
          dimension: "outcome_quality",
          interpretation: "regressed",
          metricRefs: [ref("quality-result")],
          rationale: "Quality gate regressed.",
        },
        {
          dimension: "efficiency",
          interpretation: "improved",
          metricRefs: [ref("efficiency-result")],
          rationale: "Latency decreased.",
        },
      ],
      gateOutcomes: [{
        metricRef: ref("quality-result"),
        dimension: "outcome_quality",
        status: "failed",
        observedValue: 0.5,
        threshold: { comparison: "at_least", value: 0.8 },
        reason: "Below quality threshold.",
      }],
      disagreements: [],
      failures: [],
      exclusions: [],
      missingData: [],
      comparability: {
        status: "comparable",
        basis: { protocol: "exact" },
        differences: [],
        reason: "Accepted target differences only.",
      },
      supersedes: null,
      createdAt: TIME,
      metadata: {},
      limitations: [],
    });
    const efficiency = report.dimensionSummaries.find(
      (item) => item.dimension === "efficiency",
    );

    expect(efficiency?.interpretation).toBe("gated");
    expect(projectEvaluationReportForPublication(report)).not.toHaveProperty("metadata");
    const baselineReport = createEvaluationReport({
      ...report,
      ref: ref("baseline-report"),
      intent: "baseline",
      targetSnapshotRefs: [ref("baseline-target")],
    });
    expect(createEvaluationBaselineAcceptance({
      ref: ref("baseline-acceptance"),
      reportRef: baselineReport.ref,
      acceptedBy: ref("reviewer"),
      acceptedAt: TIME,
      scope: { suite: "suite" },
      rationale: "Reviewed baseline.",
      tolerances: { quality: 0 },
      supersedes: null,
      limitations: [],
    }, baselineReport)).toMatchObject({ reportRef: baselineReport.ref });

    expect(() => createEvaluationReport({
      ...report,
      ref: ref("wrong-gate-report"),
      gateOutcomes: [{ ...report.gateOutcomes[0], dimension: "safety" }],
    })).toThrow(/gate Metric ref/);
    expect(() => createEvaluationReport({
      ...report,
      ref: ref("inconsistent-rate-report"),
      metricSummaries: report.metricSummaries.map((summary) =>
        summary.dimension === "outcome_quality"
          ? {
              ...summary,
              distribution: {
                kind: "rate" as const,
                sampleCount: 2,
                positiveCount: 1,
                value: 0.75,
              },
            }
          : summary),
    })).toThrow(/rate values are inconsistent/);
    expect(() => createEvaluationReport({
      ...report,
      ref: ref("incomparable-direction-report"),
      comparability: {
        status: "incomparable",
        basis: {},
        differences: ["protocol"],
        reason: "Protocols differ.",
      },
    })).toThrow(/cannot claim dimension direction/);
  });
});

function gradingExecution(store: MemoryRecordStore<EvaluationGrade>) {
  return new EvaluationGradingExecution({
    gradeStore: store,
    clock: { now: () => TIME },
    deadline: new NeverDeadline(),
  });
}

function gradeRequest(kind: "deterministic" | "reference" | "human_input" | "hosted_model"):
  EvaluationGradeRequest {
  const criterion = createEvaluationCriterion({
    ref: ref("criterion"),
    name: "Outcome",
    description: "The declared outcome is satisfied.",
    dimension: "outcome_quality",
    valueSchema: { kind: "boolean" },
    createdAt: TIME,
    metadata: {},
    limitations: [],
  });
  return {
    gradeRef: ref(`grade-${kind}`),
    capture: capture(),
    criterion,
    grader: createEvaluationGraderDefinition({
      ref: ref(`grader-${kind}`),
      name: kind,
      kind,
      criterionRef: criterion.ref,
      rubricRef: ref("rubric"),
      requiredSlots: [{ slotId: "outcome", schemaRef: schema("product-outcome") }],
      outputSchemaRef: schema("boolean-grade"),
      calibrationRefs: [ref("calibration")],
      validity: { validFrom: TIME, validUntil: null },
      disclosure: "internal",
      dataResidency: "local",
      requireActorAttribution: true,
      requireModelAttribution: false,
      createdAt: TIME,
      metadata: {},
      limitations: [],
    }),
    requestedAt: TIME,
    metadata: {},
  };
}

function capture(): EvaluationCapture {
  const policy = createEvaluationCapturePolicy({
    ref: ref("capture-policy"),
    slots: [{
      id: "outcome",
      owner: "product",
      schemaRef: schema("product-outcome"),
      required: true,
      maximumSensitivity: "internal",
      contentMode: "inline",
      retention: "report",
      maximumBytes: 1_024,
      optionalOmission: "complete",
      consumers: [
        { kind: "grader", ref: ref("grader-deterministic") },
        { kind: "grader", ref: ref("grader-reference") },
        { kind: "grader", ref: ref("grader-human_input") },
        { kind: "grader", ref: ref("grader-hosted_model") },
      ],
    }],
    createdAt: TIME,
    metadata: {},
    limitations: [],
  });
  return assembleEvaluationCapture({
    ref: ref("capture"),
    trialRef: ref("trial"),
    targetSnapshotRef: ref("target"),
    caseRef: ref("case"),
    policy,
    environmentRef: ref("environment"),
    contributions: [{
      slotId: "outcome",
      owner: "product",
      schemaRef: schema("product-outcome"),
      sensitivity: "internal",
      status: "captured",
      content: { kind: "inline", value: { satisfied: true } },
      reason: null,
    }],
    measurements: [],
    startedAt: TIME,
    completedAt: TIME,
    limitations: [],
    metadata: {},
  }).capture;
}

function passingCandidate(method: string): EvaluationGradeCandidate {
  return {
    value: { kind: "boolean", value: true },
    criterionOutcome: "satisfied",
    evidenceRefs: [ref("evidence")],
    captureSlotIds: ["outcome"],
    rationale: "Observed output satisfies the criterion.",
    uncertainty: { status: "unavailable", reason: "Deterministic claim." },
    attribution: {
      method,
      actorRef: ref("grader-actor"),
      modelRef: null,
      metadata: {},
    },
    disagreementGroup: null,
    limitations: [],
  };
}

function qualityMetricDefinition() {
  return createEvaluationMetricDefinition({
    ref: ref("quality-definition"),
    name: "Outcome rate",
    dimension: "outcome_quality",
    source: { kind: "grade", criterionRef: ref("criterion") },
    unit: "ratio",
    aggregation: "rate",
    requiredTrialStatuses: ["completed", "partial"],
    requiredCaptureStatuses: ["complete", "partial"],
    requiredGradingStatuses: ["graded"],
    uncertainty: { method: "wilson", confidence: 0.95, minimumSamples: 2 },
    exclusionCodes: ["metric_sample_invalid"],
    pairedComparisonKey: "case-pair",
    direction: "higher",
    role: "gate",
    gateThreshold: { comparison: "at_least", value: 0.8 },
    createdAt: TIME,
    metadata: {},
    limitations: [],
  });
}

function sample(
  trialId: string,
  targetSnapshotRef: ReturnType<typeof ref>,
  value: boolean | number,
  pairingKey: string,
): EvaluationMetricSample {
  return {
    trialRef: ref(trialId),
    targetSnapshotRef,
    caseRef: ref(pairingKey === "pair-1" ? "case-1" : pairingKey === "pair-2" ? "case-2" : "case"),
    pairingKey,
    captureRef: ref("capture"),
    trialStatus: "completed",
    captureStatus: "complete",
    source: typeof value === "boolean"
      ? {
          kind: "grade",
          gradeRef: ref("grade"),
          criterionRef: ref("criterion"),
          gradingStatus: "graded",
        }
      : {
          kind: "measurement",
          measurementId: "latency",
          owner: "runtime",
          unit: "ms",
          valid: true,
        },
    value,
  };
}

function included(sampleValue: EvaluationMetricSample) {
  return { status: "included" as const, sample: sampleValue };
}

class MemoryRecordStore<T> implements EvaluationImmutableRecordStore<T> {
  readonly records: T[] = [];

  async append(record: T): Promise<EvaluationAppendResult> {
    this.records.push(record);
    return { status: "stored" };
  }
}

class NeverDeadline implements EvaluationDeadlinePort {
  waitUntil(_deadlineAt: string, signal: AbortSignal): Promise<void> {
    return new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("settled")), { once: true });
    });
  }
}

function failure(code: EvaluationFailure["code"]): EvaluationFailure {
  const stage = code === "evaluation_cancelled"
    ? "cancellation"
    : code === "evaluation_timed_out"
      ? "timeout"
      : "grading";
  return createEvaluationFailure({
    code,
    stage,
    message: code,
    retryable: false,
    causeOwner: "test",
    details: {},
  });
}

function control() {
  return { signal: new AbortController().signal, deadlineAt: null };
}

function ref(id: string) {
  return { id, revision: "v1" };
}

function schema(schemaId: string) {
  return { schemaId, revision: "v1" };
}
