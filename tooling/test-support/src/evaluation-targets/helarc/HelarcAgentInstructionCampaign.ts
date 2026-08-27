import { createHash } from "node:crypto";

import type {
  EvaluationDimension,
  EvaluationObjective,
  EvaluationRecordRef,
} from "@agent-anything/evaluation/definition";
import type {
  EvaluationMetricDistribution,
  EvaluationMetricGateOutcome,
  EvaluationMetricUncertainty,
} from "@agent-anything/evaluation/metrics";
import {
  createEvaluationReport,
  projectEvaluationReportForPublication,
  type EvaluationReport,
  type EvaluationReportPublicationProjection,
} from "@agent-anything/evaluation/report";

import {
  compareHelarcAgentInstructionEffectiveness,
  type HelarcAgentInstructionEffectivenessComparison,
  type HelarcAgentInstructionEvaluationDisposition,
} from "./HelarcAgentInstructionEvaluation.js";
import {
  HELARC_PRODUCT_EFFECTIVENESS_PROTOCOL,
} from "./HelarcProductEffectivenessProtocol.js";
import {
  HELARC_PRODUCT_EFFECTIVENESS_REPETITIONS,
  type HelarcProductEffectivenessSuiteProfile,
} from "./HelarcProductEffectivenessSuite.js";
import type {
  HelarcProductEffectivenessDiagnostics,
  HelarcProductEffectivenessEvidenceBundle,
  HelarcProductEffectivenessSafetyGate,
  HelarcProductEffectivenessTrialEvidence,
} from "./HelarcProductEffectivenessEvidence.js";

export const HELARC_AGENT_INSTRUCTION_CAMPAIGN_REVISION =
  "helarc-agent-instruction-campaign-v1" as const;

export type HelarcAgentInstructionTargetReportStatus =
  | "passed"
  | "failed"
  | "unavailable";

export interface HelarcAgentInstructionTargetReport {
  readonly instructionTarget: "minimal" | "production";
  readonly status: HelarcAgentInstructionTargetReportStatus;
  readonly requiredTrialCount: number;
  readonly completedTrialCount: number;
  readonly evidenceBundleDigest: string;
  readonly report: EvaluationReport;
  readonly publication: EvaluationReportPublicationProjection;
}

export interface HelarcAgentInstructionComparisonReport {
  readonly disposition: HelarcAgentInstructionEvaluationDisposition;
  readonly report: EvaluationReport;
  readonly publication: EvaluationReportPublicationProjection;
}

export interface HelarcAgentInstructionCampaignCompletedArtifact {
  readonly schemaVersion: 1;
  readonly kind: "helarc_agent_instruction_campaign";
  readonly revision: typeof HELARC_AGENT_INSTRUCTION_CAMPAIGN_REVISION;
  readonly disposition: HelarcAgentInstructionEvaluationDisposition;
  readonly evidence: {
    readonly minimal: HelarcProductEffectivenessEvidenceBundle;
    readonly production: HelarcProductEffectivenessEvidenceBundle;
  };
  readonly reports: {
    readonly minimal: HelarcAgentInstructionTargetReport;
    readonly production: HelarcAgentInstructionTargetReport;
    readonly comparison: HelarcAgentInstructionComparisonReport;
  };
  readonly createdAt: string;
  readonly limitations: readonly string[];
  readonly digest: string;
}

export interface HelarcAgentInstructionCampaignUnavailableArtifact {
  readonly schemaVersion: 1;
  readonly kind: "helarc_agent_instruction_campaign";
  readonly revision: typeof HELARC_AGENT_INSTRUCTION_CAMPAIGN_REVISION;
  readonly disposition: {
    readonly status: "unavailable";
    readonly code: string;
    readonly reason: string;
  };
  readonly missingConfiguration: readonly string[];
  readonly evidence: null;
  readonly reports: null;
  readonly createdAt: string;
  readonly limitations: readonly string[];
  readonly digest: string;
}

export type HelarcAgentInstructionCampaignArtifact =
  | HelarcAgentInstructionCampaignCompletedArtifact
  | HelarcAgentInstructionCampaignUnavailableArtifact;

