import {
  compareText,
  snapshotEvaluationDataObject,
  type EvaluationDataObject,
} from "../contract/EvaluationData.js";
import {
  assertArray,
  assertIsoTime,
  assertPositiveInteger,
  assertText,
  assertToken,
  createEvaluationRecordRef,
  evaluationRefKey,
  isEvaluationRefEqual,
  snapshotLimitations,
  type EvaluationLimitation,
  type EvaluationRecordRef,
} from "../contract/EvaluationPrimitives.js";
import type { EvaluationDimension } from "../definition/EvaluationDefinition.js";
import type { EvaluationCapture } from "../capture/EvaluationCapture.js";
import type { EvaluationGradingOutcomeStatus } from "../grading/EvaluationGrading.js";
import type { EvaluationTrialStatus } from "../trial/EvaluationTrial.js";

export type EvaluationMetricSource =
  | {
      readonly kind: "grade";
      readonly criterionRef: EvaluationRecordRef;
    }
  | {
      readonly kind: "measurement";
      readonly measurementId: string;
      readonly owner: string;
    };

export type EvaluationMetricAggregation =
  | "count"
  | "rate"
  | "numeric_distribution";

export type EvaluationMetricUncertaintyMethod =
  | "none"
  | "wilson"
  | "standard_error";

export interface EvaluationMetricUncertaintyRule {
  readonly method: EvaluationMetricUncertaintyMethod;
  readonly confidence: number | null;
  readonly minimumSamples: number;
}

export interface EvaluationMetricGateThreshold {
  readonly comparison: "at_least" | "at_most";
  readonly value: number;
}

export interface EvaluationMetricDefinition {
  readonly ref: EvaluationRecordRef;
  readonly name: string;
  readonly dimension: EvaluationDimension;
  readonly source: EvaluationMetricSource;
  readonly unit: string;
  readonly aggregation: EvaluationMetricAggregation;
  readonly requiredTrialStatuses: readonly EvaluationMetricTrialStatus[];
  readonly requiredCaptureStatuses: readonly EvaluationMetricCaptureStatus[];
  readonly requiredGradingStatuses: readonly EvaluationMetricGradingStatus[];
  readonly uncertainty: EvaluationMetricUncertaintyRule;
  readonly exclusionCodes: readonly string[];
  readonly pairedComparisonKey: string | null;
  readonly direction: "higher" | "lower" | "target";
  readonly role: "gate" | "informational";
  readonly gateThreshold: EvaluationMetricGateThreshold | null;
  readonly createdAt: string;
  readonly metadata: EvaluationDataObject;
  readonly limitations: readonly EvaluationLimitation[];
}

export type EvaluationMetricTrialStatus = Extract<
  EvaluationTrialStatus,
  | "completed"
  | "partial"
  | "invalid"
  | "infrastructure_failed"
  | "invocation_failed"
  | "capture_failed"
  | "cancelled"
  | "timed_out"
>;

export type EvaluationMetricCaptureStatus = EvaluationCapture["status"];
export type EvaluationMetricGradingStatus = EvaluationGradingOutcomeStatus;

export interface EvaluationMetricSample {
  readonly trialRef: EvaluationRecordRef;
  readonly targetSnapshotRef: EvaluationRecordRef;
  readonly caseRef: EvaluationRecordRef;
  readonly pairingKey: string | null;
  readonly captureRef: EvaluationRecordRef;
  readonly trialStatus: EvaluationMetricTrialStatus;
  readonly captureStatus: EvaluationMetricCaptureStatus;
  readonly source: EvaluationMetricSampleSource;
  readonly value: boolean | number;
}

export type EvaluationMetricSampleSource =
  | {
      readonly kind: "grade";
      readonly gradeRef: EvaluationRecordRef;
      readonly criterionRef: EvaluationRecordRef;
      readonly gradingStatus: EvaluationMetricGradingStatus;
    }
  | {
      readonly kind: "measurement";
      readonly measurementId: string;
      readonly owner: string;
      readonly unit: string;
      readonly valid: boolean;
    };

export interface EvaluationMetricExclusion {
  readonly trialRef: EvaluationRecordRef | null;
  readonly code: string;
  readonly message: string;
  readonly details: EvaluationDataObject;
}

export type EvaluationMetricInput =
  | { readonly status: "included"; readonly sample: EvaluationMetricSample }
  | { readonly status: "excluded"; readonly exclusion: EvaluationMetricExclusion };

