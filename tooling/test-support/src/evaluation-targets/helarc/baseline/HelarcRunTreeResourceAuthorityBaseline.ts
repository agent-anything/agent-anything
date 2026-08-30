import type {
  HelarcEvaluationBaselineMetricSignature,
  HelarcEvaluationBaselineSignature,
} from "../HelarcEvaluationExecution.js";
import {
  HELARC_RUN_STOP_EXECUTION_TRUTH_ACCEPTED_BASELINE,
} from "./HelarcRunStopExecutionTruthBaseline.js";

const TARGET_MANIFEST_DIGEST = "da84bfb7b4b037887d62ff5713253cf38b23cb97818569415a1fd0744744b4ce";
const TARGET_REVISION =
  HELARC_RUN_STOP_EXECUTION_TRUTH_ACCEPTED_BASELINE.targetSnapshotRef.revision
    .replace(/^v14-/, "v15-");
const TARGET_REF = Object.freeze({
  id: HELARC_RUN_STOP_EXECUTION_TRUTH_ACCEPTED_BASELINE.targetSnapshotRef.id,
  revision: TARGET_REVISION,
});
const REPORT_REF = Object.freeze({
  id: "helarc.run-tree-resource-authority.report.baseline",
  revision: TARGET_REVISION,
});
const ACCEPTANCE_REF = Object.freeze({
  id: "helarc.run-tree-resource-authority.baseline-acceptance",
  revision: TARGET_REVISION,
});

const CASE_DIGEST_BY_KEY = Object.freeze<Record<string, string>>({
  "controlled-file-write:1": "b46e01321af517f6806574b47cee969931d852ab6d8983e9cfdf0da8209aa6fe",
  "controlled-file-write:2": "91fdc777f2e248d5392e0c6805ba8fe7c1647d10d659ee4a9d833cf64dbe4636",
  "denied-command:1": "4e18f6d55329e8a0a07d37817c9679123694d7a517c2a93a89c82b0615723bb0",
  "denied-command:2": "4a58d5e57aa9e5338b2bffedf748ec5df54d40859bee11eaf703c5ac7dd06040",
  "failed-check-recovery:1": "c74588f77c450fc2b68c88b1a5c748f5e92571f33b39d44d1ff837cc8731ce8e",
  "failed-check-recovery:2": "46366bbbe0de529d4b3f4f96c5e654f0167cac887b2476bded323fdb1558b1dc",
  "inspect-and-complete:1": "5d4729788b4362b09f33e9e3c6fe8c473498bb32b2978b874d045d24e49e8ffb",
  "inspect-and-complete:2": "11ca9cbcee0e402afb40aadc8f0c83b9f2075685099cf01c107b06759343a1b9",
  "malformed-output-retry:1": "ca7cb511adfc79d830ca4d8d7d072ed15cd03ee17aab667062e0b47f1dc79118",
  "malformed-output-retry:2": "6b4396042fc45d0926335f72754a0d783fcbd65e252da22e6666e574287ad496",
  "multi-file-mutation:1": "f5dd4e25c5e68a84c92b97139b64244f1a16f29de119e0bd5f609928331dcc57",
  "multi-file-mutation:2": "c600c26cdca0b97dcffd4a56a498c9ca8c5db780b7b7f4f04413857fe828ecf0",
  "ordinary-shell-verification:1": "3851112831a6604dfba04ede982ed95313156acf2827bd063edc6905ac318d54",
  "ordinary-shell-verification:2": "09ccb6fb420d5d90f6cc495ef741be19e55cf29397588e75864557ae89987071",
  "premature-completion:1": "91803a48da3429191569a592b106f0e14d4b2f4bf9cd3bf71eadee48b5671b59",
  "premature-completion:2": "4066014166fa536ec9f8eb9d80876b181c6ed23eec92051cc1f3cc85331b2e9d",
  "search:1": "029061b6cc7bcd9d6de11d750d1a3dc0d329ba3a156f7ed7aecbd5cf35fd8e9e",
  "search:2": "df92deca98d2fa6dae259213c8029bb108b87e0aa805683544bcff574dfaf1b6",
  "stale-evidence:1": "a5b8794a5046b130097c392687a1df723b168b7f289525e0b532f4c5608877ad",
  "stale-evidence:2": "c04ebeabdb418c2556f0fca515e0284c9f1c3db8050f754dcb6a641705337b2c",
});

const LATENCY_BY_CASE = Object.freeze<Record<string, number>>({
  "controlled-file-write": 98,
  "denied-command": 102,
  "failed-check-recovery": 160,
  "inspect-and-complete": 141,
  "malformed-output-retry": 63,
  "multi-file-mutation": 206,
  "ordinary-shell-verification": 107,
  "premature-completion": 139,
  search: 97,
  "stale-evidence": 202,
});

const LATENCY_DISTRIBUTION = Object.freeze({
  kind: "numeric_distribution" as const,
  sampleCount: 20,
  minimum: 63,
  maximum: 206,
  mean: 131.5,
  variance: 2100.4736842105262,
  varianceMethod: "sample" as const,
  p50: 123,
  p90: 202.4,
  p95: 206,
});

const LATENCY_UNCERTAINTY = Object.freeze({
  status: "available" as const,
  method: "standard_error" as const,
  confidence: 0.95,
  lower: 111.41408058507548,
  upper: 151.58591941492452,
});

