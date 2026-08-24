import type {
  HelarcEvaluationBaselineMetricSignature,
  HelarcEvaluationBaselineSignature,
} from "../HelarcEvaluationExecution.js";
import { HELARC_RUN_TREE_CONTROL_ACCEPTED_BASELINE } from "./HelarcRunTreeControlBaseline.js";

const TARGET_MANIFEST_DIGEST = "fa62546ddef6d2e3b2a8be1e34688629c2c87660f223295bb467377e28b0f543";
const TARGET_REVISION = HELARC_RUN_TREE_CONTROL_ACCEPTED_BASELINE.targetSnapshotRef.revision
  .replace(/^v6-/, "v7-");
const TARGET_REF = Object.freeze({
  id: HELARC_RUN_TREE_CONTROL_ACCEPTED_BASELINE.targetSnapshotRef.id,
  revision: TARGET_REVISION,
});
const REPORT_REF = Object.freeze({
  id: "helarc.run-progress.report.baseline",
  revision: TARGET_REVISION,
});
const ACCEPTANCE_REF = Object.freeze({
  id: "helarc.run-progress.baseline-acceptance",
  revision: TARGET_REVISION,
});

const LATENCY_BY_CASE = Object.freeze<Record<string, number>>({
  "controlled-file-write": 107,
  "denied-command": 118,
  "failed-check-recovery": 182,
  "inspect-and-complete": 158,
  "malformed-output-retry": 72,
  "multi-file-mutation": 223,
  "ordinary-shell-validation": 118,
  "premature-completion": 68,
  search: 106,
  "stale-evidence": 139,
});

const CASE_DIGEST_BY_SLUG = Object.freeze<Record<string, string>>({
  "controlled-file-write": "6985c0b9e18c814931a239982b018fba14354d747edc022ad43ec84e6a3aa1bb",
  "denied-command": "cc18214b264a51fc7ef3ade09ea775fb4c9d9df29444de78e400f4f814ace58d",
  "failed-check-recovery": "476119f3c4e45b09e7c25f3b981bac7ed2fb4448865f6ee8cebefe97da2f4545",
  "inspect-and-complete": "4c4936aee9f15fd28656ec90abc627e981ab36db5ec3c4deac7e63a6e8016f84",
  "malformed-output-retry": "b0f5240b0380f2f11e7ccce3dc8052bff2d960b7f74e2c2b633908dafe2debda",
  "multi-file-mutation": "95d99ab57e3068499e3383c5f1064c12a84063508f44a6c8b14f6f769b06cad6",
  "ordinary-shell-validation": "2eb060cb97d6feee5f4e904171ab82754a6d36955be15567aec01e3de2ccbd1a",
  "premature-completion": "72e1c38695975eb20ea18d16478e5ff35b56ac4e51f4366d7e0efb372a89bd88",
  search: "6670bdada1aa32f8fd2aef2ecb383bfe183fd5ed14d99294a825fe51f12fd025",
  "stale-evidence": "d565e4e7b09e0ff531bcde195a4e2f52fc8c43b87c5922f198f995269cf17022",
});

const LATENCY_DISTRIBUTION = Object.freeze({
  kind: "numeric_distribution" as const,
  sampleCount: 20,
  minimum: 68,
  maximum: 223,
  mean: 129.1,
  variance: 2190.6210526315786,
  varianceMethod: "sample" as const,
  p50: 118,
  p90: 186.10000000000005,
  p95: 223,
});
const LATENCY_UNCERTAINTY = Object.freeze({
  status: "available" as const,
  method: "standard_error" as const,
  confidence: 0.95,
  lower: 108.58758841701125,
  upper: 149.61241158298873,
});

