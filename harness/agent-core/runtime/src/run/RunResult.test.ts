import { describe, expect, it } from "vitest";
import {
  createRunResult,
  type CreateRunResultInput,
} from "./RunResult.js";
import type { RunFailureCause } from "./RunFailure.js";
import type {
  RunSettlement,
  RunSettlementCauseRecord,
} from "./RunSettlement.js";

const startedAt = "2026-07-13T00:00:00.000Z";
const completedAt = "2026-07-13T00:00:01.000Z";
const TEST_INSTRUCTION_BINDING = Object.freeze({
  id: "run-1:agent-instruction-binding:0",
  revision: `sha256:${"0".repeat(64)}`,
});

describe("RunResult", () => {
  it("constructs the three structurally distinct terminal settlements", () => {
    const completion = completionCause();
    const failure = failureCause();
    const cancellation = cancellationCause();

    expect(createRunResult(input(
      { status: "succeeded", completedAt, cause: completion.ref, output: { answer: "done" } },
      completion,
    ))).toMatchObject({
      status: "succeeded",
      finalOutput: { answer: "done" },
      cause: { kind: "completion", code: "completion_accepted" },
    });
    expect(createRunResult(input(
      { status: "failed", completedAt, cause: failure.ref },
      failure,
    ))).toMatchObject({
      status: "failed",
      finalOutput: null,
      cause: {
        kind: "failure",
        failure: { kind: "runtime", failure: { code: "runtime_test_failure" } },
      },
    });
    expect(createRunResult(input(
      { status: "cancelled", completedAt, cause: cancellation.ref },
      cancellation,
    ))).toMatchObject({
      status: "cancelled",
      finalOutput: null,
      cause: {
        kind: "cancellation",
        code: "runtime_cancelled",
        cancellation: { requestId: "cancel-1" },
      },
    });
  });

  it("allows null when it is the Agent-validated successful output", () => {
    const cause = completionCause();
    expect(createRunResult(input<null>(
      { status: "succeeded", completedAt, cause: cause.ref, output: null },
      cause,
    ))).toMatchObject({ status: "succeeded", finalOutput: null });
  });

  it("rejects settlement and direct-cause disagreement", () => {
    const failure = failureCause();
    expect(() => createRunResult(input(
      { status: "succeeded", completedAt, cause: failure.ref, output: "invalid" },
      failure,
    ))).toThrow("status disagrees with its cause record");
  });

  it("rejects a direct cause missing from the bounded cause record set", () => {
    const cause = failureCause();
    expect(() => createRunResult({
      ...input({ status: "failed", completedAt, cause: cause.ref }, cause),
      settlementCauses: [],
    })).toThrow("settlement cause is missing");
  });

  it("rejects RunItems from a different Run", () => {
    const cause = failureCause();
    const mismatchedItem = {
      ref: { run: { id: "run-2" }, id: "item-1", sequence: 1 },
      committedInRevision: 1,
      createdAt: startedAt,
      payload: { kind: "state_transition" },
    };

    expect(() => createRunResult({
      ...input({ status: "failed", completedAt, cause: cause.ref }, cause),
      items: [mismatchedItem as never],
    })).toThrow("does not belong to Run run-1");
  });

  it("rejects incomplete identity and incoherent terminal time", () => {
    const cause = failureCause();
    expect(() => createRunResult({
      ...input({ status: "failed", completedAt, cause: cause.ref }, cause),
      // @ts-expect-error Runtime validation also protects untyped callers.
      startingAgent: null,
    })).toThrow("startingAgent must be an Agent revision");

    expect(() => createRunResult({
      ...input({ status: "failed", completedAt: startedAt, cause: cause.ref }, cause),
      startedAt: completedAt,
    })).toThrow("cannot complete before it starts");
  });

  it("freezes terminal structure and owned collections", () => {
    const cause = completionCause();
    const result = createRunResult({
      ...input(
        { status: "succeeded", completedAt, cause: cause.ref, output: { answer: "done" } },
        cause,
      ),
      evidenceRefs: ["evidence-1"],
      artifactRefs: ["artifact-1"],
      metadata: { source: "test" },
    });

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.cause)).toBe(true);
    expect(Object.isFrozen(result.settlement)).toBe(true);
    expect(Object.isFrozen(result.settlementCauses)).toBe(true);
    expect(Object.isFrozen(result.items)).toBe(true);
    expect(Object.isFrozen(result.metadata)).toBe(true);
  });
});

function input<TOutput>(
  settlement: RunSettlement<TOutput>,
  cause: RunSettlementCauseRecord,
): CreateRunResultInput<TOutput> {
  return {
    runId: "run-1",
    taskId: "task-1",
    startingAgent: { id: "agent.test", revision: "1" },
    finalActiveAgent: { id: "agent.test", revision: "1" },
    startingInstructionBinding: TEST_INSTRUCTION_BINDING,
    finalInstructionBinding: TEST_INSTRUCTION_BINDING,
    startedAt,
    settlement,
    cause,
    settlementCauses: [cause],
  };
}

function completionCause(): Extract<RunSettlementCauseRecord, { kind: "completion" }> {
  return {
    ref: causeRef(),
    kind: "completion",
    code: "completion_accepted",
    source: source("run_completion_acceptance"),
    underlying: [],
    omittedUnderlyingCount: 0,
    recordedAt: completedAt,
  };
}

function failureCause(): Extract<RunSettlementCauseRecord, { kind: "failure" }> {
  return {
    ref: causeRef(),
    kind: "failure",
    failure: runtimeFailure(),
    source: source("runtime_failure"),
    underlying: [],
    omittedUnderlyingCount: 0,
    recordedAt: completedAt,
  };
}

function cancellationCause(): Extract<RunSettlementCauseRecord, { kind: "cancellation" }> {
  return {
    ref: causeRef(),
    kind: "cancellation",
    code: "runtime_cancelled",
    cancellation: {
      requestId: "cancel-1",
      origin: "user",
      reasonCode: "user_requested",
      requestedAt: startedAt,
    },
    source: source("run_cancellation"),
    underlying: [],
    omittedUnderlyingCount: 0,
    recordedAt: completedAt,
  };
}

function causeRef() {
  return { run: { id: "run-1" }, id: "run-1:cause:1", revision: "1" };
}

function source(kind: string) {
  return {
    owner: "agent-runtime",
    kind,
    id: `run-1:${kind}:1`,
    revision: "1",
    run: { id: "run-1" },
  };
}

function runtimeFailure(): RunFailureCause {
  return {
    kind: "runtime",
    failure: {
      code: "runtime_test_failure",
      message: "Runtime failed.",
      retryable: false,
      metadata: {},
    },
  };
}
