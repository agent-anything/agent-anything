import {
  createEvaluationReport,
  type EvaluationMissingDataRecord,
  type EvaluationReport,
} from "@agent-anything/evaluation/report";
import type {
  EvaluationDimension,
  EvaluationRecordRef,
} from "@agent-anything/evaluation/definition";
import type {
  EvaluationMetricDistribution,
  EvaluationMetricExclusion,
  EvaluationMetricGateOutcome,
  EvaluationMetricUncertainty,
} from "@agent-anything/evaluation/metrics";

import { HELARC_PRODUCT_EFFECTIVENESS_PROTOCOL } from "./HelarcProductEffectivenessProtocol.js";
import {
  HELARC_PRODUCT_EFFECTIVENESS_REPETITIONS,
  type HelarcProductEffectivenessCaseProfile,
  type HelarcProductEffectivenessSuiteProfile,
} from "./HelarcProductEffectivenessSuite.js";
import type {
  HelarcProductEffectivenessDiagnostics,
  HelarcProductEffectivenessEvidenceBundle,
  HelarcProductEffectivenessSafetyGate,
  HelarcProductEffectivenessTargetName,
  HelarcProductEffectivenessTrialEvidence,
} from "./HelarcProductEffectivenessEvidence.js";

export type HelarcProductEffectivenessReleaseStatus = "passed" | "failed" | "unavailable";

export interface HelarcProductEffectivenessMean {
  readonly value: number;
  readonly lower: number;
  readonly upper: number;
  readonly caseCount: number;
  readonly trialCount: number;
}

export interface HelarcProductEffectivenessDiagnosticSummary {
  readonly reliability: number;
  readonly trajectory: number | null;
  readonly validation: number | null;
  readonly latencyMs: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly toolCalls: number | null;
  readonly humanAttentionEvents: number | null;
}

export interface HelarcProductEffectivenessComparison {
  readonly schemaVersion: 1;
  readonly kind: "helarc_product_effectiveness_comparison";
  readonly releaseStatus: HelarcProductEffectivenessReleaseStatus;
  readonly releaseReason: string;
  readonly requiredPairCount: number;
  readonly comparablePairCount: number;
  readonly codex: HelarcProductEffectivenessMean | null;
  readonly helarc: HelarcProductEffectivenessMean | null;
  readonly outcomeRatio: number | null;
  readonly outcomeRatioInterval: {
    readonly lower: number;
    readonly upper: number;
    readonly confidence: 0.95;
  } | null;
  readonly safety: Readonly<Record<HelarcProductEffectivenessSafetyGate, "passed" | "failed" | "unavailable">>;
  readonly diagnostics: Readonly<Record<HelarcProductEffectivenessTargetName, HelarcProductEffectivenessDiagnosticSummary>>;
  readonly exclusions: readonly EvaluationMetricExclusion[];
  readonly report: EvaluationReport;
}

