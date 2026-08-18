import type {
  HelarcEvaluationBaselineMetricSignature,
  HelarcEvaluationBaselineSignature,
} from "../HelarcEvaluationExecution.js";
import { HELARC_VALIDATION_GATE_ACCEPTED_BASELINE } from "./HelarcValidationGateBaseline.js";

const CASE_SEMANTIC_DIGESTS = Object.freeze({
  "controlled-patch": "3624a22039a9b5caf677ca700bdb6ac186e9b6c8db9c14674743d76145460bde",
  "denied-command": "4a6ac0c3e2da785219b902f0c4dc4ea1988b9d873448546e5abad5fde57c416e",
  "inspect-and-complete": "7d8c5ec8559378c6cd97486369a21b3ae1fdf8d46b57cbdff7a3762ddb542323",
  "malformed-output-retry": "7123f65b63877adea7a9b28631623d796b0e49b54948a2a30870414feed8a653",
  search: "7e63de4826edd5445990bde64aa53eeba07ec21f2e0fdb68caff49a7b9fd2724",
});

const LATENCY_BY_CASE = Object.freeze({
  "controlled-patch": 115,
  "denied-command": 112,
  "inspect-and-complete": 146,
  "malformed-output-retry": 66,
  search: 97,
});

const LATENCY_DISTRIBUTION = Object.freeze({
  kind: "numeric_distribution" as const,
  sampleCount: 10,
  minimum: 66,
  maximum: 146,
  mean: 107.2,
  variance: 753.5111111111112,
  varianceMethod: "sample" as const,
  p50: 112,
  p90: 146,
  p95: 146,
});

const LATENCY_UNCERTAINTY = Object.freeze({
  status: "available" as const,
  method: "standard_error" as const,
  confidence: 0.95,
  lower: 90.18652913442972,
  upper: 124.21347086557029,
});

const REPORT_REF = Object.freeze({
  id: "helarc.validation-profile.report.baseline",
  revision: HELARC_VALIDATION_GATE_ACCEPTED_BASELINE.targetSnapshotRef.revision,
});
const ACCEPTANCE_REF = Object.freeze({
  id: "helarc.validation-profile.baseline-acceptance",
  revision: HELARC_VALIDATION_GATE_ACCEPTED_BASELINE.targetSnapshotRef.revision,
});

const metrics = HELARC_VALIDATION_GATE_ACCEPTED_BASELINE.metrics.map((metric) =>
  Object.freeze({
    ...metric,
    ref: validationProfileMetricResultRef(metric.ref),
    ...(metric.definitionRef.id.endsWith(".latency")
      ? {
          samples: Object.freeze(metric.samples.map((sample) => Object.freeze({
            ...sample,
            value: LATENCY_BY_CASE[caseSlug(sample.caseRef.id)],
          }))),
          distribution: LATENCY_DISTRIBUTION,
          uncertainty: LATENCY_UNCERTAINTY,
        }
      : {}),
  }) satisfies HelarcEvaluationBaselineMetricSignature
);

export const HELARC_VALIDATION_PROFILE_ACCEPTED_BASELINE = deepFreeze({
  ...HELARC_VALIDATION_GATE_ACCEPTED_BASELINE,
  reportRef: REPORT_REF,
  acceptanceRef: ACCEPTANCE_REF,
  publication: {
    ...HELARC_VALIDATION_GATE_ACCEPTED_BASELINE.publication,
    reportRef: REPORT_REF,
    metricSummaries: HELARC_VALIDATION_GATE_ACCEPTED_BASELINE.publication.metricSummaries.map(
      (summary) => Object.freeze({
        ...summary,
        metricRef: validationProfileMetricResultRef(summary.metricRef),
        ...(summary.dimension === "efficiency"
          ? {
              distribution: LATENCY_DISTRIBUTION,
              uncertainty: LATENCY_UNCERTAINTY,
            }
          : {}),
      }),
    ),
    dimensionSummaries:
      HELARC_VALIDATION_GATE_ACCEPTED_BASELINE.publication.dimensionSummaries.map(
        (summary) => Object.freeze({
          ...summary,
          metricRefs: Object.freeze(summary.metricRefs.map(validationProfileMetricResultRef)),
        }),
      ),
    gateOutcomes: HELARC_VALIDATION_GATE_ACCEPTED_BASELINE.publication.gateOutcomes.map(
      (outcome) => Object.freeze({
        ...outcome,
        metricRef: validationProfileMetricResultRef(outcome.metricRef),
      }),
    ),
    missingDataCodes: Object.freeze([]),
  },
  metrics,
  cases: HELARC_VALIDATION_GATE_ACCEPTED_BASELINE.cases.map((caseResult) => Object.freeze({
    ...caseResult,
    semanticDigest: CASE_SEMANTIC_DIGESTS[caseSlug(caseResult.caseRef.id)],
  })),
} satisfies HelarcEvaluationBaselineSignature);

export const HELARC_VALIDATION_PROFILE_BASELINE_ACCEPTANCE = deepFreeze({
  schemaVersion: 1,
  kind: "helarc_validation_profile_baseline_successor_acceptance",
  acceptedAt: "2026-08-18T00:00:00.000Z",
  predecessorAcceptanceRef: HELARC_VALIDATION_GATE_ACCEPTED_BASELINE.acceptanceRef,
  successorAcceptanceRef: ACCEPTANCE_REF,
  predecessorReportRef: HELARC_VALIDATION_GATE_ACCEPTED_BASELINE.reportRef,
  successorReportRef: REPORT_REF,
  retainedIdentities: Object.freeze([
    "target",
    "corpus",
    "campaign",
    "environment",
    "capture",
    "grader",
    "metric_definition",
  ]),
  changedCaseSemanticDigests: Object.freeze(Object.keys(CASE_SEMANTIC_DIGESTS).sort()),
  outcomeQuality: "unchanged",
  safety: "unchanged",
  reliability: "expanded_product_validation_profile_conformance",
  missingData: "required_validation_summary_captured",
  latency: "changed_with_product_validation_profile_accounting",
  cost: "unchanged_not_measured",
  exclusions: "validation_specific_exclusions_remain_owner_defined",
  limitations: "deterministic_system_baseline_only",
});

function validationProfileMetricResultRef(refValue: {
  readonly id: string;
  readonly revision: string;
}) {
  if (!refValue.id.endsWith(".validation-gate-baseline-result")) {
    throw new TypeError(`Unknown predecessor Metric result '${refValue.id}'.`);
  }
  return Object.freeze({
    id: refValue.id.replace(
      /\.validation-gate-baseline-result$/,
      ".validation-profile-baseline-result",
    ),
    revision: refValue.revision,
  });
}

function caseSlug(caseId: string): keyof typeof CASE_SEMANTIC_DIGESTS {
  const slug = caseId.replace("helarc.phase26.case.", "");
  if (!Object.hasOwn(CASE_SEMANTIC_DIGESTS, slug)) {
    throw new TypeError(`Unknown Helarc Evaluation Case '${caseId}'.`);
  }
  return slug as keyof typeof CASE_SEMANTIC_DIGESTS;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
