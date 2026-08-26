import type {
  HelarcEvaluationBaselineMetricSignature,
  HelarcEvaluationBaselineSignature,
} from "../HelarcEvaluationExecution.js";
import { HELARC_DELEGATION_TRANSFER_ACCEPTED_BASELINE } from "./HelarcDelegationTransferBaseline.js";

const TARGET_MANIFEST_DIGEST = "58c2e081ff338211c6d9a0eb06af76c4cb2c29039d21d54640c043245d311c23";
const TARGET_REVISION = HELARC_DELEGATION_TRANSFER_ACCEPTED_BASELINE.targetSnapshotRef.revision
  .replace(/^v9-/, "v10-");
const TARGET_REF = Object.freeze({
  id: HELARC_DELEGATION_TRANSFER_ACCEPTED_BASELINE.targetSnapshotRef.id,
  revision: TARGET_REVISION,
});
const REPORT_REF = Object.freeze({
  id: "helarc.agent-instructions.report.baseline",
  revision: TARGET_REVISION,
});
const ACCEPTANCE_REF = Object.freeze({
  id: "helarc.agent-instructions.baseline-acceptance",
  revision: TARGET_REVISION,
});

const CASE_DIGEST_BY_KEY = Object.freeze<Record<string, string>>({
  "controlled-file-write:1": "5a21e5f0d98584890f621d112ca38259f8c7503a0bae6aac14a33d8a12bdc961",
  "controlled-file-write:2": "a862a5cf7908f2f6c1060749700340af398864c9c798c734c3df64946d726f0d",
  "denied-command:1": "0987ba4ebd8b024495f14b63cd21cac034d3b78dbb3d6e9cc5b88defd19c7324",
  "denied-command:2": "b81e6cd67b2361757bea72b682714d69d77555d353a71a5d6ea9508aa3c8df86",
  "failed-check-recovery:1": "b600ede6e1f5a5af8dded13f33bd769b86189b003e91407c62c1127d0a3400f8",
  "failed-check-recovery:2": "15e5dc2bf6a93b6f9c9ec7f8beac3634a9137a082be75632acb6ebfc7262043d",
  "inspect-and-complete:1": "66f54233e612ca1a72330eacf7ac59d0feda657c260e9b2b9161b9573bb764a5",
  "inspect-and-complete:2": "b5fe258713b5188c46401449ef5ffcb4cf4da1511b8e1478fcbdde1ddc5b01de",
  "malformed-output-retry:1": "fde2ad19b15953354bca688aa1a62bdfee182f5757a42fac6f85dfd57917a926",
  "malformed-output-retry:2": "de7539e26c31864e8de542432f7e8dd2c2943fea8de4f1f6058b031db8bfc1fb",
  "multi-file-mutation:1": "446997591d8f69a42413ab547b7f7f41d9ff252dccd7e90a94fabac92cc7eb9d",
  "multi-file-mutation:2": "97ee2f8166cfe327105de6fa1e2f392135ba43b6edefd6eca352bfd13b124226",
  "ordinary-shell-validation:1": "c1af347914cf241391d6ee4b341882bddb083621ac8e235627a95cf083957504",
  "ordinary-shell-validation:2": "86ab908d2d80f9e11e8e042b4f5f45e7ae09a9c8dd3e85aadc5d8ad97376dced",
  "premature-completion:1": "553a0a3b5e1d8673bd28e5239f17973d9cfde8100de445b02ec8be727e23ba5f",
  "premature-completion:2": "be2a1964e092110a8b336c188e74acb1cc8715e77af942120cbba502c6483d1f",
  "search:1": "3e84786629d25a2c68277a145424efc627d7c00bf2a57f20b5ed6aad5b882962",
  "search:2": "bc56d604370fb78ca848f681911bb6e61f85b377acbe774f09b63e58a8292fe0",
  "stale-evidence:1": "bdc07e98cbcc4f576bbb59505bc600e0985f6fb3f6f165ed9baae6f4bb7a5978",
  "stale-evidence:2": "a089c855aa18debdd0d81dec8621723aaebd434974eba3476e708b020e521f2f",
});

const metrics = HELARC_DELEGATION_TRANSFER_ACCEPTED_BASELINE.metrics.map((metric) =>
  Object.freeze({
    ...metric,
    ref: agentInstructionsMetricResultRef(metric.ref),
    targetSnapshotRef: TARGET_REF,
  }) satisfies HelarcEvaluationBaselineMetricSignature);

