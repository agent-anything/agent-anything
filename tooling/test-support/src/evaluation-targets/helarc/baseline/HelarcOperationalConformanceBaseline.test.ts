import { describe, expect, it } from "vitest";

import {
  runHelarcOperationalConformance,
} from "../operational-evaluation/HelarcOperationalConformanceExecution.js";
import {
  HELARC_VERIFICATION_GUIDED_COMPLETION_ACCEPTED_BASELINE,
} from "./HelarcVerificationGuidedCompletionBaseline.js";
import {
  HELARC_OPERATIONAL_CONFORMANCE_ACCEPTED_BASELINE,
  HELARC_OPERATIONAL_CONFORMANCE_BASELINE_ACCEPTANCE,
  verifyHelarcOperationalConformanceAcceptedBaseline,
} from "./HelarcOperationalConformanceBaseline.js";

describe("Helarc operational conformance Baseline", () => {
  it("accepts only the exact passed deterministic operational Report", async () => {
    const candidate = await runHelarcOperationalConformance();

    expect(verifyHelarcOperationalConformanceAcceptedBaseline(candidate))
      .toBe(HELARC_OPERATIONAL_CONFORMANCE_ACCEPTED_BASELINE);
    expect(HELARC_OPERATIONAL_CONFORMANCE_ACCEPTED_BASELINE).toMatchObject({
      status: "passed",
      trialCount: 7,
      completedTrialCount: 7,
      metricCount: 21,
      gateCount: 11,
      passedGateCount: 11,
    });
    expect(HELARC_OPERATIONAL_CONFORMANCE_BASELINE_ACCEPTANCE.predecessorAcceptanceRef)
      .toEqual(HELARC_VERIFICATION_GUIDED_COMPLETION_ACCEPTED_BASELINE.acceptanceRef);
    expect(Object.isFrozen(HELARC_OPERATIONAL_CONFORMANCE_ACCEPTED_BASELINE)).toBe(true);
  }, 180_000);

  it("rejects a candidate whose immutable Report digest changed", async () => {
    const candidate = await runHelarcOperationalConformance();
    const changed = {
      ...candidate,
      digest: "0".repeat(64),
    };

    expect(() => verifyHelarcOperationalConformanceAcceptedBaseline(changed))
      .toThrow("does not match the accepted Baseline");
  }, 180_000);
});
