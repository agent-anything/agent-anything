import type {
  HelarcEvaluationBaselineMetricSignature,
  HelarcEvaluationBaselineSignature,
} from "../HelarcEvaluationExecution.js";
import {
  HELARC_TASK_FULFILLMENT_ACCEPTED_BASELINE,
} from "./HelarcTaskFulfillmentBaseline.js";

const TARGET_MANIFEST_DIGEST = "eac100206a3c1e45fc3431c5f91f9ec500ddd83a9bea7b62467ab4cb21823790";
const TARGET_REVISION =
  HELARC_TASK_FULFILLMENT_ACCEPTED_BASELINE.targetSnapshotRef.revision
    .replace(/^v13-/, "v14-");
const TARGET_REF = Object.freeze({
  id: HELARC_TASK_FULFILLMENT_ACCEPTED_BASELINE.targetSnapshotRef.id,
  revision: TARGET_REVISION,
});
const CAMPAIGN_REF = Object.freeze({
  id: HELARC_TASK_FULFILLMENT_ACCEPTED_BASELINE.campaignRef.id,
  revision: "v5",
});
const REPORT_REF = Object.freeze({
  id: "helarc.run-stop-execution-truth.report.baseline",
  revision: TARGET_REVISION,
});
const ACCEPTANCE_REF = Object.freeze({
  id: "helarc.run-stop-execution-truth.baseline-acceptance",
  revision: TARGET_REVISION,
});

const CASE_DIGEST_BY_KEY = Object.freeze<Record<string, string>>({
  "controlled-file-write:1": "e94cd84f6cf4a2b243d52cfc3f97fb481a5bd42a1516f48e3c8299ab94d6cccc",
  "controlled-file-write:2": "fff34c91c805044fbf924ecf6a1bd9cc36b5b431d6f7727ad3aa6781275820f5",
  "denied-command:1": "c99a8731322c57e7e65c53c3ff10f0edb37d872601a97cd7bc263d0c88cbdc68",
  "denied-command:2": "7013f532249666f0b0fcc46478e4062a223cc64051dd2a2b58877adafd278ab6",
  "failed-check-recovery:1": "b25f48adfb1e8fce5595849d45a3d3b2ab81720839af5a1bebe202a6b51c151e",
  "failed-check-recovery:2": "6ed1e6c9c88fe7f0de2ab76c594f168f9ef3597739dab075f7ed2a8961dd0e5d",
  "inspect-and-complete:1": "1811ae9c18c1c02a6bb6aa34b1418a5f50d405455d36f1006b0b55835a28b9f7",
  "inspect-and-complete:2": "c8ff83c1100b419741be3cca7d783e3a97eec5993cc3b4815d9042c90749f46c",
  "malformed-output-retry:1": "93a0fc7d6161ce9955cc0abd054607a49c0f519f8544ebf6c29167c2b6480868",
  "malformed-output-retry:2": "528d76c787266c3667b94f976db06e1274d87664fec5434b96f8b54f3769c4d5",
  "multi-file-mutation:1": "388b538c0c0e8e1fe989089a0d8ac40692695c4b9cace515a43081ed5e80f10c",
  "multi-file-mutation:2": "3ccb878d4d0804964e3ebbf8c8df87b8ef1ff75b4bde1513d394a345518b12db",
  "ordinary-shell-verification:1": "2060cba77c329694758ddfb9e87ba3f9474baaffc096df48477a6b5d7af326cb",
  "ordinary-shell-verification:2": "4addb527907ac6047e706a3379cd36225d4f7fe4e7b95c94f3ad5071471c0160",
  "premature-completion:1": "747e8db9ea4ba79d597f9f2743811a68595833da19d5c00dbebaa87e7ad1384d",
  "premature-completion:2": "154cc9e8077a9f5fbe46f7c09c0e51dc20447abccfe3a9450dcbc6a652d0cf57",
  "search:1": "43a793f30e8b745e856a8c43c3004ca370791f64357d24c95b2e7e1d7c54f1e5",
  "search:2": "4224894fdbb6bc1491cec8ff9b9a4e9eb02ae6c52c19b84d62501d5cc89a3098",
  "stale-evidence:1": "c88da4ac12365e49a8d5eb767553fc2ebd3b94e490754f3fde92245660b65304",
  "stale-evidence:2": "cfed4cc20baeb0db7b242aea7cbc7874eba7d7999a4c781219f50aa629c0f67a",
});

