import { describe, expect, it } from "vitest";
import {
  createBlockedRunResult,
  createCancelledRunResult,
  createFailedRunResult,
  createSucceededRunResult,
} from "./RunResult.js";
import type { RuntimeError } from "./RuntimeError.js";

describe("RunResult", () => {
  it("constructs structurally distinct terminal results", () => {
    const base = { runId: "run-1", taskId: "task-1" };
    const error: RuntimeError = {
      owner: "provider",
      code: "provider_request_failed",
      message: "Provider request failed.",
      retryable: false,
      metadata: {},
    };
    const cancellation = {
      requestId: "cancel-1",
      origin: "user" as const,
      reasonCode: "user_requested" as const,
      requestedAt: "2026-07-13T00:00:00.000Z",
    };

    expect(createSucceededRunResult(base, { answer: "done" })).toMatchObject({
      status: "succeeded",
      code: null,
      finalOutput: { answer: "done" },
      cancellation: null,
      errors: [],
    });
    expect(createBlockedRunResult(base, "runtime_no_safe_path")).toMatchObject({
      status: "blocked",
      code: "runtime_no_safe_path",
      finalOutput: null,
      cancellation: null,
      errors: [],
    });
    expect(createFailedRunResult(base, "provider_request_failed", [error])).toMatchObject({
      status: "failed",
      code: "provider_request_failed",
      finalOutput: null,
      cancellation: null,
      errors: [error],
    });
    expect(createCancelledRunResult(base, cancellation)).toMatchObject({
      status: "cancelled",
      code: "runtime_cancelled",
      finalOutput: null,
      cancellation,
      errors: [],
    });
  });

  it("rejects a succeeded result without output", () => {
    expect(() => createSucceededRunResult(
      { runId: "run-1", taskId: "task-1" },
      // @ts-expect-error Runtime validation also protects untyped callers.
      null,
    )).toThrow("non-null finalOutput");
  });

  it("rejects a failed result without an error", () => {
    expect(() => createFailedRunResult(
      { runId: "run-1", taskId: "task-1" },
      "provider_request_failed",
      // @ts-expect-error Runtime validation also protects untyped callers.
      [],
    )).toThrow("at least one RuntimeError");
  });

  it("rejects RunItems from a different Run", () => {
    expect(() => createBlockedRunResult({
      runId: "run-1",
      taskId: "task-1",
      items: [{
        id: "item-1",
        runId: "run-2",
        sequence: 1,
        kind: "run_blocked",
        code: "runtime_no_safe_path",
        createdAt: "2026-07-13T00:00:00.000Z",
        metadata: {},
      }],
    }, "runtime_no_safe_path")).toThrow("does not belong to Run run-1");
  });

  it("freezes terminal structure and owned collections", () => {
    const result = createSucceededRunResult({
      runId: "run-1",
      taskId: "task-1",
      evidenceRefs: ["evidence-1"],
      artifactRefs: ["artifact-1"],
      metadata: { source: "test" },
    }, { answer: "done" });

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.items)).toBe(true);
    expect(Object.isFrozen(result.evidenceRefs)).toBe(true);
    expect(Object.isFrozen(result.artifactRefs)).toBe(true);
    expect(Object.isFrozen(result.metadata)).toBe(true);
  });
});