export function createHelarcAgentInstructionCampaignArtifact(input: {
  readonly objective: EvaluationObjective;
  readonly suite: HelarcProductEffectivenessSuiteProfile;
  readonly minimal: HelarcProductEffectivenessEvidenceBundle;
  readonly production: HelarcProductEffectivenessEvidenceBundle;
  readonly createdAt: string;
}): HelarcAgentInstructionCampaignCompletedArtifact {
  const comparison = compareHelarcAgentInstructionEffectiveness({
    minimal: input.minimal,
    production: input.production,
  });
  const minimal = createTargetReport({
    objective: input.objective,
    suite: input.suite,
    bundle: input.minimal,
    instructionTarget: "minimal",
    createdAt: input.createdAt,
  });
  const production = createTargetReport({
    objective: input.objective,
    suite: input.suite,
    bundle: input.production,
    instructionTarget: "production",
    createdAt: input.createdAt,
  });
  const comparisonReport = createInstructionComparisonReport({
    objective: input.objective,
    suite: input.suite,
    minimal: input.minimal,
    production: input.production,
    comparison,
    targetReports: { minimal, production },
    createdAt: input.createdAt,
  });
  const material = deepFreeze({
    schemaVersion: 1 as const,
    kind: "helarc_agent_instruction_campaign" as const,
    revision: HELARC_AGENT_INSTRUCTION_CAMPAIGN_REVISION,
    disposition: comparison.disposition,
    evidence: { minimal: input.minimal, production: input.production },
    reports: {
      minimal,
      production,
      comparison: comparisonReport,
    },
    createdAt: input.createdAt,
    limitations: [
      "The comparison applies only to the exact paired Helarc instruction targets and fixed Suite.",
      "This artifact neither proves deterministic Harness conformance nor supplies a Codex reference Campaign.",
    ],
  });
  assertPublicationSafe(material.reports);
  return deepFreeze({ ...material, digest: sha256(stableJson(material)) });
}

export function createHelarcAgentInstructionCampaignUnavailableArtifact(input: {
  readonly code: string;
  readonly reason: string;
  readonly missingConfiguration: readonly string[];
  readonly createdAt: string;
}): HelarcAgentInstructionCampaignUnavailableArtifact {
  const material = deepFreeze({
    schemaVersion: 1 as const,
    kind: "helarc_agent_instruction_campaign" as const,
    revision: HELARC_AGENT_INSTRUCTION_CAMPAIGN_REVISION,
    disposition: {
      status: "unavailable" as const,
      code: requiredText(input.code, "code"),
      reason: requiredText(input.reason, "reason"),
    },
    missingConfiguration: [...new Set(input.missingConfiguration.map((item) =>
      requiredText(item, "missingConfiguration")
    ))].sort(),
    evidence: null,
    reports: null,
    createdAt: requiredText(input.createdAt, "createdAt"),
    limitations: [
      "No Trial, score, safety result, or Product-effectiveness claim is inferred from unavailable configuration.",
    ],
  });
  return deepFreeze({ ...material, digest: sha256(stableJson(material)) });
}

export function verifyHelarcAgentInstructionCampaignArtifact(
  value: unknown,
): HelarcAgentInstructionCampaignArtifact {
  if (!isDataObject(value)) {
    throw new TypeError("Agent instruction Campaign artifact must be an object.");
  }
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "helarc_agent_instruction_campaign" ||
    value.revision !== HELARC_AGENT_INSTRUCTION_CAMPAIGN_REVISION
  ) {
    throw new TypeError("Agent instruction Campaign artifact identity is invalid.");
  }
  if (typeof value.digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value.digest)) {
    throw new TypeError("Agent instruction Campaign artifact digest is invalid.");
  }
  const { digest, ...material } = value;
  if (digest !== sha256(stableJson(material))) {
    throw new TypeError("Agent instruction Campaign artifact digest does not match its material.");
  }
  if (!isDataObject(value.disposition) || typeof value.disposition.status !== "string") {
    throw new TypeError("Agent instruction Campaign disposition is invalid.");
  }
  if (value.disposition.status === "unavailable") {
    if (value.evidence !== null || value.reports !== null || !Array.isArray(value.missingConfiguration)) {
      throw new TypeError("Unavailable Agent instruction Campaign artifact is invalid.");
    }
  } else {
    if (!isDataObject(value.evidence) || !isDataObject(value.reports)) {
      throw new TypeError("Completed Agent instruction Campaign evidence and Reports are required.");
    }
    assertPublicationSafe(value.reports);
  }
  return deepFreeze(value as unknown as HelarcAgentInstructionCampaignArtifact);
}

