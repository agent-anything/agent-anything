import type {
  HelarcEvaluationBaselineMetricSignature,
  HelarcEvaluationBaselineSignature,
} from "../HelarcEvaluationExecution.js";
import {
  HELARC_RUN_TREE_DELEGATION_LIFECYCLE_ACCEPTED_BASELINE,
} from "./HelarcRunTreeDelegationLifecycleBaseline.js";

const TARGET_MANIFEST_DIGEST = "b0f049745596c43cfb490f4c2db3e6b214116bb740d423510b0949280d5ec6f8";
const TARGET_REVISION =
  HELARC_RUN_TREE_DELEGATION_LIFECYCLE_ACCEPTED_BASELINE.targetSnapshotRef.revision
    .replace(/^v16-/, "v17-");
const TARGET_REF = Object.freeze({
  id: HELARC_RUN_TREE_DELEGATION_LIFECYCLE_ACCEPTED_BASELINE.targetSnapshotRef.id,
  revision: TARGET_REVISION,
});
const REPORT_REF = Object.freeze({
  id: "helarc.child-delegation-progression.report.baseline",
  revision: TARGET_REVISION,
});
const ACCEPTANCE_REF = Object.freeze({
  id: "helarc.child-delegation-progression.baseline-acceptance",
  revision: TARGET_REVISION,
});

const CASE_DIGEST_BY_KEY = Object.freeze<Record<string, string>>({
  "controlled-file-write:1": "0a2caf7a22c08986b70524bc6348721dc72f38df5c35264477a31a0d38ef47dd",
  "controlled-file-write:2": "8f108ccd529aede5c042c3ffa7cff0da0f1b0d8bae1bbbf52f424874c98bcd66",
  "denied-command:1": "19144137c0ea809d4b9a4e40fa24e6cf4f9141da34d0a622307d154e30308f40",
  "denied-command:2": "c47431df2a640c75ad26ab3105efb1e2d8592bd6aea477b7e4715cf17cc5fefe",
  "failed-check-recovery:1": "0402f12e6b8db92bc7a3309f8d49fe7854e47bc2686021fc782ad54d462b606c",
  "failed-check-recovery:2": "926cd46ba1dda2e8c7c78db2ffd12162eda78780d22a8cd4ee7defbc41c953df",
  "inspect-and-complete:1": "dc9da838e5d2975e7d73b17543d33721a5cbbd57bdf6ee90c6b1e01471b76759",
  "inspect-and-complete:2": "07efd5f6bd46a79623340e6dfadb6e970f614f04e1094f8d55a507749748e127",
  "malformed-output-retry:1": "9b642eaa7f784659111a5c0b80f432e1414e45e10515ccab441c3093a3611a88",
  "malformed-output-retry:2": "b921d73c7591a283644c685c8ada8356816c3f51a3c935df32faca8816cca468",
  "multi-file-mutation:1": "7d4a69ae9873cafa233fde6a5e6a393245ebcf9bf2d8dbe6d7332bb65e14da82",
  "multi-file-mutation:2": "1f77fed8c745a9dc9cd0b3893ab2e245d1da621f05e6640d14df40e2c3e9748c",
  "ordinary-shell-verification:1": "a2723ba3fdfed78b4ae901dae72f17b6a8274cdeb2b0d69c55ba41021bbbc4f1",
  "ordinary-shell-verification:2": "8c75c9f6536a8b3d6731e3941d4bbc7bbf78f698bf55f30c748c7931766f6255",
  "premature-completion:1": "554799b03cdfbc9c291d87d26cc5803ba294cdb164e9a3056ec8efd85478fc25",
  "premature-completion:2": "286b513081528fffbf9df47567bcb053ffa3ff231b6fef70df29e60a6b6ebfca",
  "search:1": "c86c33b3c687496d1c5f158486df3cc3846913f1f8f49fb0389df5fa038d5e73",
  "search:2": "c48b7f5569810e25beace9dfa6495bbac85735d4280c9ba83bad608b7185308d",
  "stale-evidence:1": "b3f48f624575eea2ddd42febd9f7b8d15ffe8a41d279ca24ef49596b285d02b1",
  "stale-evidence:2": "da9447a18e4801485cd9489436ce17865a6c66f652aad1c82f9954a9396b03a4",
});

const metrics = HELARC_RUN_TREE_DELEGATION_LIFECYCLE_ACCEPTED_BASELINE.metrics.map(
  (metric) => Object.freeze({
    ...metric,
    ref: childDelegationMetricResultRef(metric.ref),
    targetSnapshotRef: TARGET_REF,
  }) satisfies HelarcEvaluationBaselineMetricSignature,
);