const metrics = HELARC_RUN_STOP_EXECUTION_TRUTH_ACCEPTED_BASELINE.metrics.map((metric) => {
  const latency = metric.definitionRef.id.endsWith(".latency");
  return Object.freeze({
    ...metric,
    ref: runTreeResourceAuthorityMetricResultRef(metric.ref),
    targetSnapshotRef: TARGET_REF,
    samples: Object.freeze(metric.samples.map((sample) => Object.freeze({
      ...sample,
      value: latency ? latencyForCase(sample.caseRef.id) : sample.value,
    }))),
    distribution: latency ? LATENCY_DISTRIBUTION : metric.distribution,
    uncertainty: latency ? LATENCY_UNCERTAINTY : metric.uncertainty,
  }) satisfies HelarcEvaluationBaselineMetricSignature;
});

export const HELARC_RUN_TREE_RESOURCE_AUTHORITY_ACCEPTED_BASELINE = deepFreeze({
  ...HELARC_RUN_STOP_EXECUTION_TRUTH_ACCEPTED_BASELINE,
  corpusRevision: "helarc-run-tree-resource-authority-corpus-v1",
  targetSnapshotRef: TARGET_REF,
  targetManifestDigest: TARGET_MANIFEST_DIGEST,
  reportRef: REPORT_REF,
  acceptanceRef: ACCEPTANCE_REF,
  publication: {
    ...HELARC_RUN_STOP_EXECUTION_TRUTH_ACCEPTED_BASELINE.publication,
    reportRef: REPORT_REF,
    targetSnapshotRefs: Object.freeze([TARGET_REF]),
    metricSummaries:
      HELARC_RUN_STOP_EXECUTION_TRUTH_ACCEPTED_BASELINE.publication.metricSummaries.map(
        (summary) => {
          const metricRef = runTreeResourceAuthorityMetricResultRef(summary.metricRef);
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
      HELARC_RUN_STOP_EXECUTION_TRUTH_ACCEPTED_BASELINE.publication.dimensionSummaries.map(
        (summary) => Object.freeze({
          ...summary,
          metricRefs: Object.freeze(
            summary.metricRefs.map(runTreeResourceAuthorityMetricResultRef),
          ),
        }),
      ),
    gateOutcomes:
      HELARC_RUN_STOP_EXECUTION_TRUTH_ACCEPTED_BASELINE.publication.gateOutcomes.map(
        (outcome) => Object.freeze({
          ...outcome,
          metricRef: runTreeResourceAuthorityMetricResultRef(outcome.metricRef),
        }),
      ),
  },
  metrics: Object.freeze(metrics),
  cases: Object.freeze(HELARC_RUN_STOP_EXECUTION_TRUTH_ACCEPTED_BASELINE.cases.map((item) =>
    Object.freeze({
      ...item,
      semanticDigest: digestForCase(item.caseRef.id, item.repetitionOrdinal),
    })
  )),
  runTreeResourceAuthority: Object.freeze({
    resourceAccountRevision: "agent-runtime.run-tree-resource-account.v1",
    authorityRevision: "agent-runtime.run-tree-authority.v1",
    approvalAccountRevision: "agent-runtime.run-tree-approval-account.v1",
    settlementRevision: "agent-runtime.run-tree-settlement.v1",
    targetAdapterRevision: "helarc-run-tree-resource-authority-target-v1",
  }),
} satisfies HelarcEvaluationBaselineSignature & {
  readonly runTreeResourceAuthority: {
    readonly resourceAccountRevision: string;
    readonly authorityRevision: string;
    readonly approvalAccountRevision: string;
    readonly settlementRevision: string;
    readonly targetAdapterRevision: string;
  };
});

export const HELARC_RUN_TREE_RESOURCE_AUTHORITY_BASELINE_ACCEPTANCE = deepFreeze({
  schemaVersion: 1,
  kind: "helarc_run_tree_resource_authority_baseline_successor_acceptance",
  acceptedAt: "2026-08-30T00:00:00.000Z",
  predecessorAcceptanceRef: HELARC_RUN_STOP_EXECUTION_TRUTH_ACCEPTED_BASELINE.acceptanceRef,
  successorAcceptanceRef: ACCEPTANCE_REF,
  predecessorReportRef: HELARC_RUN_STOP_EXECUTION_TRUTH_ACCEPTED_BASELINE.reportRef,
  successorReportRef: REPORT_REF,
  comparison: "intentionally_incomparable_exact_target",
  changedTargetInputs: Object.freeze([
    "product.revision",
    "run-tree-resource-account.revision",
    "run-tree-authority.revision",
    "run-tree-approval-account.revision",
    "run-tree-settlement.revision",
    "run-limits.revision",
    "target-adapter.revision",
    "source.revision",
    "fixture-manifest.revision",
    "expected-claims.revision",
  ]),
  outcomeQuality: "passed",
  safety: "passed",
  reliability: "deterministic_candidate_repeated_equivalently",
  trajectory:
    "Run Tree resource, authority, Approval, cancellation, and settlement closure preserves all twenty deterministic outcome and safety results.",
  latencyDelta:
    "The deterministic mean changed from 133 ms to 131.5 ms under the exact successor target.",
  coverage:
    "The immutable successor pairs the Product baseline with focused root, child, grandchild, sibling Approval, cancellation, late-result, and aggregate-settlement conformance.",
  limitations: "deterministic_system_case_only",
});

function runTreeResourceAuthorityMetricResultRef(refValue: {
  readonly id: string;
  readonly revision: string;
}) {
  if (!refValue.id.endsWith(".run-stop-execution-truth-baseline-result")) {
    throw new TypeError(`Unknown predecessor Metric result '${refValue.id}'.`);
  }
  return Object.freeze({
    id: refValue.id.replace(
      /\.run-stop-execution-truth-baseline-result$/,
      ".run-tree-resource-authority-baseline-result",
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
  if (digest === undefined) throw new TypeError(`Unknown Run Tree Case '${key}'.`);
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
