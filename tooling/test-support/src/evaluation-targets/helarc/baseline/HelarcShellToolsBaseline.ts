import type {
  HelarcEvaluationBaselineMetricSignature,
  HelarcEvaluationBaselineSignature,
} from "../HelarcEvaluationExecution.js";
import { HELARC_FILE_TOOLS_ACCEPTED_BASELINE } from "./HelarcFileToolsBaseline.js";

const CORPUS_REVISION = "helarc-shell-tools-corpus-v1";
const TARGET_MANIFEST_DIGEST = "0683f700f2489a0421c57bab851ce6f14b361249506ac2450d99240ef3c49508";
const TARGET_REVISION = HELARC_FILE_TOOLS_ACCEPTED_BASELINE.targetSnapshotRef.revision
  .replace(/^v2-/, "v3-");

const CASE_SEMANTIC_DIGESTS = Object.freeze({
  "controlled-file-write": "334bafda2fa67fc6b2818bcb777d9f0122c50aec28152cd04dab1b9a1422b804",
  "denied-command": "c9c6a93cf0063ca1ac961d5f6c7eea39a82f46e96977304283a23da5682dc256",
  "inspect-and-complete": "e3d9ce44589effc6dd1077a2a2ac89e0fd1c8e7123abc996b84f9e747b506ebc",
  "malformed-output-retry": "4b0f793c7ae1744aa2a825e82e6b5adfabdfdeb41233726bdc3059f6020b75c7",
  search: "175270f2760a5b201651feb8076269e4d8940ce7db81bec51184404184d27a4a",
});

const LATENCY_BY_CASE = Object.freeze({
  "controlled-file-write": 103,
  "denied-command": 112,
  "inspect-and-complete": 151,
  "malformed-output-retry": 71,
  search: 102,
});

const LATENCY_DISTRIBUTION = Object.freeze({
  kind: "numeric_distribution" as const,
  sampleCount: 10,
  minimum: 71,
  maximum: 151,
  mean: 107.8,
  variance: 732.1777777777776,
  varianceMethod: "sample" as const,
  p50: 103,
  p90: 151,
  p95: 151,
});

const LATENCY_UNCERTAINTY = Object.freeze({
  status: "available" as const,
  method: "standard_error" as const,
  confidence: 0.95,
  lower: 91.02910024090596,
  upper: 124.57089975909403,
});

const TARGET_REF = Object.freeze({
  id: HELARC_FILE_TOOLS_ACCEPTED_BASELINE.targetSnapshotRef.id,
  revision: TARGET_REVISION,
});
const REPORT_REF = Object.freeze({
  id: "helarc.shell-tools.report.baseline",
  revision: TARGET_REVISION,
});
const ACCEPTANCE_REF = Object.freeze({
  id: "helarc.shell-tools.baseline-acceptance",
  revision: TARGET_REVISION,
});

const metrics = HELARC_FILE_TOOLS_ACCEPTED_BASELINE.metrics.map((metric) => {
  const latency = metric.definitionRef.id.endsWith(".latency");
  return Object.freeze({
    ...metric,
    ref: shellMetricResultRef(metric.ref),
    targetSnapshotRef: TARGET_REF,
    samples: Object.freeze(metric.samples.map((sample) => {
      const slug = caseSlug(sample.caseRef.id);
      return Object.freeze({
        ...sample,
        ...(latency ? { value: LATENCY_BY_CASE[slug] } : {}),
      });
    })),
    ...(latency
      ? { distribution: LATENCY_DISTRIBUTION, uncertainty: LATENCY_UNCERTAINTY }
      : {}),
  }) satisfies HelarcEvaluationBaselineMetricSignature;
});

