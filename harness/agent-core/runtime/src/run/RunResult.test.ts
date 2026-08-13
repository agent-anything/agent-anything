import { describe, expect, it } from "vitest";
import {
  createBlockedRunResult,
  createCancelledRunResult,
  createFailedRunResult,
  createSucceededRunResult,
  type CreateRunResultBaseInput,
} from "./RunResult.js";
import type { RunFailureCause } from "./RunFailure.js";

const startedAt = "2026-07-13T00:00:00.000Z";
const completedAt = "2026-07-13T00:00:01.000Z";

describe("RunResult", () => {
  it("constructs structurally distinct terminal results", () => {
    const input = base();
    const failure = runtimeFailure();
    const cancellation = cancellationSummary();

    expect(createSucceededRunResult(input, { answer: "done" })).toMatchObject({
      status: "succeeded",
      code: null,
      finalOutput: { answer: "done" },
      cancellation: null,
      failure: null,
      relatedFailures: [],
    });
    expect(createBlockedRunResult(input, "runtime_no_safe_path")).toMatchObject({
      status: "blocked",
      code: "runtime_no_safe_path",
      finalOutput: null,
      cancellation: null,
      failure: null,
      relatedFailures: [],
    });
    expect(createFailedRunResult(
      input,
      "runtime_execution_failed",
      failure,
    )).toMatchObject({
      status: "failed",
      code: "runtime_execution_failed",
      finalOutput: null,
      cancellation: null,
      failure,
      relatedFailures: [],
    });
    expect(createCancelledRunResult(input, cancellation)).toMatchObject({
      status: "cancelled",
      code: "runtime_cancelled",
      finalOutput: null,
      cancellation,
      failure: null,
      relatedFailures: [],
    });
  });

  it("allows null when it is the Agent-validated successful output", () => {
    expect(createSucceededRunResult(base<null>(), null)).toMatchObject({
      status: "succeeded",
      finalOutput: null,
    });
  });

  it("rejects a failed result without a primary failure", () => {
    expect(() => createFailedRunResult(
      base(),
      "runtime_execution_failed",
      // @ts-expect-error Runtime validation also protects untyped callers.
      null,
    )).toThrow("failure must be a valid RunFailureCause");
  });

  it("rejects RunItems from a different Run", () => {
    const mismatchedItem = {
      ref: {
        run: { id: "run-2" },
        id: "item-1",
        sequence: 1,
      },
      committedInRevision: 1,
      createdAt: startedAt,
      payload: {
        kind: "terminal_transition",
        status: "blocked",
        code: "runtime_no_safe_path",
        output: null,
        failure: null,
      },
    };

    expect(() => createBlockedRunResult({
      ...base(),
      items: [mismatchedItem as never],
    }, "runtime_no_safe_path")).toThrow("does not belong to Run run-1");
  });

  it("rejects incomplete identity and incoherent terminal time", () => {
    expect(() => createBlockedRunResult({
      ...base(),
      // @ts-expect-error Runtime validation also protects untyped callers.
      startingAgent: null,
    }, "runtime_no_safe_path")).toThrow("startingAgent must be an Agent revision");

    expect(() => createBlockedRunResult({
      ...base(),
      startedAt: completedAt,
      completedAt: startedAt,
    }, "runtime_no_safe_path")).toThrow("cannot complete before it starts");
  });

  it("freezes terminal structure and owned collections", () => {
    const result = createSucceededRunResult({
      ...base(),
      evidenceRefs: ["evidence-1"],
      artifactRefs: ["artifact-1"],
      metadata: { source: "test" },
    }, { answer: "done" });

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.startingAgent)).toBe(true);
    expect(Object.isFrozen(result.items)).toBe(true);
    expect(Object.isFrozen(result.evidenceRefs)).toBe(true);
    expect(Object.isFrozen(result.artifactRefs)).toBe(true);
    expect(Object.isFrozen(result.metadata)).toBe(true);
  });
});

function base<TOutput = unknown>(): CreateRunResultBaseInput<TOutput> {
  return {
    runId: "run-1",
    taskId: "task-1",
    startingAgent: { id: "agent.test", revision: "1" },
    finalActiveAgent: { id: "agent.test", revision: "1" },
    startedAt,
    completedAt,
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

function cancellationSummary() {
  return {
    requestId: "cancel-1",
    origin: "user" as const,
    reasonCode: "user_requested" as const,
    requestedAt: startedAt,
  };
}
