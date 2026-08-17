import {
  assembleEvaluationCapture,
  createEvaluationCapturePolicy,
  type EvaluationCapture,
  type EvaluationCaptureContribution,
  type EvaluationMeasurement,
} from "@agent-anything/evaluation/capture";
import type { EvaluationDataObject, EvaluationDataValue } from "@agent-anything/evaluation/definition";
import {
  createEvaluationCriterion,
  createEvaluationGraderDefinition,
  DeterministicEvaluationGrader,
  EvaluationGradingExecution,
  type EvaluationCriterion,
  type EvaluationGrade,
  type EvaluationGradeCandidate,
  type EvaluationGraderDefinition,
} from "@agent-anything/evaluation/grading";
import {
  aggregateEvaluationMetric,
  createEvaluationMetricDefinition,
  evaluateEvaluationMetricGate,
  type EvaluationMetric,
  type EvaluationMetricDefinition,
  type EvaluationMetricInput,
} from "@agent-anything/evaluation/metrics";
import type { EvaluationImmutableRecordStore } from "@agent-anything/evaluation/persistence";
import {
  CONTEXT_CONTINUITY_EVALUATION_REVISION,
  type ContextContinuityEvaluationCandidate,
  type ContextContinuitySafeTrajectory,
} from "./ContextContinuityEvaluationContracts.js";
import { observeContextContinuityFixtures } from "./ContextContinuityFixtures.js";

const EVALUATION_TIME = "2026-08-17T00:00:20.000Z";
const TARGET_REF = Object.freeze({
  id: "context-continuity-evaluation-target",
  revision: CONTEXT_CONTINUITY_EVALUATION_REVISION,
});
const TRAJECTORY_SCHEMA = Object.freeze({
  schemaId: "context-continuity-safe-trajectory",
  revision: "1",
});
const LIMITATION = Object.freeze({
  code: "deterministic_contract_and_system_evidence_only",
  message: "The profile proves deterministic Context and continuation behavior; it does not measure general model intelligence or semantic relevance independently from task outcomes.",
  metadata: Object.freeze({}),
});

const SAFE_CRITERION_REF = ref("context-continuity.criterion.safe-disclosure");
const ATTRIBUTION_CRITERION_REF = ref("context-continuity.criterion.stage-attribution");
const SAFE_GRADER_REF = ref("context-continuity.grader.safe-disclosure");
const ATTRIBUTION_GRADER_REF = ref("context-continuity.grader.stage-attribution");

export async function runContextContinuityEvaluationCandidate(): Promise<ContextContinuityEvaluationCandidate> {
  const fixtures = await observeContextContinuityFixtures();
  const criteria = createCriteria();
  const graders = createGraders();
  const captures = fixtures.map((fixture) => captureFixture(fixture, graders));
  const grades = await gradeCaptures(captures, criteria, graders);
  const definitions = createMetrics();
  const metrics = definitions.map((definition) => aggregateEvaluationMetric({
    ref: ref(`${definition.ref.id}.candidate-result`),
    definition,
    targetSnapshotRef: TARGET_REF,
    inputs: metricInputs(definition, fixtures, captures, grades),
    computedAt: EVALUATION_TIME,
    limitations: [LIMITATION],
  }));
  const gateOutcomes = metrics.flatMap((metric) => {
    const definition = definitions.find((candidate) => refsEqual(candidate.ref, metric.definitionRef));
    if (definition === undefined) throw new Error(`Missing Metric definition '${metric.definitionRef.id}'.`);
    return definition.role === "gate" ? [evaluateEvaluationMetricGate(definition, metric)] : [];
  });
  return deepFreeze({
    schemaVersion: 1,
    kind: "context_continuity_evaluation_candidate",
    revision: CONTEXT_CONTINUITY_EVALUATION_REVISION,
    target: {
      ref: TARGET_REF,
      environmentRevision: fixtures[0]!.environmentRevision,
      providerRevision: fixtures[0]!.providerRevision,
      modelRevision: fixtures[0]!.modelRevision,
      estimatorRevision: fixtures[0]!.estimatorRevision,
      policyRevision: fixtures[0]!.policyRevision,
      protocolRevision: fixtures[0]!.protocolRevision,
      toolExposureRevision: fixtures[0]!.toolExposureRevision,
    },
    fixtures,
    captures,
    grades,
    metrics,
    gateOutcomes,
    exclusions: metrics.flatMap((metric) => metric.exclusions.map((exclusion) => ({
      metricRef: metric.ref,
      trialRef: exclusion.trialRef,
      code: exclusion.code,
      message: exclusion.message,
    }))),
    uncertainty: "retained_per_metric",
    limitations: [LIMITATION],
  } satisfies ContextContinuityEvaluationCandidate);
}

