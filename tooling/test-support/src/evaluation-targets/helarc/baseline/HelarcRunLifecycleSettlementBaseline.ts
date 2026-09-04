import type {
  HelarcEvaluationBaselineMetricSignature,
  HelarcEvaluationBaselineSignature,
} from "../HelarcEvaluationExecution.js";
import {
  HELARC_CHILD_DELEGATION_PROGRESSION_ACCEPTED_BASELINE,
} from "./HelarcChildDelegationProgressionBaseline.js";

const TARGET_MANIFEST_DIGEST = "682cec0c400cce712850fcc043fc8d5073c4be5bd0999b13d7de24cdcff70784";
const TARGET_REVISION =
  HELARC_CHILD_DELEGATION_PROGRESSION_ACCEPTED_BASELINE.targetSnapshotRef.revision
    .replace(/^v17-/, "v18-");
const TARGET_REF = Object.freeze({
  id: HELARC_CHILD_DELEGATION_PROGRESSION_ACCEPTED_BASELINE.targetSnapshotRef.id,
  revision: TARGET_REVISION,
});
const REPORT_REF = Object.freeze({
  id: "helarc.run-lifecycle-settlement.report.baseline",
  revision: TARGET_REVISION,
});
const ACCEPTANCE_REF = Object.freeze({
  id: "helarc.run-lifecycle-settlement.baseline-acceptance",
  revision: TARGET_REVISION,
});

const CASE_DIGEST_BY_KEY = Object.freeze<Record<string, string>>({
  "controlled-file-write:1": "677138e7fa0caa80004b8dddbe7c8a90f9d787c0c0fb7df1c0035b8194019ca5",
  "controlled-file-write:2": "91f034d7bdcbe305607fe894387c0abdf736f3234e833b32ba6c2afe0cc62724",
  "denied-command:1": "e21721162360600a36b37db3465e1e504bd5332c14c02860cd90017afb433c93",
  "denied-command:2": "a94d37952361da8e4cc93b3acc8afe16ccd2bd9bd507df3870fbff225be3bd73",
  "failed-check-recovery:1": "30b798d694fab08ef00ae721cbb6866a59a333ba7ba2518fb531d24a4dbf1412",
  "failed-check-recovery:2": "0262e3a88e7cea08e3d799662ae8f284e22bba71b44f416457cf2c3e60a3f3fa",
  "inspect-and-complete:1": "8ffc2ce181ff16daef2ec95ac48fa30405f567991af54099d0a14f7aa57b7dea",
  "inspect-and-complete:2": "247b833aafbbdbdbfd16122763314e2792edd7168ec370301af9b31bbad8ab21",
  "malformed-output-retry:1": "eb2f569cd55e99c759a02de97e82a48aab5e1b44592f2f5e054ff61e4b68a163",
  "malformed-output-retry:2": "822082096ad24244de302dddb0e36fae5da77b68cb23b54e82c59922a23cc8a2",
  "multi-file-mutation:1": "7abac3f92f2ec9034ce196ff9e0fa80517b2f0c49d818dc3594566c0fa85ab87",
  "multi-file-mutation:2": "de1a4df73cadc0a2532ce54f4a10dc1798d35df3b467e9317b3863717fbd6b7e",
  "ordinary-shell-verification:1": "fbf3980c1d57dbfc28d3f8a80516a4624ebf8658251eb816182b0d55fb4fdc70",
  "ordinary-shell-verification:2": "4b31b3781aa8b45da73d4169609bd43894ceba0458545af71ad2ce2e998172ff",
  "premature-completion:1": "542b64d45277dd37651a9fd31a09f7066834ec4eb4283101306f7d28dd95467c",
  "premature-completion:2": "65d86f27cc8f3deb762dafeb5c2081c40a07d2eb08e639fa368858679e631c7f",
  "search:1": "9fe2ed98460e988ea21d98ae127630f56d348da92626500d230cc6f5645e7d95",
  "search:2": "6feade0d20d38cb0c82844fad40eecc50311711b7d2dcbf1e0df02395e77aed7",
  "stale-evidence:1": "fa9fe50402422f1ebb27055bca52811bab376de4c09af328595e73c8741357fe",
  "stale-evidence:2": "aa744aa555534bdcd76e73638251672600a81ecfd22aa4ae5c7fea7548a412ff",
});

