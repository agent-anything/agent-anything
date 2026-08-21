import type {
  HelarcEvaluationBaselineMetricSignature,
  HelarcEvaluationBaselineSignature,
} from "../HelarcEvaluationExecution.js";
import { HELARC_VALIDATION_PROFILE_ACCEPTED_BASELINE } from "./HelarcValidationProfileBaseline.js";

const CORPUS_REVISION = "helarc-file-tools-corpus-v1";
const TARGET_MANIFEST_DIGEST = "df55fd0e938c2c558da3f9b8067792727266716aac830b8e590e11af6f462ab7";

const CASE_SEMANTIC_DIGESTS = Object.freeze({
  "controlled-file-write": "d4930231c0218951063e2ab29f80359a431b83c130c5176810dee62766087fef",
  "denied-command": "7bd02f8df91adeba76308293d32aaeeb06d8ac0eca70b266c0f47028d85f4a79",
  "inspect-and-complete": "b9286e7a976a614ab98d67655a4de0768d64a5f90251ed9f0e359a6f6e6bcc85",
  "malformed-output-retry": "3f90a7d9e795640dd5dd940d92614d34a557fac271761001fa1e6d3126bd1969",
  search: "9207506bebec56b3ed8ecbaaf5ea1a24379a9bc59032b053f2e2d7fefae07ee9",
});

const LATENCY_BY_CASE = Object.freeze({
  "controlled-file-write": 98,
  "denied-command": 112,
  "inspect-and-complete": 146,
  "malformed-output-retry": 66,
  search: 97,
});

const LATENCY_DISTRIBUTION = Object.freeze({
  kind: "numeric_distribution" as const,
  sampleCount: 10,
  minimum: 66,
  maximum: 146,
  mean: 103.8,
  variance: 745.9555555555555,
  varianceMethod: "sample" as const,
  p50: 98,
  p90: 146,
  p95: 146,
});

const LATENCY_UNCERTAINTY = Object.freeze({
  status: "available" as const,
  method: "standard_error" as const,
  confidence: 0.95,
  lower: 86.87204219831833,
  upper: 120.72795780168167,
});

const REPORT_REF = Object.freeze({
  id: "helarc.file-tools.report.baseline",
  revision: HELARC_VALIDATION_PROFILE_ACCEPTED_BASELINE.targetSnapshotRef.revision,
});
const ACCEPTANCE_REF = Object.freeze({
  id: "helarc.file-tools.baseline-acceptance",
  revision: HELARC_VALIDATION_PROFILE_ACCEPTED_BASELINE.targetSnapshotRef.revision,
});

const metrics = HELARC_VALIDATION_PROFILE_ACCEPTED_BASELINE.metrics.map((metric) => {
  const latency = metric.definitionRef.id.endsWith(".latency");
  return Object.freeze({
    ...metric,
    ref: fileToolsMetricResultRef(metric.ref),
    samples: Object.freeze(metric.samples.map((sample) => {
      const slug = normalizeCaseSlug(caseSlug(sample.caseRef.id));
      return Object.freeze({
        ...sample,
        caseRef: caseRef(slug),
        pairingKey: sample.pairingKey.replace("controlled-patch", "controlled-file-write"),
        ...(latency ? { value: LATENCY_BY_CASE[slug] } : {}),
      });
    })),
    ...(latency
      ? { distribution: LATENCY_DISTRIBUTION, uncertainty: LATENCY_UNCERTAINTY }
      : {}),
  }) satisfies HelarcEvaluationBaselineMetricSignature;
});

