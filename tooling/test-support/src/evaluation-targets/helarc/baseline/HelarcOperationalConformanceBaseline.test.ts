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
import {
  HELARC_RUN_STOP_OPERATIONAL_ACCEPTED_BASELINE,
  HELARC_RUN_STOP_OPERATIONAL_BASELINE_ACCEPTANCE,
  verifyHelarcRunStopOperationalAcceptedBaseline,
} from "./HelarcRunStopOperationalBaseline.js";

describe("Helarc operational conformance Baseline", () => {
  it("preserves v1 and accepts only the exact Run Stop v2 operational Report", async () => {
    const predecessorBefore = JSON.stringify(HELARC_OPERATIONAL_CONFORMANCE_ACCEPTED_BASELINE);
    const candidate = await runHelarcOperationalConformance();

    expect(() => verifyHelarcOperationalConformanceAcceptedBaseline(candidate))
      .toThrow("does not match the accepted Baseline");
    expect(verifyHelarcRunStopOperationalAcceptedBaseline(candidate))
      .toBe(HELARC_RUN_STOP_OPERATIONAL_ACCEPTED_BASELINE);
    expect(HELARC_RUN_STOP_OPERATIONAL_ACCEPTED_BASELINE).toMatchObject({
      status: "passed",
      trialCount: 7,
      completedTrialCount: 7,
      metricCount: 21,
      gateCount: 11,
      passedGateCount: 11,
    });
    expect(HELARC_OPERATIONAL_CONFORMANCE_BASELINE_ACCEPTANCE.predecessorAcceptanceRef)
      .toEqual(HELARC_VERIFICATION_GUIDED_COMPLETION_ACCEPTED_BASELINE.acceptanceRef);
    expect(HELARC_RUN_STOP_OPERATIONAL_BASELINE_ACCEPTANCE.predecessorAcceptanceRef)
      .toEqual(HELARC_OPERATIONAL_CONFORMANCE_ACCEPTED_BASELINE.acceptanceRef);
    expect(JSON.stringify(HELARC_OPERATIONAL_CONFORMANCE_ACCEPTED_BASELINE))
      .toBe(predecessorBefore);
    expect(Object.isFrozen(HELARC_OPERATIONAL_CONFORMANCE_ACCEPTED_BASELINE)).toBe(true);
    expect(Object.isFrozen(HELARC_RUN_STOP_OPERATIONAL_ACCEPTED_BASELINE)).toBe(true);
  }, 180_000);

  it("rejects a candidate whose immutable Report digest changed", async () => {
    const candidate = await runHelarcOperationalConformance();
    const changed = {
      ...candidate,
      digest: "0".repeat(64),
    };

    expect(() => verifyHelarcRunStopOperationalAcceptedBaseline(changed))
      .toThrow("does not match the accepted Baseline");
  }, 180_000);
});
