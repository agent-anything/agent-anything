import type {
  HelarcEvaluationBaselineMetricSignature,
  HelarcEvaluationBaselineSignature,
} from "../HelarcEvaluationExecution.js";
import {
  HELARC_PROVIDER_NATIVE_TOOL_INTERACTION_ACCEPTED_BASELINE,
} from "./HelarcProviderNativeToolInteractionBaseline.js";

const TARGET_MANIFEST_DIGEST = "7f565dbe305a2b66bd1aee29b6983f93ccaf1bc8d122b5d23956efb7c8e21988";
const TARGET_REVISION =
  HELARC_PROVIDER_NATIVE_TOOL_INTERACTION_ACCEPTED_BASELINE.targetSnapshotRef.revision
    .replace(/^v12-/, "v13-");
const TARGET_REF = Object.freeze({
  id: HELARC_PROVIDER_NATIVE_TOOL_INTERACTION_ACCEPTED_BASELINE.targetSnapshotRef.id,
  revision: TARGET_REVISION,
});
const CAMPAIGN_REF = Object.freeze({
  id: HELARC_PROVIDER_NATIVE_TOOL_INTERACTION_ACCEPTED_BASELINE.campaignRef.id,
  revision: "v4",
});
const REPORT_REF = Object.freeze({
  id: "helarc.task-fulfillment-gated-completion.report.baseline",
  revision: TARGET_REVISION,
});
const ACCEPTANCE_REF = Object.freeze({
  id: "helarc.task-fulfillment-gated-completion.baseline-acceptance",
  revision: TARGET_REVISION,
});

const CASE_DIGEST_BY_KEY = Object.freeze<Record<string, string>>({
  "controlled-file-write:1": "91ee815293ece03321def451feeafb0ff89b31c4019bb9e43218671c3a568fcc",
  "controlled-file-write:2": "e549bc56a201733dac1fb38e93dd5277255cbdbfa84801f4b1a6bdb4eff24fc9",
  "denied-command:1": "3d1047237be2c2ea0016c2a3ffc61a0e296c8e028909db3a58eadaa830ca8b25",
  "denied-command:2": "6f1ee3d3e263c369b5f054dd76db0f9a9ac09c4e3a3b6b4ce56ce09f57493429",
  "failed-check-recovery:1": "86d4b5720cc96f5bbfa1c3f82995cdcd08b718fb0b2e1df32e2d3120912fa7ba",
  "failed-check-recovery:2": "01a7dca92de1a821011c0cce605915dee242737a5eeb2e8ecb20e38863cb9e58",
  "inspect-and-complete:1": "339f97a3d7db939b66213ed840318cf482457b6f0395950ad48f72f8d1482218",
  "inspect-and-complete:2": "95afa6bdef64dbffc75f78acb2d42814a3f85a127634f30ff8731ad0b2b2358e",
  "malformed-output-retry:1": "35ed15bf0763f12558b28dcddbbc92763bdfc2d16df49ff39f5875839aa4af80",
  "malformed-output-retry:2": "6913505c401522e7d9c7c2f95b3d7729a3bffe32f1ad3a6753f1253ff07dc607",
  "multi-file-mutation:1": "52a15b8b77969b3d493444e4d457d4d898ea8907000e8a70e7226be0449a162a",
  "multi-file-mutation:2": "4f80ac62ee1ae6aa6e5949abf56b4537231d9176f734d7e65c661d1fb9bedede",
  "ordinary-shell-verification:1": "b2257b5e9d61b0bb600e04d3e332ca6ba89dce2ee92fc765ffa76acfae9f7191",
  "ordinary-shell-verification:2": "6467eb596a302f9e752052dc015cdd77d7f4688a6efcacb7ce4c277646d14c02",
  "premature-completion:1": "7ddc266d44be9872653b0078497e2aa18106d8a86f24be1393df6e673ce1e12e",
  "premature-completion:2": "c3c3fb718d9e908f1a0c7e6e28727b056ab9789c697924e61e19dce07ae3d93d",
  "search:1": "8ee97da20ffdeba86338f2509d2c2d2085b59f89cb9a442d47b9afa60f78a4f3",
  "search:2": "83492f3439828ef4927fb17e3eb79d62fa97738acc5a43522be514fa36e63347",
  "stale-evidence:1": "7182c899031a91162ceb27c0e3d1fa4190fad59cd6799e6d69d5b18fec89ff52",
  "stale-evidence:2": "5e77404e1f7fdf130d1c654a688a1f95cc55a1c39b1106340bad4554e3348557",
});

