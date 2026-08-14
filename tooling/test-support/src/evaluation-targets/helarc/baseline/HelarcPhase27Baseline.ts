import type {
  HelarcEvaluationBaselineMetricSignature,
  HelarcEvaluationBaselineSignature,
} from "../HelarcEvaluationExecution.js";
import { HELARC_PHASE26_ACCEPTED_BASELINE } from "./HelarcPhase26Baseline.js";

const CASE_SEMANTIC_DIGESTS = Object.freeze({
  "controlled-patch": "0c48c7c78d5914f2a8297f4a0fef72c6e2d1c64cdf0523971fdde0bed964e05c",
  "denied-command": "d968c324c2a48e4a92c706b1ed0598e6251193bf217acc4bf8708fcc70fdcdba",
  "inspect-and-complete": "5154799a1f3e898b364b9160ea3b771b3b7375ec3419904a8f33b51e99bb0f1b",
  "malformed-output-retry": "ab935360d03dcc23c8149ba7d8b4e7521f546549d883d55475bf41ed42b0e036",
  search: "0ccb1f07d67101c176f6672b7881036747475eba83fc001148c339639d427fcf",
});

const LATENCY_BY_CASE = Object.freeze({
  "controlled-patch": 85,
  "denied-command": 88,
  "inspect-and-complete": 114,
  "malformed-output-retry": 47,
  search: 72,
});

const LATENCY_DISTRIBUTION = Object.freeze({
  kind: "numeric_distribution" as const,
  sampleCount: 10,
  minimum: 47,
  maximum: 114,
  mean: 81.2,
  variance: 531.2888888888888,
  varianceMethod: "sample" as const,
  p50: 85,
  p90: 114,
  p95: 114,
});

const LATENCY_UNCERTAINTY = Object.freeze({
  status: "available" as const,
  method: "standard_error" as const,
  confidence: 0.95,
  lower: 66.91390749067533,
  upper: 95.48609250932468,
});

const PHASE27_REPORT_REF = Object.freeze({
  id: "helarc.phase27.report.baseline",
  revision: HELARC_PHASE26_ACCEPTED_BASELINE.targetSnapshotRef.revision,
});
const PHASE27_ACCEPTANCE_REF = Object.freeze({
  id: "helarc.phase27.baseline-acceptance",
  revision: HELARC_PHASE26_ACCEPTED_BASELINE.targetSnapshotRef.revision,
});

const PUBLICATION_LIMITATIONS = Object.freeze([
  Object.freeze({
    code: "deterministic_system_baseline_only",
    message: "This corpus measures deterministic Product and Harness integration, not general model intelligence.",
    metadata: Object.freeze({}),
  }),
  Object.freeze({
    code: "environment_specific_baseline",
    message: "The accepted Target Snapshot is exact to the declared operating system, architecture, and Node major version.",
    metadata: Object.freeze({}),
  }),
]) satisfies HelarcEvaluationBaselineSignature["publication"]["limitations"];

const metrics = HELARC_PHASE26_ACCEPTED_BASELINE.metrics.map((metric) =>
  Object.freeze({
    ...metric,
    ref: phase27MetricResultRef(metric.ref),
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

export const HELARC_PHASE27_ACCEPTED_BASELINE = deepFreeze({
  ...HELARC_PHASE26_ACCEPTED_BASELINE,
  reportRef: PHASE27_REPORT_REF,
  acceptanceRef: PHASE27_ACCEPTANCE_REF,
  publication: {
    ...HELARC_PHASE26_ACCEPTED_BASELINE.publication,
    reportRef: PHASE27_REPORT_REF,
    metricSummaries: HELARC_PHASE26_ACCEPTED_BASELINE.publication.metricSummaries.map((summary) =>
      Object.freeze({
        ...summary,
        metricRef: phase27MetricResultRef(summary.metricRef),
        ...(summary.dimension === "efficiency"
          ? {
              distribution: LATENCY_DISTRIBUTION,
              uncertainty: LATENCY_UNCERTAINTY,
            }
          : {}),
      })
    ),
    dimensionSummaries: HELARC_PHASE26_ACCEPTED_BASELINE.publication.dimensionSummaries.map(
      (summary) => Object.freeze({
        ...summary,
        metricRefs: Object.freeze(summary.metricRefs.map(phase27MetricResultRef)),
      }),
    ),
    gateOutcomes: HELARC_PHASE26_ACCEPTED_BASELINE.publication.gateOutcomes.map(
      (outcome) => Object.freeze({
        ...outcome,
        metricRef: phase27MetricResultRef(outcome.metricRef),
      }),
    ),
    limitations: PUBLICATION_LIMITATIONS,
  },
  metrics,
  cases: HELARC_PHASE26_ACCEPTED_BASELINE.cases.map((caseResult) => Object.freeze({
    ...caseResult,
    traceIssueCodes: Object.freeze([]),
    semanticDigest: CASE_SEMANTIC_DIGESTS[caseSlug(caseResult.caseRef.id)],
  })),
} satisfies HelarcEvaluationBaselineSignature);

export const HELARC_PHASE27_BASELINE_ACCEPTANCE = deepFreeze({
  schemaVersion: 1,
  kind: "helarc_phase27_baseline_successor_acceptance",
  acceptedAt: "2026-08-14T00:00:00.000Z",
  predecessorAcceptanceRef: HELARC_PHASE26_ACCEPTED_BASELINE.acceptanceRef,
  successorAcceptanceRef: PHASE27_ACCEPTANCE_REF,
  predecessorReportRef: HELARC_PHASE26_ACCEPTED_BASELINE.reportRef,
  successorReportRef: PHASE27_REPORT_REF,
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
  reliability: "improved_trace_completeness",
  latency: "improved_deterministic_distribution",
  cost: "unchanged_not_measured",
  exclusions: "unchanged_none",
  limitations: "removed_resolved_trace_issue_limitation",
});

function phase27MetricResultRef(refValue: {
  readonly id: string;
  readonly revision: string;
}) {
  if (!refValue.id.endsWith(".baseline-result")) {
    throw new TypeError(`Unknown Phase26 Metric result '${refValue.id}'.`);
  }
  return Object.freeze({
    id: refValue.id.replace(/\.baseline-result$/, ".phase27-baseline-result"),
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