function createTargetReport(input: {
  readonly objective: EvaluationObjective;
  readonly suite: HelarcProductEffectivenessSuiteProfile;
  readonly bundle: HelarcProductEffectivenessEvidenceBundle;
  readonly instructionTarget: "minimal" | "production";
  readonly createdAt: string;
}): HelarcAgentInstructionTargetReport {
  assertInstructionTarget(input.bundle, input.instructionTarget);
  const requiredTrialCount = input.suite.cases.length * HELARC_PRODUCT_EFFECTIVENESS_REPETITIONS;
  const completed = input.bundle.trials.filter((trial) => trial.status === "completed");
  const completeCoverage = completed.length === requiredTrialCount;
  const safety = summarizeSafety(completed, completeCoverage);
  const safetyFailed = Object.values(safety).some((value) => value === "failed");
  const status: HelarcAgentInstructionTargetReportStatus = safetyFailed
    ? "failed"
    : !completeCoverage || Object.values(safety).some((value) => value === "unavailable")
      ? "unavailable"
      : "passed";
  const summaries = targetMetricSummaries(input.instructionTarget, completed, requiredTrialCount);
  const safetyRefs = Object.fromEntries(
    HELARC_PRODUCT_EFFECTIVENESS_PROTOCOL.absoluteSafetyGates.map((gate) => [
      gate,
      metricRef(`${input.instructionTarget}.safety.${gate}`),
    ]),
  ) as Record<HelarcProductEffectivenessSafetyGate, EvaluationRecordRef>;
  const report = createEvaluationReport({
    ref: ref(`helarc.agent-instruction.report.${input.instructionTarget}`),
    intent: "baseline",
    objectiveRef: input.objective.ref,
    targetSnapshotRefs: [input.bundle.targetSnapshot.ref],
    suiteRef: input.suite.suite.ref,
    campaignRef: ref(`helarc.agent-instruction.campaign.${input.instructionTarget}`),
    captureRefs: [],
    graderRefs: [
      ref("helarc.product-effectiveness.grader.external-outcome"),
      ref("helarc.product-effectiveness.grader.deterministic-safety"),
    ],
    gradeRefs: [],
    metricRefs: summaries.map(({ metricRef: item }) => item),
    metricSummaries: summaries,
    dimensionSummaries: dimensionSummaries(summaries, completeCoverage),
    disagreements: [],
    gateOutcomes: safetyGateOutcomes(safety, safetyRefs),
    failures: [],
    exclusions: input.bundle.trials.flatMap((trial) => trial.exclusion === null
      ? []
      : [{
          trialRef: trial.ref,
          code: trial.exclusion.code,
          message: trial.exclusion.reason,
          details: { status: trial.status },
        }]),
    missingData: completeCoverage ? [] : [{
      code: "target_trial_coverage_incomplete",
      message: "The required completed Trial matrix is incomplete.",
      recordRef: input.bundle.targetSnapshot.ref,
      details: { requiredTrialCount, completedTrialCount: completed.length },
    }],
    comparability: {
      status: "comparable",
      basis: {
        targetManifest: "exact",
        suiteRevision: input.suite.revision,
        repetitionCount: HELARC_PRODUCT_EFFECTIVENESS_REPETITIONS,
      },
      differences: [],
      reason: "The target Report interprets one exact immutable Target Snapshot and Suite.",
    },
    supersedes: null,
    createdAt: input.createdAt,
    metadata: {
      claim: input.instructionTarget === "minimal"
        ? "minimal_instruction_resilience"
        : "production_product_effectiveness",
      status,
      evidenceBundleDigest: input.bundle.bundleDigest,
      requiredTrialCount,
      completedTrialCount: completed.length,
    },
    limitations: [{
      code: "bounded_instruction_target_report",
      message: "The Report applies only to the exact fixed Suite and Target Snapshot.",
      metadata: {},
    }],
  });
  return deepFreeze({
    instructionTarget: input.instructionTarget,
    status,
    requiredTrialCount,
    completedTrialCount: completed.length,
    evidenceBundleDigest: input.bundle.bundleDigest,
    report,
    publication: projectEvaluationReportForPublication(report),
  });
}

