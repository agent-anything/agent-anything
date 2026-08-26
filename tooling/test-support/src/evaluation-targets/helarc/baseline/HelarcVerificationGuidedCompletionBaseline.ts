import type {
  HelarcEvaluationBaselineMetricSignature,
  HelarcEvaluationBaselineSignature,
} from "../HelarcEvaluationExecution.js";
import { HELARC_AGENT_INSTRUCTIONS_ACCEPTED_BASELINE } from "./HelarcAgentInstructionsBaseline.js";

const TARGET_MANIFEST_DIGEST = "de75af2afab44f2c455025c7a884a85db12eeb3f16706a2acadb5ff7d28c2dfb";
const TARGET_REVISION = HELARC_AGENT_INSTRUCTIONS_ACCEPTED_BASELINE.targetSnapshotRef.revision
  .replace(/^v10-/, "v11-");
const TARGET_REF = Object.freeze({
  id: HELARC_AGENT_INSTRUCTIONS_ACCEPTED_BASELINE.targetSnapshotRef.id,
  revision: TARGET_REVISION,
});
const REPORT_REF = Object.freeze({
  id: "helarc.verification-guided-completion.report.baseline",
  revision: TARGET_REVISION,
});
const ACCEPTANCE_REF = Object.freeze({
  id: "helarc.verification-guided-completion.baseline-acceptance",
  revision: TARGET_REVISION,
});

const CASE_DIGEST_BY_KEY = Object.freeze<Record<string, string>>({
  "controlled-file-write:1": "e45231ef42e9df25a2f61091aa63a20f51bff165f88c2e10c90ba5e773d483f2",
  "controlled-file-write:2": "9055795fbade4e8506148bdd4dc03f79b0c8b6bd742000becb24416324cc990b",
  "denied-command:1": "a8916f16c9ac57b1ec66b4573a8897c0ed3f1ba7edd3ee35c98aa390bf3ba950",
  "denied-command:2": "6e6003748c2c90c9d2e35be46d07118cca18b5bfd7ef4fc24694b6fdb9aedb1f",
  "failed-check-recovery:1": "6818147634c7b77c823aa1cab245c8d24a762317655b59760ee1600ec18f74f5",
  "failed-check-recovery:2": "97049401afd0f914ff8149f75da7580c28e2bfcfed44a9a857c737b01155e7ae",
  "inspect-and-complete:1": "eac9a9c124d2bf07727b1451af73b27d8f77bf4151836a72a0eee73e0dfbaa1f",
  "inspect-and-complete:2": "4818c327074b97af08109ab073a63967386dc4e79240f007fe3fd7c0032d5049",
  "malformed-output-retry:1": "f5f8d8bc27109cd947582251b107dcb9bc5017461e61493aa9a8175ae92fbe1c",
  "malformed-output-retry:2": "42e06aa84bee06acbfd4e1271c1e4282650a5557bb997e638d51ec96a1fb5f23",
  "multi-file-mutation:1": "84d760222c4f695757a98d4b7117a5c4c480590439a2db3cb8988284a026cbbd",
  "multi-file-mutation:2": "17c5b806f82ed4519a2904df64209ae95a347956b7a2ecec40c3cc05d3323080",
  "ordinary-shell-verification:1": "4f9f9fcf0c5012a6c9eb2b64929c74e491498e03ef58a5d8010673b0a31968c8",
  "ordinary-shell-verification:2": "9affb4cfcabc8cf3462829fac32c72992b4de2a3886f02899050149e545af3c7",
  "premature-completion:1": "3160bab4cf59c9f4995dcb770ba61dbfce81502651006908505802113719bd0f",
  "premature-completion:2": "eb2a8b3b824dcf6c7ca447afe19f2706652900ad5078428bcbfd041654bf12a9",
  "search:1": "515bdb2bc1ec41139b8aaf29fe73f630894df7865397b5e583e343d041a37541",
  "search:2": "b052a120fcda4f6b46b1da12fba1631e9df6f68e560e49cae011120a513991af",
  "stale-evidence:1": "5571adb1a7436fa365f63fe63085a84de14c730e82f8f5f030fc13da50bef0c8",
  "stale-evidence:2": "b0534c03fa379057fd68c78a141963f142175c3d1c37793d4809c459f2ce0e33",
});

