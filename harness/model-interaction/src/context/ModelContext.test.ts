import { describe, expect, it } from "vitest";
import {
  assessModelContext,
  createUnknownModelInputMeasurement,
  type ModelContextCapacity,
  type ModelInputMeasurement,
} from "./ModelContext.js";

const assessedAt = "2026-09-02T00:00:00.000Z";
const requestedOutput = {
  unit: "tokens" as const,
  maximum: 100,
  source: "host_configured" as const,
  revision: "output-1",
};
const headroom = {
  unit: "tokens" as const,
  amount: 50,
  policy: { id: "headroom", revision: "1" },
};
const capacity: ModelContextCapacity = {
  supported: true,
  unit: "tokens",
  maximum: 1_000,
  semantics: "input_and_output",
  source: "host_configured",
  providerId: "provider",
  model: "model",
  revision: "capacity-1",
};

describe("Model Context assessment", () => {
  it.each([
    ["exact", 850, "proven_fit"],
    ["exact", 851, "proven_overflow"],
    ["upper_bound", 850, "proven_fit"],
    ["upper_bound", 851, "unresolved"],
    ["estimated", 850, "estimated_fit"],
    ["estimated", 851, "estimated_overflow"],
  ] as const)("maps %s measurement %i conservatively", (accuracy, amount, expected) => {
    expect(assessment(measured(accuracy, amount)).disposition).toBe(expected);
  });

  it("does not invent an amount when measurement is unknown", () => {
    const measurement = createUnknownModelInputMeasurement({
      compositionId: "composition-1",
      measuredAt: assessedAt,
      reason: "unsupported",
    });
    expect(assessment(measurement)).toMatchObject({
      disposition: "unresolved",
      effectiveInputBudget: 850,
      measurement: { status: "unknown", accuracy: "unknown" },
    });
    expect("amount" in measurement).toBe(false);
  });

  it("treats a negative output-and-headroom budget as proven overflow", () => {
    const result = assessModelContext({
      compositionId: "composition-1",
      capacity: { ...capacity, maximum: 100 },
      measurement: measured("estimated", 1),
      requestedOutput,
      headroom,
      assessedAt,
      revision: "assessment-1",
    });
    expect(result.disposition).toBe("proven_overflow");
    expect(result.effectiveInputBudget).toBe(-50);
  });

  it("does not subtract requested output from input-only capacity", () => {
    const result = assessModelContext({
      compositionId: "composition-1",
      capacity: { ...capacity, semantics: "input_only" },
      measurement: measured("exact", 950),
      requestedOutput,
      headroom,
      assessedAt,
      revision: "assessment-1",
    });
    expect(result.effectiveInputBudget).toBe(950);
    expect(result.disposition).toBe("proven_fit");
  });
});

function assessment(measurement: ModelInputMeasurement) {
  return assessModelContext({
    compositionId: "composition-1",
    capacity,
    measurement,
    requestedOutput,
    headroom,
    assessedAt,
    revision: "assessment-1",
  });
}

function measured(
  accuracy: "exact" | "upper_bound" | "estimated",
  amount: number,
): ModelInputMeasurement {
  return {
    status: "measured",
    amount,
    estimator: { id: "test-estimator", revision: "1", unit: "tokens", accuracy },
    uncertainty: accuracy === "exact" ? { kind: "none" } : { kind: "unquantified" },
    measuredCompositionId: "composition-1",
    measuredAt: assessedAt,
  };
}