function createInstructionComparisonReport(input: {
  readonly objective: EvaluationObjective;
  readonly suite: HelarcProductEffectivenessSuiteProfile;
  readonly minimal: HelarcProductEffectivenessEvidenceBundle;
  readonly production: HelarcProductEffectivenessEvidenceBundle;
  readonly comparison: HelarcAgentInstructionEffectivenessComparison;
  readonly targetReports: {
    readonly minimal: HelarcAgentInstructionTargetReport;
    readonly production: HelarcAgentInstructionTargetReport;
  };
  readonly createdAt: string;
}): HelarcAgentInstructionComparisonReport {
  const comparable = input.comparison.disposition.status !== "incomparable";
  const deltaRef = metricRef("comparison.outcome-delta");
  const safety = compareSafety(input.minimal, input.production);
  const safetyRefs = Object.fromEntries(
    HELARC_PRODUCT_EFFECTIVENESS_PROTOCOL.absoluteSafetyGates.map((gate) => [
      gate,
      metricRef(`comparison.safety.${gate}`),
    ]),
  ) as Record<HelarcProductEffectivenessSafetyGate, EvaluationRecordRef>;
  const diagnosticSummaries = comparisonDiagnosticSummaries(input.comparison);
  const summaries = [
    summary(deltaRef, "outcome_quality", numericDistribution(
      input.comparison.outcomeDelta === null ? [] : [input.comparison.outcomeDelta],
    )),
    ...HELARC_PRODUCT_EFFECTIVENESS_PROTOCOL.absoluteSafetyGates.map((gate) =>
      summary(safetyRefs[gate], "safety", safetyDistribution(safety[gate]))
    ),
    ...diagnosticSummaries,
  ];
  const report = createEvaluationReport({
    ref: ref("helarc.agent-instruction.report.comparison"),
    intent: "comparison",
    objectiveRef: input.objective.ref,
    targetSnapshotRefs: [
      input.minimal.targetSnapshot.ref,
      input.production.targetSnapshot.ref,
    ],
    suiteRef: input.suite.suite.ref,
    campaignRef: ref("helarc.agent-instruction.campaign.comparison"),
    captureRefs: [],
    graderRefs: [
      ref("helarc.product-effectiveness.grader.external-outcome"),
      ref("helarc.product-effectiveness.grader.deterministic-safety"),
    ],
    gradeRefs: [],
    metricRefs: summaries.map(({ metricRef: item }) => item),
    metricSummaries: summaries,
    dimensionSummaries: dimensionSummaries(summaries, comparable &&
      input.comparison.disposition.status === "comparable"),
    disagreements: [],
    gateOutcomes: safetyGateOutcomes(safety, safetyRefs),
    failures: [],
    exclusions: pairedExclusions(input.minimal, input.production),
    missingData: input.comparison.disposition.status === "comparable" ? [] : [{
      code: input.comparison.disposition.code,
      message: input.comparison.disposition.reason,
      recordRef: null,
      details: {
        requiredPairCount: input.comparison.requiredPairCount,
        comparablePairCount: input.comparison.comparablePairCount,
      },
    }],
    comparability: {
      status: comparable ? "comparable" : "incomparable",
      basis: {
        nonInstructionManifest: comparable ? "exact" : "different",
        suiteRevision: input.suite.revision,
        requiredPairCount: input.comparison.requiredPairCount,
      },
      differences: targetDifferences(input.minimal, input.production),
      reason: comparable
        ? "Only the declared Agent instruction target inputs differ."
        : input.comparison.disposition.status === "incomparable"
          ? input.comparison.disposition.reason
          : "The target pair is incomparable.",
    },
    supersedes: null,
    createdAt: input.createdAt,
    metadata: {
      claim: "product_instruction_effectiveness",
      disposition: input.comparison.disposition.status,
      minimalEvidenceBundleDigest: input.minimal.bundleDigest,
      productionEvidenceBundleDigest: input.production.bundleDigest,
      minimalOutcomeMean: input.comparison.minimalOutcomeMean,
      productionOutcomeMean: input.comparison.productionOutcomeMean,
      outcomeDelta: input.comparison.outcomeDelta,
      targetReportStatus: {
        minimal: input.targetReports.minimal.status,
        production: input.targetReports.production.status,
      },
    },
    limitations: [{
      code: "bounded_instruction_comparison",
      message: "The comparison measures only the declared built-in instruction difference under the exact paired target.",
      metadata: {},
    }],
  });
  return deepFreeze({
    disposition: input.comparison.disposition,
    report,
    publication: projectEvaluationReportForPublication(report),
  });
}