const LATENCY_BY_CASE = Object.freeze<Record<string, number>>({
  "controlled-file-write": 99,
  "denied-command": 108,
  "failed-check-recovery": 167,
  "inspect-and-complete": 145,
  "malformed-output-retry": 61,
  "multi-file-mutation": 210,
  "ordinary-shell-verification": 108,
  "premature-completion": 240,
  search: 98,
  "stale-evidence": 306,
});

const LATENCY_DISTRIBUTION = Object.freeze({
  kind: "numeric_distribution" as const,
  sampleCount: 20,
  minimum: 61,
  maximum: 306,
  mean: 154.2,
  variance: 5571.3263157894735,
  varianceMethod: "sample" as const,
  p50: 126.5,
  p90: 246.60000000000008,
  p95: 306,
});

const LATENCY_UNCERTAINTY = Object.freeze({
  status: "available" as const,
  method: "standard_error" as const,
  confidence: 0.95,
  lower: 121.48760123954236,
  upper: 186.91239876045762,
});

const metrics = HELARC_PROVIDER_NATIVE_TOOL_INTERACTION_ACCEPTED_BASELINE.metrics.map(
  (metric) => {
    const latency = metric.definitionRef.id.endsWith(".latency");
    return Object.freeze({
      ...metric,
      ref: taskFulfillmentMetricResultRef(metric.ref),
      targetSnapshotRef: TARGET_REF,
      samples: Object.freeze(metric.samples.map((sample) => Object.freeze({
        ...sample,
        value: latency ? latencyForCase(sample.caseRef.id) : sample.value,
      }))),
      distribution: latency ? LATENCY_DISTRIBUTION : metric.distribution,
      uncertainty: latency ? LATENCY_UNCERTAINTY : metric.uncertainty,
    }) satisfies HelarcEvaluationBaselineMetricSignature;
  },
);

