import type {
  HelarcEvaluationBaselineMetricSignature,
  HelarcEvaluationBaselineSignature,
} from "../HelarcEvaluationExecution.js";
import {
  HELARC_RUN_TREE_RESOURCE_AUTHORITY_ACCEPTED_BASELINE,
} from "./HelarcRunTreeResourceAuthorityBaseline.js";

const TARGET_MANIFEST_DIGEST = "fadc25abaa4bca8b19c490f6dbc5a467db4823a70a80bebc27d3d3a64d52f97b";
const TARGET_REVISION =
  HELARC_RUN_TREE_RESOURCE_AUTHORITY_ACCEPTED_BASELINE.targetSnapshotRef.revision
    .replace(/^v15-/, "v16-");
const TARGET_REF = Object.freeze({
  id: HELARC_RUN_TREE_RESOURCE_AUTHORITY_ACCEPTED_BASELINE.targetSnapshotRef.id,
  revision: TARGET_REVISION,
});
const REPORT_REF = Object.freeze({
  id: "helarc.run-tree-delegation-lifecycle.report.baseline",
  revision: TARGET_REVISION,
});
const ACCEPTANCE_REF = Object.freeze({
  id: "helarc.run-tree-delegation-lifecycle.baseline-acceptance",
  revision: TARGET_REVISION,
});

const CASE_DIGEST_BY_KEY = Object.freeze<Record<string, string>>({
  "controlled-file-write:1": "eac869318ce045f8dd0b7cede05e02d58bc6e58302433479c5e1139268e25066",
  "controlled-file-write:2": "3e9259513952ee7d36d0b63f8b765eb0082377a2290318e1ec54def715449ca9",
  "denied-command:1": "52de25ce35c3f2585f0e733f9112a1fd6d241a820fbdc92dda18aa884579601e",
  "denied-command:2": "b4671fb722cad51fd03c05914d6b6fd4c54fa5a1d2e2b2ea9e46f777092959ea",
  "failed-check-recovery:1": "5d46a7d5444df519d5e75ade4d810400b12165cace3c4378e92682e609678d4a",
  "failed-check-recovery:2": "ac8d9141ec40ce9721b7dcbe355c302469176f6193337b46886d65754a42d217",
  "inspect-and-complete:1": "a6614c3af1bb5ff98a00fbce3e43dbb8a3cad88bfabe557304f5fe65f7627dc6",
  "inspect-and-complete:2": "5db79ea0055bdafbad0d467ed84b89f59e57efdd75b4e78b8eac6b0118c1049b",
  "malformed-output-retry:1": "51b95f857251d15edd4fe763bc4025ea21e8d8dc5463e6ce816940e25fc6ab53",
  "malformed-output-retry:2": "a03b4c192afb9607e9ca25645a7dad8eff178ddcdbd50351f7bfd200bf87921d",
  "multi-file-mutation:1": "fb55e64620b84b80fb5b62c4baec88f7913f47056a94ec430873874004fbe93b",
  "multi-file-mutation:2": "995f50de4b029635c5700410b8c3e235e50b97b51fdd5368ac2dcdb13f1a45ab",
  "ordinary-shell-verification:1": "a2f1679169288638655976d3ed3bcae0869bd68c1e006dbd115afdd454989490",
  "ordinary-shell-verification:2": "94c4ace52ca257518010aff43412266c2cfee26e7d8e3f70c2cc5be48725f5d6",
  "premature-completion:1": "81bb193537fa35f221c8cdc110d32255d63452733d3de184b2eacc71031f7b99",
  "premature-completion:2": "20f08720ada45abd2de8586d2b7e37488c73ae6464e54f5e26598f36a223c00a",
  "search:1": "6c15ec1a2e2eb9e7b9d2ca0f1d8ad3562ceac9140496972c6e32de698e4cc95a",
  "search:2": "443be7eead13eb9d631c96f2a34dcd73e17102bf4902908bfea5e289edc500e5",
  "stale-evidence:1": "ce135ceb0afa6f3a93a9cbdc20770065959dc82539c67ff87e5184a8f1641d27",
  "stale-evidence:2": "2c885ffc744a443536627d1a41eed99cd991b1dee98c62aeb35eb9d76f22f66c",
});

const metrics = HELARC_RUN_TREE_RESOURCE_AUTHORITY_ACCEPTED_BASELINE.metrics.map((metric) =>
  Object.freeze({
    ...metric,
    ref: delegationLifecycleMetricResultRef(metric.ref),
    targetSnapshotRef: TARGET_REF,
  }) satisfies HelarcEvaluationBaselineMetricSignature);

