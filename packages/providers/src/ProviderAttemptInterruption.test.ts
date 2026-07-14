import type {
  InvocationInterruptionContext,
  InvocationInterruptionRef,
} from "@agent-anything/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProviderAttemptInterruption,
  providerResultFromInterruption,
} from "./ProviderAttemptInterruption.js";

describe("ProviderAttemptInterruption", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps Run cancellation as the first cause when timeout fires later", async () => {
    vi.useFakeTimers();
    const upstream = upstreamContext();
    const attempt = createProviderAttemptInterruption(upstream.context, 25);

    upstream.abort({
      kind: "run_cancellation",
      cancellation: { runId: "run_001", requestId: "cancel_001" },
    });
    await vi.advanceTimersByTimeAsync(25);

    expect(providerResultFromInterruption(attempt.cause)).toEqual({
      kind: "cancelled",
      cancellation: { runId: "run_001", requestId: "cancel_001" },
    });
    attempt.dispose();
  });

  it("keeps attempt timeout when Run cancellation arrives later", async () => {
    vi.useFakeTimers();
    const upstream = upstreamContext();
    const attempt = createProviderAttemptInterruption(upstream.context, 25);

    await vi.advanceTimersByTimeAsync(25);
    upstream.abort({
      kind: "run_cancellation",
      cancellation: { runId: "run_001", requestId: "cancel_001" },
    });

    expect(providerResultFromInterruption(attempt.cause)).toMatchObject({
      kind: "failed",
      failure: { category: "timeout", code: "provider_timeout" },
    });
    attempt.dispose();
  });

  it("preserves an attributed operation deadline", () => {
    const upstream = upstreamContext();
    const attempt = createProviderAttemptInterruption(upstream.context, 1000);

    upstream.abort({
      kind: "operation_deadline",
      deadline: {
        operationId: "provider_request_001",
        deadlineAt: "2026-07-14T03:00:00.000Z",
      },
    });

    expect(providerResultFromInterruption(attempt.cause)).toMatchObject({
      kind: "failed",
      failure: {
        category: "deadline",
        code: "provider_operation_deadline",
        metadata: { operationId: "provider_request_001" },
      },
    });
    attempt.dispose();
  });

  it("fails closed when an upstream abort has no trusted attribution", () => {
    const upstream = upstreamContext();
    const attempt = createProviderAttemptInterruption(upstream.context, 1000);

    upstream.abort(null);

    expect(providerResultFromInterruption(attempt.cause)).toMatchObject({
      kind: "cancellation_unconfirmed",
      failure: { code: "provider_cancellation_unconfirmed" },
    });
    attempt.dispose();
  });
});

function upstreamContext() {
  const controller = new AbortController();
  let interruption: InvocationInterruptionRef | null = null;
  return {
    context: {
      signal: controller.signal,
      get interruption() {
        return interruption;
      },
    } satisfies InvocationInterruptionContext,
    abort(cause: InvocationInterruptionRef | null) {
      interruption = cause;
      controller.abort(cause);
    },
  };
}
