import {
  snapshotValidationEvaluationProjection,
  snapshotValidationHostProjection,
} from "@agent-anything/validation/projection";
import { describe, expect, it } from "vitest";
import { VALIDATION_BEHAVIOR_SCENARIOS } from "./ValidationBehaviorProfile.js";

const NOW = "2026-08-18T00:00:00.000Z";

describe("Validation behavior conformance profile", () => {
  it("keeps a complete deterministic scenario inventory under semantic owners", () => {
    const ids = VALIDATION_BEHAVIOR_SCENARIOS.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining([
      "profile.empty",
      "profile.mandatory",
      "command.completed",
      "command.partial",
      "command.failed",
      "command.denied",
      "command.timed_out",
      "command.cancelled",
      "target.satisfied",
      "target.violated",
      "target.unavailable",
      "target.stale",
      "evidence.insufficient",
      "evidence.conflicting",
      "assessment.satisfied",
      "assessment.violated",
      "assessment.inconclusive",
      "gate.eligible",
      "gate.unassessed",
      "gate.pending",
      "gate.stale",
      "gate.violated",
      "gate.inconclusive",
      "gate.invalid",
      "gate.failed",
      "lifecycle.cancelled",
      "lifecycle.conflict",
      "lifecycle.duplicate",
      "lifecycle.late",
      "lifecycle.post_terminal",
      "disclosure.renderer",
      "disclosure.evaluation",
    ]));
  });

  it("rejects raw Evidence, command, path, and policy fields from bounded projections", () => {
    const snapshot = { runId: "run-1", revision: 3 };
    expect(() => snapshotValidationHostProjection({
      snapshot,
      counts: [],
      activeChecks: 0,
      gateStatus: null,
      safeReasons: [],
      updatedAt: NOW,
      rawEvidence: "secret",
    } as never)).toThrow(/unsupported field 'rawEvidence'/);
    expect(() => snapshotValidationEvaluationProjection({
      snapshot,
      checkStatus: "completed",
      assessmentVerdict: "satisfied",
      gateStatus: "completion_eligible",
      latencyMs: 10,
      costUnits: 1,
      failureOwner: null,
      command: "secret",
    } as never)).toThrow(/unsupported field 'command'/);
  });
});