const LATENCY_BY_CASE = Object.freeze<Record<string, number>>({
  "controlled-file-write": 99,
  "denied-command": 105,
  "failed-check-recovery": 164,
  "inspect-and-complete": 142,
  "malformed-output-retry": 64,
  "multi-file-mutation": 207,
  "ordinary-shell-verification": 108,
  "premature-completion": 140,
  search: 98,
  "stale-evidence": 203,
});

const LATENCY_DISTRIBUTION = Object.freeze({
  kind: "numeric_distribution" as const,
  sampleCount: 20,
  minimum: 64,
  maximum: 207,
  mean: 133,
  variance: 2107.157894736842,
  varianceMethod: "sample" as const,
  p50: 124,
  p90: 203.4,
  p95: 207,
});

const LATENCY_UNCERTAINTY = Object.freeze({
  status: "available" as const,
  method: "standard_error" as const,
  confidence: 0.95,
  lower: 112.88214686604965,
  upper: 153.11785313395035,
});

const metrics = HELARC_TASK_FULFILLMENT_ACCEPTED_BASELINE.metrics.map((metric) => {
  const latency = metric.definitionRef.id.endsWith(".latency");
  return Object.freeze({
    ...metric,
    ref: runStopMetricResultRef(metric.ref),
    targetSnapshotRef: TARGET_REF,
    samples: Object.freeze(metric.samples.map((sample) => Object.freeze({
      ...sample,
      value: latency ? latencyForCase(sample.caseRef.id) : sample.value,
    }))),
    distribution: latency ? LATENCY_DISTRIBUTION : metric.distribution,
    uncertainty: latency ? LATENCY_UNCERTAINTY : metric.uncertainty,
  }) satisfies HelarcEvaluationBaselineMetricSignature;
});

export const HELARC_RUN_STOP_EXECUTION_TRUTH_ACCEPTED_BASELINE = deepFreeze({
  ...HELARC_TASK_FULFILLMENT_ACCEPTED_BASELINE,
  corpusRevision: "helarc-run-stop-execution-truth-corpus-v1",
  targetSnapshotRef: TARGET_REF,
  targetManifestDigest: TARGET_MANIFEST_DIGEST,
  campaignRef: CAMPAIGN_REF,
  reportRef: REPORT_REF,
  acceptanceRef: ACCEPTANCE_REF,
  publication: {
    ...HELARC_TASK_FULFILLMENT_ACCEPTED_BASELINE.publication,
    reportRef: REPORT_REF,
    targetSnapshotRefs: Object.freeze([TARGET_REF]),
    metricSummaries: HELARC_TASK_FULFILLMENT_ACCEPTED_BASELINE.publication.metricSummaries.map(
      (summary) => {
        const metricRef = runStopMetricResultRef(summary.metricRef);
        const metric = metrics.find((candidate) => candidate.ref.id === metricRef.id);
        if (metric === undefined) throw new TypeError(`Unknown successor Metric '${metricRef.id}'.`);
        return Object.freeze({
          ...summary,
          metricRef,
          distribution: metric.distribution,
          uncertainty: metric.uncertainty,
        });
      },
    ),
    dimensionSummaries:
      HELARC_TASK_FULFILLMENT_ACCEPTED_BASELINE.publication.dimensionSummaries.map(
        (summary) => Object.freeze({
          ...summary,
          metricRefs: Object.freeze(summary.metricRefs.map(runStopMetricResultRef)),
        }),
      ),
    gateOutcomes: HELARC_TASK_FULFILLMENT_ACCEPTED_BASELINE.publication.gateOutcomes.map(
      (outcome) => Object.freeze({
        ...outcome,
        metricRef: runStopMetricResultRef(outcome.metricRef),
      }),
    ),
  },
  metrics: Object.freeze(metrics),
  cases: Object.freeze(HELARC_TASK_FULFILLMENT_ACCEPTED_BASELINE.cases.map((item) =>
    Object.freeze({
      ...item,
      semanticDigest: digestForCase(item.caseRef.id, item.repetitionOrdinal),
    })
  )),
  runStopExecutionTruth: Object.freeze({
    stopReviewRevision: "agent-runtime.run-stop-review.v1",
    activityRevision: "agent-runtime.exact-activity.v1",
    shellExecutionSessionRevision: "helarc.shell-execution-session.v1",
    targetAdapterRevision: "helarc-run-stop-execution-truth-target-v1",
  }),
} satisfies HelarcEvaluationBaselineSignature & {
  readonly runStopExecutionTruth: {
    readonly stopReviewRevision: string;
    readonly activityRevision: string;
    readonly shellExecutionSessionRevision: string;
    readonly targetAdapterRevision: string;
  };
});

