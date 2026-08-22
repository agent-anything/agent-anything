import type {
  HelarcEvaluationBaselineMetricSignature,
  HelarcEvaluationBaselineSignature,
} from "../HelarcEvaluationExecution.js";
import { HELARC_PHASE26_ACCEPTED_BASELINE } from "./HelarcPhase26Baseline.js";

const CASE_SEMANTIC_DIGESTS = Object.freeze({
  "controlled-patch": "b01fcbe43c7a782c6b87192a3761e2c316cfd7b287bb9ca331c2599b816699ba",
  "denied-command": "6319c63e024b2cc1954a12e44db409ee5175576ed4df3708697f918d7d8ab34a",
  "inspect-and-complete": "448fd5d676b1e91c78afdc26c035eb7718c2b02f8027d5de84006bf5aa0559ec",
  "malformed-output-retry": "72bd3a27146f8bc3c3cfab99f15f07c34a6ee32a97daec358e24a8a00f2cf894",
  search: "8646f3618f79fcf8494ff46b1732f6ce92e295e1532761a730fa7be4af017772",
});

const LATENCY_BY_CASE = Object.freeze({
  "controlled-patch": 104,
  "denied-command": 102,
  "inspect-and-complete": 135,
  "malformed-output-retry": 55,
  search: 86,
});

const LATENCY_DISTRIBUTION = Object.freeze({
  kind: "numeric_distribution" as const,
  sampleCount: 10,
  minimum: 55,
  maximum: 135,
  mean: 96.4,
  variance: 755.8222222222222,
  varianceMethod: "sample" as const,
  p50: 102,
  p90: 135,
  p95: 135,
});

const LATENCY_UNCERTAINTY = Object.freeze({
  status: "available" as const,
  method: "standard_error" as const,
  confidence: 0.95,
  lower: 79.36045790781401,
  upper: 113.439542092186,
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

const REPORT_REF = Object.freeze({
  id: "helarc.context-continuity.report.baseline",
  revision: HELARC_PHASE26_ACCEPTED_BASELINE.targetSnapshotRef.revision,
});
const ACCEPTANCE_REF = Object.freeze({
  id: "helarc.context-continuity.baseline-acceptance",
  revision: HELARC_PHASE26_ACCEPTED_BASELINE.targetSnapshotRef.revision,
});

const metrics = HELARC_PHASE26_ACCEPTED_BASELINE.metrics.map((metric) =>
  Object.freeze({
    ...metric,
    ref: contextContinuityMetricResultRef(metric.ref),
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

export const HELARC_CONTEXT_CONTINUITY_ACCEPTED_BASELINE = deepFreeze({
  ...HELARC_PHASE26_ACCEPTED_BASELINE,
  targetManifestDigest: "de0b62d128f7350f5c4e3a578454b03da807b337a6f254cb6e0c7df6e246d120",
  reportRef: REPORT_REF,
  acceptanceRef: ACCEPTANCE_REF,
  publication: {
    ...HELARC_PHASE26_ACCEPTED_BASELINE.publication,
    reportRef: REPORT_REF,
    metricSummaries: HELARC_PHASE26_ACCEPTED_BASELINE.publication.metricSummaries.map((summary) =>
      Object.freeze({
        ...summary,
        metricRef: contextContinuityMetricResultRef(summary.metricRef),
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
        metricRefs: Object.freeze(summary.metricRefs.map(contextContinuityMetricResultRef)),
      }),
    ),
    gateOutcomes: HELARC_PHASE26_ACCEPTED_BASELINE.publication.gateOutcomes.map(
      (outcome) => Object.freeze({
        ...outcome,
        metricRef: contextContinuityMetricResultRef(outcome.metricRef),
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

export const HELARC_CONTEXT_CONTINUITY_BASELINE_ACCEPTANCE = deepFreeze({
  schemaVersion: 1,
  kind: "helarc_context_continuity_baseline_successor_acceptance",
  acceptedAt: "2026-08-17T00:00:00.000Z",
  predecessorAcceptanceRef: HELARC_PHASE26_ACCEPTED_BASELINE.acceptanceRef,
  successorAcceptanceRef: ACCEPTANCE_REF,
  predecessorReportRef: HELARC_PHASE26_ACCEPTED_BASELINE.reportRef,
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
  reliability: "expanded_context_and_continuation_conformance",
  latency: "changed_with_complete_context_accounting",
  cost: "unchanged_not_measured",
  exclusions: "context_specific_exclusions_recorded_separately",
  limitations: "deterministic_system_baseline_only",
});

function contextContinuityMetricResultRef(refValue: {
  readonly id: string;
  readonly revision: string;
}) {
  if (!refValue.id.endsWith(".baseline-result")) {
    throw new TypeError(`Unknown predecessor Metric result '${refValue.id}'.`);
  }
  return Object.freeze({
    id: refValue.id.replace(
      /\.baseline-result$/,
      ".context-continuity-baseline-result",
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