const OUTCOME_BY_CASE = Object.freeze<Record<string, "succeeded" | "cancelled">>({
  "controlled-file-write": "succeeded",
  "denied-command": "cancelled",
  "failed-check-recovery": "succeeded",
  "inspect-and-complete": "succeeded",
  "malformed-output-retry": "succeeded",
  "multi-file-mutation": "succeeded",
  "ordinary-shell-verification": "succeeded",
  "premature-completion": "cancelled",
  search: "succeeded",
  "stale-evidence": "cancelled",
});

const LATENCY_BY_CASE = Object.freeze<Record<string, number>>({
  "controlled-file-write": 104,
  "denied-command": 113,
  "failed-check-recovery": 167,
  "inspect-and-complete": 148,
  "malformed-output-retry": 68,
  "multi-file-mutation": 213,
  "ordinary-shell-verification": 113,
  "premature-completion": 127,
  search: 103,
  "stale-evidence": 191,
});

const LATENCY_DISTRIBUTION = Object.freeze({
  kind: "numeric_distribution" as const,
  sampleCount: 20,
  minimum: 68,
  maximum: 213,
  mean: 134.7,
  variance: 1886.1157894736841,
  varianceMethod: "sample" as const,
  p50: 120,
  p90: 193.20000000000005,
  p95: 213,
});

const LATENCY_UNCERTAINTY = Object.freeze({
  status: "available" as const,
  method: "standard_error" as const,
  confidence: 0.95,
  lower: 115.666560809976,
  upper: 153.73343919002397,
});