export function compareHelarcProductEffectiveness(input: {
  readonly suite: HelarcProductEffectivenessSuiteProfile;
  readonly codex: HelarcProductEffectivenessEvidenceBundle;
  readonly helarc: HelarcProductEffectivenessEvidenceBundle;
  readonly reportRef: EvaluationRecordRef;
  readonly campaignRef: EvaluationRecordRef;
  readonly createdAt: string;
}): HelarcProductEffectivenessComparison {
  assertBundleTarget(input.codex, "codex", input.suite);
  assertBundleTarget(input.helarc, "helarc", input.suite);
  const requiredPairCount = input.suite.cases.length * HELARC_PRODUCT_EFFECTIVENESS_REPETITIONS;
  const codexByPair = new Map(input.codex.trials.map((trial) => [trial.pairingKey, trial]));
  const helarcByPair = new Map(input.helarc.trials.map((trial) => [trial.pairingKey, trial]));
  const pairs: Array<{
    readonly profile: HelarcProductEffectivenessCaseProfile;
    readonly codex: HelarcProductEffectivenessTrialEvidence;
    readonly helarc: HelarcProductEffectivenessTrialEvidence;
  }> = [];
  const exclusions: EvaluationMetricExclusion[] = [];

  for (const profile of input.suite.cases) {
    for (let repetition = 1; repetition <= HELARC_PRODUCT_EFFECTIVENESS_REPETITIONS; repetition += 1) {
      const pairingKey = `${profile.definition.pairingKey}.rep-${repetition}`;
      const codex = codexByPair.get(pairingKey);
      const helarc = helarcByPair.get(pairingKey);
      if (codex?.status === "completed" && helarc?.status === "completed") {
        pairs.push(Object.freeze({ profile, codex, helarc }));
        continue;
      }
      exclusions.push(pairExclusion(pairingKey, codex, helarc));
    }
  }

  const completeCoverage = pairs.length === requiredPairCount;
  const codexMean = completeCoverage ? weightedMean(input.suite.cases, pairs, "codex") : null;
  const helarcMean = completeCoverage ? weightedMean(input.suite.cases, pairs, "helarc") : null;
  const outcomeRatio = codexMean !== null && helarcMean !== null && codexMean.value > 0
    ? helarcMean.value / codexMean.value
    : null;
  const outcomeRatioInterval = codexMean !== null && helarcMean !== null && codexMean.lower > 0
    ? Object.freeze({
        lower: clampNonNegative(helarcMean.lower / codexMean.upper),
        upper: helarcMean.upper / codexMean.lower,
        confidence: 0.95 as const,
      })
    : null;
  const safety = summarizeSafety(pairs, completeCoverage);
  const safetyFailed = Object.values(safety).some((status) => status === "failed");
  const safetyUnavailable = Object.values(safety).some((status) => status === "unavailable");
  const release = decideRelease({
    completeCoverage,
    safetyFailed,
    safetyUnavailable,
    outcomeRatio,
  });
  const diagnostics = Object.freeze({
    codex: summarizeDiagnostics(input.codex, input.suite),
    helarc: summarizeDiagnostics(input.helarc, input.suite),
  });
  const report = createComparisonReport({
    ...input,
    completeCoverage,
    release,
    codexMean,
    helarcMean,
    outcomeRatio,
    outcomeRatioInterval,
    safety,
    diagnostics,
    exclusions,
  });
  return deepFreeze({
    schemaVersion: 1,
    kind: "helarc_product_effectiveness_comparison",
    releaseStatus: release.status,
    releaseReason: release.reason,
    requiredPairCount,
    comparablePairCount: pairs.length,
    codex: codexMean,
    helarc: helarcMean,
    outcomeRatio,
    outcomeRatioInterval,
    safety,
    diagnostics,
    exclusions: Object.freeze([...exclusions]),
    report,
  });
}

function weightedMean(
  profiles: readonly HelarcProductEffectivenessCaseProfile[],
  pairs: readonly {
    readonly profile: HelarcProductEffectivenessCaseProfile;
    readonly codex: HelarcProductEffectivenessTrialEvidence;
    readonly helarc: HelarcProductEffectivenessTrialEvidence;
  }[],
  target: HelarcProductEffectivenessTargetName,
): HelarcProductEffectivenessMean {
  const caseMeans = profiles.map((profile) => {
    const scores = pairs
      .filter((pair) => pair.profile.id === profile.id)
      .map((pair) => pair[target].outcomeScore!);
    if (scores.length !== HELARC_PRODUCT_EFFECTIVENESS_REPETITIONS) {
      throw new TypeError(`Case '${profile.id}' lacks complete Product-effectiveness scores.`);
    }
    return Object.freeze({
      weight: profile.weight,
      mean: average(scores)!,
    });
  });
  const value = caseMeans.reduce((sum, item) => sum + item.weight * item.mean, 0);
  const weightSquares = caseMeans.reduce((sum, item) => sum + item.weight ** 2, 0);
  const effectiveCaseCount = 1 / weightSquares;
  const weightedVariance = caseMeans.reduce(
    (sum, item) => sum + item.weight * (item.mean - value) ** 2,
    0,
  );
  const margin = 1.96 * Math.sqrt(weightedVariance / effectiveCaseCount);
  return Object.freeze({
    value,
    lower: clampUnit(value - margin),
    upper: clampUnit(value + margin),
    caseCount: profiles.length,
    trialCount: pairs.length,
  });
}

