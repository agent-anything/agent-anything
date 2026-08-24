import { describe, expect, it } from "vitest";
import { HELARC_DETERMINISTIC_SYSTEM_ACCEPTED_BASELINE } from "./baseline/HelarcDeterministicSystemBaseline.js";
import {
  HELARC_CONTEXT_CONTINUITY_ACCEPTED_BASELINE,
} from "./baseline/HelarcContextContinuityBaseline.js";
import {
  HELARC_VALIDATION_GATE_ACCEPTED_BASELINE,
  HELARC_VALIDATION_GATE_BASELINE_ACCEPTANCE,
} from "./baseline/HelarcValidationGateBaseline.js";
import {
  HELARC_VALIDATION_PROFILE_ACCEPTED_BASELINE,
  HELARC_VALIDATION_PROFILE_BASELINE_ACCEPTANCE,
} from "./baseline/HelarcValidationProfileBaseline.js";
import {
  HELARC_FILE_TOOLS_ACCEPTED_BASELINE,
  HELARC_FILE_TOOLS_BASELINE_ACCEPTANCE,
} from "./baseline/HelarcFileToolsBaseline.js";
import {
  HELARC_SHELL_TOOLS_ACCEPTED_BASELINE,
  HELARC_SHELL_TOOLS_BASELINE_ACCEPTANCE,
} from "./baseline/HelarcShellToolsBaseline.js";
import {
  HELARC_TOOL_EXPOSURE_ACCEPTED_BASELINE,
  HELARC_TOOL_EXPOSURE_BASELINE_ACCEPTANCE,
} from "./baseline/HelarcToolExposureBaseline.js";
import {
  HELARC_VALIDATION_COMPLETION_ACCEPTED_BASELINE,
  HELARC_VALIDATION_COMPLETION_BASELINE_ACCEPTANCE,
} from "./baseline/HelarcValidationCompletionBaseline.js";
import {
  HELARC_RUN_TREE_CONTROL_ACCEPTED_BASELINE,
  HELARC_RUN_TREE_CONTROL_BASELINE_ACCEPTANCE,
} from "./baseline/HelarcRunTreeControlBaseline.js";
import {
  HELARC_RUN_PROGRESS_ACCEPTED_BASELINE,
  HELARC_RUN_PROGRESS_BASELINE_ACCEPTANCE,
} from "./baseline/HelarcRunProgressBaseline.js";
import {
  compareHelarcEvaluationBaseline,
  projectHelarcEvaluationBaselineSignature,
  runHelarcEvaluationBaselineCandidate,
  type HelarcEvaluationBaselineSignature,
} from "./HelarcEvaluationExecution.js";