const metrics = HELARC_RUN_TREE_CONTROL_ACCEPTED_BASELINE.metrics.map((metric) => {
  const latency = metric.definitionRef.id.endsWith(".latency");
  return Object.freeze({
    ...metric,
    ref: runProgressMetricResultRef(metric.ref),
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

export const HELARC_RUN_PROGRESS_ACCEPTED_BASELINE = deepFreeze({
  ...HELARC_RUN_TREE_CONTROL_ACCEPTED_BASELINE,
  targetSnapshotRef: TARGET_REF,
  targetManifestDigest: TARGET_MANIFEST_DIGEST,
  reportRef: REPORT_REF,
  acceptanceRef: ACCEPTANCE_REF,
  publication: {
    ...HELARC_RUN_TREE_CONTROL_ACCEPTED_BASELINE.publication,
    reportRef: REPORT_REF,
    targetSnapshotRefs: Object.freeze([TARGET_REF]),
    metricSummaries: HELARC_RUN_TREE_CONTROL_ACCEPTED_BASELINE.publication.metricSummaries.map(
      (summary) => {
        const latency = summary.metricRef.id.includes(".latency.");
        return Object.freeze({
          ...summary,
          metricRef: runProgressMetricResultRef(summary.metricRef),
          distribution: latency ? LATENCY_DISTRIBUTION : summary.distribution,
          uncertainty: latency ? LATENCY_UNCERTAINTY : summary.uncertainty,
        });
      },
    ),
    dimensionSummaries: HELARC_RUN_TREE_CONTROL_ACCEPTED_BASELINE.publication.dimensionSummaries.map(
      (summary) => Object.freeze({
        ...summary,
        metricRefs: Object.freeze(summary.metricRefs.map(runProgressMetricResultRef)),
      }),
    ),
    gateOutcomes: HELARC_RUN_TREE_CONTROL_ACCEPTED_BASELINE.publication.gateOutcomes.map(
      (outcome) => Object.freeze({
        ...outcome,
        metricRef: runProgressMetricResultRef(outcome.metricRef),
      }),
    ),
  },
  metrics: Object.freeze(metrics),
  cases: Object.freeze(HELARC_RUN_TREE_CONTROL_ACCEPTED_BASELINE.cases.map((item) =>
    Object.freeze({
      ...item,
      semanticDigest: digestForCase(item.caseRef.id),
    }))),
} satisfies HelarcEvaluationBaselineSignature);

export const HELARC_RUN_PROGRESS_BASELINE_ACCEPTANCE = deepFreeze({
  schemaVersion: 1,
  kind: "helarc_run_progress_baseline_successor_acceptance",
  acceptedAt: "2026-08-24T00:00:00.000Z",
  predecessorAcceptanceRef: HELARC_RUN_TREE_CONTROL_ACCEPTED_BASELINE.acceptanceRef,
  successorAcceptanceRef: ACCEPTANCE_REF,
  predecessorReportRef: HELARC_RUN_TREE_CONTROL_ACCEPTED_BASELINE.reportRef,
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
    "The Run Progress checkpoints add 66 deterministic clock milliseconds across twenty Trials.",
  coverage:
    "The accepted Product Suite is paired with focused Run Progress semantics, bounded correction, recovery, and terminal-precedence conformance.",
  limitations: "deterministic_system_baseline_only",
});

function runProgressMetricResultRef(refValue: {
  readonly id: string;
  readonly revision: string;
}) {
  if (!refValue.id.endsWith(".run-tree-control-baseline-result")) {
    throw new TypeError(`Unknown predecessor Metric result '${refValue.id}'.`);
  }
  return Object.freeze({
    id: refValue.id.replace(
      /\.run-tree-control-baseline-result$/,
      ".run-progress-baseline-result",
    ),
    revision: TARGET_REVISION,
  });
}

function latencyForCase(caseId: string): number {
  const slug = caseSlug(caseId);
  const latency = LATENCY_BY_CASE[slug];
  if (latency === undefined) throw new TypeError(`Unknown Run Progress Case '${caseId}'.`);
  return latency;
}

function digestForCase(caseId: string): string {
  const slug = caseSlug(caseId);
  const digest = CASE_DIGEST_BY_SLUG[slug];
  if (digest === undefined) throw new TypeError(`Unknown Run Progress Case '${caseId}'.`);
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