function summarizeSafety(
  pairs: readonly {
    readonly codex: HelarcProductEffectivenessTrialEvidence;
    readonly helarc: HelarcProductEffectivenessTrialEvidence;
  }[],
  completeCoverage: boolean,
): Readonly<Record<HelarcProductEffectivenessSafetyGate, "passed" | "failed" | "unavailable">> {
  const result: Record<string, "passed" | "failed" | "unavailable"> = {};
  for (const gate of HELARC_PRODUCT_EFFECTIVENESS_PROTOCOL.absoluteSafetyGates) {
    const values = pairs.flatMap((pair) => [pair.codex.safety[gate], pair.helarc.safety[gate]]);
    result[gate] = values.some((value) => value === false)
      ? "failed"
      : !completeCoverage || values.length === 0 || values.some((value) => value !== true)
        ? "unavailable"
        : "passed";
  }
  return Object.freeze(result) as Readonly<Record<
    HelarcProductEffectivenessSafetyGate,
    "passed" | "failed" | "unavailable"
  >>;
}

function summarizeDiagnostics(
  bundle: HelarcProductEffectivenessEvidenceBundle,
  suite: HelarcProductEffectivenessSuiteProfile,
): HelarcProductEffectivenessDiagnosticSummary {
  const required = suite.cases.length * HELARC_PRODUCT_EFFECTIVENESS_REPETITIONS;
  const completed = bundle.trials.filter((trial) => trial.status === "completed");
  return Object.freeze({
    reliability: completed.length / required,
    trajectory: averageDiagnostics(completed, "trajectoryScore"),
    validation: averageDiagnostics(completed, "validationScore"),
    latencyMs: averageDiagnostics(completed, "latencyMs"),
    inputTokens: averageDiagnostics(completed, "inputTokens"),
    outputTokens: averageDiagnostics(completed, "outputTokens"),
    toolCalls: averageDiagnostics(completed, "toolCalls"),
    humanAttentionEvents: averageDiagnostics(completed, "humanAttentionEvents"),
  });
}

function decideRelease(input: {
  readonly completeCoverage: boolean;
  readonly safetyFailed: boolean;
  readonly safetyUnavailable: boolean;
  readonly outcomeRatio: number | null;
}): { readonly status: HelarcProductEffectivenessReleaseStatus; readonly reason: string } {
  if (input.safetyFailed) {
    return Object.freeze({ status: "failed", reason: "At least one absolute safety gate failed." });
  }
  if (!input.completeCoverage) {
    return Object.freeze({ status: "unavailable", reason: "Paired completed Trial coverage is incomplete." });
  }
  if (input.safetyUnavailable) {
    return Object.freeze({ status: "unavailable", reason: "At least one absolute safety gate is unavailable." });
  }
  if (input.outcomeRatio === null) {
    return Object.freeze({ status: "unavailable", reason: "The accepted reference mean cannot form an outcome ratio." });
  }
  if (input.outcomeRatio < HELARC_PRODUCT_EFFECTIVENESS_PROTOCOL.minimumWeightedOutcomeRatio) {
    return Object.freeze({ status: "failed", reason: "The weighted outcome ratio is below the release threshold." });
  }
  return Object.freeze({ status: "passed", reason: "Outcome and absolute safety release gates passed." });
}

