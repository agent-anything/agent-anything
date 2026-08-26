import { describe, expect, it } from "vitest";
import {
  classifyContextContinuityFailure,
  observeContextContinuityFixtures,
  type ContextContinuityFailureSignals,
} from "./index.js";

describe("Context Continuity adverse-path conformance", () => {
  it("keeps every owning failure stage distinct", () => {
    const cases: readonly [ContextContinuityFailureSignals, string][] = [
      [{ missingContribution: true }, "missing_contribution"],
      [{ admissionRejected: true }, "admission_rejection"],
      [{ transitionRejected: true }, "context_transition"],
      [{ runCancelled: true }, "run_control"],
      [{ projectionOmitted: true }, "projection_omission"],
      [{ toolUnavailable: true }, "tool_availability"],
      [{ toolNotExposed: true }, "tool_exposure"],
      [{ providerTransportFailed: true }, "provider_transport"],
      [{ modelReasoningFailed: true }, "model_reasoning"],
      [{ executionFailed: true }, "execution"],
      [{ verificationFailed: true }, "verification"],
      [{}, "none"],
    ];

    for (const [signals, expected] of cases) {
      expect(classifyContextContinuityFailure(signals)).toBe(expected);
    }
  });

  it("preserves earliest-stage attribution when downstream symptoms coexist", () => {
    expect(classifyContextContinuityFailure({
      projectionOmitted: true,
      providerTransportFailed: true,
      modelReasoningFailed: true,
      executionFailed: true,
    })).toBe("projection_omission");
  });

  it("observes atomic conflicts, cancellation, reconstruction, and explicit unsupported state", async () => {
    const fixtures = await observeContextContinuityFixtures();
    const byId = new Map(fixtures.map((fixture) => [fixture.fixtureId, fixture]));

    expect(byId.get("conflicting_current_replacements")).toMatchObject({
      transitionConflictCount: 1,
      transitionCommittedCount: 2,
      attribution: "context_transition",
    });
    expect(byId.get("cancelled_transition")).toMatchObject({
      transitionCancelledCount: 1,
      transitionCommittedCount: 0,
      attribution: "run_control",
    });
    expect(byId.get("continuation_loss_reconstruction")?.continuation)
      .toMatchObject({ reconstructionEquivalent: true, behaviorCorrect: true });
    expect(byId.get("provider_continuation_unsupported")?.continuation)
      .toMatchObject({ outcome: "unavailable", reason: "unsupported", providerSupport: "unsupported" });
  });
});