export const HELARC_FILE_TOOLS_ACCEPTED_BASELINE = deepFreeze({
  ...HELARC_VALIDATION_PROFILE_ACCEPTED_BASELINE,
  corpusRevision: CORPUS_REVISION,
  targetManifestDigest: TARGET_MANIFEST_DIGEST,
  reportRef: REPORT_REF,
  acceptanceRef: ACCEPTANCE_REF,
  publication: {
    ...HELARC_VALIDATION_PROFILE_ACCEPTED_BASELINE.publication,
    reportRef: REPORT_REF,
    metricSummaries: HELARC_VALIDATION_PROFILE_ACCEPTED_BASELINE.publication.metricSummaries.map(
      (summary) => Object.freeze({
        ...summary,
        metricRef: fileToolsMetricResultRef(summary.metricRef),
        ...(summary.dimension === "efficiency"
          ? { distribution: LATENCY_DISTRIBUTION, uncertainty: LATENCY_UNCERTAINTY }
          : {}),
      }),
    ),
    dimensionSummaries:
      HELARC_VALIDATION_PROFILE_ACCEPTED_BASELINE.publication.dimensionSummaries.map(
        (summary) => Object.freeze({
          ...summary,
          metricRefs: Object.freeze(summary.metricRefs.map(fileToolsMetricResultRef)),
        }),
      ),
    gateOutcomes: HELARC_VALIDATION_PROFILE_ACCEPTED_BASELINE.publication.gateOutcomes.map(
      (outcome) => Object.freeze({
        ...outcome,
        metricRef: fileToolsMetricResultRef(outcome.metricRef),
      }),
    ),
  },
  metrics,
  cases: HELARC_VALIDATION_PROFILE_ACCEPTED_BASELINE.cases.map((caseResult) => {
    const slug = normalizeCaseSlug(caseSlug(caseResult.caseRef.id));
    return Object.freeze({
      ...caseResult,
      caseRef: caseRef(slug),
      semanticDigest: CASE_SEMANTIC_DIGESTS[slug],
    });
  }),
} satisfies HelarcEvaluationBaselineSignature);

export const HELARC_FILE_TOOLS_BASELINE_ACCEPTANCE = deepFreeze({
  schemaVersion: 1,
  kind: "helarc_file_tools_baseline_successor_acceptance",
  acceptedAt: "2026-08-21T00:00:00.000Z",
  predecessorAcceptanceRef: HELARC_VALIDATION_PROFILE_ACCEPTED_BASELINE.acceptanceRef,
  successorAcceptanceRef: ACCEPTANCE_REF,
  predecessorReportRef: HELARC_VALIDATION_PROFILE_ACCEPTED_BASELINE.reportRef,
  successorReportRef: REPORT_REF,
  comparison: "intentionally_incomparable_exact_target",
  changedTargetInputs: Object.freeze([
    "model_decision_contract",
    "tool_catalog",
    "file_operation_contracts",
    "file_mutation_execution_path",
    "evaluation_corpus",
  ]),
  outcomeQuality: "passed",
  safety: "passed",
  reliability: "deterministic_candidate_repeated_equivalently",
  limitations: "deterministic_system_baseline_only",
});

function fileToolsMetricResultRef(refValue: {
  readonly id: string;
  readonly revision: string;
}) {
  if (!refValue.id.endsWith(".validation-profile-baseline-result")) {
    throw new TypeError(`Unknown predecessor Metric result '${refValue.id}'.`);
  }
  return Object.freeze({
    id: refValue.id.replace(
      /\.validation-profile-baseline-result$/,
      ".file-tools-baseline-result",
    ),
    revision: refValue.revision,
  });
}

function normalizeCaseSlug(slug: string): keyof typeof CASE_SEMANTIC_DIGESTS {
  const normalized = slug === "controlled-patch" ? "controlled-file-write" : slug;
  if (!Object.hasOwn(CASE_SEMANTIC_DIGESTS, normalized)) {
    throw new TypeError(`Unknown Helarc Evaluation Case '${slug}'.`);
  }
  return normalized as keyof typeof CASE_SEMANTIC_DIGESTS;
}

function caseSlug(caseId: string): string {
  return caseId.replace("helarc.phase26.case.", "");
}

function caseRef(slug: string) {
  return Object.freeze({ id: `helarc.phase26.case.${slug}`, revision: "v1" });
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