function createComparisonReport(input: {
  readonly suite: HelarcProductEffectivenessSuiteProfile;
  readonly codex: HelarcProductEffectivenessEvidenceBundle;
  readonly helarc: HelarcProductEffectivenessEvidenceBundle;
  readonly reportRef: EvaluationRecordRef;
  readonly campaignRef: EvaluationRecordRef;
  readonly createdAt: string;
  readonly completeCoverage: boolean;
  readonly release: { readonly status: HelarcProductEffectivenessReleaseStatus; readonly reason: string };
  readonly codexMean: HelarcProductEffectivenessMean | null;
  readonly helarcMean: HelarcProductEffectivenessMean | null;
  readonly outcomeRatio: number | null;
  readonly outcomeRatioInterval: { readonly lower: number; readonly upper: number } | null;
  readonly safety: Readonly<Record<HelarcProductEffectivenessSafetyGate, "passed" | "failed" | "unavailable">>;
  readonly diagnostics: Readonly<Record<HelarcProductEffectivenessTargetName, HelarcProductEffectivenessDiagnosticSummary>>;
  readonly exclusions: readonly EvaluationMetricExclusion[];
}): EvaluationReport {
  const ratioRef = ref("helarc.product-effectiveness.metric.outcome-ratio.result");
  const safetyRefs = Object.fromEntries(
    HELARC_PRODUCT_EFFECTIVENESS_PROTOCOL.absoluteSafetyGates.map((gate) => [
      gate,
      ref(`helarc.product-effectiveness.metric.safety.${gate}.result`),
    ]),
  ) as Record<HelarcProductEffectivenessSafetyGate, EvaluationRecordRef>;
  const diagnosticMetricSummaries = createDiagnosticMetricSummaries(input.diagnostics);
  const metricSummaries = [
    {
      metricRef: ratioRef,
      dimension: "outcome_quality" as const,
      distribution: numericDistribution(input.outcomeRatio),
      uncertainty: ratioUncertainty(input.outcomeRatioInterval),
    },
    ...HELARC_PRODUCT_EFFECTIVENESS_PROTOCOL.absoluteSafetyGates.map((gate) => ({
      metricRef: safetyRefs[gate],
      dimension: "safety" as const,
      distribution: safetyDistribution(input.safety[gate]),
      uncertainty: unavailableUncertainty("Absolute safety is evaluated without statistical substitution."),
    })),
    ...diagnosticMetricSummaries,
  ];
  const gateOutcomes: EvaluationMetricGateOutcome[] = [
    {
      metricRef: ratioRef,
      dimension: "outcome_quality",
      status: input.outcomeRatio === null
        ? "unavailable"
        : input.outcomeRatio >= HELARC_PRODUCT_EFFECTIVENESS_PROTOCOL.minimumWeightedOutcomeRatio
          ? "passed"
          : "failed",
      observedValue: input.outcomeRatio,
      threshold: {
        comparison: "at_least",
        value: HELARC_PRODUCT_EFFECTIVENESS_PROTOCOL.minimumWeightedOutcomeRatio,
      },
      reason: input.outcomeRatio === null
        ? "Complete comparable outcome evidence is unavailable."
        : "The whole-Product outcome ratio was evaluated against the accepted threshold.",
    },
    ...HELARC_PRODUCT_EFFECTIVENESS_PROTOCOL.absoluteSafetyGates.map((gate) => ({
      metricRef: safetyRefs[gate],
      dimension: "safety" as const,
      status: input.safety[gate],
      observedValue: input.safety[gate] === "unavailable"
        ? null
        : input.safety[gate] === "passed" ? 1 : 0,
      threshold: { comparison: "at_least" as const, value: 1 },
      reason: `Absolute safety gate '${gate}' was evaluated across admitted paired Trials.`,
    })),
  ];
  const metricRefs = metricSummaries.map((summary) => summary.metricRef);
  const comparable = input.completeCoverage;
  const dimensions: EvaluationDimension[] = [
    "outcome_quality",
    "safety",
    "reliability",
    "trajectory",
    "collaboration",
    "efficiency",
  ];
  return createEvaluationReport({
    ref: input.reportRef,
    intent: "comparison",
    objectiveRef: input.codex.targetSnapshot.objectiveRef,
    targetSnapshotRefs: [input.codex.targetSnapshot.ref, input.helarc.targetSnapshot.ref],
    suiteRef: input.suite.suite.ref,
    campaignRef: input.campaignRef,
    captureRefs: [],
    graderRefs: [
      ref("helarc.product-effectiveness.grader.external-outcome"),
      ref("helarc.product-effectiveness.grader.deterministic-safety"),
    ],
    gradeRefs: [],
    metricRefs,
    metricSummaries,
    dimensionSummaries: dimensions.map((dimension) => ({
      dimension,
      interpretation: comparable
        ? dimension === "outcome_quality" || dimension === "safety"
          ? "stable" as const
          : "unavailable" as const
        : "unavailable" as const,
      metricRefs: metricSummaries
        .filter((summary) => summary.dimension === dimension)
        .map((summary) => summary.metricRef),
      rationale: dimension === "outcome_quality"
        ? input.release.reason
        : dimension === "safety"
          ? "Safety is an absolute release gate."
          : "The diagnostic dimension is reported separately in Product-effectiveness metadata.",
    })),
    disagreements: [],
    gateOutcomes,
    failures: [],
    exclusions: input.exclusions,
    missingData: missingData(input),
    comparability: {
      status: comparable ? "comparable" : "incomparable",
      basis: {
        suiteRevision: input.suite.revision,
        requiredPairs: input.suite.cases.length * HELARC_PRODUCT_EFFECTIVENESS_REPETITIONS,
        targetInputsExplicit: true,
      },
      differences: targetDifferences(input.codex, input.helarc),
      reason: comparable
        ? "Every admitted Case has three exact completed pairs."
        : "The exact paired completed Trial matrix is incomplete.",
    },
    supersedes: null,
    createdAt: input.createdAt,
    metadata: {
      releaseStatus: input.release.status,
      releaseReason: input.release.reason,
      codexBundleDigest: input.codex.bundleDigest,
      helarcBundleDigest: input.helarc.bundleDigest,
      codexWeightedMean: input.codexMean?.value ?? null,
      helarcWeightedMean: input.helarcMean?.value ?? null,
      outcomeRatio: input.outcomeRatio,
      diagnostics: {
        codex: diagnosticData(input.diagnostics.codex),
        helarc: diagnosticData(input.diagnostics.helarc),
      },
    },
    limitations: [{
      code: "bounded_product_effectiveness_suite",
      message: "The comparison applies only to the exact fixed Suite and Target Snapshots.",
      metadata: {},
    }],
  });
}

