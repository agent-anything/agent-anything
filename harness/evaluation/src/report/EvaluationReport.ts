import {
  compareText,
  snapshotEvaluationDataObject,
  type EvaluationDataObject,
} from "../contract/EvaluationData.js";
import {
  assertArray,
  assertIsoTime,
  assertText,
  assertToken,
  createEvaluationFailure,
  createEvaluationRecordRef,
  evaluationRefKey,
  snapshotLimitations,
  snapshotRefs,
  type EvaluationFailure,
  type EvaluationLimitation,
  type EvaluationRecordRef,
} from "../contract/EvaluationPrimitives.js";
import type { EvaluationDimension } from "../definition/EvaluationDefinition.js";
import type {
  EvaluationMetricDistribution,
  EvaluationMetricExclusion,
  EvaluationMetricGateOutcome,
  EvaluationMetricUncertainty,
} from "../metrics/EvaluationMetrics.js";

export type EvaluationReportIntent = "baseline" | "comparison" | "regression";

export type EvaluationDimensionInterpretation =
  | "improved"
  | "stable"
  | "regressed"
  | "unavailable"
  | "gated";

export interface EvaluationDimensionSummary {
  readonly dimension: EvaluationDimension;
  readonly interpretation: EvaluationDimensionInterpretation;
  readonly metricRefs: readonly EvaluationRecordRef[];
  readonly rationale: string;
}

export interface EvaluationComparability {
  readonly status: "comparable" | "incomparable";
  readonly basis: EvaluationDataObject;
  readonly differences: readonly string[];
  readonly reason: string;
}

export interface EvaluationMissingDataRecord {
  readonly code: string;
  readonly message: string;
  readonly recordRef: EvaluationRecordRef | null;
  readonly details: EvaluationDataObject;
}

export interface EvaluationReportMetricSummary {
  readonly metricRef: EvaluationRecordRef;
  readonly dimension: EvaluationDimension;
  readonly distribution: EvaluationMetricDistribution;
  readonly uncertainty: EvaluationMetricUncertainty;
}

export interface EvaluationGraderDisagreement {
  readonly group: string;
  readonly gradeRefs: readonly EvaluationRecordRef[];
  readonly status: "resolved" | "unresolved";
  readonly summary: string;
  readonly limitations: readonly EvaluationLimitation[];
}

export interface EvaluationReport {
  readonly ref: EvaluationRecordRef;
  readonly intent: EvaluationReportIntent;
  readonly objectiveRef: EvaluationRecordRef;
  readonly targetSnapshotRefs: readonly EvaluationRecordRef[];
  readonly suiteRef: EvaluationRecordRef;
  readonly campaignRef: EvaluationRecordRef;
  readonly captureRefs: readonly EvaluationRecordRef[];
  readonly graderRefs: readonly EvaluationRecordRef[];
  readonly gradeRefs: readonly EvaluationRecordRef[];
  readonly metricRefs: readonly EvaluationRecordRef[];
  readonly metricSummaries: readonly EvaluationReportMetricSummary[];
  readonly dimensionSummaries: readonly EvaluationDimensionSummary[];
  readonly disagreements: readonly EvaluationGraderDisagreement[];
  readonly gateOutcomes: readonly EvaluationMetricGateOutcome[];
  readonly failures: readonly EvaluationFailure[];
  readonly exclusions: readonly EvaluationMetricExclusion[];
  readonly missingData: readonly EvaluationMissingDataRecord[];
  readonly comparability: EvaluationComparability;
  readonly supersedes: EvaluationRecordRef | null;
  readonly createdAt: string;
  readonly metadata: EvaluationDataObject;
  readonly limitations: readonly EvaluationLimitation[];
}

export interface EvaluationBaselineAcceptance {
  readonly ref: EvaluationRecordRef;
  readonly reportRef: EvaluationRecordRef;
  readonly acceptedBy: EvaluationRecordRef;
  readonly acceptedAt: string;
  readonly scope: EvaluationDataObject;
  readonly rationale: string;
  readonly tolerances: EvaluationDataObject;
  readonly supersedes: EvaluationRecordRef | null;
  readonly limitations: readonly EvaluationLimitation[];
}