export const HELARC_TASK_FULFILLMENT_ACCEPTED_BASELINE = deepFreeze({
  ...HELARC_PROVIDER_NATIVE_TOOL_INTERACTION_ACCEPTED_BASELINE,
  corpusRevision: "helarc-task-fulfillment-gated-completion-corpus-v1",
  targetSnapshotRef: TARGET_REF,
  targetManifestDigest: TARGET_MANIFEST_DIGEST,
  campaignRef: CAMPAIGN_REF,
  reportRef: REPORT_REF,
  acceptanceRef: ACCEPTANCE_REF,
  publication: {
    ...HELARC_PROVIDER_NATIVE_TOOL_INTERACTION_ACCEPTED_BASELINE.publication,
    reportRef: REPORT_REF,
    targetSnapshotRefs: Object.freeze([TARGET_REF]),
    metricSummaries:
      HELARC_PROVIDER_NATIVE_TOOL_INTERACTION_ACCEPTED_BASELINE.publication.metricSummaries.map(
        (summary) => {
          const metricRef = taskFulfillmentMetricResultRef(summary.metricRef);
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
      HELARC_PROVIDER_NATIVE_TOOL_INTERACTION_ACCEPTED_BASELINE.publication.dimensionSummaries.map(
        (summary) => Object.freeze({
          ...summary,
          metricRefs: Object.freeze(summary.metricRefs.map(taskFulfillmentMetricResultRef)),
        }),
      ),
    gateOutcomes:
      HELARC_PROVIDER_NATIVE_TOOL_INTERACTION_ACCEPTED_BASELINE.publication.gateOutcomes.map(
        (outcome) => Object.freeze({
          ...outcome,
          metricRef: taskFulfillmentMetricResultRef(outcome.metricRef),
        }),
      ),
  },
  metrics: Object.freeze(metrics),
  cases: Object.freeze(
    HELARC_PROVIDER_NATIVE_TOOL_INTERACTION_ACCEPTED_BASELINE.cases.map((item) =>
      Object.freeze({
        ...item,
        semanticDigest: digestForCase(item.caseRef.id, item.repetitionOrdinal),
      })
    ),
  ),
  taskFulfillment: Object.freeze({
    contractRevision: "agent-core.task-fulfillment.v1",
    evaluatorRevision: "helarc.task-fulfillment-evaluator.v1",
    completionGateRevision: "task-fulfillment-before-verification.v1",
    targetAdapterRevision: "helarc-task-fulfillment-gated-completion-target-v1",
  }),
} satisfies HelarcEvaluationBaselineSignature & {
  readonly taskFulfillment: {
    readonly contractRevision: string;
    readonly evaluatorRevision: string;
    readonly completionGateRevision: string;
    readonly targetAdapterRevision: string;
  };
});

export const HELARC_TASK_FULFILLMENT_BASELINE_ACCEPTANCE = deepFreeze({
  schemaVersion: 1,
  kind: "helarc_task_fulfillment_baseline_successor_acceptance",
  acceptedAt: "2026-08-28T00:00:00.000Z",
  predecessorAcceptanceRef:
    HELARC_PROVIDER_NATIVE_TOOL_INTERACTION_ACCEPTED_BASELINE.acceptanceRef,
  successorAcceptanceRef: ACCEPTANCE_REF,
  predecessorReportRef: HELARC_PROVIDER_NATIVE_TOOL_INTERACTION_ACCEPTED_BASELINE.reportRef,
  successorReportRef: REPORT_REF,
  comparison: "intentionally_incomparable_exact_target",
  changedTargetInputs: Object.freeze([
    "product.revision",
    "task-fulfillment-contract.revision",
    "task-fulfillment-evaluator.revision",
    "completion-gate.revision",
    "target-adapter.revision",
    "source.revision",
    "fixture-manifest.revision",
    "expected-claims.revision",
  ]),
  outcomeQuality: "passed",
  safety: "passed",
  reliability: "deterministic_candidate_repeated_equivalently",
  trajectory:
    "A Product-owned Task Fulfillment assessment now precedes Verification completion gating, preserving accepted outcomes and safety while preventing Controller completion from being authoritative.",
  coverage:
    "The successor records exact Task Fulfillment contracts, Product evaluator identity, Completion Gate order, bounded assessment Run Items, Trace continuity, and twenty paired deterministic Case executions.",
  limitations: "deterministic_system_case_only",
});

function taskFulfillmentMetricResultRef(refValue: {
  readonly id: string;
  readonly revision: string;
}) {
  if (!refValue.id.endsWith(".provider-native-tool-interaction-baseline-result")) {
    throw new TypeError(`Unknown predecessor Metric result '${refValue.id}'.`);
  }
  return Object.freeze({
    id: refValue.id.replace(
      /\.provider-native-tool-interaction-baseline-result$/,
      ".task-fulfillment-gated-completion-baseline-result",
    ),
    revision: TARGET_REVISION,
  });
}

function latencyForCase(caseId: string): number {
  const key = caseKey(caseId);
  const value = LATENCY_BY_CASE[key];
  if (value === undefined) throw new TypeError(`Unknown latency Case '${caseId}'.`);
  return value;
}

function digestForCase(caseId: string, repetitionOrdinal: number): string {
  const key = `${caseKey(caseId)}:${repetitionOrdinal}`;
  const digest = CASE_DIGEST_BY_KEY[key];
  if (digest === undefined) throw new TypeError(`Unknown Task Fulfillment Case '${key}'.`);
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