export type EvaluationMetricUncertainty =
  | {
      readonly status: "available";
      readonly method: EvaluationMetricUncertaintyMethod;
      readonly confidence: number;
      readonly lower: number;
      readonly upper: number;
    }
  | {
      readonly status: "unavailable";
      readonly method: EvaluationMetricUncertaintyMethod;
      readonly reason: string;
    };

export type EvaluationMetricDistribution =
  | {
      readonly kind: "count";
      readonly sampleCount: number;
      readonly value: number | null;
    }
  | {
      readonly kind: "rate";
      readonly sampleCount: number;
      readonly positiveCount: number;
      readonly value: number | null;
    }
  | {
      readonly kind: "numeric_distribution";
      readonly sampleCount: number;
      readonly minimum: number | null;
      readonly maximum: number | null;
      readonly mean: number | null;
      readonly variance: number | null;
      readonly varianceMethod: "sample";
      readonly p50: number | null;
      readonly p90: number | null;
      readonly p95: number | null;
    };

export interface EvaluationMetric {
  readonly ref: EvaluationRecordRef;
  readonly definitionRef: EvaluationRecordRef;
  readonly targetSnapshotRef: EvaluationRecordRef;
  readonly samples: readonly EvaluationMetricSample[];
  readonly distribution: EvaluationMetricDistribution;
  readonly uncertainty: EvaluationMetricUncertainty;
  readonly exclusions: readonly EvaluationMetricExclusion[];
  readonly computedAt: string;
  readonly limitations: readonly EvaluationLimitation[];
}

export interface EvaluationMetricGateOutcome {
  readonly metricRef: EvaluationRecordRef;
  readonly dimension: EvaluationDimension;
  readonly status: "passed" | "failed" | "unavailable";
  readonly observedValue: number | null;
  readonly threshold: EvaluationMetricGateThreshold;
  readonly reason: string;
}

export interface EvaluationPairedDifference {
  readonly pairingKey: string;
  readonly caseRef: EvaluationRecordRef;
  readonly baselineTrialRef: EvaluationRecordRef;
  readonly candidateTrialRef: EvaluationRecordRef;
  readonly baselineValue: number;
  readonly candidateValue: number;
  readonly difference: number;
}

export interface EvaluationPairedComparison {
  readonly baselineTargetRef: EvaluationRecordRef;
  readonly candidateTargetRef: EvaluationRecordRef;
  readonly pairs: readonly EvaluationPairedDifference[];
  readonly exclusions: readonly EvaluationMetricExclusion[];
}

type EvaluationPairedMetricSample = Omit<
  EvaluationMetricSample,
  "pairingKey" | "value"
> & {
  readonly pairingKey: string;
  readonly value: number;
};

export function createEvaluationMetricDefinition(
  input: EvaluationMetricDefinition,
): EvaluationMetricDefinition {
  assertText(input?.name, "EvaluationMetricDefinition.name", 512);
  assertDimension(input.dimension);
  const source = snapshotSource(input.source);
  assertToken(input.unit, "EvaluationMetricDefinition.unit");
  if (!(["count", "rate", "numeric_distribution"] as const).includes(input.aggregation)) {
    throw new TypeError("EvaluationMetricDefinition.aggregation is unsupported.");
  }
  const uncertainty = snapshotUncertaintyRule(input.uncertainty, input.aggregation);
  if (input.pairedComparisonKey !== null) {
    assertToken(input.pairedComparisonKey, "EvaluationMetricDefinition.pairedComparisonKey");
  }
  if (!(["higher", "lower", "target"] as const).includes(input.direction)) {
    throw new TypeError("EvaluationMetricDefinition.direction is unsupported.");
  }
  if (input.role !== "gate" && input.role !== "informational") {
    throw new TypeError("EvaluationMetricDefinition.role is unsupported.");
  }
  const gateThreshold = snapshotGateThreshold(input.gateThreshold, input.role);
  assertIsoTime(input.createdAt, "EvaluationMetricDefinition.createdAt");
  const requiredGradingStatuses = uniqueStatuses(
    input.requiredGradingStatuses,
    GRADING_STATUSES,
    "EvaluationMetricDefinition.requiredGradingStatuses",
    source.kind === "measurement",
  );
  if (source.kind === "grade") {
    if (
      requiredGradingStatuses.length !== 1 ||
      requiredGradingStatuses[0] !== "graded"
    ) {
      throw new TypeError("A Grade-value Metric requires exactly the graded state.");
    }
  } else if (requiredGradingStatuses.length !== 0) {
    throw new TypeError("A measurement Metric must not declare Grading states.");
  }
  return Object.freeze({
    ref: createEvaluationRecordRef(input.ref, "EvaluationMetricDefinition.ref"),
    name: input.name,
    dimension: input.dimension,
    source,
    unit: input.unit,
    aggregation: input.aggregation,
    requiredTrialStatuses: uniqueStatuses(
      input.requiredTrialStatuses,
      TRIAL_STATUSES,
      "EvaluationMetricDefinition.requiredTrialStatuses",
    ),
    requiredCaptureStatuses: uniqueStatuses(
      input.requiredCaptureStatuses,
      CAPTURE_STATUSES,
      "EvaluationMetricDefinition.requiredCaptureStatuses",
    ),
    requiredGradingStatuses,
    uncertainty,
    exclusionCodes: uniqueTokens(
      input.exclusionCodes,
      "EvaluationMetricDefinition.exclusionCodes",
      true,
    ),
    pairedComparisonKey: input.pairedComparisonKey,
    direction: input.direction,
    role: input.role,
    gateThreshold,
    createdAt: input.createdAt,
    metadata: snapshotEvaluationDataObject(input.metadata, "EvaluationMetricDefinition.metadata"),
    limitations: snapshotLimitations(input.limitations, "EvaluationMetricDefinition.limitations"),
  });
}