describe("Helarc accepted Evaluation baseline succession", () => {
  it("preserves accepted history and proves the Run Progress baseline successor", async () => {
    const baselines = [
      HELARC_DETERMINISTIC_SYSTEM_ACCEPTED_BASELINE,
      HELARC_CONTEXT_CONTINUITY_ACCEPTED_BASELINE,
      HELARC_VALIDATION_GATE_ACCEPTED_BASELINE,
      HELARC_VALIDATION_PROFILE_ACCEPTED_BASELINE,
      HELARC_FILE_TOOLS_ACCEPTED_BASELINE,
      HELARC_SHELL_TOOLS_ACCEPTED_BASELINE,
      HELARC_TOOL_EXPOSURE_ACCEPTED_BASELINE,
      HELARC_VALIDATION_COMPLETION_ACCEPTED_BASELINE,
      HELARC_RUN_TREE_CONTROL_ACCEPTED_BASELINE,
      HELARC_RUN_PROGRESS_ACCEPTED_BASELINE,
    ];
    const historyBefore = baselines.map((baseline) => JSON.stringify(baseline));
    const candidate = await runHelarcEvaluationBaselineCandidate();
    const predecessorComparison = compareHelarcEvaluationBaseline(
      HELARC_RUN_TREE_CONTROL_ACCEPTED_BASELINE,
      candidate,
    );
    const acceptedComparison = compareHelarcEvaluationBaseline(
      HELARC_RUN_PROGRESS_ACCEPTED_BASELINE,
      candidate,
    );

    expect(predecessorComparison).toMatchObject({
      status: "incomparable",
      differences: ["target_snapshot_ref", "target_manifest"],
    });
    expect(acceptedComparison.status).toBe("equivalent");
    expect(acceptedComparison.pairedComparisons).toHaveLength(4);
    expect(acceptedComparison.pairedComparisons.every((item) =>
      item.pairs.length === 20 && item.exclusions.length === 0)).toBe(true);
    expect(candidate.publication.gateOutcomes.map((item) => [item.dimension, item.status])).toEqual([
      ["outcome_quality", "passed"],
      ["safety", "passed"],
    ]);
    expect(candidate.cases.every(({ traceIssueCodes }) => traceIssueCodes.length === 0)).toBe(true);
    expect(baselines.map((baseline) => JSON.stringify(baseline))).toEqual(historyBefore);
    expect(candidate.report.ref).toEqual(HELARC_RUN_PROGRESS_ACCEPTED_BASELINE.reportRef);
    expect(candidate.acceptance.ref).toEqual(HELARC_RUN_PROGRESS_ACCEPTED_BASELINE.acceptanceRef);
    expect(candidate.report.supersedes)
      .toEqual(HELARC_RUN_TREE_CONTROL_ACCEPTED_BASELINE.reportRef);
    expect(candidate.acceptance.supersedes)
      .toEqual(HELARC_RUN_TREE_CONTROL_ACCEPTED_BASELINE.acceptanceRef);
    expect(candidate.metrics.map(({ ref }) => ref)).toEqual(
      HELARC_RUN_PROGRESS_ACCEPTED_BASELINE.metrics.map(({ ref }) => ref),
    );
    expect(HELARC_VALIDATION_GATE_BASELINE_ACCEPTANCE.predecessorReportRef)
      .toEqual(HELARC_CONTEXT_CONTINUITY_ACCEPTED_BASELINE.reportRef);
    expect(HELARC_VALIDATION_PROFILE_BASELINE_ACCEPTANCE.predecessorReportRef)
      .toEqual(HELARC_VALIDATION_GATE_ACCEPTED_BASELINE.reportRef);
    expect(HELARC_FILE_TOOLS_BASELINE_ACCEPTANCE.predecessorReportRef)
      .toEqual(HELARC_VALIDATION_PROFILE_ACCEPTED_BASELINE.reportRef);
    expect(HELARC_SHELL_TOOLS_BASELINE_ACCEPTANCE.predecessorReportRef)
      .toEqual(HELARC_FILE_TOOLS_ACCEPTED_BASELINE.reportRef);
    expect(HELARC_TOOL_EXPOSURE_BASELINE_ACCEPTANCE.predecessorReportRef)
      .toEqual(HELARC_SHELL_TOOLS_ACCEPTED_BASELINE.reportRef);
    expect(HELARC_VALIDATION_COMPLETION_BASELINE_ACCEPTANCE.predecessorReportRef)
      .toEqual(HELARC_TOOL_EXPOSURE_ACCEPTED_BASELINE.reportRef);
    expect(HELARC_RUN_TREE_CONTROL_BASELINE_ACCEPTANCE.predecessorReportRef)
      .toEqual(HELARC_VALIDATION_COMPLETION_ACCEPTED_BASELINE.reportRef);
    expect(HELARC_RUN_PROGRESS_BASELINE_ACCEPTANCE.predecessorReportRef)
      .toEqual(HELARC_RUN_TREE_CONTROL_ACCEPTED_BASELINE.reportRef);
    expect(Object.isFrozen(HELARC_VALIDATION_COMPLETION_ACCEPTED_BASELINE)).toBe(true);
    expect(Object.isFrozen(HELARC_RUN_TREE_CONTROL_ACCEPTED_BASELINE)).toBe(true);
    expect(Object.isFrozen(HELARC_RUN_PROGRESS_ACCEPTED_BASELINE)).toBe(true);
  }, 120_000);

  it("reports a safety regression even when paired latency improves", () => {
    const improvedLatencyAndUnsafe = changeAcceptedBaselineForRegression();
    const comparison = compareHelarcEvaluationBaseline(
      HELARC_RUN_PROGRESS_ACCEPTED_BASELINE,
      improvedLatencyAndUnsafe,
    );

    expect(comparison.status).toBe("regressed");
    if (comparison.status !== "regressed") return;
    expect(comparison.differences).toContain("gate:safety:failed");
    const latencyIndex = HELARC_RUN_PROGRESS_ACCEPTED_BASELINE.metrics.findIndex(
      (metric) => metric.definitionRef.id.endsWith(".latency"),
    );
    const latency = comparison.pairedComparisons[latencyIndex];
    expect(latency?.pairs.every((pair) => pair.difference < 0)).toBe(true);
  });
});

function changeAcceptedBaselineForRegression(): HelarcEvaluationBaselineSignature {
  const baseline = projectHelarcEvaluationBaselineSignature(
    HELARC_RUN_PROGRESS_ACCEPTED_BASELINE,
  );
  return Object.freeze({
    ...baseline,
    publication: Object.freeze({
      ...baseline.publication,
      gateOutcomes: Object.freeze(baseline.publication.gateOutcomes.map((gate) =>
        gate.dimension === "safety"
          ? Object.freeze({
              ...gate,
              status: "failed" as const,
              observedValue: 0,
              reason: "Synthetic regression fixture does not satisfy the safety gate.",
            })
          : gate)),
    }),
    metrics: Object.freeze(baseline.metrics.map((metric) =>
      metric.definitionRef.id.endsWith(".latency")
        ? Object.freeze({
            ...metric,
            samples: Object.freeze(metric.samples.map((sample) => Object.freeze({
              ...sample,
              value: Math.max(0, Number(sample.value) - 1),
            }))),
          })
        : metric)),
  });
}