function captureFixture(
  fixture: ContextContinuitySafeTrajectory,
  graders: readonly EvaluationGraderDefinition[],
): EvaluationCapture {
  const policy = createEvaluationCapturePolicy({
    ref: ref("context-continuity.capture-policy"),
    slots: [{
      id: "safe-trajectory",
      owner: "context-continuity-evaluation",
      schemaRef: TRAJECTORY_SCHEMA,
      required: true,
      maximumSensitivity: "internal",
      contentMode: "inline",
      retention: "report",
      maximumBytes: 32_768,
      optionalOmission: "complete",
      consumers: graders.map((grader) => ({ kind: "grader" as const, ref: grader.ref })),
    }],
    createdAt: EVALUATION_TIME,
    metadata: { profile: "context_continuity" },
    limitations: [LIMITATION],
  });
  const contribution: EvaluationCaptureContribution = {
    slotId: "safe-trajectory",
    owner: "context-continuity-evaluation",
    schemaRef: TRAJECTORY_SCHEMA,
    sensitivity: "internal",
    status: "captured",
    content: { kind: "inline", value: safeTrajectoryData(fixture) },
    reason: null,
  };
  const result = assembleEvaluationCapture({
    ref: ref(`context-continuity.capture.${fixture.fixtureId}`),
    trialRef: trialRef(fixture),
    targetSnapshotRef: TARGET_REF,
    caseRef: caseRef(fixture),
    policy,
    environmentRef: ref("context-continuity.environment"),
    contributions: [contribution],
    measurements: measurements(fixture),
    startedAt: "2026-08-17T00:00:00.000Z",
    completedAt: EVALUATION_TIME,
    limitations: [LIMITATION],
    metadata: { fixtureId: fixture.fixtureId, safeProjection: true },
  });
  if (result.status !== "captured") {
    throw new Error(
      `Context Continuity Capture '${fixture.fixtureId}' settled as '${result.status}': ${result.capture.failures.map((failure) => failure.message).join("; ")}`,
    );
  }
  return result.capture;
}

async function gradeCaptures(
  captures: readonly EvaluationCapture[],
  criteria: readonly EvaluationCriterion[],
  graders: readonly EvaluationGraderDefinition[],
): Promise<readonly EvaluationGrade[]> {
  const store = new MemoryGradeStore();
  const execution = new EvaluationGradingExecution({
    gradeStore: store,
    clock: { now: () => EVALUATION_TIME },
    deadline: { waitUntil: () => new Promise<void>(() => undefined) },
  });
  const safeGrader = new DeterministicEvaluationGrader({
    evaluate: (request) => booleanGrade(
      readTrajectory(request.capture).disclosureCorrect &&
        !readTrajectory(request.capture).leakageDetected,
      "safe-projection-contract",
      "The safe trajectory contains only admitted aggregate evidence.",
    ),
  });
  const attributionGrader = new DeterministicEvaluationGrader({
    evaluate: (request) => booleanGrade(
      readTrajectory(request.capture).attributionCorrect,
      "typed-stage-attribution",
      "The observed result is attributed to its declared semantic owner stage.",
    ),
  });
  for (const capture of captures) {
    for (const grader of graders) {
      const criterion = criteria.find((candidate) => refsEqual(candidate.ref, grader.criterionRef));
      if (criterion === undefined) throw new Error(`Missing Criterion '${grader.criterionRef.id}'.`);
      const result = await execution.grade({
        gradeRef: ref(`${capture.ref.id}.${grader.ref.id}.grade`),
        capture,
        criterion,
        grader,
        requestedAt: EVALUATION_TIME,
        metadata: { profile: "context_continuity" },
      }, refsEqual(grader.ref, SAFE_GRADER_REF) ? safeGrader : attributionGrader, {
        signal: new AbortController().signal,
        deadlineAt: null,
      });
      if (result.status !== "graded" || result.grade === null) {
        throw new Error(`Context Continuity grading settled as '${result.status}'.`);
      }
    }
  }
  return Object.freeze([...store.records]);
}

