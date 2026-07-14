import { describe, expect, it } from "vitest";
import {
  createRunCancellationController,
  toRunCancellationSummary,
} from "./RunCancellation.js";

describe("RunCancellationController", () => {
  it("accepts the first valid request and exposes it through the live context", () => {
    const controller = createRunCancellationController({
      runId: "run-1",
      createRequestId: () => "cancel-1",
      now: () => "2026-07-13T00:00:00.000Z",
    });

    expect(controller.context.request).toBeNull();
    expect(controller.context.signal.aborted).toBe(false);

    const receipt = controller.requestCancellation({
      origin: "user",
      reasonCode: "user_requested",
      reason: " Stop this run. ",
    });

    expect(receipt.accepted).toBe(true);
    expect(receipt.request).toEqual({
      id: "cancel-1",
      runId: "run-1",
      origin: "user",
      reasonCode: "user_requested",
      reason: "Stop this run.",
      approvalRequestId: null,
      parentRunId: null,
      requestedAt: "2026-07-13T00:00:00.000Z",
    });
    expect(controller.context.request).toBe(receipt.request);
    expect(controller.context.signal.aborted).toBe(true);
    expect(controller.context.signal.reason).toBe(receipt.request);
    expect(toRunCancellationSummary(receipt.request)).toEqual({
      requestId: "cancel-1",
      origin: "user",
      reasonCode: "user_requested",
      requestedAt: "2026-07-13T00:00:00.000Z",
    });
  });

  it("keeps the first request when cancellation is requested again", () => {
    const controller = createRunCancellationController({ runId: "run-1" });
    const first = controller.requestCancellation({
      origin: "host",
      reasonCode: "host_requested",
    });
    const second = controller.requestCancellation({
      origin: "user",
      reasonCode: "user_requested",
    });

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(false);
    expect(second.request).toBe(first.request);
  });

  it("rejects an origin and reason mismatch", () => {
    const controller = createRunCancellationController({ runId: "run-1" });

    expect(() => controller.requestCancellation({
      origin: "user",
      reasonCode: "host_shutdown",
    })).toThrow("is not valid for origin user");
    expect(controller.context.request).toBeNull();
  });

  it("requires correlation for approval and parent Run cancellation", () => {
    const approvalController = createRunCancellationController({ runId: "run-1" });
    const parentController = createRunCancellationController({ runId: "run-2" });

    expect(() => approvalController.requestCancellation({
      origin: "approval",
      reasonCode: "approval_cancelled",
    })).toThrow("approvalRequestId");
    expect(() => parentController.requestCancellation({
      origin: "parent_run",
      reasonCode: "parent_run_cancelled",
    })).toThrow("parentRunId");
  });

  it("rejects an invalid request timestamp and oversized reason", () => {
    const invalidClock = createRunCancellationController({
      runId: "run-1",
      now: () => "not-a-date",
    });
    const oversizedReason = createRunCancellationController({ runId: "run-2" });

    expect(() => invalidClock.requestCancellation({
      origin: "user",
      reasonCode: "user_requested",
    })).toThrow("valid date-time");
    expect(() => oversizedReason.requestCancellation({
      origin: "user",
      reasonCode: "user_requested",
      reason: "x".repeat(501),
    })).toThrow("must not exceed 500 characters");
    expect(invalidClock.context.request).toBeNull();
    expect(oversizedReason.context.request).toBeNull();
  });
});