export interface EvaluationReportPublicationProjection {
  readonly reportRef: EvaluationRecordRef;
  readonly intent: EvaluationReportIntent;
  readonly targetSnapshotRefs: readonly EvaluationRecordRef[];
  readonly metricSummaries: readonly EvaluationReportMetricSummary[];
  readonly dimensionSummaries: readonly EvaluationDimensionSummary[];
  readonly disagreements: readonly EvaluationGraderDisagreement[];
  readonly gateOutcomes: readonly EvaluationMetricGateOutcome[];
  readonly failureCodes: readonly string[];
  readonly exclusionCodes: readonly string[];
  readonly missingDataCodes: readonly string[];
  readonly comparability: EvaluationComparability;
  readonly limitations: readonly EvaluationLimitation[];
}

export function createEvaluationReport(input: EvaluationReport): EvaluationReport {
  if (!(["baseline", "comparison", "regression"] as const).includes(input?.intent)) {
    throw new TypeError("EvaluationReport.intent is unsupported.");
  }
  const targetSnapshotRefs = sortedRequiredRefs(
    input.targetSnapshotRefs,
    "EvaluationReport.targetSnapshotRefs",
  );
  if (input.intent === "baseline" && targetSnapshotRefs.length !== 1) {
    throw new TypeError("Baseline Report requires exactly one Target Snapshot.");
  }
  if (input.intent !== "baseline" && targetSnapshotRefs.length < 2) {
    throw new TypeError("Comparison and regression Reports require at least two Target Snapshots.");
  }
  const gradeRefs = sortedRefs(input.gradeRefs, "EvaluationReport.gradeRefs");
  const metricRefs = sortedRequiredRefs(input.metricRefs, "EvaluationReport.metricRefs");
  const metricSummaries = snapshotMetricSummaries(input.metricSummaries, metricRefs);
  const comparability = snapshotComparability(input.comparability);
  if (input.intent === "baseline" && comparability.status !== "comparable") {
    throw new TypeError("Baseline Report must be internally comparable.");
  }
  const gateOutcomes = snapshotGateOutcomes(
    input.gateOutcomes,
    metricRefs,
    metricSummaries,
  );
  const admittedDimensionSummaries = snapshotDimensionSummaries(
    input.dimensionSummaries,
    metricRefs,
    metricSummaries,
  );
  if (
    comparability.status === "incomparable" &&
    admittedDimensionSummaries.some((summary) => summary.interpretation !== "unavailable")
  ) {
    throw new TypeError("An incomparable Evaluation Report cannot claim dimension direction.");
  }
  const dimensionSummaries = applyGatePrecedence(
    admittedDimensionSummaries,
    gateOutcomes,
  );
  const reportRef = createEvaluationRecordRef(input.ref, "EvaluationReport.ref");
  const supersedes = input.supersedes === null
    ? null
    : createEvaluationRecordRef(input.supersedes, "EvaluationReport.supersedes");
  if (supersedes !== null && evaluationRefKey(supersedes) === evaluationRefKey(reportRef)) {
    throw new TypeError("Evaluation Report cannot supersede itself.");
  }
  assertIsoTime(input.createdAt, "EvaluationReport.createdAt");
  return Object.freeze({
    ref: reportRef,
    intent: input.intent,
    objectiveRef: createEvaluationRecordRef(input.objectiveRef, "EvaluationReport.objectiveRef"),
    targetSnapshotRefs,
    suiteRef: createEvaluationRecordRef(input.suiteRef, "EvaluationReport.suiteRef"),
    campaignRef: createEvaluationRecordRef(input.campaignRef, "EvaluationReport.campaignRef"),
    captureRefs: sortedRefs(input.captureRefs, "EvaluationReport.captureRefs"),
    graderRefs: sortedRequiredRefs(input.graderRefs, "EvaluationReport.graderRefs"),
    gradeRefs,
    metricRefs,
    metricSummaries,
    dimensionSummaries,
    disagreements: snapshotDisagreements(input.disagreements, gradeRefs),
    gateOutcomes,
    failures: Object.freeze(input.failures.map(createEvaluationFailure).sort((left, right) =>
      compareText(`${left.code}:${left.message}`, `${right.code}:${right.message}`))),
    exclusions: snapshotExclusions(input.exclusions),
    missingData: snapshotMissingData(input.missingData),
    comparability,
    supersedes,
    createdAt: input.createdAt,
    metadata: snapshotEvaluationDataObject(input.metadata, "EvaluationReport.metadata"),
    limitations: snapshotLimitations(input.limitations, "EvaluationReport.limitations"),
  });
}