export function aggregateEvaluationMetric(input: {
  readonly ref: EvaluationRecordRef;
  readonly definition: EvaluationMetricDefinition;
  readonly targetSnapshotRef: EvaluationRecordRef;
  readonly inputs: readonly EvaluationMetricInput[];
  readonly computedAt: string;
  readonly limitations: readonly EvaluationLimitation[];
}): EvaluationMetric {
  const definition = createEvaluationMetricDefinition(input.definition);
  const targetSnapshotRef = createEvaluationRecordRef(
    input.targetSnapshotRef,
    "EvaluationMetric.targetSnapshotRef",
  );
  assertArray(input.inputs, "EvaluationMetric.inputs");
  const samplesByTrial = new Map<string, EvaluationMetricSample>();
  const duplicateTrialKeys = new Set<string>();
  const exclusions: EvaluationMetricExclusion[] = [];
  for (const item of input.inputs) {
    if (item?.status === "excluded") {
      try {
        const exclusion = snapshotExclusion(item.exclusion);
        exclusions.push(definition.exclusionCodes.includes(exclusion.code)
          ? exclusion
          : undeclaredExclusion(exclusion));
      } catch (error) {
        exclusions.push(invalidSampleExclusion(
          safeRecordRef(item.exclusion?.trialRef),
          error instanceof Error ? error.message : "Metric exclusion is invalid.",
        ));
      }
      continue;
    }
    if (item?.status !== "included") {
      exclusions.push(invalidSampleExclusion(null, "Metric input status is unsupported."));
      continue;
    }
    try {
      const sample = snapshotSample(item.sample, definition, targetSnapshotRef);
      const trialKey = evaluationRefKey(sample.trialRef);
      if (samplesByTrial.has(trialKey) || duplicateTrialKeys.has(trialKey)) {
        samplesByTrial.delete(trialKey);
        if (!duplicateTrialKeys.has(trialKey)) {
          exclusions.push(duplicateTrialExclusion(sample.trialRef));
          duplicateTrialKeys.add(trialKey);
        }
        continue;
      }
      samplesByTrial.set(trialKey, sample);
    } catch (error) {
      exclusions.push(invalidSampleExclusion(
        safeRecordRef(item.sample?.trialRef),
        error instanceof Error ? error.message : "Metric sample is invalid.",
      ));
    }
  }
  const orderedSamples = Object.freeze([...samplesByTrial.values()].sort(compareSamples));
  const distribution = buildDistribution(definition.aggregation, orderedSamples);
  const uncertainty = buildUncertainty(definition.uncertainty, distribution, orderedSamples);
  assertIsoTime(input.computedAt, "EvaluationMetric.computedAt");
  return Object.freeze({
    ref: createEvaluationRecordRef(input.ref, "EvaluationMetric.ref"),
    definitionRef: definition.ref,
    targetSnapshotRef,
    samples: orderedSamples,
    distribution,
    uncertainty,
    exclusions: Object.freeze(exclusions.sort(compareExclusions)),
    computedAt: input.computedAt,
    limitations: snapshotLimitations(input.limitations, "EvaluationMetric.limitations"),
  });
}

