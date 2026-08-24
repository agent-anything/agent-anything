import type {
  HelarcEvaluationBaselineMetricSignature,
  HelarcEvaluationBaselineSignature,
} from "../HelarcEvaluationExecution.js";
import { HELARC_VALIDATION_COMPLETION_ACCEPTED_BASELINE } from "./HelarcValidationCompletionBaseline.js";

const TARGET_MANIFEST_DIGEST = "23e885793033692293b33fcf29d002696d5aaee091180611ad0105fc49890f75";
const TARGET_REVISION = HELARC_VALIDATION_COMPLETION_ACCEPTED_BASELINE.targetSnapshotRef.revision
  .replace(/^v5-/, "v6-");
const TARGET_REF = Object.freeze({
  id: HELARC_VALIDATION_COMPLETION_ACCEPTED_BASELINE.targetSnapshotRef.id,
  revision: TARGET_REVISION,
});
const REPORT_REF = Object.freeze({
  id: "helarc.run-tree-control.report.baseline",
  revision: TARGET_REVISION,
});
const ACCEPTANCE_REF = Object.freeze({
  id: "helarc.run-tree-control.baseline-acceptance",
  revision: TARGET_REVISION,
});

const LATENCY_BY_CASE = Object.freeze<Record<string, number>>({
  "controlled-file-write": 104,
  "denied-command": 115,
  "failed-check-recovery": 176,
  "inspect-and-complete": 152,
  "malformed-output-retry": 72,
  "multi-file-mutation": 217,
  "ordinary-shell-validation": 115,
  "premature-completion": 68,
  search: 103,
  "stale-evidence": 136,
});

const CASE_DIGEST_BY_SLUG = Object.freeze<Record<string, string>>({
  "controlled-file-write": "cf1035f6c88e303b127e785295ef73970254738b4f066b1d3daf206f34d6a2aa",
  "denied-command": "48bb87a8c850b04e115824d43cf8ab89c297ebb5e70c5fc251987cb3714ba4b0",
  "failed-check-recovery": "a9a0aa33198b11cb640c33aa1d59d5bef802a452617b6a2fab7bde8f7a637dbf",
  "inspect-and-complete": "b53f248618ae9a99aa17e68177e6cb1f8676f9b529fb18c08731f9bc63832396",
  "malformed-output-retry": "b0f5240b0380f2f11e7ccce3dc8052bff2d960b7f74e2c2b633908dafe2debda",
  "multi-file-mutation": "7472c1417de1914ed6d16c850e5f09b0a5c001b7c5ddb2b865e97d74e4bb83b6",
  "ordinary-shell-validation": "52f40c05dcb22f13309e61af37329ceae295b59da6cdd8be6547271c45971ad8",
  "premature-completion": "72e1c38695975eb20ea18d16478e5ff35b56ac4e51f4366d7e0efb372a89bd88",
  search: "02c070fb334faaf0b2ba8ebf80414aa244f6725a88730bca452370bc319b0813",
  "stale-evidence": "b47d27962d92f331494842cc7d5b8371393c0ec36124352c642b6bbfe09fd7c0",
});

const LATENCY_DISTRIBUTION = Object.freeze({
  kind: "numeric_distribution" as const,
  sampleCount: 20,
  minimum: 68,
  maximum: 217,
  mean: 125.8,
  variance: 2009.642105263158,
  varianceMethod: "sample" as const,
  p50: 115,
  p90: 180.10000000000005,
  p95: 217,
});
const LATENCY_UNCERTAINTY = Object.freeze({
  status: "available" as const,
  method: "standard_error" as const,
  confidence: 0.95,
  lower: 106.1531714974792,
  upper: 145.4468285025208,
});

const metrics = HELARC_VALIDATION_COMPLETION_ACCEPTED_BASELINE.metrics.map((metric) => {
  const latency = metric.definitionRef.id.endsWith(".latency");
  return Object.freeze({
    ...metric,
    ref: runTreeControlMetricResultRef(metric.ref),
    targetSnapshotRef: TARGET_REF,
    samples: latency
      ? Object.freeze(metric.samples.map((sample) => Object.freeze({
          ...sample,
          value: latencyForCase(sample.caseRef.id),
        })))
      : metric.samples,
    distribution: latency ? LATENCY_DISTRIBUTION : metric.distribution,
    uncertainty: latency ? LATENCY_UNCERTAINTY : metric.uncertainty,
  }) satisfies HelarcEvaluationBaselineMetricSignature;
});