export function createEvaluationBaselineAcceptance(
  input: EvaluationBaselineAcceptance,
  report: EvaluationReport,
): EvaluationBaselineAcceptance {
  if (report.intent !== "baseline") {
    throw new TypeError("Evaluation Baseline acceptance requires a baseline Report.");
  }
  if (
    input?.reportRef.id !== report.ref.id ||
    input.reportRef.revision !== report.ref.revision
  ) {
    throw new TypeError("Evaluation Baseline acceptance references another Report revision.");
  }
  assertIsoTime(input?.acceptedAt, "EvaluationBaselineAcceptance.acceptedAt");
  assertText(input.rationale, "EvaluationBaselineAcceptance.rationale", 4_096);
  const acceptanceRef = createEvaluationRecordRef(
    input.ref,
    "EvaluationBaselineAcceptance.ref",
  );
  const supersedes = input.supersedes === null
    ? null
    : createEvaluationRecordRef(
        input.supersedes,
        "EvaluationBaselineAcceptance.supersedes",
      );
  if (supersedes !== null && evaluationRefKey(supersedes) === evaluationRefKey(acceptanceRef)) {
    throw new TypeError("Evaluation Baseline acceptance cannot supersede itself.");
  }
  return Object.freeze({
    ref: acceptanceRef,
    reportRef: createEvaluationRecordRef(
      input.reportRef,
      "EvaluationBaselineAcceptance.reportRef",
    ),
    acceptedBy: createEvaluationRecordRef(
      input.acceptedBy,
      "EvaluationBaselineAcceptance.acceptedBy",
    ),
    acceptedAt: input.acceptedAt,
    scope: snapshotEvaluationDataObject(input.scope, "EvaluationBaselineAcceptance.scope"),
    rationale: input.rationale,
    tolerances: snapshotEvaluationDataObject(
      input.tolerances,
      "EvaluationBaselineAcceptance.tolerances",
    ),
    supersedes,
    limitations: snapshotLimitations(
      input.limitations,
      "EvaluationBaselineAcceptance.limitations",
    ),
  });
}

export function projectEvaluationReportForPublication(
  report: EvaluationReport,
): EvaluationReportPublicationProjection {
  return Object.freeze({
    reportRef: report.ref,
    intent: report.intent,
    targetSnapshotRefs: report.targetSnapshotRefs,
    metricSummaries: report.metricSummaries,
    dimensionSummaries: report.dimensionSummaries,
    disagreements: report.disagreements,
    gateOutcomes: report.gateOutcomes,
    failureCodes: Object.freeze([...new Set(report.failures.map((item) => item.code))].sort(compareText)),
    exclusionCodes: Object.freeze([...new Set(report.exclusions.map((item) => item.code))].sort(compareText)),
    missingDataCodes: Object.freeze([...new Set(report.missingData.map((item) => item.code))].sort(compareText)),
    comparability: report.comparability,
    limitations: report.limitations,
  });
}