export function evaluateEvaluationMetricGate(
  definition: EvaluationMetricDefinition,
  metric: EvaluationMetric,
): EvaluationMetricGateOutcome {
  const admitted = createEvaluationMetricDefinition(definition);
  if (admitted.role !== "gate" || admitted.gateThreshold === null) {
    throw new TypeError("Only a gate Metric definition can be evaluated as a gate.");
  }
  if (!isEvaluationRefEqual(admitted.ref, metric.definitionRef)) {
    throw new TypeError("Metric and gate definition revisions do not agree.");
  }
  const observedValue = distributionValue(metric.distribution);
  if (observedValue === null) {
    return Object.freeze({
      metricRef: metric.ref,
      dimension: admitted.dimension,
      status: "unavailable",
      observedValue: null,
      threshold: admitted.gateThreshold,
      reason: "No valid Metric sample is available.",
    });
  }
  const passed = admitted.gateThreshold.comparison === "at_least"
    ? observedValue >= admitted.gateThreshold.value
    : observedValue <= admitted.gateThreshold.value;
  return Object.freeze({
    metricRef: metric.ref,
    dimension: admitted.dimension,
    status: passed ? "passed" : "failed",
    observedValue,
    threshold: admitted.gateThreshold,
    reason: passed ? "Metric satisfies its gate." : "Metric does not satisfy its gate.",
  });
}

export function comparePairedEvaluationSamples(input: {
  readonly baselineTargetRef: EvaluationRecordRef;
  readonly candidateTargetRef: EvaluationRecordRef;
  readonly baseline: readonly EvaluationMetricSample[];
  readonly candidate: readonly EvaluationMetricSample[];
}): EvaluationPairedComparison {
  const baselineTargetRef = createEvaluationRecordRef(
    input.baselineTargetRef,
    "EvaluationPairedComparison.baselineTargetRef",
  );
  const candidateTargetRef = createEvaluationRecordRef(
    input.candidateTargetRef,
    "EvaluationPairedComparison.candidateTargetRef",
  );
  const baseline = indexPairedSamples(input.baseline, baselineTargetRef, "baseline");
  const candidate = indexPairedSamples(input.candidate, candidateTargetRef, "candidate");
  const keys = [...new Set([
    ...baseline.samples.keys(),
    ...candidate.samples.keys(),
  ])].sort(compareText);
  const pairs: EvaluationPairedDifference[] = [];
  const exclusions: EvaluationMetricExclusion[] = [
    ...baseline.exclusions,
    ...candidate.exclusions,
  ];
  for (const key of keys) {
    const left = baseline.samples.get(key);
    const right = candidate.samples.get(key);
    if (!left || !right) {
      exclusions.push(Object.freeze({
        trialRef: left?.trialRef ?? right?.trialRef ?? null,
        code: "paired_sample_unmatched",
        message: `Pair '${key}' is missing one side.`,
        details: Object.freeze({ pairingKey: key }),
      }));
      continue;
    }
    pairs.push(Object.freeze({
      pairingKey: left.pairingKey!,
      caseRef: left.caseRef,
      baselineTrialRef: left.trialRef,
      candidateTrialRef: right.trialRef,
      baselineValue: left.value,
      candidateValue: right.value,
      difference: right.value - left.value,
    }));
  }
  return Object.freeze({
    baselineTargetRef,
    candidateTargetRef,
    pairs: Object.freeze(pairs),
    exclusions: Object.freeze(exclusions.sort(compareExclusions)),
  });
}

