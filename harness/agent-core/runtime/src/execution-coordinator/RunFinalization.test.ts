import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunFinalizationContext } from "./RunFinalization.js";

describe("RunFinalization", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates an independent bounded finalization signal", async () => {
    vi.useFakeTimers();
    const scope = createRunFinalizationContext({
      runId: "run_001",
      cancellation: null,
      timeoutMs: 25,
      startedAt: "2026-07-14T00:00:00.000Z",
    });

    expect(scope.context).toMatchObject({
      runId: "run_001",
      cancellation: null,
      deadlineAt: "2026-07-14T00:00:00.025Z",
    });
    expect(scope.context.signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(25);

    expect(scope.context.signal.aborted).toBe(true);
    scope.dispose();
  });

  it("disposes the deadline without aborting completed finalization", async () => {
    vi.useFakeTimers();
    const scope = createRunFinalizationContext({
      runId: "run_001",
      cancellation: null,
      timeoutMs: 25,
      startedAt: "2026-07-14T00:00:00.000Z",
    });

    scope.dispose();
    scope.dispose();
    await vi.advanceTimersByTimeAsync(25);

    expect(scope.context.signal.aborted).toBe(false);
  });
});