function snapshotMetricSummaries(
  input: readonly EvaluationReportMetricSummary[],
  metricRefs: readonly EvaluationRecordRef[],
): readonly EvaluationReportMetricSummary[] {
  assertArray(input, "EvaluationReport.metricSummaries");
  const admitted = new Set(metricRefs.map(evaluationRefKey));
  const seen = new Set<string>();
  const summaries = input.map((summary, index) => {
    const path = `EvaluationReport.metricSummaries[${index}]`;
    const metricRef = createEvaluationRecordRef(summary?.metricRef, `${path}.metricRef`);
    const key = evaluationRefKey(metricRef);
    if (!admitted.has(key) || seen.has(key)) {
      throw new TypeError(`Report Metric summary ref '${key}' is not admitted or is duplicated.`);
    }
    seen.add(key);
    assertDimension(summary.dimension);
    const distribution = snapshotDistribution(summary.distribution, `${path}.distribution`);
    const uncertainty = snapshotMetricUncertainty(summary.uncertainty, `${path}.uncertainty`);
    assertMetricSummaryConsistency(distribution, uncertainty, path);
    return Object.freeze({
      metricRef,
      dimension: summary.dimension,
      distribution,
      uncertainty,
    });
  });
  if (seen.size !== admitted.size) {
    throw new TypeError("EvaluationReport requires one summary for every Metric ref.");
  }
  return Object.freeze(summaries.sort((left, right) =>
    compareText(evaluationRefKey(left.metricRef), evaluationRefKey(right.metricRef))));
}

function snapshotDisagreements(
  input: readonly EvaluationGraderDisagreement[],
  reportGradeRefs: readonly EvaluationRecordRef[],
): readonly EvaluationGraderDisagreement[] {
  assertArray(input, "EvaluationReport.disagreements");
  const admitted = new Set(reportGradeRefs.map(evaluationRefKey));
  const groups = new Set<string>();
  const disagreements = input.map((item, index) => {
    const path = `EvaluationReport.disagreements[${index}]`;
    assertToken(item?.group, `${path}.group`);
    if (groups.has(item.group)) throw new TypeError(`Disagreement group '${item.group}' is duplicated.`);
    groups.add(item.group);
    const gradeRefs = sortedRequiredRefs(item.gradeRefs, `${path}.gradeRefs`);
    if (gradeRefs.length < 2 || gradeRefs.some((ref) => !admitted.has(evaluationRefKey(ref)))) {
      throw new TypeError(`Disagreement group '${item.group}' requires admitted Grade refs.`);
    }
    if (item.status !== "resolved" && item.status !== "unresolved") {
      throw new TypeError(`${path}.status is unsupported.`);
    }
    assertText(item.summary, `${path}.summary`, 2_048);
    return Object.freeze({
      group: item.group,
      gradeRefs,
      status: item.status,
      summary: item.summary,
      limitations: snapshotLimitations(item.limitations, `${path}.limitations`),
    });
  });
  return Object.freeze(disagreements.sort((left, right) => compareText(left.group, right.group)));
}

function snapshotDistribution(
  input: EvaluationMetricDistribution,
  path: string,
): EvaluationMetricDistribution {
  if (input?.kind === "count") {
    assertNonNegativeInteger(input.sampleCount, `${path}.sampleCount`);
    assertNullableFinite(input.value, `${path}.value`);
    if (
      (input.sampleCount === 0 && input.value !== null) ||
      (input.sampleCount > 0 && (
        input.value === null ||
        !Number.isSafeInteger(input.value) ||
        input.value < 0 ||
        input.value > input.sampleCount
      ))
    ) throw new TypeError(`${path} count values are inconsistent.`);
    return Object.freeze({ ...input });
  }
  if (input?.kind === "rate") {
    assertNonNegativeInteger(input.sampleCount, `${path}.sampleCount`);
    assertNonNegativeInteger(input.positiveCount, `${path}.positiveCount`);
    if (input.positiveCount > input.sampleCount) throw new TypeError(`${path}.positiveCount is invalid.`);
    assertNullableFinite(input.value, `${path}.value`);
    const expectedValue = input.sampleCount === 0
      ? null
      : input.positiveCount / input.sampleCount;
    if (input.value !== expectedValue) throw new TypeError(`${path} rate values are inconsistent.`);
    return Object.freeze({ ...input });
  }
  if (input?.kind === "numeric_distribution") {
    assertNonNegativeInteger(input.sampleCount, `${path}.sampleCount`);
    if (input.varianceMethod !== "sample") {
      throw new TypeError(`${path}.varianceMethod is unsupported.`);
    }
    for (const [name, value] of Object.entries({
      minimum: input.minimum,
      maximum: input.maximum,
      mean: input.mean,
      variance: input.variance,
      p50: input.p50,
      p90: input.p90,
      p95: input.p95,
    })) assertNullableFinite(value, `${path}.${name}`);
    const values = [input.minimum, input.maximum, input.mean, input.p50, input.p90, input.p95];
    if (
      (input.sampleCount === 0 && values.some((value) => value !== null)) ||
      (input.sampleCount > 0 && values.some((value) => value === null)) ||
      (input.sampleCount < 2 && input.variance !== null) ||
      (input.sampleCount >= 2 && (input.variance === null || input.variance < 0))
    ) {
      throw new TypeError(`${path} numeric values are inconsistent with sample count.`);
    }
    if (
      input.sampleCount > 0 &&
      !(
        input.minimum! <= input.mean! &&
        input.mean! <= input.maximum! &&
        input.minimum! <= input.p50! &&
        input.p50! <= input.p90! &&
        input.p90! <= input.p95! &&
        input.p95! <= input.maximum!
      )
    ) {
      throw new TypeError(`${path} numeric order is inconsistent.`);
    }
    return Object.freeze({ ...input });
  }
  throw new TypeError(`${path}.kind is unsupported.`);
}