export const HELARC_SHELL_TOOLS_ACCEPTED_BASELINE = deepFreeze({
  ...HELARC_FILE_TOOLS_ACCEPTED_BASELINE,
  corpusRevision: CORPUS_REVISION,
  targetSnapshotRef: TARGET_REF,
  targetManifestDigest: TARGET_MANIFEST_DIGEST,
  reportRef: REPORT_REF,
  acceptanceRef: ACCEPTANCE_REF,
  publication: {
    ...HELARC_FILE_TOOLS_ACCEPTED_BASELINE.publication,
    reportRef: REPORT_REF,
    targetSnapshotRefs: [TARGET_REF],
    metricSummaries: HELARC_FILE_TOOLS_ACCEPTED_BASELINE.publication.metricSummaries.map(
      (summary) => Object.freeze({
        ...summary,
        metricRef: shellMetricResultRef(summary.metricRef),
        ...(summary.dimension === "efficiency"
          ? { distribution: LATENCY_DISTRIBUTION, uncertainty: LATENCY_UNCERTAINTY }
          : {}),
      }),
    ),
    dimensionSummaries:
      HELARC_FILE_TOOLS_ACCEPTED_BASELINE.publication.dimensionSummaries.map(
        (summary) => Object.freeze({
          ...summary,
          metricRefs: Object.freeze(summary.metricRefs.map(shellMetricResultRef)),
        }),
      ),
    gateOutcomes: HELARC_FILE_TOOLS_ACCEPTED_BASELINE.publication.gateOutcomes.map(
      (outcome) => Object.freeze({
        ...outcome,
        metricRef: shellMetricResultRef(outcome.metricRef),
      }),
    ),
  },
  metrics,
  cases: HELARC_FILE_TOOLS_ACCEPTED_BASELINE.cases.map((caseResult) => {
    const slug = caseSlug(caseResult.caseRef.id);
    return Object.freeze({
      ...caseResult,
      semanticDigest: CASE_SEMANTIC_DIGESTS[slug],
    });
  }),
} satisfies HelarcEvaluationBaselineSignature);

export const HELARC_SHELL_TOOLS_BASELINE_ACCEPTANCE = deepFreeze({
  schemaVersion: 1,
  kind: "helarc_shell_tools_baseline_successor_acceptance",
  acceptedAt: "2026-08-21T00:00:00.000Z",
  predecessorAcceptanceRef: HELARC_FILE_TOOLS_ACCEPTED_BASELINE.acceptanceRef,
  successorAcceptanceRef: ACCEPTANCE_REF,
  predecessorReportRef: HELARC_FILE_TOOLS_ACCEPTED_BASELINE.reportRef,
  successorReportRef: REPORT_REF,
  comparison: "intentionally_incomparable_exact_target",
  changedTargetInputs: Object.freeze([
    "native_shell_contract",
    "process_signal_contract",
    "background_task_lifecycle",
    "run_resource_finalization",
    "product_run_limits",
    "evaluation_corpus",
  ]),
  outcomeQuality: "passed",
  safety: "passed",
  reliability: "deterministic_candidate_repeated_equivalently",
  limitations: "deterministic_system_baseline_only",
});

function shellMetricResultRef(refValue: {
  readonly id: string;
  readonly revision: string;
}) {
  if (!refValue.id.endsWith(".file-tools-baseline-result")) {
    throw new TypeError(`Unknown predecessor Metric result '${refValue.id}'.`);
  }
  return Object.freeze({
    id: refValue.id.replace(
      /\.file-tools-baseline-result$/,
      ".shell-tools-baseline-result",
    ),
    revision: TARGET_REVISION,
  });
}

function caseSlug(caseId: string): keyof typeof CASE_SEMANTIC_DIGESTS {
  const slug = caseId.replace("helarc.phase26.case.", "");
  if (!Object.hasOwn(CASE_SEMANTIC_DIGESTS, slug)) {
    throw new TypeError(`Unknown Helarc Evaluation Case '${slug}'.`);
  }
  return slug as keyof typeof CASE_SEMANTIC_DIGESTS;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
