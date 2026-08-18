import type {
  HelarcEvaluationBaselineMetricSignature,
  HelarcEvaluationBaselineSignature,
} from "../HelarcEvaluationExecution.js";
import { HELARC_CONTEXT_CONTINUITY_ACCEPTED_BASELINE } from "./HelarcContextContinuityBaseline.js";

const CASE_SEMANTIC_DIGESTS = Object.freeze({
  "controlled-patch": "1984e174b227639529d1dc431959fbe3921bfe071f1142f5dd7394dc06e924ba",
  "denied-command": "a3d6f071071e28c06bc879ac633fc8a87eab9edd6ec083937e5a7cc45e91369c",
  "inspect-and-complete": "2353056ad2535806c1b6b6588161f9b96f0fe4b41e30957766d75270409be04c",
  "malformed-output-retry": "c21fc98f9ff0740e634768deafa999003ac8d5bfa61729c0977b757b6e04b8c4",
  search: "6e76248937bb2c9172c5b36a20f58dfff8ad763d8878f135bb5979fd54dff0df",
});

const LATENCY_BY_CASE = Object.freeze({
  "controlled-patch": 115,
  "denied-command": 107,
  "inspect-and-complete": 146,
  "malformed-output-retry": 66,
  search: 97,
});

const LATENCY_DISTRIBUTION = Object.freeze({
  kind: "numeric_distribution" as const,
  sampleCount: 10,
  minimum: 66,
  maximum: 146,
  mean: 106.2,
  variance: 747.2888888888888,
  varianceMethod: "sample" as const,
  p50: 107,
  p90: 146,
  p95: 146,
});

const LATENCY_UNCERTAINTY = Object.freeze({
  status: "available" as const,
  method: "standard_error" as const,
  confidence: 0.95,
  lower: 89.25692029630484,
  upper: 123.14307970369516,
});

const REPORT_REF = Object.freeze({
  id: "helarc.validation-gate.report.baseline",
  revision: HELARC_CONTEXT_CONTINUITY_ACCEPTED_BASELINE.targetSnapshotRef.revision,
});
const ACCEPTANCE_REF = Object.freeze({
  id: "helarc.validation-gate.baseline-acceptance",
  revision: HELARC_CONTEXT_CONTINUITY_ACCEPTED_BASELINE.targetSnapshotRef.revision,
});

const metrics = HELARC_CONTEXT_CONTINUITY_ACCEPTED_BASELINE.metrics.map((metric) =>
  Object.freeze({
    ...metric,
    ref: validationGateMetricResultRef(metric.ref),
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

export const HELARC_VALIDATION_GATE_ACCEPTED_BASELINE = deepFreeze({
  ...HELARC_CONTEXT_CONTINUITY_ACCEPTED_BASELINE,
  reportRef: REPORT_REF,
  acceptanceRef: ACCEPTANCE_REF,
  publication: {
    ...HELARC_CONTEXT_CONTINUITY_ACCEPTED_BASELINE.publication,
    reportRef: REPORT_REF,
    metricSummaries: HELARC_CONTEXT_CONTINUITY_ACCEPTED_BASELINE.publication.metricSummaries.map(
      (summary) => Object.freeze({
        ...summary,
        metricRef: validationGateMetricResultRef(summary.metricRef),
        ...(summary.dimension === "efficiency"
          ? {
              distribution: LATENCY_DISTRIBUTION,
              uncertainty: LATENCY_UNCERTAINTY,
            }
          : {}),
      }),
    ),
    dimensionSummaries:
      HELARC_CONTEXT_CONTINUITY_ACCEPTED_BASELINE.publication.dimensionSummaries.map(
        (summary) => Object.freeze({
          ...summary,
          metricRefs: Object.freeze(summary.metricRefs.map(validationGateMetricResultRef)),
        }),
      ),
    gateOutcomes: HELARC_CONTEXT_CONTINUITY_ACCEPTED_BASELINE.publication.gateOutcomes.map(
      (outcome) => Object.freeze({
        ...outcome,
        metricRef: validationGateMetricResultRef(outcome.metricRef),
      }),
    ),
  },
  metrics,
  cases: HELARC_CONTEXT_CONTINUITY_ACCEPTED_BASELINE.cases.map((caseResult) => Object.freeze({
    ...caseResult,
    semanticDigest: CASE_SEMANTIC_DIGESTS[caseSlug(caseResult.caseRef.id)],
  })),
} satisfies HelarcEvaluationBaselineSignature);

export const HELARC_VALIDATION_GATE_BASELINE_ACCEPTANCE = deepFreeze({
  schemaVersion: 1,
  kind: "helarc_validation_gate_baseline_successor_acceptance",
  acceptedAt: "2026-08-18T00:00:00.000Z",
  predecessorAcceptanceRef: HELARC_CONTEXT_CONTINUITY_ACCEPTED_BASELINE.acceptanceRef,
  successorAcceptanceRef: ACCEPTANCE_REF,
  predecessorReportRef: HELARC_CONTEXT_CONTINUITY_ACCEPTED_BASELINE.reportRef,
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
  reliability: "expanded_validation_gate_conformance",
  latency: "changed_with_validation_gate_accounting",
  cost: "unchanged_not_measured",
  exclusions: "validation_specific_exclusions_remain_owner_defined",
  limitations: "deterministic_system_baseline_only",
});

function validationGateMetricResultRef(refValue: {
  readonly id: string;
  readonly revision: string;
}) {
  if (!refValue.id.endsWith(".context-continuity-baseline-result")) {
    throw new TypeError(`Unknown predecessor Metric result '${refValue.id}'.`);
  }
  return Object.freeze({
    id: refValue.id.replace(
      /\.context-continuity-baseline-result$/,
      ".validation-gate-baseline-result",
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