function snapshotMetricUncertainty(
  input: EvaluationMetricUncertainty,
  path: string,
): EvaluationMetricUncertainty {
  if (input?.status === "unavailable") {
    if (!(["none", "wilson", "standard_error"] as const).includes(input.method)) {
      throw new TypeError(`${path}.method is unsupported.`);
    }
    assertText(input.reason, `${path}.reason`, 1_024);
    return Object.freeze({ ...input });
  }
  if (input?.status !== "available") throw new TypeError(`${path}.status is unsupported.`);
  if (input.method !== "wilson" && input.method !== "standard_error") {
    throw new TypeError(`${path}.method is unsupported.`);
  }
  if (
    !Number.isFinite(input.confidence) ||
    input.confidence <= 0 ||
    input.confidence >= 1 ||
    !Number.isFinite(input.lower) ||
    !Number.isFinite(input.upper) ||
    input.lower > input.upper
  ) throw new TypeError(`${path} interval is invalid.`);
  return Object.freeze({ ...input });
}

function assertMetricSummaryConsistency(
  distribution: EvaluationMetricDistribution,
  uncertainty: EvaluationMetricUncertainty,
  path: string,
): void {
  const compatible = uncertainty.method === "none" ||
    (distribution.kind === "rate" && uncertainty.method === "wilson") ||
    (
      distribution.kind === "numeric_distribution" &&
      uncertainty.method === "standard_error"
    );
  if (!compatible) throw new TypeError(`${path} uncertainty method does not match distribution.`);
  if (uncertainty.status !== "available") return;
  const center = distribution.kind === "numeric_distribution"
    ? distribution.mean
    : distribution.kind === "rate"
      ? distribution.value
      : null;
  if (
    center === null ||
    uncertainty.lower > center ||
    uncertainty.upper < center
  ) {
    throw new TypeError(`${path} uncertainty interval does not contain its estimate.`);
  }
}