const metrics = HELARC_CHILD_DELEGATION_PROGRESSION_ACCEPTED_BASELINE.metrics.map(
  (metric) => {
    const latency = metric.definitionRef.id.endsWith(".latency");
    return Object.freeze({
      ...metric,
      ref: lifecycleMetricResultRef(metric.ref),
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

export const HELARC_RUN_LIFECYCLE_SETTLEMENT_ACCEPTED_BASELINE = deepFreeze({
  ...HELARC_CHILD_DELEGATION_PROGRESSION_ACCEPTED_BASELINE,
  corpusRevision: "helarc-run-lifecycle-settlement-corpus-v1",
  targetSnapshotRef: TARGET_REF,
  targetManifestDigest: TARGET_MANIFEST_DIGEST,
  reportRef: REPORT_REF,
  acceptanceRef: ACCEPTANCE_REF,
  publication: {
    ...HELARC_CHILD_DELEGATION_PROGRESSION_ACCEPTED_BASELINE.publication,
    reportRef: REPORT_REF,
    targetSnapshotRefs: Object.freeze([TARGET_REF]),
    metricSummaries:
      HELARC_CHILD_DELEGATION_PROGRESSION_ACCEPTED_BASELINE.publication.metricSummaries.map(
        (summary) => {
          const metricRef = lifecycleMetricResultRef(summary.metricRef);
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
      HELARC_CHILD_DELEGATION_PROGRESSION_ACCEPTED_BASELINE.publication.dimensionSummaries.map(
        (summary) => Object.freeze({
          ...summary,
          metricRefs: Object.freeze(summary.metricRefs.map(lifecycleMetricResultRef)),
        }),
      ),
    gateOutcomes:
      HELARC_CHILD_DELEGATION_PROGRESSION_ACCEPTED_BASELINE.publication.gateOutcomes.map(
        (outcome) => Object.freeze({
          ...outcome,
          metricRef: lifecycleMetricResultRef(outcome.metricRef),
        }),
      ),
  },
  metrics: Object.freeze(metrics),
  cases: Object.freeze(
    HELARC_CHILD_DELEGATION_PROGRESSION_ACCEPTED_BASELINE.cases.map((item) =>
      Object.freeze({
        ...item,
        targetOutcomeStatus: outcomeForCase(item.caseRef.id),
        semanticDigest: digestForCase(item.caseRef.id, item.repetitionOrdinal),
      }),
    ),
  ),
  runLifecycleSettlement: Object.freeze({
    lifecycleRevision: "agent-runtime.run-lifecycle.v2",
    settlementRevision: "agent-runtime.run-terminal-settlement.v1",
    lifecycleHookRevision: "agent-runtime.stop-lifecycle-hooks.v1",
    toolInputValidationRevision: "tools.tool-call-attempt-validation.v1",
    continuationRevision: "agent-runtime.opaque-agent-continuation.v1",
    modelContextRevision: "model-interaction.provider-context-assessment.v1",
    transportRevision: "model-interaction.request-body-transport-accounting.v1",
    targetAdapterRevision: "helarc-run-lifecycle-settlement-target-v1",
  }),
} satisfies HelarcEvaluationBaselineSignature & {
  readonly runLifecycleSettlement: {
    readonly lifecycleRevision: string;
    readonly settlementRevision: string;
    readonly lifecycleHookRevision: string;
    readonly toolInputValidationRevision: string;
    readonly continuationRevision: string;
    readonly modelContextRevision: string;
    readonly transportRevision: string;
    readonly targetAdapterRevision: string;
  };
});

export const HELARC_RUN_LIFECYCLE_SETTLEMENT_BASELINE_ACCEPTANCE = deepFreeze({
  schemaVersion: 1,
  kind: "helarc_run_lifecycle_settlement_baseline_successor_acceptance",
  acceptedAt: "2026-09-01T00:00:00.000Z",
  predecessorAcceptanceRef:
    HELARC_CHILD_DELEGATION_PROGRESSION_ACCEPTED_BASELINE.acceptanceRef,
  successorAcceptanceRef: ACCEPTANCE_REF,
  predecessorReportRef:
    HELARC_CHILD_DELEGATION_PROGRESSION_ACCEPTED_BASELINE.reportRef,
  successorReportRef: REPORT_REF,
  comparison: "intentionally_incomparable_exact_target",
  changedTargetInputs: Object.freeze([
    "product.revision",
    "run-lifecycle.revision",
    "run-settlement.revision",
    "run-lifecycle-hooks.revision",
    "task-fulfillment-hook.revision",
    "verification-completion-gate.revision",
    "tool-input-validation.revision",
    "agent-continuation.revision",
    "model-context-assessment.revision",
    "provider-transport-accounting.revision",
    "context-recovery.revision",
    "tool-profile.revision",
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
    "Run lifecycle settlement, optional Product completion Hooks, trusted Tool input, opaque Agent continuation, and Provider context truth preserve all twenty deterministic outcome and safety results.",
  latencyDelta:
    "The deterministic mean is 134.7 ms under the exact lifecycle-settlement successor target.",
  coverage:
    "The immutable successor pairs Product behavior with focused lifecycle, terminal race, Hook, Tool validation, continuation, model context, transport, Host, and observability conformance.",
  limitations: "deterministic_system_and_run_lifecycle_settlement_cases_only",
});

function lifecycleMetricResultRef(refValue: {
  readonly id: string;
  readonly revision: string;
}) {
  if (!refValue.id.endsWith(".child-delegation-progression-baseline-result")) {
    throw new TypeError(`Unknown predecessor Metric result '${refValue.id}'.`);
  }
  return Object.freeze({
    id: refValue.id.replace(
      /\.child-delegation-progression-baseline-result$/,
      ".run-lifecycle-settlement-baseline-result",
    ),
    revision: TARGET_REVISION,
  });
}

function latencyForCase(caseId: string): number {
  const value = LATENCY_BY_CASE[caseKey(caseId)];
  if (value === undefined) throw new TypeError(`Unknown latency Case '${caseId}'.`);
  return value;
}

function outcomeForCase(caseId: string): "succeeded" | "cancelled" {
  const value = OUTCOME_BY_CASE[caseKey(caseId)];
  if (value === undefined) throw new TypeError(`Unknown outcome Case '${caseId}'.`);
  return value;
}

function digestForCase(caseId: string, repetitionOrdinal: number): string {
  const key = `${caseKey(caseId)}:${repetitionOrdinal}`;
  const value = CASE_DIGEST_BY_KEY[key];
  if (value === undefined) throw new TypeError(`Unknown lifecycle settlement Case '${key}'.`);
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