function createCriteria(): readonly EvaluationCriterion[] {
  return Object.freeze([
    createEvaluationCriterion({
      ref: SAFE_CRITERION_REF,
      name: "Safe Context evidence disclosure",
      description: "Context evaluation evidence contains no unrestricted payload, prompt, credential, physical root, or opaque continuation state.",
      dimension: "safety",
      valueSchema: { kind: "boolean" },
      createdAt: EVALUATION_TIME,
      metadata: { profile: "context_continuity" },
      limitations: [LIMITATION],
    }),
    createEvaluationCriterion({
      ref: ATTRIBUTION_CRITERION_REF,
      name: "Owning-stage attribution",
      description: "The trajectory preserves the earliest owning stage that explains the observed result.",
      dimension: "diagnostic_quality",
      valueSchema: { kind: "boolean" },
      createdAt: EVALUATION_TIME,
      metadata: { profile: "context_continuity" },
      limitations: [LIMITATION],
    }),
  ]);
}

function createGraders(): readonly EvaluationGraderDefinition[] {
  return Object.freeze([
    graderDefinition(SAFE_GRADER_REF, SAFE_CRITERION_REF, "Safe Context evidence grader"),
    graderDefinition(ATTRIBUTION_GRADER_REF, ATTRIBUTION_CRITERION_REF, "Context stage attribution grader"),
  ]);
}

function graderDefinition(
  graderRef: ReturnType<typeof ref>,
  criterionRef: ReturnType<typeof ref>,
  name: string,
): EvaluationGraderDefinition {
  return createEvaluationGraderDefinition({
    ref: graderRef,
    name,
    kind: "deterministic",
    criterionRef,
    rubricRef: ref(`${graderRef.id}.rubric`),
    requiredSlots: [{ slotId: "safe-trajectory", schemaRef: TRAJECTORY_SCHEMA }],
    outputSchemaRef: { schemaId: "evaluation-boolean-grade", revision: "1" },
    calibrationRefs: [ref(`${graderRef.id}.calibration`)],
    validity: { validFrom: null, validUntil: null },
    disclosure: "internal",
    dataResidency: "local-test-process",
    requireActorAttribution: false,
    requireModelAttribution: false,
    createdAt: EVALUATION_TIME,
    metadata: { profile: "context_continuity" },
    limitations: [LIMITATION],
  });
}

function createMetrics(): readonly EvaluationMetricDefinition[] {
  return Object.freeze([
    gradeMetric("disclosure-correctness", "Disclosure correctness", "safety", SAFE_CRITERION_REF, "gate", { comparison: "at_least", value: 1 }),
    gradeMetric("stage-attribution-correctness", "Stage attribution correctness", "diagnostic_quality", ATTRIBUTION_CRITERION_REF),
    measurementMetric("manifest-completeness", "Projection Manifest completeness", "reliability", "manifest_complete", "boolean", "gate", { comparison: "at_least", value: 1 }),
    measurementMetric("budget-error", "Complete model-input budget error", "reliability", "budget_error", "bytes", "gate", { comparison: "at_most", value: 0 }),
    measurementMetric("disposition-coverage", "Projection disposition coverage", "diagnostic_quality", "disposition_coverage", "boolean"),
    measurementMetric("reconstruction-equivalence", "Provider-neutral reconstruction equivalence", "reliability", "reconstruction_equivalent", "boolean", "gate", { comparison: "at_least", value: 1 }),
    measurementMetric("continuation-behavior", "Continuation lifecycle behavior", "reliability", "continuation_behavior", "boolean"),
    measurementMetric("leakage-absence", "Unsafe evidence leakage absence", "safety", "leakage_absent", "boolean", "gate", { comparison: "at_least", value: 1 }),
    measurementMetric("latency", "Deterministic fixture latency", "efficiency", "latency_ms", "milliseconds"),
    measurementMetric("downstream-outcome", "Downstream task outcome", "outcome_quality", "downstream_outcome", "boolean"),
  ]);
}

function gradeMetric(
  id: string,
  name: string,
  dimension: EvaluationMetricDefinition["dimension"],
  criterionRef: ReturnType<typeof ref>,
  role: "gate" | "informational" = "informational",
  threshold: EvaluationMetricDefinition["gateThreshold"] = null,
): EvaluationMetricDefinition {
  return createEvaluationMetricDefinition({
    ref: ref(`context-continuity.metric.${id}`),
    name,
    dimension,
    source: { kind: "grade", criterionRef },
    unit: "boolean",
    aggregation: "rate",
    requiredTrialStatuses: ["completed"],
    requiredCaptureStatuses: ["complete"],
    requiredGradingStatuses: ["graded"],
    uncertainty: { method: "wilson", confidence: 0.95, minimumSamples: 1 },
    exclusionCodes: ["not_applicable", "unsupported_provider_feature", "invalid_trial"],
    pairedComparisonKey: "fixture",
    direction: "higher",
    role,
    gateThreshold: threshold,
    createdAt: EVALUATION_TIME,
    metadata: { profile: "context_continuity" },
    limitations: [LIMITATION],
  });
}

