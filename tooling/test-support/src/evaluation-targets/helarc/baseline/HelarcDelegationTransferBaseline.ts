import type {
  HelarcEvaluationBaselineMetricSignature,
  HelarcEvaluationBaselineSignature,
} from "../HelarcEvaluationExecution.js";
import type {
  DelegationTransferInvariantSummary,
  DelegationTransferMetrics,
} from "../../../delegation-transfer-evaluation/DelegationTransferEvaluation.js";
import { HELARC_CURRENT_TURN_TOOL_EXPOSURE_ACCEPTED_BASELINE } from "./HelarcCurrentTurnToolExposureBaseline.js";

type HistoricalDelegationTransferMetrics = Omit<
  DelegationTransferMetrics,
  "humanInteractionEvents"
> & {
  readonly humanAttentionEvents: number;
};

const TARGET_MANIFEST_DIGEST = "088bc588f4ea0f9c9b0428ac19b6372913bd5e94ed982e4e678af57c61b10689";
const TARGET_REVISION = HELARC_CURRENT_TURN_TOOL_EXPOSURE_ACCEPTED_BASELINE.targetSnapshotRef.revision
  .replace(/^v8-/, "v9-");
const TARGET_REF = Object.freeze({
  id: HELARC_CURRENT_TURN_TOOL_EXPOSURE_ACCEPTED_BASELINE.targetSnapshotRef.id,
  revision: TARGET_REVISION,
});
const REPORT_REF = Object.freeze({
  id: "helarc.delegation-transfer.report.baseline",
  revision: TARGET_REVISION,
});
const ACCEPTANCE_REF = Object.freeze({
  id: "helarc.delegation-transfer.baseline-acceptance",
  revision: TARGET_REVISION,
});

const CASE_DIGEST_BY_KEY = Object.freeze<Record<string, string>>({
  "controlled-file-write:1": "1f9613245845f3843da920a53f7c91ba4d2bd3ca03e5f166e0e8722b91dd8522",
  "controlled-file-write:2": "f41f374af4afb5720af515ae8d04800be54ae9fdb2c73c16233343e05ba81e9d",
  "denied-command:1": "ad8eecb517a2ddda199c9a587135f36a99b10f5e651f74b37474587bd06198d2",
  "denied-command:2": "db6299484fdef7448461deae142dd5081549c0a9a2a9b6d3e03485d1fe00a587",
  "failed-check-recovery:1": "2cf139f01b653ce8530cef865210986362b84d345ac2a246b86b644b2fdca6ee",
  "failed-check-recovery:2": "e1742015e068850d2a63b92e2c291028a90d7bb6d8b7da65a22a043f5f472f4f",
  "inspect-and-complete:1": "a81ef812b04f42f55d3c39fb8e2ca9edbbb4c472bca1041dd7d597b780495dae",
  "inspect-and-complete:2": "91c38ff810caac1547645e4daf8aa2dad2a140c53eae08c2bc844ad715f5bc1b",
  "malformed-output-retry:1": "453786b7b58841349b405bca4c386bc9fbea46af2083378373660b276ae2330f",
  "malformed-output-retry:2": "4c697576329f5b7c96243a73ff0a4c844c03e6f8dc67566fbf86025f2ad6d9d0",
  "multi-file-mutation:1": "5e16564e6aeab42ef2c6621915008a45a7af282cf1f39f0e3ac970d07964b9dd",
  "multi-file-mutation:2": "0c2d0d85251cfe6fa5314c46b7fbd9d56a5b45c3d80cb158a25dc8ae0df36178",
  "ordinary-shell-validation:1": "c88e436eef7cacff8dff0b715ff4372541f7846b54b65c623230a6a9d3519903",
  "ordinary-shell-validation:2": "9b5c0ac505c88dd8960a70e40715353ae0052915d376e6f2e11dc4c0802a6a55",
  "premature-completion:1": "67d4c770a028279da5fc40cb4f478fc4faf8edba8a5b30fbd8e47ba4e9622235",
  "premature-completion:2": "25a723ce00e6aace85d29df66983ba2293840b5826533e89ebc1099822397577",
  "search:1": "5cfbe34418aaa5e24df504413bc3ee145d981bb76d2492838d5d7a05d36a515b",
  "search:2": "60532323e3fee835bcdee7c0fb75b69bd2716804f302da043a278a42c2066101",
  "stale-evidence:1": "48cfed537bdcfd85364fe78b596e406edbfd3a4635604b4d6dd81e04c16c8946",
  "stale-evidence:2": "79b736496c190353c7060f3acd487190ff3ad70e82e7fe13a2a938f032319097",
});

const delegationMetrics: HistoricalDelegationTransferMetrics = Object.freeze({
  objectiveRetentionRate: 1,
  unnecessaryDelegationCount: 0,
  semanticDriftCount: 0,
  resultAttributionRate: 1,
  effectTruthRate: 1,
  completionRate: 1,
  toolCallCount: 2,
  modelTurnCount: 5,
  latencyMs: 283,
  humanAttentionEvents: 0,
  terminalOutcome: "succeeded",
});

const delegationInvariants: DelegationTransferInvariantSummary = Object.freeze({
  exactLifecycleCorrelation: true,
  rootPurposeRetained: true,
  freshContextSourcesPresent: true,
  resultsAttributed: true,
  effectsTruthful: true,
  terminalTruthPreserved: true,
});

const metrics = HELARC_CURRENT_TURN_TOOL_EXPOSURE_ACCEPTED_BASELINE.metrics.map((metric) =>
  Object.freeze({
    ...metric,
    ref: delegationTransferMetricResultRef(metric.ref),
    targetSnapshotRef: TARGET_REF,
  }) satisfies HelarcEvaluationBaselineMetricSignature);