function buildDistribution(
  aggregation: EvaluationMetricAggregation,
  samples: readonly EvaluationMetricSample[],
): EvaluationMetricDistribution {
  if (aggregation === "count") {
    const values = samples.map((sample) => sample.value as boolean);
    return Object.freeze({
      kind: "count",
      sampleCount: values.length,
      value: values.length === 0 ? null : values.filter(Boolean).length,
    });
  }
  if (aggregation === "rate") {
    const values = samples.map((sample) => sample.value as boolean);
    const positiveCount = values.filter(Boolean).length;
    return Object.freeze({
      kind: "rate",
      sampleCount: values.length,
      positiveCount,
      value: values.length === 0 ? null : positiveCount / values.length,
    });
  }
  const values = samples.map((sample) => sample.value as number).sort((a, b) => a - b);
  if (values.length === 0) {
    return Object.freeze({
      kind: "numeric_distribution",
      sampleCount: 0,
      minimum: null,
      maximum: null,
      mean: null,
      variance: null,
      varianceMethod: "sample",
      p50: null,
      p90: null,
      p95: null,
    });
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.length < 2
    ? null
    : values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (values.length - 1);
  return Object.freeze({
    kind: "numeric_distribution",
    sampleCount: values.length,
    minimum: values[0],
    maximum: values[values.length - 1],
    mean,
    variance,
    varianceMethod: "sample",
    p50: percentile(values, 0.5),
    p90: percentile(values, 0.9),
    p95: percentile(values, 0.95),
  });
}

function buildUncertainty(
  rule: EvaluationMetricUncertaintyRule,
  distribution: EvaluationMetricDistribution,
  samples: readonly EvaluationMetricSample[],
): EvaluationMetricUncertainty {
  if (rule.method === "none") {
    return Object.freeze({ status: "unavailable", method: "none", reason: "No uncertainty method declared." });
  }
  if (samples.length < rule.minimumSamples) {
    return Object.freeze({
      status: "unavailable",
      method: rule.method,
      reason: `At least ${rule.minimumSamples} samples are required.`,
    });
  }
  const confidence = rule.confidence!;
  if (rule.method === "wilson") {
    if (distribution.kind !== "rate" || distribution.value === null) {
      return Object.freeze({ status: "unavailable", method: "wilson", reason: "Wilson interval requires a rate." });
    }
    const z = normalZ(confidence);
    const n = distribution.sampleCount;
    const p = distribution.value;
    const denominator = 1 + (z * z) / n;
    const center = (p + (z * z) / (2 * n)) / denominator;
    const margin = (z / denominator) * Math.sqrt((p * (1 - p) / n) + (z * z) / (4 * n * n));
    return Object.freeze({
      status: "available",
      method: "wilson",
      confidence,
      lower: Math.max(0, center - margin),
      upper: Math.min(1, center + margin),
    });
  }
  if (distribution.kind !== "numeric_distribution" || distribution.mean === null || distribution.variance === null) {
    return Object.freeze({
      status: "unavailable",
      method: "standard_error",
      reason: "Standard error requires numeric samples.",
    });
  }
  const z = normalZ(confidence);
  const margin = z * Math.sqrt(distribution.variance / distribution.sampleCount);
  return Object.freeze({
    status: "available",
    method: "standard_error",
    confidence,
    lower: distribution.mean - margin,
    upper: distribution.mean + margin,
  });
}

function snapshotSample(
  input: EvaluationMetricSample,
  definition: EvaluationMetricDefinition,
  targetSnapshotRef: EvaluationRecordRef,
): EvaluationMetricSample {
  const targetRef = createEvaluationRecordRef(input?.targetSnapshotRef, "EvaluationMetricSample.targetSnapshotRef");
  if (!isEvaluationRefEqual(targetRef, targetSnapshotRef)) {
    throw new TypeError("Metric sample belongs to another Target Snapshot.");
  }
  const expectedBoolean = definition.aggregation === "count" || definition.aggregation === "rate";
  if (
    (expectedBoolean && typeof input.value !== "boolean") ||
    (!expectedBoolean && (typeof input.value !== "number" || !Number.isFinite(input.value)))
  ) throw new TypeError("Metric sample value does not match aggregation.");
  if (input.pairingKey !== null) assertToken(input.pairingKey, "EvaluationMetricSample.pairingKey");
  const trialStatus = snapshotMetricStatus(
    input.trialStatus,
    TRIAL_STATUSES,
    "EvaluationMetricSample.trialStatus",
  );
  if (!definition.requiredTrialStatuses.includes(trialStatus)) {
    throw new TypeError("Metric sample Trial status is not admitted by its definition.");
  }
  const captureStatus = snapshotMetricStatus(
    input.captureStatus,
    CAPTURE_STATUSES,
    "EvaluationMetricSample.captureStatus",
  );
  if (!definition.requiredCaptureStatuses.includes(captureStatus)) {
    throw new TypeError("Metric sample Capture status is not admitted by its definition.");
  }
  const source = snapshotMetricSampleSource(input.source);
  assertMetricSampleSource(source, definition);
  return Object.freeze({
    trialRef: createEvaluationRecordRef(input.trialRef, "EvaluationMetricSample.trialRef"),
    targetSnapshotRef: targetRef,
    caseRef: createEvaluationRecordRef(input.caseRef, "EvaluationMetricSample.caseRef"),
    pairingKey: input.pairingKey,
    captureRef: createEvaluationRecordRef(
      input.captureRef,
      "EvaluationMetricSample.captureRef",
    ),
    trialStatus,
    captureStatus,
    source,
    value: input.value,
  });
}

function snapshotMetricSampleSource(
  input: EvaluationMetricSampleSource,
): EvaluationMetricSampleSource {
  if (input?.kind === "grade") {
    const gradingStatus = snapshotMetricStatus(
      input.gradingStatus,
      GRADING_STATUSES,
      "EvaluationMetricSample.source.gradingStatus",
    );
    return Object.freeze({
      kind: "grade",
      gradeRef: createEvaluationRecordRef(
        input.gradeRef,
        "EvaluationMetricSample.source.gradeRef",
      ),
      criterionRef: createEvaluationRecordRef(
        input.criterionRef,
        "EvaluationMetricSample.source.criterionRef",
      ),
      gradingStatus,
    });
  }
  if (input?.kind === "measurement") {
    assertToken(input.measurementId, "EvaluationMetricSample.source.measurementId");
    assertToken(input.owner, "EvaluationMetricSample.source.owner");
    assertToken(input.unit, "EvaluationMetricSample.source.unit");
    if (typeof input.valid !== "boolean") {
      throw new TypeError("EvaluationMetricSample.source.valid must be boolean.");
    }
    return Object.freeze({
      kind: "measurement",
      measurementId: input.measurementId,
      owner: input.owner,
      unit: input.unit,
      valid: input.valid,
    });
  }
  throw new TypeError("EvaluationMetricSample.source is unsupported.");
}

function assertMetricSampleSource(
  source: EvaluationMetricSampleSource,
  definition: EvaluationMetricDefinition,
): void {
  if (source.kind !== definition.source.kind) {
    throw new TypeError("Metric sample source kind does not match its definition.");
  }
  if (source.kind === "grade" && definition.source.kind === "grade") {
    if (
      source.gradingStatus !== "graded" ||
      !definition.requiredGradingStatuses.includes(source.gradingStatus) ||
      !isEvaluationRefEqual(source.criterionRef, definition.source.criterionRef)
    ) {
      throw new TypeError("Metric sample Grade source is not admitted by its definition.");
    }
    return;
  }
  if (source.kind === "measurement" && definition.source.kind === "measurement") {
    if (
      !source.valid ||
      source.measurementId !== definition.source.measurementId ||
      source.owner !== definition.source.owner ||
      source.unit !== definition.unit
    ) {
      throw new TypeError("Metric sample measurement source is not admitted by its definition.");
    }
  }
}

function snapshotSource(input: EvaluationMetricSource): EvaluationMetricSource {
  if (input?.kind === "grade") {
    return Object.freeze({
      kind: "grade",
      criterionRef: createEvaluationRecordRef(
        input.criterionRef,
        "EvaluationMetricDefinition.source.criterionRef",
      ),
    });
  }
  if (input?.kind === "measurement") {
    assertToken(input.measurementId, "EvaluationMetricDefinition.source.measurementId");
    assertToken(input.owner, "EvaluationMetricDefinition.source.owner");
    return Object.freeze({ ...input });
  }
  throw new TypeError("EvaluationMetricDefinition.source is unsupported.");
}

function snapshotUncertaintyRule(
  input: EvaluationMetricUncertaintyRule,
  aggregation: EvaluationMetricAggregation,
): EvaluationMetricUncertaintyRule {
  if (!(["none", "wilson", "standard_error"] as const).includes(input?.method)) {
    throw new TypeError("Evaluation Metric uncertainty method is unsupported.");
  }
  assertPositiveInteger(input.minimumSamples, "EvaluationMetricUncertaintyRule.minimumSamples");
  if (input.method === "none") {
    if (input.confidence !== null) throw new TypeError("No uncertainty method must not declare confidence.");
  } else if (
    input.confidence === null ||
    !Number.isFinite(input.confidence) ||
    input.confidence <= 0 ||
    input.confidence >= 1
  ) throw new TypeError("Evaluation Metric confidence must be between zero and one.");
  if (input.method === "wilson" && aggregation !== "rate") {
    throw new TypeError("Wilson uncertainty requires rate aggregation.");
  }
  if (input.method === "standard_error" && aggregation !== "numeric_distribution") {
    throw new TypeError("Standard-error uncertainty requires numeric distribution.");
  }
  return Object.freeze({ ...input });
}

function snapshotGateThreshold(
  input: EvaluationMetricGateThreshold | null,
  role: EvaluationMetricDefinition["role"],
): EvaluationMetricGateThreshold | null {
  if (role === "informational") {
    if (input !== null) throw new TypeError("Informational Metric must not declare a gate threshold.");
    return null;
  }
  if (
    input === null ||
    (input.comparison !== "at_least" && input.comparison !== "at_most") ||
    !Number.isFinite(input.value)
  ) throw new TypeError("Gate Metric requires a finite threshold.");
  return Object.freeze({ ...input });
}

function snapshotExclusion(input: EvaluationMetricExclusion): EvaluationMetricExclusion {
  assertToken(input?.code, "EvaluationMetricExclusion.code");
  assertText(input.message, "EvaluationMetricExclusion.message", 1_024);
  return Object.freeze({
    trialRef: input.trialRef === null
      ? null
      : createEvaluationRecordRef(input.trialRef, "EvaluationMetricExclusion.trialRef"),
    code: input.code,
    message: input.message,
    details: snapshotEvaluationDataObject(input.details, "EvaluationMetricExclusion.details"),
  });
}

function invalidSampleExclusion(
  trialRef: EvaluationRecordRef | null,
  message: string,
): EvaluationMetricExclusion {
  return Object.freeze({
    trialRef: trialRef === null ? null : createEvaluationRecordRef(trialRef),
    code: "metric_sample_invalid",
    message,
    details: Object.freeze({}),
  });
}

function undeclaredExclusion(
  input: EvaluationMetricExclusion,
): EvaluationMetricExclusion {
  return Object.freeze({
    trialRef: input.trialRef,
    code: "metric_exclusion_undeclared",
    message: `Exclusion code '${input.code}' is not declared by the Metric definition.`,
    details: Object.freeze({ suppliedCode: input.code }),
  });
}

function duplicateTrialExclusion(
  trialRef: EvaluationRecordRef,
): EvaluationMetricExclusion {
  return Object.freeze({
    trialRef,
    code: "metric_trial_duplicated",
    message: "Multiple Metric samples were supplied for one Trial revision.",
    details: Object.freeze({}),
  });
}

function safeRecordRef(input: unknown): EvaluationRecordRef | null {
  try {
    return createEvaluationRecordRef(input as EvaluationRecordRef);
  } catch {
    return null;
  }
}

function indexPairedSamples(
  samples: readonly EvaluationMetricSample[],
  targetRef: EvaluationRecordRef,
  side: string,
): {
  readonly samples: Map<string, EvaluationPairedMetricSample>;
  readonly exclusions: readonly EvaluationMetricExclusion[];
} {
  const result = new Map<string, EvaluationPairedMetricSample>();
  const exclusions: EvaluationMetricExclusion[] = [];
  const duplicatedKeys = new Set<string>();
  for (const input of samples) {
    let sample: EvaluationPairedMetricSample;
    try {
      sample = snapshotPairedSample(input, targetRef, side);
    } catch (error) {
      exclusions.push(invalidSampleExclusion(
        safeRecordRef(input?.trialRef),
        error instanceof Error ? error.message : `${side} paired sample is invalid.`,
      ));
      continue;
    }
    const key = `${evaluationRefKey(sample.caseRef)}:${sample.pairingKey}`;
    if (result.has(key) || duplicatedKeys.has(key)) {
      result.delete(key);
      if (!duplicatedKeys.has(key)) {
        exclusions.push(Object.freeze({
          trialRef: sample.trialRef,
          code: "paired_sample_duplicated",
          message: `${side} paired sample key '${key}' is duplicated.`,
          details: Object.freeze({ pairingKey: sample.pairingKey! }),
        }));
        duplicatedKeys.add(key);
      }
      continue;
    }
    result.set(key, sample);
  }
  return { samples: result, exclusions: Object.freeze(exclusions) };
}

function snapshotPairedSample(
  input: EvaluationMetricSample,
  targetRef: EvaluationRecordRef,
  side: string,
): EvaluationPairedMetricSample {
  const trialRef = createEvaluationRecordRef(input?.trialRef, `${side}.trialRef`);
  const sampleTargetRef = createEvaluationRecordRef(
    input.targetSnapshotRef,
    `${side}.targetSnapshotRef`,
  );
  if (!isEvaluationRefEqual(sampleTargetRef, targetRef)) {
    throw new TypeError(`${side} paired sample belongs to another Target Snapshot.`);
  }
  if (input.pairingKey === null) {
    throw new TypeError(`${side} paired sample has no pairing key.`);
  }
  assertToken(input.pairingKey, `${side}.pairingKey`);
  if (typeof input.value !== "number" || !Number.isFinite(input.value)) {
    throw new TypeError(`${side} paired sample is not numeric.`);
  }
  return Object.freeze({
    trialRef,
    targetSnapshotRef: sampleTargetRef,
    caseRef: createEvaluationRecordRef(input.caseRef, `${side}.caseRef`),
    pairingKey: input.pairingKey,
    captureRef: createEvaluationRecordRef(input.captureRef, `${side}.captureRef`),
    trialStatus: snapshotMetricStatus(
      input.trialStatus,
      TRIAL_STATUSES,
      `${side}.trialStatus`,
    ),
    captureStatus: snapshotMetricStatus(
      input.captureStatus,
      CAPTURE_STATUSES,
      `${side}.captureStatus`,
    ),
    source: snapshotMetricSampleSource(input.source),
    value: input.value,
  });
}

function distributionValue(distribution: EvaluationMetricDistribution): number | null {
  if (distribution.kind === "numeric_distribution") return distribution.mean;
  return distribution.value;
}

function percentile(values: readonly number[], percentileValue: number): number {
  const index = (values.length - 1) * percentileValue;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return values[lower];
  return values[lower] + (values[upper] - values[lower]) * (index - lower);
}

function normalZ(confidence: number): number {
  return inverseStandardNormal(0.5 + confidence / 2);
}

function inverseStandardNormal(probability: number): number {
  const a = [
    -3.969683028665376e1,
    2.209460984245205e2,
    -2.759285104469687e2,
    1.38357751867269e2,
    -3.066479806614716e1,
    2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1,
    1.615858368580409e2,
    -1.556989798598866e2,
    6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3,
    -3.223964580411365e-1,
    -2.400758277161838,
    -2.549732539343734,
    4.374664141464968,
    2.938163982698783,
  ];
  const d = [
    7.784695709041462e-3,
    3.224671290700398e-1,
    2.445134137142996,
    3.754408661907416,
  ];
  const low = 0.02425;
  const high = 1 - low;
  if (probability < low) {
    const q = Math.sqrt(-2 * Math.log(probability));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (probability > high) {
    const q = Math.sqrt(-2 * Math.log(1 - probability));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = probability - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function compareSamples(left: EvaluationMetricSample, right: EvaluationMetricSample): number {
  return compareText(evaluationRefKey(left.trialRef), evaluationRefKey(right.trialRef));
}

function compareExclusions(
  left: EvaluationMetricExclusion,
  right: EvaluationMetricExclusion,
): number {
  return compareText(
    `${left.code}:${left.trialRef ? evaluationRefKey(left.trialRef) : ""}`,
    `${right.code}:${right.trialRef ? evaluationRefKey(right.trialRef) : ""}`,
  );
}

function uniqueTokens(
  input: readonly string[],
  path: string,
  allowEmpty = false,
): readonly string[] {
  assertArray(input, path);
  const values = input.map((item, index) => {
    assertToken(item, `${path}[${index}]`);
    return item;
  });
  if ((!allowEmpty && values.length === 0) || new Set(values).size !== values.length) {
    throw new TypeError(`${path} must be ${allowEmpty ? "unique" : "non-empty and unique"}.`);
  }
  return Object.freeze([...values].sort(compareText));
}

function uniqueStatuses<TStatus extends string>(
  input: readonly TStatus[],
  admitted: readonly TStatus[],
  path: string,
  allowEmpty = false,
): readonly TStatus[] {
  assertArray(input, path);
  const values = input.map((item, index) => {
    if (!admitted.includes(item)) {
      throw new TypeError(`${path}[${index}] is unsupported.`);
    }
    return item;
  });
  if ((!allowEmpty && values.length === 0) || new Set(values).size !== values.length) {
    throw new TypeError(`${path} must be ${allowEmpty ? "unique" : "non-empty and unique"}.`);
  }
  return Object.freeze([...values].sort(compareText));
}

function snapshotMetricStatus<TStatus extends string>(
  input: TStatus,
  admitted: readonly TStatus[],
  path: string,
): TStatus {
  if (!admitted.includes(input)) throw new TypeError(`${path} is unsupported.`);
  return input;
}

const TRIAL_STATUSES: readonly EvaluationMetricTrialStatus[] = Object.freeze([
  "completed",
  "partial",
  "invalid",
  "infrastructure_failed",
  "invocation_failed",
  "capture_failed",
  "cancelled",
  "timed_out",
]);

const CAPTURE_STATUSES: readonly EvaluationMetricCaptureStatus[] = Object.freeze([
  "complete",
  "partial",
  "failed",
]);

const GRADING_STATUSES: readonly EvaluationMetricGradingStatus[] = Object.freeze([
  "graded",
  "invalid",
  "unavailable",
  "failed",
  "cancelled",
  "timed_out",
]);

function assertDimension(value: EvaluationDimension): void {
  if (!([
    "outcome_quality",
    "safety",
    "reliability",
    "collaboration",
    "trajectory",
    "final_communication",
    "diagnostic_quality",
    "efficiency",
  ] as const).includes(value)) throw new TypeError("EvaluationMetricDefinition.dimension is unsupported.");
}
