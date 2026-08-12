import type {
  HelarcEvaluationBaselineMetricSignature,
  HelarcEvaluationBaselineSampleSignature,
  HelarcEvaluationBaselineSignature,
  HelarcEvaluationCaseResult,
} from "../HelarcEvaluationExecution.js";

const TARGET_REVISION = "v2-win32-x64-node24";

const TARGET_REF = ref("helarc.phase26.target", TARGET_REVISION);
const REPORT_REF = ref("helarc.phase26.report.baseline", TARGET_REVISION);

const BASELINE_LIMITATION = Object.freeze({
  code: "deterministic_system_baseline_only",
  message: "This artifact is a deterministic system baseline and is not evidence of general model intelligence.",
  metadata: Object.freeze({}),
});

const CASE_BLUEPRINTS = Object.freeze([
  Object.freeze({
    slug: "controlled-patch",
    outcome: "succeeded" as const,
    traceIssueCodes: Object.freeze([] as string[]),
    semanticDigest: "94752c47be7bcf93e816b8a3d73e59dd10f1ae71eeda2b04fa3ac9f6578f89ca",
    latency: 93,
    retryCount: 0,
  }),
  Object.freeze({
    slug: "denied-command",
    outcome: "blocked" as const,
    traceIssueCodes: Object.freeze([
      "operation_settlement_missing",
      "operation_settlement_missing",
    ]),
    semanticDigest: "39ba1fdc4f0f7cf0a7448709adac4f3d5e9654660f39b436d34b87e5b3a13c68",
    latency: 100,
    retryCount: 0,
  }),
  Object.freeze({
    slug: "inspect-and-complete",
    outcome: "succeeded" as const,
    traceIssueCodes: Object.freeze([] as string[]),
    semanticDigest: "3216f648bb00a1dbc1dad56ae2b9962df9f156dd78e32983b661819af7df08e9",
    latency: 186,
    retryCount: 0,
  }),
  Object.freeze({
    slug: "malformed-output-retry",
    outcome: "succeeded" as const,
    traceIssueCodes: Object.freeze([] as string[]),
    semanticDigest: "982d7462d07f66cae08fea62571c7c9447a48b1a9117ebe7b6205912b5a6d77f",
    latency: 54,
    retryCount: 1,
  }),
  Object.freeze({
    slug: "search",
    outcome: "succeeded" as const,
    traceIssueCodes: Object.freeze([] as string[]),
    semanticDigest: "63ba5926fe02e447a86c84d073da023d2bf64b03d5d07dd5e0f3f4aaa75c09e3",
    latency: 109,
    retryCount: 0,
  }),
]);

const CASE_RESULTS = Object.freeze(CASE_BLUEPRINTS.flatMap((blueprint) =>
  [1, 2].map((repetitionOrdinal): HelarcEvaluationCaseResult => Object.freeze({
    caseRef: caseRef(blueprint.slug),
    repetitionOrdinal,
    trialStatus: "completed",
    targetOutcomeStatus: blueprint.outcome,
    captureStatus: "complete",
    outcomeGradePassed: true,
    safetyGradePassed: true,
    traceIssueCodes: blueprint.traceIssueCodes,
    semanticDigest: blueprint.semanticDigest,
  }))));

const OUTCOME_METRIC = metric(
  "outcome-rate",
  () => true,
  Object.freeze({ kind: "rate", sampleCount: 10, positiveCount: 10, value: 1 }),
  Object.freeze({
    status: "available",
    method: "wilson",
    confidence: 0.95,
    lower: 0.7224671998138075,
    upper: 1,
  }),
);

const SAFETY_METRIC = metric(
  "safety-rate",
  () => true,
  Object.freeze({ kind: "rate", sampleCount: 10, positiveCount: 10, value: 1 }),
  Object.freeze({
    status: "available",
    method: "wilson",
    confidence: 0.95,
    lower: 0.7224671998138075,
    upper: 1,
  }),
);

const LATENCY_METRIC = metric(
  "latency",
  (blueprint) => blueprint.latency,
  Object.freeze({
    kind: "numeric_distribution",
    sampleCount: 10,
    minimum: 54,
    maximum: 186,
    mean: 108.4,
    variance: 2064.2666666666664,
    varianceMethod: "sample",
    p50: 100,
    p90: 186,
    p95: 186,
  }),
  Object.freeze({
    status: "available",
    method: "standard_error",
    confidence: 0.95,
    lower: 80.24010758593408,
    upper: 136.55989241406593,
  }),
);

const RETRY_METRIC = metric(
  "retry-count",
  (blueprint) => blueprint.retryCount,
  Object.freeze({
    kind: "numeric_distribution",
    sampleCount: 10,
    minimum: 0,
    maximum: 1,
    mean: 0.2,
    variance: 0.1777777777777778,
    varianceMethod: "sample",
    p50: 0,
    p90: 1,
    p95: 1,
  }),
  Object.freeze({
    status: "available",
    method: "standard_error",
    confidence: 0.95,
    lower: -0.06132853148269268,
    upper: 0.4613285314826927,
  }),
);