function targetMetricSummaries(
  target: "minimal" | "production",
  trials: readonly HelarcProductEffectivenessTrialEvidence[],
  requiredTrialCount: number,
) {
  const diagnostics: readonly [
    keyof HelarcProductEffectivenessDiagnostics,
    EvaluationDimension,
  ][] = [
    ["trajectoryScore", "trajectory"],
    ["verificationScore", "diagnostic_quality"],
    ["latencyMs", "efficiency"],
    ["inputTokens", "efficiency"],
    ["outputTokens", "efficiency"],
    ["estimatedCost", "efficiency"],
    ["toolCalls", "efficiency"],
    ["retries", "reliability"],
    ["humanInteractionEvents", "collaboration"],
  ];
  return [
    summary(
      metricRef(`${target}.outcome`),
      "outcome_quality",
      numericDistribution(trials.flatMap((trial) =>
        trial.outcomeScore === null ? [] : [trial.outcomeScore]
      )),
    ),
    ...HELARC_PRODUCT_EFFECTIVENESS_PROTOCOL.absoluteSafetyGates.map((gate) =>
      summary(
        metricRef(`${target}.safety.${gate}`),
        "safety",
        booleanDistribution(trials.flatMap((trial) =>
          trial.safety[gate] === null ? [] : [trial.safety[gate]]
        )),
      )
    ),
    summary(
      metricRef(`${target}.reliability`),
      "reliability",
      numericDistribution([trials.length / requiredTrialCount]),
    ),
    ...diagnostics.map(([field, dimension]) => summary(
      metricRef(`${target}.${field}`),
      dimension,
      numericDistribution(trials.flatMap((trial) => {
        const value = trial.diagnostics[field];
        return value === null ? [] : [value];
      })),
    )),
  ];
}

function comparisonDiagnosticSummaries(
  comparison: HelarcAgentInstructionEffectivenessComparison,
) {
  const fields: readonly [keyof HelarcProductEffectivenessDiagnostics, EvaluationDimension][] = [
    ["trajectoryScore", "trajectory"],
    ["verificationScore", "diagnostic_quality"],
    ["latencyMs", "efficiency"],
    ["inputTokens", "efficiency"],
    ["outputTokens", "efficiency"],
    ["estimatedCost", "efficiency"],
    ["toolCalls", "efficiency"],
    ["retries", "reliability"],
    ["humanInteractionEvents", "collaboration"],
  ];
  return (["minimal", "production"] as const).flatMap((target) =>
    fields.map(([field, dimension]) => {
      const value = comparison.diagnostics[target][field];
      return summary(
        metricRef(`comparison.${target}.${field}`),
        dimension,
        numericDistribution(value === null ? [] : [value]),
      );
    })
  );
}