function assertNonNegativeInteger(value: number, path: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${path} must be non-negative.`);
}

function assertNullableFinite(value: number | null, path: string): void {
  if (value !== null && !Number.isFinite(value)) throw new TypeError(`${path} must be finite or null.`);
}

function snapshotDimensionSummaries(
  input: readonly EvaluationDimensionSummary[],
  metricRefs: readonly EvaluationRecordRef[],
  metricSummaries: readonly EvaluationReportMetricSummary[],
): readonly EvaluationDimensionSummary[] {
  assertArray(input, "EvaluationReport.dimensionSummaries");
  const seen = new Set<EvaluationDimension>();
  const admitted = new Map(metricRefs.map((ref) => [evaluationRefKey(ref), ref]));
  const metricDimensions = new Map(metricSummaries.map((summary) => [
    evaluationRefKey(summary.metricRef),
    summary.dimension,
  ]));
  const assigned = new Set<string>();
  const result = input.map((summary, index) => {
    assertDimension(summary?.dimension);
    if (seen.has(summary.dimension)) throw new TypeError(`Dimension '${summary.dimension}' is duplicated.`);
    seen.add(summary.dimension);
    if (!(["improved", "stable", "regressed", "unavailable", "gated"] as const).includes(summary.interpretation)) {
      throw new TypeError(`EvaluationReport.dimensionSummaries[${index}].interpretation is unsupported.`);
    }
    assertText(summary.rationale, `EvaluationReport.dimensionSummaries[${index}].rationale`, 2_048);
    const summaryMetricRefs = snapshotRefs(
      summary.metricRefs,
      `EvaluationReport.dimensionSummaries[${index}].metricRefs`,
    );
    if (summaryMetricRefs.length === 0) {
      throw new TypeError(`Dimension '${summary.dimension}' requires at least one Metric ref.`);
    }
    for (const metricRef of summaryMetricRefs) {
      const key = evaluationRefKey(metricRef);
      if (
        !admitted.has(key) ||
        assigned.has(key) ||
        metricDimensions.get(key) !== summary.dimension
      ) {
        throw new TypeError(`Dimension '${summary.dimension}' has an invalid Metric ref '${key}'.`);
      }
      assigned.add(key);
    }
    return Object.freeze({
      dimension: summary.dimension,
      interpretation: summary.interpretation,
      metricRefs: Object.freeze([...summaryMetricRefs].sort((left, right) =>
        compareText(evaluationRefKey(left), evaluationRefKey(right)))),
      rationale: summary.rationale,
    });
  });
  if (assigned.size !== admitted.size) {
    throw new TypeError("EvaluationReport requires one dimension assignment for every Metric ref.");
  }
  return Object.freeze(result.sort((left, right) => compareText(left.dimension, right.dimension)));
}

function applyGatePrecedence(
  summaries: readonly EvaluationDimensionSummary[],
  gates: readonly EvaluationMetricGateOutcome[],
): readonly EvaluationDimensionSummary[] {
  const blocking = gates.some((gate) =>
    (gate.dimension === "outcome_quality" || gate.dimension === "safety") &&
    gate.status !== "passed");
  if (!blocking) return summaries;
  return Object.freeze(summaries.map((summary) =>
    summary.dimension === "efficiency" && summary.interpretation === "improved"
      ? Object.freeze({
          ...summary,
          interpretation: "gated" as const,
          rationale: "Efficiency improvement is gated by outcome-quality or safety results.",
        })
      : summary));
}

function snapshotGateOutcomes(
  input: readonly EvaluationMetricGateOutcome[],
  metricRefs: readonly EvaluationRecordRef[],
  metricSummaries: readonly EvaluationReportMetricSummary[],
): readonly EvaluationMetricGateOutcome[] {
  assertArray(input, "EvaluationReport.gateOutcomes");
  const admitted = new Set(metricRefs.map(evaluationRefKey));
  const dimensions = new Map(metricSummaries.map((summary) => [
    evaluationRefKey(summary.metricRef),
    summary.dimension,
  ]));
  const seen = new Set<string>();
  return Object.freeze(input.map((gate, index) => {
    assertDimension(gate?.dimension);
    if (!(["passed", "failed", "unavailable"] as const).includes(gate.status)) {
      throw new TypeError(`EvaluationReport.gateOutcomes[${index}].status is unsupported.`);
    }
    if (gate.observedValue !== null && !Number.isFinite(gate.observedValue)) {
      throw new TypeError(`EvaluationReport.gateOutcomes[${index}].observedValue is invalid.`);
    }
    if (
      (gate.threshold.comparison !== "at_least" && gate.threshold.comparison !== "at_most") ||
      !Number.isFinite(gate.threshold.value)
    ) throw new TypeError(`EvaluationReport.gateOutcomes[${index}].threshold is invalid.`);
    assertText(gate.reason, `EvaluationReport.gateOutcomes[${index}].reason`, 1_024);
    const metricRef = createEvaluationRecordRef(
      gate.metricRef,
      `EvaluationReport.gateOutcomes[${index}].metricRef`,
    );
    const key = evaluationRefKey(metricRef);
    if (!admitted.has(key) || seen.has(key) || dimensions.get(key) !== gate.dimension) {
      throw new TypeError(`Evaluation Report gate Metric ref '${key}' is invalid or duplicated.`);
    }
    seen.add(key);
    return Object.freeze({
      metricRef,
      dimension: gate.dimension,
      status: gate.status,
      observedValue: gate.observedValue,
      threshold: Object.freeze({ ...gate.threshold }),
      reason: gate.reason,
    });
  }).sort((left, right) => compareText(evaluationRefKey(left.metricRef), evaluationRefKey(right.metricRef))));
}

function snapshotComparability(input: EvaluationComparability): EvaluationComparability {
  if (input?.status !== "comparable" && input?.status !== "incomparable") {
    throw new TypeError("EvaluationComparability.status is unsupported.");
  }
  assertText(input.reason, "EvaluationComparability.reason", 2_048);
  const differences = uniqueTokens(input.differences, "EvaluationComparability.differences", true);
  if (input.status === "incomparable" && differences.length === 0) {
    throw new TypeError("Incomparable Evaluation Report requires declared differences.");
  }
  return Object.freeze({
    status: input.status,
    basis: snapshotEvaluationDataObject(input.basis, "EvaluationComparability.basis"),
    differences,
    reason: input.reason,
  });
}

function snapshotExclusions(
  input: readonly EvaluationMetricExclusion[],
): readonly EvaluationMetricExclusion[] {
  assertArray(input, "EvaluationReport.exclusions");
  return Object.freeze(input.map((item, index) => {
    assertToken(item?.code, `EvaluationReport.exclusions[${index}].code`);
    assertText(item.message, `EvaluationReport.exclusions[${index}].message`, 1_024);
    return Object.freeze({
      trialRef: item.trialRef === null
        ? null
        : createEvaluationRecordRef(item.trialRef, `EvaluationReport.exclusions[${index}].trialRef`),
      code: item.code,
      message: item.message,
      details: snapshotEvaluationDataObject(
        item.details,
        `EvaluationReport.exclusions[${index}].details`,
      ),
    });
  }).sort((left, right) => compareText(
    `${left.code}:${left.trialRef ? evaluationRefKey(left.trialRef) : ""}`,
    `${right.code}:${right.trialRef ? evaluationRefKey(right.trialRef) : ""}`,
  )));
}

function snapshotMissingData(
  input: readonly EvaluationMissingDataRecord[],
): readonly EvaluationMissingDataRecord[] {
  assertArray(input, "EvaluationReport.missingData");
  return Object.freeze(input.map((item, index) => {
    assertToken(item?.code, `EvaluationReport.missingData[${index}].code`);
    assertText(item.message, `EvaluationReport.missingData[${index}].message`, 1_024);
    return Object.freeze({
      code: item.code,
      message: item.message,
      recordRef: item.recordRef === null
        ? null
        : createEvaluationRecordRef(item.recordRef, `EvaluationReport.missingData[${index}].recordRef`),
      details: snapshotEvaluationDataObject(
        item.details,
        `EvaluationReport.missingData[${index}].details`,
      ),
    });
  }).sort((left, right) => compareText(left.code, right.code)));
}

function sortedRequiredRefs(input: readonly EvaluationRecordRef[], path: string) {
  const refs = sortedRefs(input, path);
  if (refs.length === 0) throw new TypeError(`${path} must not be empty.`);
  return refs;
}

function sortedRefs(input: readonly EvaluationRecordRef[], path: string) {
  return Object.freeze([...snapshotRefs(input, path)].sort((left, right) =>
    compareText(evaluationRefKey(left), evaluationRefKey(right))));
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
  ] as const).includes(value)) throw new TypeError("Evaluation dimension is unsupported.");
}