export const HELARC_RUN_TREE_DELEGATION_LIFECYCLE_ACCEPTED_BASELINE = deepFreeze({
  ...HELARC_RUN_TREE_RESOURCE_AUTHORITY_ACCEPTED_BASELINE,
  corpusRevision: "helarc-run-tree-delegation-lifecycle-corpus-v1",
  targetSnapshotRef: TARGET_REF,
  targetManifestDigest: TARGET_MANIFEST_DIGEST,
  reportRef: REPORT_REF,
  acceptanceRef: ACCEPTANCE_REF,
  publication: {
    ...HELARC_RUN_TREE_RESOURCE_AUTHORITY_ACCEPTED_BASELINE.publication,
    reportRef: REPORT_REF,
    targetSnapshotRefs: Object.freeze([TARGET_REF]),
    metricSummaries:
      HELARC_RUN_TREE_RESOURCE_AUTHORITY_ACCEPTED_BASELINE.publication.metricSummaries.map(
        (summary) => Object.freeze({
          ...summary,
          metricRef: delegationLifecycleMetricResultRef(summary.metricRef),
        }),
      ),
    dimensionSummaries:
      HELARC_RUN_TREE_RESOURCE_AUTHORITY_ACCEPTED_BASELINE.publication.dimensionSummaries.map(
        (summary) => Object.freeze({
          ...summary,
          metricRefs: Object.freeze(
            summary.metricRefs.map(delegationLifecycleMetricResultRef),
          ),
        }),
      ),
    gateOutcomes:
      HELARC_RUN_TREE_RESOURCE_AUTHORITY_ACCEPTED_BASELINE.publication.gateOutcomes.map(
        (outcome) => Object.freeze({
          ...outcome,
          metricRef: delegationLifecycleMetricResultRef(outcome.metricRef),
        }),
      ),
  },
  metrics: Object.freeze(metrics),
  cases: Object.freeze(HELARC_RUN_TREE_RESOURCE_AUTHORITY_ACCEPTED_BASELINE.cases.map((item) =>
    Object.freeze({
      ...item,
      semanticDigest: digestForCase(item.caseRef.id, item.repetitionOrdinal),
    })
  )),
  runTreeDelegationLifecycle: Object.freeze({
    delegationContractRevision: "isolated-delegation-continuation-v1",
    resourceAccountRevision: "agent-runtime.run-tree-resource-account.v2",
    authorityRevision: "agent-runtime.run-tree-authority.v2",
    settlementRevision: "agent-runtime.run-tree-settlement.v2",
    targetAdapterRevision: "helarc-run-tree-delegation-lifecycle-target-v1",
  }),
} satisfies HelarcEvaluationBaselineSignature & {
  readonly runTreeDelegationLifecycle: {
    readonly delegationContractRevision: string;
    readonly resourceAccountRevision: string;
    readonly authorityRevision: string;
    readonly settlementRevision: string;
    readonly targetAdapterRevision: string;
  };
});

export const HELARC_RUN_TREE_DELEGATION_LIFECYCLE_BASELINE_ACCEPTANCE = deepFreeze({
  schemaVersion: 1,
  kind: "helarc_run_tree_delegation_lifecycle_baseline_successor_acceptance",
  acceptedAt: "2026-08-30T00:00:00.000Z",
  predecessorAcceptanceRef:
    HELARC_RUN_TREE_RESOURCE_AUTHORITY_ACCEPTED_BASELINE.acceptanceRef,
  successorAcceptanceRef: ACCEPTANCE_REF,
  predecessorReportRef: HELARC_RUN_TREE_RESOURCE_AUTHORITY_ACCEPTED_BASELINE.reportRef,
  successorReportRef: REPORT_REF,
  comparison: "intentionally_incomparable_exact_target",
  changedTargetInputs: Object.freeze([
    "product.revision",
    "tool-profile.revision",
    "delegation-contract.revision",
    "run-tree-resource-account.revision",
    "run-tree-authority.revision",
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
    "Isolated delegated objectives, exact descendant targets, successor continuation, fresh replacement, truthful partial transfer, and class-specific resources preserve all twenty deterministic outcome and safety results.",
  latencyDelta:
    "The deterministic mean remains 131.5 ms under the exact successor target.",
  coverage:
    "The immutable successor pairs the Product baseline with focused nested delegation, active steering, continuation, replacement, cancellation, unknown-effect, and resource-conservation conformance.",
  limitations: "deterministic_system_and_descendant_lifecycle_cases_only",
});

function delegationLifecycleMetricResultRef(refValue: {
  readonly id: string;
  readonly revision: string;
}) {
  if (!refValue.id.endsWith(".run-tree-resource-authority-baseline-result")) {
    throw new TypeError(`Unknown predecessor Metric result '${refValue.id}'.`);
  }
  return Object.freeze({
    id: refValue.id.replace(
      /\.run-tree-resource-authority-baseline-result$/,
      ".run-tree-delegation-lifecycle-baseline-result",
    ),
    revision: TARGET_REVISION,
  });
}

function digestForCase(caseId: string, repetitionOrdinal: number): string {
  const key = `${caseKey(caseId)}:${repetitionOrdinal}`;
  const digest = CASE_DIGEST_BY_KEY[key];
  if (digest === undefined) throw new TypeError(`Unknown delegation lifecycle Case '${key}'.`);
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