function summarizeSafety(
  trials: readonly HelarcProductEffectivenessTrialEvidence[],
  completeCoverage: boolean,
): Readonly<Record<HelarcProductEffectivenessSafetyGate, "passed" | "failed" | "unavailable">> {
  return Object.freeze(Object.fromEntries(
    HELARC_PRODUCT_EFFECTIVENESS_PROTOCOL.absoluteSafetyGates.map((gate) => {
      const values = trials.map((trial) => trial.safety[gate]);
      const status = values.some((value) => value === false)
        ? "failed"
        : !completeCoverage || values.length === 0 || values.some((value) => value !== true)
          ? "unavailable"
          : "passed";
      return [gate, status];
    }),
  )) as Readonly<Record<
    HelarcProductEffectivenessSafetyGate,
    "passed" | "failed" | "unavailable"
  >>;
}

function compareSafety(
  minimal: HelarcProductEffectivenessEvidenceBundle,
  production: HelarcProductEffectivenessEvidenceBundle,
) {
  const required = minimal.trials.length > 0 && minimal.trials.length === production.trials.length;
  return Object.freeze(Object.fromEntries(
    HELARC_PRODUCT_EFFECTIVENESS_PROTOCOL.absoluteSafetyGates.map((gate) => {
      const values = [...minimal.trials, ...production.trials].map((trial) => trial.safety[gate]);
      const status = values.some((value) => value === false)
        ? "failed"
        : !required || values.length === 0 || values.some((value) => value !== true)
          ? "unavailable"
          : "passed";
      return [gate, status];
    }),
  )) as Readonly<Record<
    HelarcProductEffectivenessSafetyGate,
    "passed" | "failed" | "unavailable"
  >>;
}

function safetyGateOutcomes(
  safety: Readonly<Record<HelarcProductEffectivenessSafetyGate, "passed" | "failed" | "unavailable">>,
  refs: Readonly<Record<HelarcProductEffectivenessSafetyGate, EvaluationRecordRef>>,
): readonly EvaluationMetricGateOutcome[] {
  return Object.freeze(HELARC_PRODUCT_EFFECTIVENESS_PROTOCOL.absoluteSafetyGates.map((gate) => ({
    metricRef: refs[gate],
    dimension: "safety" as const,
    status: safety[gate],
    observedValue: safety[gate] === "unavailable" ? null : safety[gate] === "passed" ? 1 : 0,
    threshold: { comparison: "at_least" as const, value: 1 },
    reason: `Absolute safety gate '${gate}' is interpreted before outcome and diagnostics.`,
  })));
}

function dimensionSummaries(
  summaries: readonly ReturnType<typeof summary>[],
  available: boolean,
) {
  const dimensions = [...new Set(summaries.map(({ dimension }) => dimension))].sort();
  return dimensions.map((dimension) => ({
    dimension,
    interpretation: available ? "stable" as const : "unavailable" as const,
    metricRefs: summaries.filter((item) => item.dimension === dimension).map(({ metricRef: item }) => item),
    rationale: available
      ? `The ${dimension} evidence is interpreted only after absolute safety gates.`
      : `The ${dimension} evidence is unavailable because required coverage or comparability is absent.`,
  }));
}

function pairedExclusions(
  minimal: HelarcProductEffectivenessEvidenceBundle,
  production: HelarcProductEffectivenessEvidenceBundle,
) {
  const minimalByPair = new Map(minimal.trials.map((trial) => [trial.pairingKey, trial]));
  const productionByPair = new Map(production.trials.map((trial) => [trial.pairingKey, trial]));
  return [...new Set([...minimalByPair.keys(), ...productionByPair.keys()])].sort().flatMap((key) => {
    const left = minimalByPair.get(key);
    const right = productionByPair.get(key);
    if (left?.status === "completed" && right?.status === "completed") return [];
    return [{
      trialRef: left?.ref ?? right?.ref ?? null,
      code: left?.exclusion?.code ?? right?.exclusion?.code ?? "paired_trial_not_completed",
      message: `Pair '${key}' lacks two completed Trials.`,
      details: { minimalStatus: left?.status ?? "missing", productionStatus: right?.status ?? "missing" },
    }];
  });
}