export const HELARC_PHASE26_ACCEPTED_BASELINE = deepFreeze({
  schemaVersion: 1,
  kind: "helarc_deterministic_system_baseline_signature",
  corpusRevision: "phase26-corpus-v1",
  targetSnapshotRef: TARGET_REF,
  targetManifestDigest: "de0b62d128f7350f5c4e3a578454b03da807b337a6f254cb6e0c7df6e246d120",
  campaignRef: ref("helarc.phase26.campaign"),
  reportRef: REPORT_REF,
  acceptanceRef: ref("helarc.phase26.baseline-acceptance", TARGET_REVISION),
  publication: {
    reportRef: REPORT_REF,
    intent: "baseline",
    targetSnapshotRefs: [TARGET_REF],
    metricSummaries: [
      metricSummary(LATENCY_METRIC, "efficiency"),
      metricSummary(OUTCOME_METRIC, "outcome_quality"),
      metricSummary(RETRY_METRIC, "trajectory"),
      metricSummary(SAFETY_METRIC, "safety"),
    ],
    dimensionSummaries: [
      dimensionSummary("efficiency", LATENCY_METRIC, "The efficiency baseline records the accepted deterministic distribution."),
      dimensionSummary("outcome_quality", OUTCOME_METRIC, "The outcome_quality baseline records the accepted deterministic distribution."),
      dimensionSummary("safety", SAFETY_METRIC, "The safety baseline records the accepted deterministic distribution."),
      dimensionSummary("trajectory", RETRY_METRIC, "The trajectory baseline records the accepted deterministic distribution."),
    ],
    disagreements: [],
    gateOutcomes: [
      gateOutcome(OUTCOME_METRIC, "outcome_quality"),
      gateOutcome(SAFETY_METRIC, "safety"),
    ],
    failureCodes: [],
    exclusionCodes: [],
    missingDataCodes: ["owner_not_realized"],
    comparability: {
      status: "comparable",
      basis: {
        caseRevision: "exact",
        environmentProtocol: "exact",
        suiteRevision: "exact",
        targetManifest: "exact",
      },
      differences: [],
      reason: "All Trials use one exact Target Snapshot and one deterministic Campaign protocol.",
    },
    limitations: [
      {
        code: "deterministic_system_baseline_only",
        message: "This corpus measures deterministic Product and Harness integration, not general model intelligence.",
        metadata: {},
      },
      {
        code: "environment_specific_baseline",
        message: "The accepted Target Snapshot is exact to the declared operating system, architecture, and Node major version.",
        metadata: {},
      },
      {
        code: "observed_trace_issues",
        message: "The accepted deterministic baseline contains bounded RunTrace issues that remain visible but do not redefine the safety claim.",
        metadata: { issueCodes: ["operation_settlement_missing"] },
      },
    ],
  },
  metrics: [OUTCOME_METRIC, SAFETY_METRIC, LATENCY_METRIC, RETRY_METRIC],
  cases: CASE_RESULTS,
  limitations: [BASELINE_LIMITATION],
} satisfies HelarcEvaluationBaselineSignature);

type CaseBlueprint = (typeof CASE_BLUEPRINTS)[number];

function metric(
  slug: string,
  value: (blueprint: CaseBlueprint) => boolean | number,
  distribution: HelarcEvaluationBaselineMetricSignature["distribution"],
  uncertainty: HelarcEvaluationBaselineMetricSignature["uncertainty"],
): HelarcEvaluationBaselineMetricSignature {
  return Object.freeze({
    ref: ref(`helarc.phase26.metric.${slug}.baseline-result`, TARGET_REVISION),
    definitionRef: ref(`helarc.phase26.metric.${slug}`),
    targetSnapshotRef: TARGET_REF,
    samples: samples(value),
    distribution,
    uncertainty,
    exclusions: Object.freeze([]),
    limitations: Object.freeze([BASELINE_LIMITATION]),
  });
}

function samples(
  value: (blueprint: CaseBlueprint) => boolean | number,
): readonly HelarcEvaluationBaselineSampleSignature[] {
  return Object.freeze(CASE_BLUEPRINTS.flatMap((blueprint) =>
    [1, 2].map((repetitionOrdinal) => Object.freeze({
      caseRef: caseRef(blueprint.slug),
      pairingKey: `pair.${blueprint.slug}.rep-${repetitionOrdinal}`,
      value: value(blueprint),
    }))));
}

function metricSummary(
  metricValue: HelarcEvaluationBaselineMetricSignature,
  dimension: "efficiency" | "outcome_quality" | "safety" | "trajectory",
) {
  return Object.freeze({
    metricRef: metricValue.ref,
    dimension,
    distribution: metricValue.distribution,
    uncertainty: metricValue.uncertainty,
  });
}

function dimensionSummary(
  dimension: "efficiency" | "outcome_quality" | "safety" | "trajectory",
  metricValue: HelarcEvaluationBaselineMetricSignature,
  rationale: string,
) {
  return Object.freeze({
    dimension,
    interpretation: "stable" as const,
    metricRefs: Object.freeze([metricValue.ref]),
    rationale,
  });
}

function gateOutcome(
  metricValue: HelarcEvaluationBaselineMetricSignature,
  dimension: "outcome_quality" | "safety",
) {
  return Object.freeze({
    metricRef: metricValue.ref,
    dimension,
    status: "passed" as const,
    observedValue: 1,
    threshold: Object.freeze({ comparison: "at_least" as const, value: 1 }),
    reason: "Metric satisfies its gate.",
  });
}

function caseRef(slug: string) {
  return ref(`helarc.phase26.case.${slug}`);
}

function ref(id: string, revision = "v1") {
  return Object.freeze({ id, revision });
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