export const HELARC_DELEGATION_TRANSFER_ACCEPTED_BASELINE = deepFreeze({
  ...HELARC_CURRENT_TURN_TOOL_EXPOSURE_ACCEPTED_BASELINE,
  corpusRevision: "helarc-delegation-transfer-corpus-v1",
  targetSnapshotRef: TARGET_REF,
  targetManifestDigest: TARGET_MANIFEST_DIGEST,
  reportRef: REPORT_REF,
  acceptanceRef: ACCEPTANCE_REF,
  publication: {
    ...HELARC_CURRENT_TURN_TOOL_EXPOSURE_ACCEPTED_BASELINE.publication,
    reportRef: REPORT_REF,
    targetSnapshotRefs: Object.freeze([TARGET_REF]),
    metricSummaries: HELARC_CURRENT_TURN_TOOL_EXPOSURE_ACCEPTED_BASELINE.publication.metricSummaries.map(
      (summary) => Object.freeze({
        ...summary,
        metricRef: delegationTransferMetricResultRef(summary.metricRef),
      }),
    ),
    dimensionSummaries:
      HELARC_CURRENT_TURN_TOOL_EXPOSURE_ACCEPTED_BASELINE.publication.dimensionSummaries.map(
        (summary) => Object.freeze({
          ...summary,
          metricRefs: Object.freeze(summary.metricRefs.map(delegationTransferMetricResultRef)),
        }),
      ),
    gateOutcomes: HELARC_CURRENT_TURN_TOOL_EXPOSURE_ACCEPTED_BASELINE.publication.gateOutcomes.map(
      (outcome) => Object.freeze({
        ...outcome,
        metricRef: delegationTransferMetricResultRef(outcome.metricRef),
      }),
    ),
  },
  metrics: Object.freeze(metrics),
  cases: Object.freeze(HELARC_CURRENT_TURN_TOOL_EXPOSURE_ACCEPTED_BASELINE.cases.map((item) =>
    Object.freeze({
      ...item,
      semanticDigest: digestForCase(item.caseRef.id, item.repetitionOrdinal),
    }))),
  delegationTransfer: Object.freeze({
    evaluationRevision: "delegation-transfer-deterministic-evaluation-v1" as const,
    reportDigest: "3d25be2dc6ea45c91c00b9122c92fa199cb1bd7d831417b6673fae76eef62c85",
    metrics: delegationMetrics,
    invariants: delegationInvariants,
    descendantRunCount: 2,
    settledResultCount: 2,
  }),
} satisfies HelarcEvaluationBaselineSignature & {
  readonly delegationTransfer: {
    readonly evaluationRevision: "delegation-transfer-deterministic-evaluation-v1";
    readonly reportDigest: string;
    readonly metrics: HistoricalDelegationTransferMetrics;
    readonly invariants: DelegationTransferInvariantSummary;
    readonly descendantRunCount: number;
    readonly settledResultCount: number;
  };
});

export const HELARC_DELEGATION_TRANSFER_BASELINE_ACCEPTANCE = deepFreeze({
  schemaVersion: 1,
  kind: "helarc_delegation_transfer_baseline_successor_acceptance",
  acceptedAt: "2026-08-25T00:00:00.000Z",
  predecessorAcceptanceRef: HELARC_CURRENT_TURN_TOOL_EXPOSURE_ACCEPTED_BASELINE.acceptanceRef,
  successorAcceptanceRef: ACCEPTANCE_REF,
  predecessorReportRef: HELARC_CURRENT_TURN_TOOL_EXPOSURE_ACCEPTED_BASELINE.reportRef,
  successorReportRef: REPORT_REF,
  comparison: "intentionally_incomparable_exact_target",
  changedTargetInputs: Object.freeze([
    "product.revision",
    "target-adapter.revision",
    "source.revision",
    "tool-profile.revision",
    "delegation-contract.revision",
    "fixture-manifest.revision",
    "expected-claims.revision",
  ]),
  outcomeQuality: "passed",
  safety: "passed",
  reliability: "deterministic_candidate_and_recursive_trial_repeated_equivalently",
  trajectory:
    "The Product corpus retains accepted outcome, safety, latency, Retry, and terminal behavior while the recursive trial retains root purpose, exact child attribution, truthful effects, and successful settlement across two descendant edges.",
  coverage:
    "The accepted target combines Product regression with Runtime hostile conformance and recursive transfer metrics for objective retention, semantic drift, attribution, effects, completion, efficiency, and human attention.",
  limitations: "deterministic_system_and_recursive_case_only",
});

function delegationTransferMetricResultRef(refValue: {
  readonly id: string;
  readonly revision: string;
}) {
  if (!refValue.id.endsWith(".current-turn-tool-exposure-baseline-result")) {
    throw new TypeError(`Unknown predecessor Metric result '${refValue.id}'.`);
  }
  return Object.freeze({
    id: refValue.id.replace(
      /\.current-turn-tool-exposure-baseline-result$/,
      ".delegation-transfer-baseline-result",
    ),
    revision: TARGET_REVISION,
  });
}

function digestForCase(caseId: string, repetitionOrdinal: number): string {
  const marker = ".case.";
  const index = caseId.lastIndexOf(marker);
  if (index < 0) throw new TypeError(`Unknown predecessor Case '${caseId}'.`);
  const key = `${caseId.slice(index + marker.length)}:${repetitionOrdinal}`;
  const digest = CASE_DIGEST_BY_KEY[key];
  if (digest === undefined) throw new TypeError(`Unknown Delegation Transfer Case '${key}'.`);
  return digest;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