function targetDifferences(
  minimal: HelarcProductEffectivenessEvidenceBundle,
  production: HelarcProductEffectivenessEvidenceBundle,
): readonly string[] {
  const left = new Map(minimal.targetSnapshot.manifest.map((item) => [item.key, item]));
  return Object.freeze(production.targetSnapshot.manifest
    .filter((item) => JSON.stringify(item.representation) !== JSON.stringify(left.get(item.key)?.representation))
    .map((item) => item.key)
    .sort());
}

function assertInstructionTarget(
  bundle: HelarcProductEffectivenessEvidenceBundle,
  target: "minimal" | "production",
): void {
  const entry = bundle.targetSnapshot.manifest.find((item) => item.key === "agent_instructions");
  const value = entry?.representation?.kind === "value" ? entry.representation.value : null;
  if (!isDataObject(value) || value.target !== target) {
    throw new TypeError(`Evidence bundle does not identify the '${target}' instruction target.`);
  }
}

function isDataObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function summary(
  metric: EvaluationRecordRef,
  dimension: EvaluationDimension,
  distribution: EvaluationMetricDistribution,
) {
  return Object.freeze({
    metricRef: metric,
    dimension,
    distribution,
    uncertainty: unavailableUncertainty("No statistical interval is inferred beyond retained samples."),
  });
}

function numericDistribution(values: readonly number[]): EvaluationMetricDistribution {
  if (values.length === 0) {
    return Object.freeze({
      kind: "numeric_distribution" as const,
      sampleCount: 0,
      minimum: null,
      maximum: null,
      mean: null,
      variance: null,
      varianceMethod: "sample" as const,
      p50: null,
      p90: null,
      p95: null,
    });
  }
  const sorted = [...values].sort((left, right) => left - right);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const variance = sorted.length < 2
    ? null
    : sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (sorted.length - 1);
  return Object.freeze({
    kind: "numeric_distribution" as const,
    sampleCount: sorted.length,
    minimum: sorted[0]!,
    maximum: sorted[sorted.length - 1]!,
    mean,
    variance,
    varianceMethod: "sample" as const,
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p95: percentile(sorted, 0.95),
  });
}

function booleanDistribution(values: readonly boolean[]): EvaluationMetricDistribution {
  const positiveCount = values.filter(Boolean).length;
  return Object.freeze({
    kind: "rate" as const,
    sampleCount: values.length,
    positiveCount,
    value: values.length === 0 ? null : positiveCount / values.length,
  });
}

function safetyDistribution(
  status: "passed" | "failed" | "unavailable",
): EvaluationMetricDistribution {
  return Object.freeze({
    kind: "rate" as const,
    sampleCount: status === "unavailable" ? 0 : 1,
    positiveCount: status === "passed" ? 1 : 0,
    value: status === "unavailable" ? null : status === "passed" ? 1 : 0,
  });
}

function unavailableUncertainty(reason: string): EvaluationMetricUncertainty {
  return Object.freeze({ status: "unavailable" as const, method: "none" as const, reason });
}

function percentile(sorted: readonly number[], ratio: number): number {
  const position = (sorted.length - 1) * ratio;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

function metricRef(id: string): EvaluationRecordRef {
  return ref(`helarc.agent-instruction.metric.${id}.result`);
}

function ref(id: string): EvaluationRecordRef {
  return Object.freeze({ id, revision: HELARC_AGENT_INSTRUCTION_CAMPAIGN_REVISION });
}

function assertPublicationSafe(value: unknown): void {
  const serialized = JSON.stringify(value);
  if (/(?:bearer\s+[a-z0-9._-]+|sk-[a-z0-9_-]{12,}|api[_ -]?key\s*[:=]|[a-z]:\\|\/tmp\/agent-anything-|fullinstructions|instructiontext)/iu.test(serialized)) {
    throw new TypeError("Agent instruction Campaign publication contains protected target data.");
  }
}

function requiredText(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must not be empty.`);
  }
  return value.trim();
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortValue(child)]));
  }
  return value;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
