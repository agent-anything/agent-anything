import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunCancellationController, type RunStatus } from "../run/index.js";
import type { RetryWaitRequest } from "../retry/RetryWaitControl.js";
import { RunDecisionBasis } from "./RunDecisionBasis.js";
import { RunRetryWaitScope } from "./RunRetryWaitScope.js";

afterEach(() => vi.useRealTimers());

describe("Run Retry wait ownership", () => {
  it("registers before arming and closes one exact generation even for synchronous timer delivery", async () => {
    const fixture = setup();
    const order: string[] = [];
    fixture.open.mockImplementation(() => { order.push("registered"); });
    await expect(fixture.scope.wait(request(), async () => {
      order.push("armed");
      expect(fixture.scope.isWaiting).toBe(true);
      return { kind: "elapsed" };
    })).resolves.toEqual({ kind: "elapsed" });
    expect(order).toEqual(["registered", "armed"]);
    expect(fixture.close).toHaveBeenCalledTimes(1);
    expect(fixture.close).toHaveBeenCalledWith(fixture.open.mock.calls[0]![0], "elapsed");
    expect(fixture.ready).toHaveBeenCalledTimes(1);
    expect(fixture.scope.isWaiting).toBe(false);
    await fixture.scope.wait(request(), async () => ({kind: "elapsed"}));
    expect(fixture.open.mock.calls.map(([pending]) => pending.generation)).toEqual([1, 2]);
  });

  it("timer readiness cannot resume a suspended Run", async () => {
    const fixture = setup();
    let ready!: () => void;
    const timer = new Promise<{kind: "elapsed"}>(resolve => { ready = () => resolve({kind: "elapsed"}); });
    let settled = false;
    const pending = fixture.scope.wait(request(), () => timer).then(result => { settled = true; return result; });
    fixture.state.status = "suspended";
    ready();
    await vi.waitFor(() => expect(fixture.ready).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    expect(fixture.state.status).toBe("suspended");
    fixture.state.status = "waiting";
    fixture.scope.notifyStateChanged();
    expect(await pending).toEqual({kind: "elapsed"});
  });

  it("disposes timer resources without fabricating Run cancellation and ignores late delivery", async () => {
    const fixture = setup();
    let signal!: AbortSignal;
    let deliver!: () => void;
    const timer = new Promise<{kind: "elapsed"}>(resolve => { deliver = () => resolve({kind: "elapsed"}); });
    const pending = fixture.scope.wait(request(), disposal => { signal = disposal; return timer; });
    await vi.waitFor(() => expect(signal).toBeDefined());
    fixture.scope.dispose();
    expect(await pending).toEqual({kind: "invalidated"});
    expect(signal.aborted).toBe(true);
    expect(fixture.cancellation.context.request).toBeNull();
    deliver();
    await Promise.resolve();
    expect(fixture.ready).not.toHaveBeenCalled();
    expect(fixture.close).toHaveBeenCalledOnce();
  });

  it.each(["cancel", "deadline", "basis"] as const)("unblocks a pending timer on %s without another Attempt", async kind => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(NOW));
    const fixture = setup();
    const pending = fixture.scope.wait(request(), () => new Promise(() => {}));
    if (kind === "cancel") fixture.cancellation.requestCancellation({origin: "user", reasonCode: "user_requested"});
    if (kind === "deadline") await vi.advanceTimersByTimeAsync(1000);
    if (kind === "basis") { fixture.current = false; fixture.scope.notifyStateChanged(); }
    expect((await pending).kind).toBe({cancel: "cancelled", deadline: "deadline_exceeded", basis: "invalidated"}[kind]);
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects another invocation and an overlapping wait before arming", async () => {
    const fixture = setup();
    const arm = vi.fn(async () => ({kind: "elapsed" as const}));
    await expect(fixture.scope.wait({...request(), operation: {...request().operation, runId: "other"}}, arm)).rejects.toThrow("belong");
    expect(arm).not.toHaveBeenCalled();
    const waiting = fixture.scope.wait(request(), () => new Promise(() => {}));
    await expect(fixture.scope.wait(request(), arm)).rejects.toThrow("overlap");
    fixture.scope.dispose(); await waiting;
  });

  it("only an invocation's own retry bookkeeping preserves its decision basis", () => {
    const basis = new RunDecisionBasis();
    basis.capture("a", 2); basis.capture("b", 2);
    basis.committed(3, "a");
    expect(basis.revision("a", 3)).toBe(2);
    expect(basis.revision("b", 3)).toBe(3);
    basis.committed(4, null);
    expect(basis.revision("a", 4)).toBe(4);
    basis.release("a");
    expect(basis.revision("a", 9)).toBe(9);
  });
});

function setup() {
  const cancellation = createRunCancellationController({runId: "run"});
  const state = {status: "running" as RunStatus, revision: 2};
  const open = vi.fn<(pending: Parameters<ConstructorParameters<typeof RunRetryWaitScope>[0]["open"]>[0]) => void>();
  const close = vi.fn();
  const ready = vi.fn();
  const fixture = {cancellation, state, open, close, ready, current: true, scope: null as unknown as RunRetryWaitScope};
  fixture.scope = new RunRetryWaitScope({
    runId: "run", invocationId: "turn", branchId: "turn", deadlineAt: new Date(Date.now() + 1000).toISOString(),
    cancellation: cancellation.context, now: () => new Date().toISOString(), snapshot: () => state,
    isCurrent: () => fixture.current, open, close, ready,
  });
  return fixture;
}

const NOW = "2026-09-12T00:00:00.000Z";
function request(): RetryWaitRequest {
  return {
    operation: {runId: "run", operationId: "operation", owner: "provider_request", subject: {kind: "provider_request", controllerRequestId: "turn"}, startedAt: NOW},
    precedingAttempt: {attemptId: "attempt", operationId: "operation", budgetId: "budget", attemptNumber: 1, budgetAttemptNumber: 1, retryNumber: 0, maxBudgetAttempts: 2, startedAt: NOW},
    policy: {maxRetries: 1, delay: {kind: "exponential_jitter", baseDelayMs: 10, maxDelayMs: 100, multiplier: 2, jitterRatio: 0.1}, retryableCategories: ["transport"], serverDelay: {mode: "ignore"}},
    delay: {delayMs: 10, source: "calculated_backoff", scheduledAt: NOW, nextAttemptAt: "2026-09-12T00:00:00.010Z"},
  };
}
