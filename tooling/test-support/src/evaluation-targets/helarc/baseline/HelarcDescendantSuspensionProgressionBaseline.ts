import type {
  HelarcEvaluationBaselineMetricSignature,
  HelarcEvaluationBaselineSignature,
} from "../HelarcEvaluationExecution.js";
import {
  HELARC_RUN_LIFECYCLE_SETTLEMENT_ACCEPTED_BASELINE,
} from "./HelarcRunLifecycleSettlementBaseline.js";

const TARGET_MANIFEST_DIGEST = "eea24e08b70b4c678ff2a99b94e1a564e5a46fe4114073a3e2bab97a848d79ef";
const TARGET_REVISION =
  HELARC_RUN_LIFECYCLE_SETTLEMENT_ACCEPTED_BASELINE.targetSnapshotRef.revision
    .replace(/^v18-/, "v19-");
const TARGET_REF = Object.freeze({
  id: HELARC_RUN_LIFECYCLE_SETTLEMENT_ACCEPTED_BASELINE.targetSnapshotRef.id,
  revision: TARGET_REVISION,
});
const REPORT_REF = Object.freeze({
  id: "helarc.descendant-suspension-progression.report.baseline",
  revision: TARGET_REVISION,
});
const ACCEPTANCE_REF = Object.freeze({
  id: "helarc.descendant-suspension-progression.baseline-acceptance",
  revision: TARGET_REVISION,
});

const CASE_DIGEST_BY_KEY = Object.freeze<Record<string, string>>({
  "controlled-file-write:1": "b3805be62e287ea11d9fa8e5271b10c99cbb3965520636855ce7ec9c699203c5",
  "controlled-file-write:2": "b10e254b4d1848e7ee1df9a953370e480211c91259d90a127f9491e205ab165b",
  "denied-command:1": "814071608364989c3a9d25377a5a3727c362bd1537ffb0484f7be1fdda8eb6f0",
  "denied-command:2": "d665d2249a9022042beb88ca75b8306ad038204f93d8460ad172e9cf9eb0098d",
  "failed-check-recovery:1": "fba5b2523c491f7fac4d2f39cf28fffcbebe34ffe5e12b70170043e19af7b343",
  "failed-check-recovery:2": "ac86b6bb9d6466a9729c162be93fecd8b1bcd2d45c640a90b51054f4cdb40847",
  "inspect-and-complete:1": "e01ea7cb4c30aaf18314bfffc04fd4c0a51ce29e85b8900b96e35450555ca973",
  "inspect-and-complete:2": "42f0f017b26551e9c2e6e86917b22804ec2ea6e0da34f8f42355b6df44b6b12d",
  "malformed-output-retry:1": "bdb91ae86242e41572545a392758fca4dcbdcb15fddd402994996f9308af39b8",
  "malformed-output-retry:2": "9f6df91d8a28a81890712548705c83d926c87e03f01de4521c4b695cbd195984",
  "multi-file-mutation:1": "cd1141e9cc17bb07f7f191257163ad9d74816eda0574ce5a55e8f95971a30ade",
  "multi-file-mutation:2": "fb061efd69df2476723386ff0c5ead67d266226532f1996e6daad4c2908be115",
  "ordinary-shell-verification:1": "48727146e422390a928c2f2bcace3d86fb8dc4340f84a2f0f248696c950b5a73",
  "ordinary-shell-verification:2": "5514b7a813dd36252aa98d7a668d24e1402b68f3b8b0de2d7c985b2f1906d851",
  "premature-completion:1": "0e515fe2e18827a14d0cbfa56e4b8a977e19be8996e76f9ef92adb757e597bb5",
  "premature-completion:2": "21509e87d21b54a2b7e41eb65b925e6bbd9c8bf79ef81c5e9f104d15c278c760",
  "search:1": "ce424f273fff97174ff81dd2c524c98b68a108edb00de64cf52e8a427df239f8",
  "search:2": "fa1119f8bbb4bfe695686a32b06725db579e687ed3c8b47d000fad705f3e1f9f",
  "stale-evidence:1": "2afbd32bb71b300326a4be78dd1e567db879d27feeff8dac5e56e1a9e6ae25c1",
  "stale-evidence:2": "ca1a9b840d5a990e5afb9d80b559237aa74f9c5ba611f7a64895ffed6ea4bf24",
});

const LATENCY_BY_CASE = Object.freeze<Record<string, number>>({
  "controlled-file-write": 101,
  "denied-command": 116,
  "failed-check-recovery": 164,
  "inspect-and-complete": 145,
  "malformed-output-retry": 65,
  "multi-file-mutation": 210,
  "ordinary-shell-verification": 110,
  "premature-completion": 139,
  search: 100,
  "stale-evidence": 203,
});

const LATENCY_DISTRIBUTION = Object.freeze({
  kind: "numeric_distribution" as const,
  sampleCount: 20,
  minimum: 65,
  maximum: 210,
  mean: 135.3,
  variance: 2049.6947368421047,
  varianceMethod: "sample" as const,
  p50: 127.5,
  p90: 203.70000000000002,
  p95: 210,
});

const LATENCY_UNCERTAINTY = Object.freeze({
  status: "available" as const,
  method: "standard_error" as const,
  confidence: 0.95,
  lower: 115.45835447944361,
  upper: 155.1416455205564,
});