function createDiagnosticMetricSummaries(
  diagnostics: Readonly<Record<
    HelarcProductEffectivenessTargetName,
    HelarcProductEffectivenessDiagnosticSummary
  >>,
) {
  const definitions = [
    ["reliability", "reliability"],
    ["trajectory", "trajectory"],
    ["validation", "trajectory"],
    ["latencyMs", "efficiency"],
    ["inputTokens", "efficiency"],
    ["outputTokens", "efficiency"],
    ["toolCalls", "efficiency"],
    ["humanAttentionEvents", "collaboration"],
  ] as const satisfies readonly [
    keyof HelarcProductEffectivenessDiagnosticSummary,
    EvaluationDimension,
  ][];
  return (["codex", "helarc"] as const).flatMap((target) =>
    definitions.map(([measurement, dimension]) => ({
      metricRef: ref(`helarc.product-effectiveness.metric.${target}.${measurement}.result`),
      dimension,
      distribution: numericDistribution(diagnostics[target][measurement]),
      uncertainty: unavailableUncertainty(
        `Diagnostic '${measurement}' is reported independently for ${target}.`,
      ),
    })));
}

function pairExclusion(
  pairingKey: string,
  codex: HelarcProductEffectivenessTrialEvidence | undefined,
  helarc: HelarcProductEffectivenessTrialEvidence | undefined,
): EvaluationMetricExclusion {
  const code = codex === undefined || helarc === undefined
    ? "paired_sample_unmatched"
    : codex.exclusion?.code ?? helarc.exclusion?.code ?? "paired_trial_not_completed";
  return Object.freeze({
    trialRef: codex?.ref ?? helarc?.ref ?? null,
    code,
    message: `Pair '${pairingKey}' lacks two comparable completed Trials.`,
    details: Object.freeze({
      pairingKey,
      codexStatus: codex?.status ?? "missing",
      helarcStatus: helarc?.status ?? "missing",
    }),
  });
}

function numericDistribution(value: number | null): EvaluationMetricDistribution {
  return value === null
    ? Object.freeze({
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
      })
    : Object.freeze({
        kind: "numeric_distribution",
        sampleCount: 1,
        minimum: value,
        maximum: value,
        mean: value,
        variance: null,
        varianceMethod: "sample",
        p50: value,
        p90: value,
        p95: value,
      });
}

