import {describe, expect, it} from "vitest";
import {projectHelarcLatencySummary, projectHelarcSemanticMeasurements} from "./HelarcEvaluationMeasurements.js";

describe("Helarc semantic measurement identity", () => {
  const latency = Object.freeze({id: "latency_ms", owner: "runtime", source: "run-trace", unit: "ms",
    value: 338, valid: true, limitation: null});

  it("ignores only simulated latency value without changing captured evidence", () => {
    expect(projectHelarcSemanticMeasurements([latency]))
      .toEqual(projectHelarcSemanticMeasurements([{...latency, value: 340}]));
    expect(latency.value).toBe(338);
    expect(projectHelarcSemanticMeasurements([{...latency, valid: false}]))
      .not.toEqual(projectHelarcSemanticMeasurements([latency]));
  });

  it("retains other measurements and measurements from a different source", () => {
    for (const change of [{id: "action_count"}, {owner: "provider"}, {source: "wall-clock"}, {unit: "count"}]) {
      const measurement = {...latency, ...change};
      expect(projectHelarcSemanticMeasurements([measurement])[0]).toBe(measurement);
      expect(projectHelarcSemanticMeasurements([measurement]))
        .not.toEqual(projectHelarcSemanticMeasurements([{...measurement, value: 340}]));
    }
  });

  it("keeps latency coverage and uncertainty validity in report identity", () => {
    const summary = {distribution: {kind: "numeric_distribution" as const, sampleCount: 2,
      minimum: 338, maximum: 340, mean: 339, variance: 2, varianceMethod: "sample" as const, p50: 339, p90: 340, p95: 340},
      uncertainty: {status: "available" as const, method: "standard_error" as const, confidence: 0.95, lower: 337, upper: 341}};
    expect(projectHelarcLatencySummary(summary)).toEqual(projectHelarcLatencySummary({
      distribution: {...summary.distribution, mean: 341, maximum: 342},
      uncertainty: {...summary.uncertainty, upper: 343},
    }));
    expect(projectHelarcLatencySummary(summary)).not.toEqual(projectHelarcLatencySummary({
      ...summary, distribution: {...summary.distribution, sampleCount: 1},
    }));
    expect(summary.distribution.mean).toBe(339);
  });
});