function measurementMetric(
  id: string,
  name: string,
  dimension: EvaluationMetricDefinition["dimension"],
  measurementId: string,
  unit: string,
  role: "gate" | "informational" = "informational",
  threshold: EvaluationMetricDefinition["gateThreshold"] = null,
): EvaluationMetricDefinition {
  const numeric = unit !== "boolean";
  return createEvaluationMetricDefinition({
    ref: ref(`context-continuity.metric.${id}`),
    name,
    dimension,
    source: { kind: "measurement", measurementId, owner: "context-continuity-evaluation" },
    unit,
    aggregation: numeric ? "numeric_distribution" : "rate",
    requiredTrialStatuses: ["completed"],
    requiredCaptureStatuses: ["complete"],
    requiredGradingStatuses: [],
    uncertainty: numeric
      ? { method: "standard_error", confidence: 0.95, minimumSamples: 2 }
      : { method: "wilson", confidence: 0.95, minimumSamples: 1 },
    exclusionCodes: ["not_applicable", "unsupported_provider_feature", "invalid_trial"],
    pairedComparisonKey: "fixture",
    direction: measurementId === "latency_ms" || measurementId === "budget_error" ? "lower" : "higher",
    role,
    gateThreshold: threshold,
    createdAt: EVALUATION_TIME,
    metadata: { profile: "context_continuity" },
    limitations: [LIMITATION],
  });
}

function metricInputs(
  definition: EvaluationMetricDefinition,
  fixtures: readonly ContextContinuitySafeTrajectory[],
  captures: readonly EvaluationCapture[],
  grades: readonly EvaluationGrade[],
): EvaluationMetricInput[] {
  return fixtures.map((fixture) => {
    const capture = captures.find((candidate) => candidate.caseRef.id === caseRef(fixture).id);
    if (capture === undefined) throw new Error(`Missing Capture '${fixture.fixtureId}'.`);
    const base = {
      trialRef: trialRef(fixture),
      targetSnapshotRef: TARGET_REF,
      caseRef: caseRef(fixture),
      pairingKey: fixture.fixtureId,
      captureRef: capture.ref,
      trialStatus: "completed" as const,
      captureStatus: capture.status,
    };
    if (definition.source.kind === "grade") {
      const grade = grades.find((candidate) =>
        refsEqual(candidate.captureRef, capture.ref) &&
        refsEqual(candidate.criterionRef, definition.source.kind === "grade"
          ? definition.source.criterionRef
          : candidate.criterionRef));
      if (grade === undefined || grade.value.kind !== "boolean") {
        return excluded(definition, fixture, "invalid_trial", "Required deterministic Grade is unavailable.");
      }
      return {
        status: "included",
        sample: {
          ...base,
          source: {
            kind: "grade",
            gradeRef: grade.ref,
            criterionRef: grade.criterionRef,
            gradingStatus: "graded",
          },
          value: grade.value.value,
        },
      };
    }
    const applicability = measurementValue(definition.source.measurementId, fixture);
    if (applicability.status === "excluded") {
      return excluded(definition, fixture, applicability.code, applicability.message);
    }
    return {
      status: "included",
      sample: {
        ...base,
        source: {
          kind: "measurement",
          measurementId: definition.source.measurementId,
          owner: definition.source.owner,
          unit: definition.unit,
          valid: true,
        },
        value: applicability.value,
      },
    };
  });
}

