import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunCancellationController } from "@agent-anything/agent-core/run";
import {
  createRetryAttemptInterruptionFactory,
  createRetryWait,
  systemRetryClock,
} from "./RetryDependencies.js";

describe("Retry deterministic dependencies", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("preserves operation deadline when it wins before Run cancellation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-14T00:00:00.000Z");
    const cancellation = createRunCancellationController({ runId: "run_001" });
    const interruption = createRetryAttemptInterruptionFactory(systemRetryClock).create({
      operationId: "retry_001",
      owner: "provider_request",
      runId: "run_001",
      subject: { kind: "provider_request", controllerRequestId: "controller_001" },
      startedAt: "2026-07-14T00:00:00.000Z",
      deadlineAt: "2026-07-14T00:00:00.025Z",
    }, cancellation.context);

    await vi.advanceTimersByTimeAsync(25);
    cancellation.requestCancellation({ origin: "user", reasonCode: "user_requested" });

    expect(interruption.signal.aborted).toBe(true);
    expect(interruption.deadlineReason).toEqual({
      kind: "retry_deadline_exceeded",
      operationId: "retry_001",
      deadlineAt: "2026-07-14T00:00:00.025Z",
    });
    interruption.dispose();
  });

  it("does not let a later deadline overwrite Run cancellation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-14T00:00:00.000Z");
    const cancellation = createRunCancellationController({ runId: "run_001" });
    const interruption = createRetryAttemptInterruptionFactory(systemRetryClock).create({
      operationId: "retry_001",
      owner: "provider_request",
      runId: "run_001",
      subject: { kind: "provider_request", controllerRequestId: "controller_001" },
      startedAt: "2026-07-14T00:00:00.000Z",
      deadlineAt: "2026-07-14T00:00:00.025Z",
    }, cancellation.context);
    const receipt = cancellation.requestCancellation({
      origin: "user",
      reasonCode: "user_requested",
    });

    await vi.advanceTimersByTimeAsync(25);

    expect(interruption.signal.reason).toBe(receipt.request);
    expect(interruption.deadlineReason).toBeNull();
    interruption.dispose();
  });

  it("settles backoff with exact cancellation attribution", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-14T00:00:00.000Z");
    const cancellation = createRunCancellationController({ runId: "run_001" });
    const wait = createRetryWait(systemRetryClock).wait(100, cancellation.context);
    const receipt = cancellation.requestCancellation({
      origin: "host",
      reasonCode: "host_requested",
    });

    await expect(wait).resolves.toMatchObject({
      kind: "cancelled",
      attribution: {
        requestId: receipt.request.id,
        runId: "run_001",
        operation: "retry_wait",
      },
    });
  });
});