function safetyDistribution(
  status: "passed" | "failed" | "unavailable",
): EvaluationMetricDistribution {
  return Object.freeze({
    kind: "rate",
    sampleCount: status === "unavailable" ? 0 : 1,
    positiveCount: status === "passed" ? 1 : 0,
    value: status === "unavailable" ? null : status === "passed" ? 1 : 0,
  });
}

function ratioUncertainty(
  interval: { readonly lower: number; readonly upper: number } | null,
): EvaluationMetricUncertainty {
  return interval === null
    ? unavailableUncertainty("Complete paired evidence is unavailable for ratio uncertainty.")
    : Object.freeze({
        status: "available",
        method: "standard_error",
        confidence: 0.95,
        lower: interval.lower,
        upper: interval.upper,
      });
}

function unavailableUncertainty(reason: string): EvaluationMetricUncertainty {
  return Object.freeze({ status: "unavailable", method: "none", reason });
}

function missingData(input: {
  readonly safety: Readonly<Record<HelarcProductEffectivenessSafetyGate, "passed" | "failed" | "unavailable">>;
  readonly completeCoverage: boolean;
  readonly diagnostics: Readonly<Record<HelarcProductEffectivenessTargetName, HelarcProductEffectivenessDiagnosticSummary>>;
}) {
  const records: EvaluationMissingDataRecord[] = [];
  if (!input.completeCoverage) {
    records.push({
      code: "paired_trial_coverage_incomplete",
      message: "The required paired completed Trial matrix is incomplete.",
      recordRef: null,
      details: {},
    });
  }
  for (const [gate, status] of Object.entries(input.safety)) {
    if (status === "unavailable") records.push({
      code: "safety_gate_unavailable",
      message: `Safety gate '${gate}' is unavailable.`,
      recordRef: null,
      details: { gate },
    });
  }
  for (const [target, diagnostics] of Object.entries(input.diagnostics)) {
    for (const [measurement, value] of Object.entries(diagnostics)) {
      if (value === null) records.push({
        code: "diagnostic_measurement_unavailable",
        message: `Diagnostic '${measurement}' is unavailable for ${target}.`,
        recordRef: null,
        details: { target, measurement },
      });
    }
  }
  return records;
}

function diagnosticData(summary: HelarcProductEffectivenessDiagnosticSummary) {
  return {
    reliability: summary.reliability,
    trajectory: summary.trajectory,
    validation: summary.validation,
    latencyMs: summary.latencyMs,
    inputTokens: summary.inputTokens,
    outputTokens: summary.outputTokens,
    toolCalls: summary.toolCalls,
    humanAttentionEvents: summary.humanAttentionEvents,
  };
}

function targetDifferences(
  codex: HelarcProductEffectivenessEvidenceBundle,
  helarc: HelarcProductEffectivenessEvidenceBundle,
): readonly string[] {
  const left = new Map(codex.targetSnapshot.manifest.map((item) => [item.key, item]));
  return Object.freeze(helarc.targetSnapshot.manifest
    .filter((item) => JSON.stringify(item.representation) !== JSON.stringify(left.get(item.key)?.representation))
    .map((item) => item.key)
    .sort());
}

function assertBundleTarget(
  bundle: HelarcProductEffectivenessEvidenceBundle,
  targetName: HelarcProductEffectivenessTargetName,
  suite: HelarcProductEffectivenessSuiteProfile,
): void {
  if (bundle.targetName !== targetName) {
    throw new TypeError(`Expected the ${targetName} Product-effectiveness Evidence bundle.`);
  }
  if (refKey(bundle.suiteRef) !== refKey(suite.suite.ref)) {
    throw new TypeError(`${targetName} Evidence belongs to another Suite revision.`);
  }
}

function averageDiagnostics(
  trials: readonly HelarcProductEffectivenessTrialEvidence[],
  key: keyof HelarcProductEffectivenessDiagnostics,
): number | null {
  return average(trials.map((trial) => trial.diagnostics[key]).filter(
    (value): value is number => value !== null,
  ));
}

function average(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampNonNegative(value: number): number {
  return Math.max(0, value);
}

function ref(id: string, revision = "v1"): EvaluationRecordRef {
  return Object.freeze({ id, revision });
}

function refKey(refValue: EvaluationRecordRef): string {
  return `${refValue.id}@${refValue.revision}`;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
