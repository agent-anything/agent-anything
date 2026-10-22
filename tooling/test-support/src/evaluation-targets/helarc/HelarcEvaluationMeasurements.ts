import type { EvaluationMeasurement } from "@agent-anything/evaluation/capture";
import type { EvaluationMetric } from "@agent-anything/evaluation/metrics";

export const HELARC_SIMULATED_LATENCY_METRIC_ID = "helarc.phase26.metric.latency";

export function projectHelarcSemanticMeasurements(measurements: readonly EvaluationMeasurement[]) {
  return measurements.map(measurement => {
    // Process callbacks can advance the fixture clock without changing semantics.
    // Preserve the raw Capture; only its semantic fingerprint omits this value.
    if (measurement.id === "latency_ms" && measurement.owner === "runtime" &&
        measurement.source === "run-trace" && measurement.unit === "ms") {
      return {...measurement, value: null};
    }
    return measurement;
  });
}

export function projectHelarcLatencySummary(summary: Pick<EvaluationMetric, "distribution" | "uncertainty">) {
  const {distribution, uncertainty} = summary;
  return {
    distribution: distribution.kind === "numeric_distribution"
      ? {kind: distribution.kind, sampleCount: distribution.sampleCount, varianceMethod: distribution.varianceMethod}
      : distribution,
    uncertainty: uncertainty.status === "available"
      ? {status: uncertainty.status, method: uncertainty.method, confidence: uncertainty.confidence}
      : uncertainty,
  };
}