export const HELARC_AGENT_INSTRUCTIONS_ACCEPTED_BASELINE = deepFreeze({
  ...HELARC_DELEGATION_TRANSFER_ACCEPTED_BASELINE,
  corpusRevision: "helarc-agent-instructions-corpus-v1",
  targetSnapshotRef: TARGET_REF,
  targetManifestDigest: TARGET_MANIFEST_DIGEST,
  reportRef: REPORT_REF,
  acceptanceRef: ACCEPTANCE_REF,
  publication: {
    ...HELARC_DELEGATION_TRANSFER_ACCEPTED_BASELINE.publication,
    reportRef: REPORT_REF,
    targetSnapshotRefs: Object.freeze([TARGET_REF]),
    metricSummaries: HELARC_DELEGATION_TRANSFER_ACCEPTED_BASELINE.publication.metricSummaries.map(
      (summary) => Object.freeze({
        ...summary,
        metricRef: agentInstructionsMetricResultRef(summary.metricRef),
      }),
    ),
    dimensionSummaries:
      HELARC_DELEGATION_TRANSFER_ACCEPTED_BASELINE.publication.dimensionSummaries.map(
        (summary) => Object.freeze({
          ...summary,
          metricRefs: Object.freeze(summary.metricRefs.map(agentInstructionsMetricResultRef)),
        }),
      ),
    gateOutcomes: HELARC_DELEGATION_TRANSFER_ACCEPTED_BASELINE.publication.gateOutcomes.map(
      (outcome) => Object.freeze({
        ...outcome,
        metricRef: agentInstructionsMetricResultRef(outcome.metricRef),
      }),
    ),
  },
  metrics: Object.freeze(metrics),
  cases: Object.freeze(HELARC_DELEGATION_TRANSFER_ACCEPTED_BASELINE.cases.map((item) =>
    Object.freeze({
      ...item,
      semanticDigest: digestForCase(item.caseRef.id, item.repetitionOrdinal),
    }))),
  agentInstructions: Object.freeze({
    target: "production" as const,
    agentId: "helarc-code-agent",
    agentRevision: "instructions-v1:09f4ef0356805351fa19c457fecedc7cc5f40b92c42df411b5abda8022472267",
    releaseId: "helarc.instructions.release.production",
    releaseRevision: "sha256:4211deb99376019111b449097e7b79418cc23c3c28059ede0d6520cf02bf9431",
    instructionsId: "helarc-code-agent.production.instructions",
    instructionsRevision: "sha256:09f4ef0356805351fa19c457fecedc7cc5f40b92c42df411b5abda8022472267",
    resolverRevision: "helarc-instruction-resolver.v1",
    contentDigest: "09f4ef0356805351fa19c457fecedc7cc5f40b92c42df411b5abda8022472267",
    blockCount: 9,
  }),
} satisfies HelarcEvaluationBaselineSignature & {
  readonly agentInstructions: {
    readonly target: "production";
    readonly agentId: string;
    readonly agentRevision: string;
    readonly releaseId: string;
    readonly releaseRevision: string;
    readonly instructionsId: string;
    readonly instructionsRevision: string;
    readonly resolverRevision: string;
    readonly contentDigest: string;
    readonly blockCount: number;
  };
});

export const HELARC_AGENT_INSTRUCTIONS_BASELINE_ACCEPTANCE = deepFreeze({
  schemaVersion: 1,
  kind: "helarc_agent_instructions_baseline_successor_acceptance",
  acceptedAt: "2026-08-26T00:00:00.000Z",
  predecessorAcceptanceRef: HELARC_DELEGATION_TRANSFER_ACCEPTED_BASELINE.acceptanceRef,
  successorAcceptanceRef: ACCEPTANCE_REF,
  predecessorReportRef: HELARC_DELEGATION_TRANSFER_ACCEPTED_BASELINE.reportRef,
  successorReportRef: REPORT_REF,
  comparison: "intentionally_incomparable_exact_target",
  changedTargetInputs: Object.freeze([
    "product.revision",
    "agent.revision",
    "agent.instructions.release",
    "agent.instructions.resolver",
    "agent.instructions.digest",
    "target-adapter.revision",
    "source.revision",
    "fixture-manifest.revision",
    "expected-claims.revision",
  ]),
  outcomeQuality: "passed",
  safety: "passed",
  reliability: "deterministic_candidate_repeated_equivalently",
  trajectory:
    "The Product corpus preserves accepted outcomes, safety, latency, Retry, terminal behavior, and recursive delegation evidence while binding the exact production Agent Instructions snapshot into target identity.",
  coverage:
    "The successor records the resolved instruction release, resolver, content digest, section count, Agent revision, Product target manifest, and twenty paired deterministic Case executions.",
  limitations: "deterministic_system_case_only",
});

function agentInstructionsMetricResultRef(refValue: {
  readonly id: string;
  readonly revision: string;
}) {
  if (!refValue.id.endsWith(".delegation-transfer-baseline-result")) {
    throw new TypeError(`Unknown predecessor Metric result '${refValue.id}'.`);
  }
  return Object.freeze({
    id: refValue.id.replace(
      /\.delegation-transfer-baseline-result$/,
      ".agent-instructions-baseline-result",
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
  if (digest === undefined) throw new TypeError(`Unknown Agent Instructions Case '${key}'.`);
  return digest;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
