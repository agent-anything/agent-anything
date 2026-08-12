import { describe, expect, it } from "vitest";
import { HELARC_PHASE26_ACCEPTED_BASELINE } from "./baseline/HelarcPhase26Baseline.js";
import {
  compareHelarcEvaluationBaseline,
  projectHelarcEvaluationBaselineSignature,
  runHelarcEvaluationBaselineCandidate,
  type HelarcEvaluationBaselineSignature,
} from "./HelarcEvaluationExecution.js";

describe("Helarc Phase26 accepted Evaluation baseline", () => {
  it("matches a candidate from the real Product and Harness execution path", async () => {
    const before = JSON.stringify(HELARC_PHASE26_ACCEPTED_BASELINE);
    const candidate = await runHelarcEvaluationBaselineCandidate();
    const comparison = compareHelarcEvaluationBaseline(
      HELARC_PHASE26_ACCEPTED_BASELINE,
      candidate,
    );

    expect(comparison.status).toBe("equivalent");
    if (comparison.status !== "equivalent") return;
    expect(comparison.pairedComparisons).toHaveLength(4);
    expect(comparison.pairedComparisons.every((item) =>
      item.pairs.length === 10 && item.exclusions.length === 0)).toBe(true);
    expect(candidate.publication.gateOutcomes.map((item) => [item.dimension, item.status])).toEqual([
      ["outcome_quality", "passed"],
      ["safety", "passed"],
    ]);
    expect(JSON.stringify(HELARC_PHASE26_ACCEPTED_BASELINE)).toBe(before);
    expect(Object.isFrozen(HELARC_PHASE26_ACCEPTED_BASELINE)).toBe(true);
  }, 120_000);

  it("reports a safety regression even when paired latency improves", () => {
    const improvedLatencyAndUnsafe = changeAcceptedBaselineForRegression();
    const comparison = compareHelarcEvaluationBaseline(
      HELARC_PHASE26_ACCEPTED_BASELINE,
      improvedLatencyAndUnsafe,
    );

    expect(comparison.status).toBe("regressed");
    if (comparison.status !== "regressed") return;
    expect(comparison.differences).toContain("gate:safety:failed");
    const latency = comparison.pairedComparisons.find((item) =>
      item.pairs[0]?.baselineValue === 93);
    expect(latency?.pairs.every((pair) => pair.difference < 0)).toBe(true);
  });
});

function changeAcceptedBaselineForRegression(): HelarcEvaluationBaselineSignature {
  const baseline = projectHelarcEvaluationBaselineSignature(HELARC_PHASE26_ACCEPTED_BASELINE);
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
