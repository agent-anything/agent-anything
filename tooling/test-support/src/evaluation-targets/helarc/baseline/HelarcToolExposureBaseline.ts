import type {
  HelarcEvaluationBaselineMetricSignature,
  HelarcEvaluationBaselineSignature,
} from "../HelarcEvaluationExecution.js";
import { HELARC_SHELL_TOOLS_ACCEPTED_BASELINE } from "./HelarcShellToolsBaseline.js";

const TARGET_MANIFEST_DIGEST = "54aef9d15a07ead473c18483afb64417dd6b397ece73027f147433ed648fefff";
const TARGET_REVISION = HELARC_SHELL_TOOLS_ACCEPTED_BASELINE.targetSnapshotRef.revision
  .replace(/^v3-/, "v4-");

const TARGET_REF = Object.freeze({
  id: HELARC_SHELL_TOOLS_ACCEPTED_BASELINE.targetSnapshotRef.id,
  revision: TARGET_REVISION,
});
const REPORT_REF = Object.freeze({
  id: "helarc.tool-exposure.report.baseline",
  revision: TARGET_REVISION,
});
const ACCEPTANCE_REF = Object.freeze({
  id: "helarc.tool-exposure.baseline-acceptance",
  revision: TARGET_REVISION,
});

const metrics = HELARC_SHELL_TOOLS_ACCEPTED_BASELINE.metrics.map((metric) =>
  Object.freeze({
    ...metric,
    ref: toolExposureMetricResultRef(metric.ref),
    targetSnapshotRef: TARGET_REF,
  }) satisfies HelarcEvaluationBaselineMetricSignature
);

export const HELARC_TOOL_EXPOSURE_ACCEPTED_BASELINE = deepFreeze({
  ...HELARC_SHELL_TOOLS_ACCEPTED_BASELINE,
  targetSnapshotRef: TARGET_REF,
  targetManifestDigest: TARGET_MANIFEST_DIGEST,
  reportRef: REPORT_REF,
  acceptanceRef: ACCEPTANCE_REF,
  publication: {
    ...HELARC_SHELL_TOOLS_ACCEPTED_BASELINE.publication,
    reportRef: REPORT_REF,
    targetSnapshotRefs: [TARGET_REF],
    metricSummaries: HELARC_SHELL_TOOLS_ACCEPTED_BASELINE.publication.metricSummaries.map(
      (summary) => Object.freeze({
        ...summary,
        metricRef: toolExposureMetricResultRef(summary.metricRef),
      }),
    ),
    dimensionSummaries:
      HELARC_SHELL_TOOLS_ACCEPTED_BASELINE.publication.dimensionSummaries.map(
        (summary) => Object.freeze({
          ...summary,
          metricRefs: Object.freeze(summary.metricRefs.map(toolExposureMetricResultRef)),
        }),
      ),
    gateOutcomes: HELARC_SHELL_TOOLS_ACCEPTED_BASELINE.publication.gateOutcomes.map(
      (outcome) => Object.freeze({
        ...outcome,
        metricRef: toolExposureMetricResultRef(outcome.metricRef),
      }),
    ),
  },
  metrics,
} satisfies HelarcEvaluationBaselineSignature);

export const HELARC_TOOL_EXPOSURE_BASELINE_ACCEPTANCE = deepFreeze({
  schemaVersion: 1,
  kind: "helarc_tool_exposure_baseline_successor_acceptance",
  acceptedAt: "2026-08-21T00:00:00.000Z",
  predecessorAcceptanceRef: HELARC_SHELL_TOOLS_ACCEPTED_BASELINE.acceptanceRef,
  successorAcceptanceRef: ACCEPTANCE_REF,
  predecessorReportRef: HELARC_SHELL_TOOLS_ACCEPTED_BASELINE.reportRef,
  successorReportRef: REPORT_REF,
  comparison: "intentionally_incomparable_exact_target",
  changedTargetInputs: Object.freeze([
    "product.revision",
    "agent.revision",
    "prompt.revision",
    "target-adapter.revision",
    "source.revision",
    "tool-profile.revision",
  ]),
  outcomeQuality: "passed",
  safety: "passed",
  reliability: "deterministic_candidate_repeated_equivalently",
  coverage:
    "The unchanged deterministic Suite proves regression behavior only; focused tests own clarification and descendant-Agent coverage.",
  limitations: "deterministic_system_baseline_only",
});

function toolExposureMetricResultRef(refValue: {
  readonly id: string;
  readonly revision: string;
}) {
  if (!refValue.id.endsWith(".shell-tools-baseline-result")) {
    throw new TypeError(`Unknown predecessor Metric result '${refValue.id}'.`);
  }
  return Object.freeze({
    id: refValue.id.replace(
      /\.shell-tools-baseline-result$/,
      ".tool-exposure-baseline-result",
    ),
    revision: TARGET_REVISION,
  });
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