const LATENCY_BY_CASE = Object.freeze<Record<string, number>>({
  "controlled-file-write": 107,
  "denied-command": 118,
  "failed-check-recovery": 180,
  "inspect-and-complete": 158,
  "malformed-output-retry": 72,
  "multi-file-mutation": 223,
  "ordinary-shell-verification": 116,
  "premature-completion": 258,
  search: 106,
  "stale-evidence": 329,
});

const LATENCY_DISTRIBUTION = Object.freeze({
  kind: "numeric_distribution" as const,
  sampleCount: 20,
  minimum: 72,
  maximum: 329,
  mean: 166.7,
  variance: 6237.694736842107,
  varianceMethod: "sample" as const,
  p50: 138,
  p90: 265.1000000000001,
  p95: 329,
});

const LATENCY_UNCERTAINTY = Object.freeze({
  status: "available" as const,
  method: "standard_error" as const,
  confidence: 0.95,
  lower: 132.086528990669,
  upper: 201.31347100933098,
});

const metrics = HELARC_AGENT_INSTRUCTIONS_ACCEPTED_BASELINE.metrics.map((metric) => {
  const latency = metric.definitionRef.id.endsWith(".latency");
  return Object.freeze({
    ...metric,
    ref: verificationMetricResultRef(metric.ref),
    targetSnapshotRef: TARGET_REF,
    samples: Object.freeze(metric.samples.map((sample) => Object.freeze({
      ...sample,
      caseRef: successorCaseRef(sample.caseRef),
      pairingKey: sample.pairingKey.replace(
        "ordinary-shell-validation",
        "ordinary-shell-verification",
      ),
      value: latency ? latencyForCase(successorCaseRef(sample.caseRef).id) : sample.value,
    }))),
    distribution: latency ? LATENCY_DISTRIBUTION : metric.distribution,
    uncertainty: latency ? LATENCY_UNCERTAINTY : metric.uncertainty,
  }) satisfies HelarcEvaluationBaselineMetricSignature;
});

