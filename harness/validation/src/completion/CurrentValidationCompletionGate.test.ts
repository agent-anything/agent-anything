import { describe, expect, it } from "vitest";
import { CurrentValidationCompletionGate } from "./CurrentValidationCompletionGate.js";
import type { CompletionGateInput } from "./CompletionGate.js";

const NOW = "2026-08-18T00:00:00.000Z";
const interruption = Object.freeze({ signal: new AbortController().signal, interruption: null });

describe("CurrentValidationCompletionGate", () => {
  it("admits an explicit zero-Requirement profile", async () => {
    const decision = await new CurrentValidationCompletionGate(() => NOW)
      .evaluate(input(), interruption);
    expect(decision).toMatchObject({
      status: "completion_eligible",
      disposition: null,
      reasons: [],
      failure: null,
    });
  });

  it.each([
    ["unassessed", "blocked_unassessed", "continue"],
    ["pending", "blocked_pending", "wait"],
    ["stale", "blocked_stale", "block"],
    ["violated", "blocked_violated", "block"],
    ["inconclusive", "blocked_inconclusive", "fail"],
  ] as const)("maps %s current state to %s", async (state, status, disposition) => {
    const decision = await new CurrentValidationCompletionGate(() => NOW).evaluate(input({
      mandatoryStates: [{
        current: {
          requirement: ref("requirement"),
          status: state,
          subject: state === "unassessed" ? null : ref("subject"),
          assessment: state === "unassessed" || state === "pending" ? null : ref("assessment"),
          pendingAttempts: state === "pending" ? [{ id: "attempt", ordinal: 1 }] : [],
          limitations: state === "stale" || state === "inconclusive"
            ? ["validation_test_limitation"]
            : [],
          updatedAt: NOW,
        },
        disposition,
      }],
    }), interruption);
    expect(decision).toMatchObject({ status, disposition });
  });

  it("fails closed for an unsatisfied required condition", async () => {
    const decision = await new CurrentValidationCompletionGate(() => NOW).evaluate(input({
      conditions: [{ ...owner("host-condition"), required: true, satisfied: false }],
    }), interruption);
    expect(decision).toMatchObject({
      status: "blocked_unassessed",
      disposition: "block",
      reasons: [{ code: "validation_gate_condition_unsatisfied" }],
    });
  });

  it("returns a Validation-owned failure when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const decision = await new CurrentValidationCompletionGate(() => NOW).evaluate(input(), {
      signal: controller.signal,
      interruption: null,
    });
    expect(decision).toMatchObject({
      status: "failed",
      disposition: "fail",
      failure: { code: "validation_gate_cancelled", stage: "completion_gate" },
    });
  });
});

function input(overrides: Partial<CompletionGateInput> = {}): CompletionGateInput {
  return {
    invocation: ref("gate"),
    run: { id: "run-1" },
    turn: { run: { id: "run-1" }, id: "turn-1", sequence: 1 },
    proposal: ref("proposal"),
    proposalOutputDigest: "sha256-output",
    outputContract: owner("output-contract"),
    specification: null,
    validationSnapshot: { runId: "run-1", revision: 1 },
    mandatoryStates: [],
    pendingWork: [],
    conditions: [],
    lifecycle: { runRevision: 1, status: "running", cancellationRevision: 0, deadlineAt: null },
    policy: owner("gate-policy"),
    correlation: owner("correlation"),
    requestedAt: NOW,
    ...overrides,
  };
}

function ref(id: string) {
  return { id, revision: "1" };
}

function owner(id: string) {
  return { owner: "validation", kind: "test", id, revision: "1" };
}