export const HELARC_RUN_TREE_CONTROL_ACCEPTED_BASELINE = deepFreeze({
  ...HELARC_VALIDATION_COMPLETION_ACCEPTED_BASELINE,
  targetSnapshotRef: TARGET_REF,
  targetManifestDigest: TARGET_MANIFEST_DIGEST,
  reportRef: REPORT_REF,
  acceptanceRef: ACCEPTANCE_REF,
  publication: {
    ...HELARC_VALIDATION_COMPLETION_ACCEPTED_BASELINE.publication,
    reportRef: REPORT_REF,
    targetSnapshotRefs: Object.freeze([TARGET_REF]),
    metricSummaries:
      HELARC_VALIDATION_COMPLETION_ACCEPTED_BASELINE.publication.metricSummaries.map(
        (summary) => {
          const latency = summary.metricRef.id.includes(".latency.");
          return Object.freeze({
            ...summary,
            metricRef: runTreeControlMetricResultRef(summary.metricRef),
            distribution: latency ? LATENCY_DISTRIBUTION : summary.distribution,
            uncertainty: latency ? LATENCY_UNCERTAINTY : summary.uncertainty,
          });
        },
      ),
    dimensionSummaries:
      HELARC_VALIDATION_COMPLETION_ACCEPTED_BASELINE.publication.dimensionSummaries.map(
        (summary) => Object.freeze({
          ...summary,
          metricRefs: Object.freeze(summary.metricRefs.map(runTreeControlMetricResultRef)),
        }),
      ),
    gateOutcomes:
      HELARC_VALIDATION_COMPLETION_ACCEPTED_BASELINE.publication.gateOutcomes.map(
        (outcome) => Object.freeze({
          ...outcome,
          metricRef: runTreeControlMetricResultRef(outcome.metricRef),
        }),
      ),
  },
  metrics: Object.freeze(metrics),
  cases: Object.freeze(HELARC_VALIDATION_COMPLETION_ACCEPTED_BASELINE.cases.map((item) =>
    Object.freeze({
      ...item,
      semanticDigest: digestForCase(item.caseRef.id),
    }))),
} satisfies HelarcEvaluationBaselineSignature);

export const HELARC_RUN_TREE_CONTROL_BASELINE_ACCEPTANCE = deepFreeze({
  schemaVersion: 1,
  kind: "helarc_run_tree_control_baseline_successor_acceptance",
  acceptedAt: "2026-08-24T00:00:00.000Z",
  predecessorAcceptanceRef: HELARC_VALIDATION_COMPLETION_ACCEPTED_BASELINE.acceptanceRef,
  successorAcceptanceRef: ACCEPTANCE_REF,
  predecessorReportRef: HELARC_VALIDATION_COMPLETION_ACCEPTED_BASELINE.reportRef,
  successorReportRef: REPORT_REF,
  comparison: "intentionally_incomparable_exact_target",
  changedTargetInputs: Object.freeze([
    "product.revision",
    "target-adapter.revision",
    "source.revision",
    "run-limits.revision",
  ]),
  outcomeQuality: "passed",
  safety: "passed",
  reliability: "deterministic_candidate_repeated_equivalently",
  latencyDelta:
    "Eighteen Trials add 1 ms and two denied-command Trials add 3 ms under the deterministic clock.",
  coverage:
    "The root-only accepted Suite is paired with focused recursive Product and hostile Runtime Run Tree conformance.",
  limitations: "deterministic_system_baseline_only",
});

function runTreeControlMetricResultRef(refValue: {
  readonly id: string;
  readonly revision: string;
}) {
  if (!refValue.id.endsWith(".validation-completion-baseline-result")) {
    throw new TypeError(`Unknown predecessor Metric result '${refValue.id}'.`);
  }
  return Object.freeze({
    id: refValue.id.replace(
      /\.validation-completion-baseline-result$/,
      ".run-tree-control-baseline-result",
    ),
    revision: TARGET_REVISION,
  });
}

function latencyForCase(caseId: string): number {
  const slug = caseSlug(caseId);
  const latency = LATENCY_BY_CASE[slug];
  if (latency === undefined) throw new TypeError(`Unknown Run Tree Control Case '${caseId}'.`);
  return latency;
}

function digestForCase(caseId: string): string {
  const slug = caseSlug(caseId);
  const digest = CASE_DIGEST_BY_SLUG[slug];
  if (digest === undefined) throw new TypeError(`Unknown Run Tree Control Case '${caseId}'.`);
  return digest;
}

function caseSlug(caseId: string): string {
  const marker = ".case.";
  const index = caseId.lastIndexOf(marker);
  if (index < 0) throw new TypeError(`Unknown predecessor Case '${caseId}'.`);
  return caseId.slice(index + marker.length);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