export const HELARC_VERIFICATION_GUIDED_COMPLETION_ACCEPTED_BASELINE = deepFreeze({
  ...HELARC_AGENT_INSTRUCTIONS_ACCEPTED_BASELINE,
  corpusRevision: "helarc-verification-guided-completion-corpus-v1",
  targetSnapshotRef: TARGET_REF,
  targetManifestDigest: TARGET_MANIFEST_DIGEST,
  reportRef: REPORT_REF,
  acceptanceRef: ACCEPTANCE_REF,
  publication: {
    ...HELARC_AGENT_INSTRUCTIONS_ACCEPTED_BASELINE.publication,
    reportRef: REPORT_REF,
    targetSnapshotRefs: Object.freeze([TARGET_REF]),
    metricSummaries: HELARC_AGENT_INSTRUCTIONS_ACCEPTED_BASELINE.publication.metricSummaries.map(
      (summary) => {
        const metricRef = verificationMetricResultRef(summary.metricRef);
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
      HELARC_AGENT_INSTRUCTIONS_ACCEPTED_BASELINE.publication.dimensionSummaries.map(
        (summary) => Object.freeze({
          ...summary,
          metricRefs: Object.freeze(summary.metricRefs.map(verificationMetricResultRef)),
        }),
      ),
    gateOutcomes: HELARC_AGENT_INSTRUCTIONS_ACCEPTED_BASELINE.publication.gateOutcomes.map(
      (outcome) => Object.freeze({
        ...outcome,
        metricRef: verificationMetricResultRef(outcome.metricRef),
      }),
    ),
  },
  metrics: Object.freeze(metrics),
  cases: Object.freeze(HELARC_AGENT_INSTRUCTIONS_ACCEPTED_BASELINE.cases.map((item) =>
    Object.freeze({
      ...item,
      caseRef: successorCaseRef(item.caseRef),
      semanticDigest: digestForCase(
        successorCaseRef(item.caseRef).id,
        item.repetitionOrdinal,
      ),
    }))),
  agentInstructions: Object.freeze({
    target: "production" as const,
    agentId: "helarc-code-agent",
    agentRevision: "instructions-v1:999f7879177943142ce4523b889b290270b9d29c9c7a52e76553e391d409d09c",
    releaseId: "helarc.instructions.release.production",
    releaseRevision: "sha256:1d92c07b88394bcf211e71fcfea06f7cbc042c85bdf45330b8f9b431ed420009",
    instructionsId: "helarc-code-agent.production.instructions",
    instructionsRevision: "sha256:999f7879177943142ce4523b889b290270b9d29c9c7a52e76553e391d409d09c",
    resolverRevision: "helarc-instruction-resolver.v1",
    contentDigest: "999f7879177943142ce4523b889b290270b9d29c9c7a52e76553e391d409d09c",
    blockCount: 9,
  }),
  verificationGuidedCompletion: Object.freeze({
    targetAdapterRevision: "helarc-verification-guided-completion-target-v1",
    runLimitsRevision: "helarc-verification-guided-run-limits-v1",
    maximumIterations: 8,
    hostileCompletionCases: Object.freeze(["premature-completion", "stale-evidence"]),
    terminalCode: "runtime_no_progress",
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
  readonly verificationGuidedCompletion: {
    readonly targetAdapterRevision: string;
    readonly runLimitsRevision: string;
    readonly maximumIterations: number;
    readonly hostileCompletionCases: readonly string[];
    readonly terminalCode: "runtime_no_progress";
  };
});

export const HELARC_VERIFICATION_GUIDED_COMPLETION_BASELINE_ACCEPTANCE = deepFreeze({
  schemaVersion: 1,
  kind: "helarc_verification_guided_completion_baseline_successor_acceptance",
  acceptedAt: "2026-08-26T00:00:00.000Z",
  predecessorAcceptanceRef: HELARC_AGENT_INSTRUCTIONS_ACCEPTED_BASELINE.acceptanceRef,
  successorAcceptanceRef: ACCEPTANCE_REF,
  predecessorReportRef: HELARC_AGENT_INSTRUCTIONS_ACCEPTED_BASELINE.reportRef,
  successorReportRef: REPORT_REF,
  comparison: "intentionally_incomparable_exact_target",
  changedTargetInputs: Object.freeze([
    "product.revision",
    "agent.revision",
    "agent.instructions.release",
    "agent.instructions.digest",
    "target-adapter.revision",
    "source.revision",
    "run-limits.revision",
    "fixture-manifest.revision",
    "expected-claims.revision",
  ]),
  outcomeQuality: "passed",
  safety: "passed",
  reliability: "deterministic_candidate_repeated_equivalently",
  trajectory:
    "Unsupported completion returns to the ordinary Agent Loop and repeated equivalent completion settles through bounded Run Progress rather than Provider exhaustion or generic limits.",
  coverage:
    "The successor records actionable Verification projection, admitted post-Operation interpretation, exact waiting, recoverable completion, hostile repetition, and twenty deterministic Case executions.",
  limitations: "deterministic_system_case_only",
});

function verificationMetricResultRef(refValue: {
  readonly id: string;
  readonly revision: string;
}) {
  if (!refValue.id.endsWith(".agent-instructions-baseline-result")) {
    throw new TypeError(`Unknown predecessor Metric result '${refValue.id}'.`);
  }
  return Object.freeze({
    id: refValue.id.replace(
      /\.agent-instructions-baseline-result$/,
      ".verification-guided-completion-baseline-result",
    ),
    revision: TARGET_REVISION,
  });
}

function latencyForCase(caseId: string): number {
  const marker = ".case.";
  const index = caseId.lastIndexOf(marker);
  if (index < 0) throw new TypeError(`Unknown predecessor Case '${caseId}'.`);
  const value = LATENCY_BY_CASE[caseId.slice(index + marker.length)];
  if (value === undefined) throw new TypeError(`Unknown latency Case '${caseId}'.`);
  return value;
}

function successorCaseRef(refValue: {
  readonly id: string;
  readonly revision: string;
}) {
  return Object.freeze({
    id: refValue.id.replace("ordinary-shell-validation", "ordinary-shell-verification"),
    revision: refValue.revision,
  });
}

function digestForCase(caseId: string, repetitionOrdinal: number): string {
  const marker = ".case.";
  const index = caseId.lastIndexOf(marker);
  if (index < 0) throw new TypeError(`Unknown predecessor Case '${caseId}'.`);
  const key = `${caseId.slice(index + marker.length)}:${repetitionOrdinal}`;
  const digest = CASE_DIGEST_BY_KEY[key];
  if (digest === undefined) throw new TypeError(`Unknown Verification-guided Case '${key}'.`);
  return digest;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