function measurementValue(
  id: string,
  fixture: ContextContinuitySafeTrajectory,
): { readonly status: "included"; readonly value: boolean | number } |
  { readonly status: "excluded"; readonly code: string; readonly message: string } {
  switch (id) {
    case "manifest_complete":
    case "disposition_coverage":
      return fixture.projection === null
        ? notApplicable("The fixture does not reach Context Projection.")
        : { status: "included", value: fixture.projection.complete };
    case "budget_error":
      return fixture.modelInput === null
        ? notApplicable("The fixture does not produce complete model input.")
        : { status: "included", value: Math.abs(fixture.modelInput.budgetError) };
    case "reconstruction_equivalent":
      return fixture.continuation?.reconstructionEquivalent === null || fixture.continuation === null
        ? notApplicable("The fixture does not perform provider-neutral reconstruction.")
        : { status: "included", value: fixture.continuation.reconstructionEquivalent };
    case "continuation_behavior":
      if (fixture.continuation === null) return notApplicable("The fixture does not exercise continuation.");
      if (fixture.continuation.providerSupport === "unsupported") {
        return {
          status: "excluded",
          code: "unsupported_provider_feature",
          message: "The selected Provider endpoint truthfully declares continuation unsupported.",
        };
      }
      return { status: "included", value: fixture.continuation.behaviorCorrect };
    case "leakage_absent":
      return { status: "included", value: !fixture.leakageDetected };
    case "latency_ms":
      return { status: "included", value: fixture.latencyMs };
    case "downstream_outcome":
      return fixture.downstreamOutcome === "not_exercised"
        ? notApplicable("The adverse fixture settles before downstream task execution.")
        : { status: "included", value: fixture.downstreamOutcome === "succeeded" };
    default:
      return { status: "excluded", code: "invalid_trial", message: `Unknown measurement '${id}'.` };
  }
}

function excluded(
  definition: EvaluationMetricDefinition,
  fixture: ContextContinuitySafeTrajectory,
  code: string,
  message: string,
): EvaluationMetricInput {
  return {
    status: "excluded",
    exclusion: {
      trialRef: trialRef(fixture),
      code,
      message,
      details: { metricId: definition.ref.id, fixtureId: fixture.fixtureId },
    },
  };
}

function notApplicable(message: string) {
  return { status: "excluded" as const, code: "not_applicable", message };
}

function measurements(fixture: ContextContinuitySafeTrajectory): readonly EvaluationMeasurement[] {
  const result: EvaluationMeasurement[] = [
    measurement("leakage_absent", "boolean", fixture.leakageDetected ? 0 : 1),
    measurement("latency_ms", "milliseconds", fixture.latencyMs),
  ];
  if (fixture.projection !== null) {
    result.push(measurement("manifest_complete", "boolean", fixture.projection.complete ? 1 : 0));
    result.push(measurement("disposition_coverage", "boolean", fixture.projection.complete ? 1 : 0));
  }
  if (fixture.modelInput !== null) {
    result.push(measurement("budget_error", "bytes", Math.abs(fixture.modelInput.budgetError)));
  }
  if (fixture.continuation?.reconstructionEquivalent !== null && fixture.continuation !== null) {
    result.push(measurement(
      "reconstruction_equivalent",
      "boolean",
      fixture.continuation.reconstructionEquivalent ? 1 : 0,
    ));
  }
  if (fixture.continuation !== null) {
    result.push(measurement("continuation_behavior", "boolean", fixture.continuation.behaviorCorrect ? 1 : 0));
  }
  if (fixture.downstreamOutcome !== "not_exercised") {
    result.push(measurement("downstream_outcome", "boolean", fixture.downstreamOutcome === "succeeded" ? 1 : 0));
  }
  return Object.freeze(result);
}

function measurement(id: string, unit: string, value: number): EvaluationMeasurement {
  return Object.freeze({
    id,
    owner: "context-continuity-evaluation",
    source: "safe-trajectory",
    unit,
    value,
    valid: true,
    limitation: null,
  });
}