const metrics = HELARC_RUN_LIFECYCLE_SETTLEMENT_ACCEPTED_BASELINE.metrics.map(
  (metric) => {
    const latency = metric.definitionRef.id.endsWith(".latency");
    return Object.freeze({
      ...metric,
      ref: progressionMetricResultRef(metric.ref),
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

export const HELARC_DESCENDANT_SUSPENSION_PROGRESSION_ACCEPTED_BASELINE = deepFreeze({
  ...HELARC_RUN_LIFECYCLE_SETTLEMENT_ACCEPTED_BASELINE,
  corpusRevision: "helarc-descendant-suspension-progression-corpus-v1",
  targetSnapshotRef: TARGET_REF,
  targetManifestDigest: TARGET_MANIFEST_DIGEST,
  reportRef: REPORT_REF,
  acceptanceRef: ACCEPTANCE_REF,
  publication: {
    ...HELARC_RUN_LIFECYCLE_SETTLEMENT_ACCEPTED_BASELINE.publication,
    reportRef: REPORT_REF,
    targetSnapshotRefs: Object.freeze([TARGET_REF]),
    metricSummaries:
      HELARC_RUN_LIFECYCLE_SETTLEMENT_ACCEPTED_BASELINE.publication.metricSummaries.map(
        (summary) => {
          const metricRef = progressionMetricResultRef(summary.metricRef);
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
      HELARC_RUN_LIFECYCLE_SETTLEMENT_ACCEPTED_BASELINE.publication.dimensionSummaries.map(
        (summary) => Object.freeze({
          ...summary,
          metricRefs: Object.freeze(summary.metricRefs.map(progressionMetricResultRef)),
        }),
      ),
    gateOutcomes:
      HELARC_RUN_LIFECYCLE_SETTLEMENT_ACCEPTED_BASELINE.publication.gateOutcomes.map(
        (outcome) => Object.freeze({
          ...outcome,
          metricRef: progressionMetricResultRef(outcome.metricRef),
        }),
      ),
  },
  metrics: Object.freeze(metrics),
  cases: Object.freeze(
    HELARC_RUN_LIFECYCLE_SETTLEMENT_ACCEPTED_BASELINE.cases.map((item) =>
      Object.freeze({
        ...item,
        semanticDigest: digestForCase(item.caseRef.id, item.repetitionOrdinal),
      }),
    ),
  ),
  descendantSuspensionProgression: Object.freeze({
    lifecycleRevision: "agent-runtime.run-lifecycle.v3",
    agentHookRevision: "agent-hooks.stop-and-stop-failure.v1",
    suspensionRevision: "agent-runtime.same-run-descendant-resume.v1",
    resultTransferRevision: "agent-runtime.exactly-once-descendant-transfer.v1",
    hostRecoveryRevision: "host.trusted-descendant-resume.v1",
    targetAdapterRevision: "helarc-descendant-suspension-progression-target-v1",
  }),
} satisfies HelarcEvaluationBaselineSignature & {
  readonly descendantSuspensionProgression: {
    readonly lifecycleRevision: string;
    readonly agentHookRevision: string;
    readonly suspensionRevision: string;
    readonly resultTransferRevision: string;
    readonly hostRecoveryRevision: string;
    readonly targetAdapterRevision: string;
  };
});

export const HELARC_DESCENDANT_SUSPENSION_PROGRESSION_BASELINE_ACCEPTANCE = deepFreeze({
  schemaVersion: 1,
  kind: "helarc_descendant_suspension_progression_baseline_successor_acceptance",
  acceptedAt: "2026-09-05T00:00:00.000Z",
  predecessorAcceptanceRef:
    HELARC_RUN_LIFECYCLE_SETTLEMENT_ACCEPTED_BASELINE.acceptanceRef,
  successorAcceptanceRef: ACCEPTANCE_REF,
  predecessorReportRef:
    HELARC_RUN_LIFECYCLE_SETTLEMENT_ACCEPTED_BASELINE.reportRef,
  successorReportRef: REPORT_REF,
  comparison: "intentionally_incomparable_exact_target",
  changedTargetInputs: Object.freeze([
    "product.revision",
    "prompt.revision",
    "run-lifecycle.revision",
    "agent-hooks.revision",
    "target-adapter.revision",
    "source.revision",
    "delegation-contract.revision",
    "delegation-dispatch.revision",
    "run-limits.revision",
    "descendant-projection.revision",
    "descendant-suspension.revision",
    "descendant-result-transfer.revision",
    "host-descendant-recovery.revision",
    "fixture-manifest.revision",
    "expected-claims.revision",
  ]),
  outcomeQuality: "passed",
  safety: "passed",
  reliability: "deterministic_candidate_repeated_equivalently",
  trajectory:
    "Agent-owned Stop and StopFailure Hooks and same-Run Descendant suspension, Parent progression, Host recovery, and exactly-once result transfer preserve all twenty deterministic outcome and safety results.",
  latencyDelta:
    "The deterministic mean is 135.3 ms under the exact Descendant suspension-progression successor target.",
  coverage:
    "The immutable successor pairs Product behavior with focused Agent Hook, suspended Child progression, exact resume routing, terminal transfer, Host, Desktop, and observability conformance.",
  limitations: "deterministic_system_and_descendant_suspension_progression_cases_only",
});

function progressionMetricResultRef(refValue: {
  readonly id: string;
  readonly revision: string;
}) {
  if (!refValue.id.endsWith(".run-lifecycle-settlement-baseline-result")) {
    throw new TypeError(`Unknown predecessor Metric result '${refValue.id}'.`);
  }
  return Object.freeze({
    id: refValue.id.replace(
      /\.run-lifecycle-settlement-baseline-result$/,
      ".descendant-suspension-progression-baseline-result",
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
  const value = CASE_DIGEST_BY_KEY[key];
  if (value === undefined) throw new TypeError(`Unknown suspension-progression Case '${key}'.`);
  return value;
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
