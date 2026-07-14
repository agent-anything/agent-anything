import { describe, expect, it } from "vitest";
import { snapshotRetryEvent } from "./RetryEvent.js";
import { snapshotRetryOperation } from "./RetryOperation.js";
import { snapshotRetryPolicy } from "./RetryPolicy.js";

describe("Retry contracts", () => {
  it("normalizes duplicate categories and freezes a validated policy", () => {
    const policy = snapshotRetryPolicy({
      maxRetries: 2,
      delay: { ...delayPolicy(100, 1_000), secret: "must not survive" },
      retryableCategories: ["transport", "transport", "timeout"],
      serverDelay: { mode: "prefer_trusted", maxServerDelayMs: 5_000 },
      secret: "must not survive",
    } as never);

    expect(policy.retryableCategories).toEqual(["transport", "timeout"]);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.delay)).toBe(true);
    expect(Object.isFrozen(policy.retryableCategories)).toBe(true);
    expect(policy).not.toHaveProperty("secret");
    expect(policy.delay).not.toHaveProperty("secret");
  });

  it.each([
    [{ maxRetries: -1 }, "maxRetries"],
    [{ delay: { ...delayPolicy(100, 1_000), multiplier: 3 } }, "multiplier"],
    [{ delay: delayPolicy(2_000, 1_000) }, "maxDelayMs"],
    [{ delay: delayPolicy(0, 2_147_483_648) }, "2147483647"],
    [{ serverDelay: { mode: "prefer_trusted", maxServerDelayMs: -1 } }, "maxServerDelayMs"],
  ])("rejects malformed policy input %#", (change, message) => {
    expect(() => snapshotRetryPolicy({
      maxRetries: 1,
      delay: delayPolicy(100, 1_000),
      retryableCategories: ["transport"],
      serverDelay: { mode: "ignore" },
      ...change,
    } as never)).toThrow(message);
  });

  it("validates owner-specific operation subjects and deadline order", () => {
    const operation = snapshotRetryOperation({
      operationId: "retry_001",
      owner: "provider_request",
      runId: "run_001",
      subject: {
        kind: "provider_request",
        controllerRequestId: "controller_001",
        secret: "must not survive",
      },
      startedAt: "2026-07-14T00:00:00.000Z",
      deadlineAt: "2026-07-14T00:00:10.000Z",
      secret: "must not survive",
    } as never);

    expect(Object.isFrozen(operation.subject)).toBe(true);
    expect(operation).not.toHaveProperty("secret");
    expect(operation.subject).not.toHaveProperty("secret");
    expect(() => snapshotRetryOperation({
      ...operation,
      subject: { kind: "approval_review", approvalRequestId: "approval_001" },
    })).toThrow("does not match");
    expect(() => snapshotRetryOperation({
      ...operation,
      deadlineAt: operation.startedAt,
    })).toThrow("later than startedAt");
  });

  it("rebuilds Retry events from allowlisted safe fields", () => {
    const event = snapshotRetryEvent({
      type: "retry_scheduled",
      runId: "run_001",
      operationId: "retry_001",
      owner: "provider_request",
      occurredAt: "2026-07-14T00:00:00.000Z",
      afterAttemptId: "attempt_001",
      budgetId: "budget_001",
      retryNumber: 1,
      nextAttemptNumber: 2,
      nextBudgetAttemptNumber: 2,
      delayMs: 100,
      delaySource: "calculated_backoff",
      nextAttemptAt: "2026-07-14T00:00:00.100Z",
      failureCategory: "transport",
      failureCode: "provider_request_failed",
      secret: "must not survive",
    } as never, "run_001");

    expect(event).not.toHaveProperty("secret");
    expect(Object.isFrozen(event)).toBe(true);
  });

  it("rebuilds and validates cancellation attribution", () => {
    const candidate = {
      type: "retry_cancelled" as const,
      runId: "run_001",
      operationId: "retry_001",
      owner: "provider_request" as const,
      occurredAt: "2026-07-14T00:00:00.000Z",
      phase: "backoff" as const,
      budgetId: "budget_001",
      attemptId: null,
      attemptNumber: null,
      attribution: {
        requestId: "cancel_001",
        runId: "run_001",
        boundary: "retry_wait" as const,
        observedAt: "2026-07-14T00:00:00.000Z",
        secret: "must not survive",
      },
    };
    const event = snapshotRetryEvent(candidate, "run_001");

    expect(event).not.toHaveProperty("attribution.secret");
    expect(() => snapshotRetryEvent({
      ...candidate,
      attribution: { ...candidate.attribution, boundary: "unknown" },
    } as never, "run_001")).toThrow("boundary is unsupported");
  });
});

function delayPolicy(baseDelayMs: number, maxDelayMs: number) {
  return {
    kind: "exponential_jitter" as const,
    baseDelayMs,
    maxDelayMs,
    multiplier: 2 as const,
    jitterRatio: 0.1 as const,
  };
}