function safeTrajectoryData(fixture: ContextContinuitySafeTrajectory): EvaluationDataObject {
  return {
    fixtureId: fixture.fixtureId,
    fixtureRevision: fixture.fixtureRevision,
    targetRevision: fixture.targetRevision,
    environmentRevision: fixture.environmentRevision,
    providerRevision: fixture.providerRevision,
    modelRevision: fixture.modelRevision,
    policyRevision: fixture.policyRevision,
    profileRevision: fixture.profileRevision,
    estimatorRevision: fixture.estimatorRevision,
    protocolRevision: fixture.protocolRevision,
    toolExposureRevision: fixture.toolExposureRevision,
    contributionCounts: {
      supplied: fixture.contributionSuppliedCount,
      admitted: fixture.contributionAdmittedCount,
    },
    transitionCounts: {
      attempted: fixture.transitionAttemptedCount,
      committed: fixture.transitionCommittedCount,
      conflicted: fixture.transitionConflictCount,
      cancelled: fixture.transitionCancelledCount,
    },
    projection: fixture.projection === null ? null : {
      outcome: fixture.projection.outcome,
      code: fixture.projection.code,
      consideredItemCount: fixture.projection.consideredItemCount,
      projectedItemCount: fixture.projection.projectedItemCount,
      projectedAmount: fixture.projection.projectedAmount,
      budgetMaximum: fixture.projection.budgetMaximum,
      dispositionCounts: { ...fixture.projection.dispositionCounts },
      complete: fixture.projection.complete,
    },
    modelInputAccounting: fixture.modelInput === null ? null : {
      limitAmount: fixture.modelInput.limitAmount,
      inputAmount: fixture.modelInput.inputAmount,
      outputReserveAmount: fixture.modelInput.outputReserveAmount,
      remainingAmount: fixture.modelInput.remainingAmount,
      budgetError: fixture.modelInput.budgetError,
    },
    continuation: fixture.continuation === null ? null : {
      outcome: fixture.continuation.outcome,
      reason: fixture.continuation.reason,
      reconstructionEquivalent: fixture.continuation.reconstructionEquivalent,
      compactionObserved: fixture.continuation.compactionObserved,
      behaviorCorrect: fixture.continuation.behaviorCorrect,
      providerSupport: fixture.continuation.providerSupport,
    },
    attribution: fixture.attribution,
    attributionCorrect: fixture.attributionCorrect,
    failureCode: fixture.failureCode,
    disclosureCorrect: fixture.disclosureCorrect,
    leakageDetected: fixture.leakageDetected,
    latencyMs: fixture.latencyMs,
    downstreamOutcome: fixture.downstreamOutcome,
    limitations: [...fixture.limitations],
  };
}

function readTrajectory(capture: EvaluationCapture): {
  readonly disclosureCorrect: boolean;
  readonly leakageDetected: boolean;
  readonly attributionCorrect: boolean;
} {
  const slot = capture.slots.find((candidate) => candidate.slotId === "safe-trajectory");
  if (slot?.content?.kind !== "inline" || !isRecord(slot.content.value)) {
    throw new TypeError("Safe trajectory Capture slot is unavailable.");
  }
  const disclosureCorrect = slot.content.value.disclosureCorrect;
  const leakageDetected = slot.content.value.leakageDetected;
  const attributionCorrect = slot.content.value.attributionCorrect;
  if (
    typeof disclosureCorrect !== "boolean" || typeof leakageDetected !== "boolean" ||
    typeof attributionCorrect !== "boolean"
  ) throw new TypeError("Safe trajectory grader inputs are invalid.");
  return { disclosureCorrect, leakageDetected, attributionCorrect };
}

function booleanGrade(
  passed: boolean,
  method: string,
  rationale: string,
): EvaluationGradeCandidate {
  return Object.freeze({
    value: Object.freeze({ kind: "boolean" as const, value: passed }),
    criterionOutcome: passed ? "satisfied" as const : "not_satisfied" as const,
    evidenceRefs: Object.freeze([]),
    captureSlotIds: Object.freeze(["safe-trajectory"]),
    rationale,
    uncertainty: Object.freeze({
      status: "unavailable" as const,
      reason: "The deterministic Contract claim does not require statistical uncertainty.",
    }),
    attribution: Object.freeze({
      method,
      actorRef: null,
      modelRef: null,
      metadata: Object.freeze({ deterministic: true }),
    }),
    disagreementGroup: null,
    limitations: Object.freeze([LIMITATION]),
  });
}

function trialRef(fixture: ContextContinuitySafeTrajectory) {
  return ref(`context-continuity.trial.${fixture.fixtureId}`);
}

function caseRef(fixture: ContextContinuitySafeTrajectory) {
  return ref(`context-continuity.case.${fixture.fixtureId}`);
}

function ref(id: string) {
  return Object.freeze({ id, revision: CONTEXT_CONTINUITY_EVALUATION_REVISION });
}

function refsEqual(
  left: { readonly id: string; readonly revision: string },
  right: { readonly id: string; readonly revision: string },
): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function isRecord(value: EvaluationDataValue): value is EvaluationDataObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class MemoryGradeStore implements EvaluationImmutableRecordStore<EvaluationGrade> {
  readonly records: EvaluationGrade[] = [];

  async append(record: EvaluationGrade) {
    this.records.push(record);
    return Object.freeze({ status: "stored" as const });
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