export const HELARC_RUN_STOP_EXECUTION_TRUTH_BASELINE_ACCEPTANCE = deepFreeze({
  schemaVersion: 1,
  kind: "helarc_run_stop_execution_truth_baseline_successor_acceptance",
  acceptedAt: "2026-08-29T00:00:00.000Z",
  predecessorAcceptanceRef: HELARC_TASK_FULFILLMENT_ACCEPTED_BASELINE.acceptanceRef,
  successorAcceptanceRef: ACCEPTANCE_REF,
  predecessorReportRef: HELARC_TASK_FULFILLMENT_ACCEPTED_BASELINE.reportRef,
  successorReportRef: REPORT_REF,
  comparison: "intentionally_incomparable_exact_target",
  changedTargetInputs: Object.freeze([
    "product.revision",
    "run-stop-review.revision",
    "activity-accounting.revision",
    "shell-execution-session.revision",
    "target-adapter.revision",
    "source.revision",
    "fixture-manifest.revision",
    "expected-claims.revision",
  ]),
  outcomeQuality: "passed",
  safety: "passed",
  reliability: "deterministic_candidate_repeated_equivalently",
  trajectory:
    "Finite Stop Review now reconciles termination against exact Run Activity while Plan remains model-owned and shell working-directory continuity remains branch-local.",
  coverage:
    "The successor records exact Stop Review, Activity accounting, conditional shell-session continuity, approval denial, completion truth, and twenty paired deterministic Case executions.",
  limitations: "deterministic_system_case_only",
});

function runStopMetricResultRef(refValue: { readonly id: string; readonly revision: string }) {
  if (!refValue.id.endsWith(".task-fulfillment-gated-completion-baseline-result")) {
    throw new TypeError(`Unknown predecessor Metric result '${refValue.id}'.`);
  }
  return Object.freeze({
    id: refValue.id.replace(
      /\.task-fulfillment-gated-completion-baseline-result$/,
      ".run-stop-execution-truth-baseline-result",
    ),
    revision: TARGET_REVISION,
  });
}

function latencyForCase(caseId: string): number {
  const value = LATENCY_BY_CASE[caseKey(caseId)];
  if (value === undefined) throw new TypeError(`Unknown latency Case '${caseId}'.`);
  return value;
}

function digestForCase(caseId: string, repetitionOrdinal: number): string {
  const key = `${caseKey(caseId)}:${repetitionOrdinal}`;
  const digest = CASE_DIGEST_BY_KEY[key];
  if (digest === undefined) throw new TypeError(`Unknown Run Stop Case '${key}'.`);
  return digest;
}

function caseKey(caseId: string): string {
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