export const HELARC_CHILD_DELEGATION_PROGRESSION_ACCEPTED_BASELINE = deepFreeze({
  ...HELARC_RUN_TREE_DELEGATION_LIFECYCLE_ACCEPTED_BASELINE,
  corpusRevision: "helarc-child-delegation-progression-corpus-v1",
  targetSnapshotRef: TARGET_REF,
  targetManifestDigest: TARGET_MANIFEST_DIGEST,
  reportRef: REPORT_REF,
  acceptanceRef: ACCEPTANCE_REF,
  publication: {
    ...HELARC_RUN_TREE_DELEGATION_LIFECYCLE_ACCEPTED_BASELINE.publication,
    reportRef: REPORT_REF,
    targetSnapshotRefs: Object.freeze([TARGET_REF]),
    metricSummaries:
      HELARC_RUN_TREE_DELEGATION_LIFECYCLE_ACCEPTED_BASELINE.publication.metricSummaries.map(
        (summary) => Object.freeze({
          ...summary,
          metricRef: childDelegationMetricResultRef(summary.metricRef),
        }),
      ),
    dimensionSummaries:
      HELARC_RUN_TREE_DELEGATION_LIFECYCLE_ACCEPTED_BASELINE.publication.dimensionSummaries.map(
        (summary) => Object.freeze({
          ...summary,
          metricRefs: Object.freeze(
            summary.metricRefs.map(childDelegationMetricResultRef),
          ),
        }),
      ),
    gateOutcomes:
      HELARC_RUN_TREE_DELEGATION_LIFECYCLE_ACCEPTED_BASELINE.publication.gateOutcomes.map(
        (outcome) => Object.freeze({
          ...outcome,
          metricRef: childDelegationMetricResultRef(outcome.metricRef),
        }),
      ),
  },
  metrics: Object.freeze(metrics),
  cases: Object.freeze(
    HELARC_RUN_TREE_DELEGATION_LIFECYCLE_ACCEPTED_BASELINE.cases.map((item) =>
      Object.freeze({
        ...item,
        semanticDigest: digestForCase(item.caseRef.id, item.repetitionOrdinal),
      }),
    ),
  ),
  childDelegationProgression: Object.freeze({
    delegationContractRevision: "ordinary-child-sibling-dispatch-v1",
    dispatchRevision: "agent-runtime.model-authored-sibling-dispatch.v1",
    toolInheritanceRevision: "agent-runtime.exact-parent-tool-selection.v1",
    resourceAccountRevision: "agent-runtime.run-tree-resource-account.v3",
    authorityRevision: "agent-runtime.run-tree-authority.v3",
    settlementRevision: "agent-runtime.run-tree-settlement.v3",
    descendantProjectionRevision: "host.descendant-dispatch-projection.v1",
    targetAdapterRevision: "helarc-child-delegation-progression-target-v1",
  }),
} satisfies HelarcEvaluationBaselineSignature & {
  readonly childDelegationProgression: {
    readonly delegationContractRevision: string;
    readonly dispatchRevision: string;
    readonly toolInheritanceRevision: string;
    readonly resourceAccountRevision: string;
    readonly authorityRevision: string;
    readonly settlementRevision: string;
    readonly descendantProjectionRevision: string;
    readonly targetAdapterRevision: string;
  };
});

export const HELARC_CHILD_DELEGATION_PROGRESSION_BASELINE_ACCEPTANCE = deepFreeze({
  schemaVersion: 1,
  kind: "helarc_child_delegation_progression_baseline_successor_acceptance",
  acceptedAt: "2026-09-01T00:00:00.000Z",
  predecessorAcceptanceRef:
    HELARC_RUN_TREE_DELEGATION_LIFECYCLE_ACCEPTED_BASELINE.acceptanceRef,
  successorAcceptanceRef: ACCEPTANCE_REF,
  predecessorReportRef:
    HELARC_RUN_TREE_DELEGATION_LIFECYCLE_ACCEPTED_BASELINE.reportRef,
  successorReportRef: REPORT_REF,
  comparison: "intentionally_incomparable_exact_target",
  changedTargetInputs: Object.freeze([
    "product.revision",
    "tool-profile.revision",
    "delegation-contract.revision",
    "delegation-dispatch.revision",
    "delegation-tool-inheritance.revision",
    "run-tree-resource-account.revision",
    "run-tree-authority.revision",
    "run-tree-settlement.revision",
    "descendant-projection.revision",
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
    "Ordinary Child Runs, exact inherited Tool selection, model-authored sibling dispatch, ordered Parent settlement, and truthful descendant projection preserve all twenty deterministic outcome and safety results.",
  latencyDelta:
    "The deterministic mean remains 131.5 ms under the exact successor target.",
  coverage:
    "The immutable successor pairs the Product baseline with focused single-child, mixed-sibling, admission, cancellation, resource, authority, settlement, event, Host projection, and Desktop conformance.",
  limitations: "deterministic_system_and_child_delegation_progression_cases_only",
});

function childDelegationMetricResultRef(refValue: {
  readonly id: string;
  readonly revision: string;
}) {
  if (!refValue.id.endsWith(".run-tree-delegation-lifecycle-baseline-result")) {
    throw new TypeError(`Unknown predecessor Metric result '${refValue.id}'.`);
  }
  return Object.freeze({
    id: refValue.id.replace(
      /\.run-tree-delegation-lifecycle-baseline-result$/,
      ".child-delegation-progression-baseline-result",
    ),
    revision: TARGET_REVISION,
  });
}

function digestForCase(caseId: string, repetitionOrdinal: number): string {
  const key = `${caseKey(caseId)}:${repetitionOrdinal}`;
  const digest = CASE_DIGEST_BY_KEY[key];
  if (digest === undefined) {
    throw new TypeError(`Unknown Child delegation progression Case '${key}'.`);
  }
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
