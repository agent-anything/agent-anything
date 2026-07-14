import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunCancellationController } from "../runner/RunCancellation.js";
import {
  cancellationAttribution,
  createRetryAttemptInterruptionFactory,
  createRetryWait,
  defaultRetryIdGenerator,
  systemRetryClock,
} from "./RetryDependencies.js";
import type {
  RetryClock,
  RetryExecutorDependencies,
  RetryWait,
} from "./RetryExecution.js";
import type { RetryEvent } from "./RetryEvent.js";
import { RetryExecutor } from "./RetryExecutor.js";

interface AttemptError {
  readonly category: string;
  readonly code: string;
  readonly disposition: "retryable" | "non_retryable" | "deadline_exceeded";
  readonly retryAfterMs?: number;
}

describe("RetryExecutor", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses maxRetries as additional attempts and returns internal budget exhaustion", async () => {
    const harness = createHarness();
    const attempts: number[] = [];
    const result = await harness.executor.execute(
      harness.input({ maxRetries: 2 }),
      async ({ attempt }) => {
        attempts.push(attempt.attemptNumber);
        return { kind: "failed", error: retryableError() };
      },
    );

    expect(result).toMatchObject({
      kind: "budget_exhausted",
      exhaustion: {
        progress: { completedAttempts: 3, totalRetryDelayMs: 300 },
        lastFailure: { category: "transport" },
      },
    });
    expect(attempts).toEqual([1, 2, 3]);
    expect(harness.events.map((event) => event.type)).toEqual([
      "retry_attempt_started",
      "retry_attempt_finished",
      "retry_scheduled",
      "retry_attempt_started",
      "retry_attempt_finished",
      "retry_scheduled",
      "retry_attempt_started",
      "retry_attempt_finished",
    ]);
    expect(harness.events).not.toContainEqual(expect.objectContaining({
      type: "retry_exhausted",
    }));
    expect(harness.attemptIds).toEqual([
      "retry_001:attempt:1",
      "retry_001:attempt:2",
      "retry_001:attempt:3",
    ]);
  });

  it("returns success after a retry with stable operation identity", async () => {
    const harness = createHarness();
    let calls = 0;
    const result = await harness.executor.execute(
      harness.input({ maxRetries: 1 }),
      async ({ attempt }) => {
        calls += 1;
        expect(attempt.operationId).toBe("retry_001");
        return calls === 1
          ? { kind: "failed", error: retryableError() }
          : { kind: "succeeded", value: "done" };
      },
    );

    expect(result).toEqual({ kind: "succeeded", value: "done" });
    expect(harness.waitedDelays).toEqual([100]);
  });

  it("returns non-retryable and policy-disabled failures after one attempt", async () => {
    for (const input of [
      { error: { ...retryableError(), disposition: "non_retryable" as const } },
      { error: retryableError(), retryableCategories: [] as string[] },
    ]) {
      const harness = createHarness();
      let calls = 0;
      const result = await harness.executor.execute(
        harness.input({
          maxRetries: 3,
          retryableCategories: input.retryableCategories,
        }),
        async () => {
          calls += 1;
          return { kind: "failed", error: input.error };
        },
      );

      expect(result.kind).toBe("failed");
      expect(calls).toBe(1);
      expect(harness.waitedDelays).toEqual([]);
    }
  });

  it("prefers bounded trusted server delay and ignores malformed delay", async () => {
    const trusted = createHarness();
    let trustedCalls = 0;
    await trusted.executor.execute(
      trusted.input({
        maxRetries: 1,
        serverDelay: { mode: "prefer_trusted", maxServerDelayMs: 500 },
      }),
      async () => ++trustedCalls === 1
        ? { kind: "failed", error: retryableError({ retryAfterMs: 250 }) }
        : { kind: "succeeded", value: "done" },
    );
    const trustedSchedule = trusted.events.find((event) => event.type === "retry_scheduled");
    expect(trusted.waitedDelays).toEqual([250]);
    expect(trustedSchedule).toMatchObject({ delaySource: "trusted_server_delay" });

    const malformed = createHarness();
    let malformedCalls = 0;
    await malformed.executor.execute(
      malformed.input({
        maxRetries: 1,
        serverDelay: { mode: "prefer_trusted", maxServerDelayMs: 500 },
      }),
      async () => ++malformedCalls === 1
        ? { kind: "failed", error: retryableError({ retryAfterMs: -1 }) }
        : { kind: "succeeded", value: "done" },
    );
    expect(malformed.waitedDelays).toEqual([100]);
  });

  it("stops instead of clamping trusted server delay above its limit", async () => {
    const harness = createHarness();
    const result = await harness.executor.execute(
      harness.input({
        maxRetries: 2,
        serverDelay: { mode: "prefer_trusted", maxServerDelayMs: 500 },
      }),
      async () => ({
        kind: "failed",
        error: retryableError({ retryAfterMs: 501 }),
      }),
    );

    expect(result.kind).toBe("failed");
    expect(harness.waitedDelays).toEqual([]);
    expect(harness.events.map((event) => event.type)).toEqual([
      "retry_attempt_started",
      "retry_attempt_finished",
    ]);
  });

  it("emits zero-attempt deadline exhaustion before initial work", async () => {
    const harness = createHarness({ now: "2026-07-14T00:00:01.000Z" });
    let called = false;
    const result = await harness.executor.execute(
      harness.input({ deadlineAt: "2026-07-14T00:00:00.500Z" }),
      async () => {
        called = true;
        return { kind: "succeeded", value: "unused" };
      },
    );

    expect(called).toBe(false);
    expect(result).toMatchObject({
      kind: "deadline_exhausted",
      exhaustion: { totalAttempts: 0, lastFailure: null },
    });
    expect(harness.events.map((event) => event.type)).toEqual(["retry_exhausted"]);
  });

  it("does not schedule a delay that reaches the operation deadline", async () => {
    const harness = createHarness();
    const result = await harness.executor.execute(
      harness.input({ deadlineAt: "2026-07-14T00:00:00.100Z" }),
      async () => ({ kind: "failed", error: retryableError() }),
    );

    expect(result.kind).toBe("deadline_exhausted");
    expect(harness.waitedDelays).toEqual([]);
    expect(harness.events.map((event) => event.type)).toEqual([
      "retry_attempt_started",
      "retry_attempt_finished",
      "retry_exhausted",
    ]);
  });

  it("cancels before attempt without inventing attempt history", async () => {
    const harness = createHarness();
    harness.cancellation.requestCancellation({
      origin: "user",
      reasonCode: "user_requested",
    });
    let called = false;
    const result = await harness.executor.execute(harness.input(), async () => {
      called = true;
      return { kind: "succeeded", value: "unused" };
    });

    expect(result.kind).toBe("cancelled");
    expect(called).toBe(false);
    expect(harness.events.map((event) => event.type)).toEqual(["retry_cancelled"]);
    expect(harness.events[0]).toMatchObject({ phase: "before_attempt", attemptId: null });
  });

  it("cancels during backoff and starts no later attempt", async () => {
    const clock = new MutableClock("2026-07-14T00:00:00.000Z");
    const cancellation = createRunCancellationController({ runId: "run_001" });
    const wait: RetryWait = {
      async wait() {
        cancellation.requestCancellation({ origin: "host", reasonCode: "host_requested" });
        return {
          kind: "cancelled",
          attribution: cancellationAttribution(cancellation.context, clock),
        };
      },
    };
    const harness = createHarness({ clock, cancellation, wait });
    let calls = 0;
    const result = await harness.executor.execute(harness.input(), async () => {
      calls += 1;
      return { kind: "failed", error: retryableError() };
    });

    expect(result.kind).toBe("cancelled");
    expect(calls).toBe(1);
    expect(harness.events.at(-1)).toMatchObject({
      type: "retry_cancelled",
      phase: "backoff",
    });
  });

  it("emits attempt-finished before cancellation for an exactly cancelled attempt", async () => {
    const harness = createHarness();
    const result = await harness.executor.execute(harness.input(), async () => {
      harness.cancellation.requestCancellation({
        origin: "user",
        reasonCode: "user_requested",
      });
      return {
        kind: "cancelled",
        attribution: cancellationAttribution(harness.cancellation.context, harness.clock),
      };
    });

    expect(result.kind).toBe("cancelled");
    expect(harness.events.map((event) => event.type)).toEqual([
      "retry_attempt_started",
      "retry_attempt_finished",
      "retry_cancelled",
    ]);
    expect(harness.events[1]).toMatchObject({ outcome: "cancelled", next: "cancelled" });
  });

  it("preserves typed failure when cancellation arrives after attempt settlement", async () => {
    const harness = createHarness();
    const result = await harness.executor.execute(harness.input(), async () => {
      harness.cancellation.requestCancellation({
        origin: "user",
        reasonCode: "user_requested",
      });
      return { kind: "failed", error: retryableError() };
    });

    expect(result).toMatchObject({ kind: "failed", failure: { code: "transport_failed" } });
    expect(harness.events.map((event) => event.type)).toEqual([
      "retry_attempt_started",
      "retry_attempt_finished",
    ]);
    expect(harness.events[1]).toMatchObject({ next: "return_to_owner" });
  });

  it("does not classify or retry unexpected implementation rejection", async () => {
    const harness = createHarness();
    await expect(harness.executor.execute(harness.input(), async () => {
      throw new Error("implementation failed");
    })).rejects.toThrow("implementation failed");

    expect(harness.events.map((event) => event.type)).toEqual([
      "retry_attempt_started",
    ]);
    expect(harness.waitedDelays).toEqual([]);
  });

  it("does not start an attempt when the required event sink fails", async () => {
    const harness = createHarness();
    const input = harness.input();
    let called = false;

    await expect(harness.executor.execute({
      ...input,
      events: {
        emit() {
          throw new Error("event sink failed");
        },
      },
    }, async () => {
      called = true;
      return { kind: "succeeded", value: "unused" };
    })).rejects.toThrow("event sink failed");

    expect(called).toBe(false);
    expect(harness.waitedDelays).toEqual([]);
  });

  it("returns an allowlisted safe classifier failure", async () => {
    const harness = createHarness();
    const input = harness.input({ maxRetries: 0 });
    const result = await harness.executor.execute({
      ...input,
      classifier: {
        classify() {
          return {
            disposition: "non_retryable" as const,
            reasonCode: "transport_failed",
            failure: {
              category: "transport",
              code: "transport_failed",
              message: "Safe failure.",
              retryAfterMs: -1,
              secret: "must not survive",
            },
          };
        },
      },
    }, async () => ({ kind: "failed", error: retryableError() }));

    expect(result).toEqual({
      kind: "failed",
      error: retryableError(),
      failure: {
        category: "transport",
        code: "transport_failed",
        message: "Safe failure.",
      },
    });
    expect(result).not.toHaveProperty("failure.secret");
    expect(result).not.toHaveProperty("failure.retryAfterMs");
  });

  it("continues operation-wide numbering from prior progress", async () => {
    const harness = createHarness();
    const result = await harness.executor.execute(
      harness.input({
        maxRetries: 0,
        priorProgress: { completedAttempts: 3, totalRetryDelayMs: 50 },
      }),
      async () => ({ kind: "failed", error: retryableError() }),
    );

    expect(harness.events[0]).toMatchObject({
      type: "retry_attempt_started",
      attemptNumber: 4,
      budgetAttemptNumber: 1,
    });
    expect(result).toMatchObject({
      kind: "budget_exhausted",
      exhaustion: {
        progress: { completedAttempts: 4, totalRetryDelayMs: 50 },
      },
    });
  });

  it("keeps calculated jitter within the declared bounded interval", async () => {
    for (let index = 0; index < 100; index += 1) {
      const harness = createHarness({ randomUnit: index / 100 });
      let calls = 0;
      await harness.executor.execute(
        harness.input({ maxRetries: 1 }),
        async () => ++calls === 1
          ? { kind: "failed", error: retryableError() }
          : { kind: "succeeded", value: "done" },
      );
      expect(harness.waitedDelays[0]).toBeGreaterThanOrEqual(90);
      expect(harness.waitedDelays[0]).toBeLessThan(110);
    }
  });

  it("attributes an active operation deadline without calling it Run cancellation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-14T00:00:00.000Z");
    const cancellation = createRunCancellationController({ runId: "run_001" });
    const events: RetryEvent[] = [];
    const executor = new RetryExecutor({
      clock: systemRetryClock,
      ids: defaultRetryIdGenerator,
      random: { nextUnit: () => 0.5 },
      wait: createRetryWait(systemRetryClock),
      interruptions: createRetryAttemptInterruptionFactory(systemRetryClock),
    });
    const run = executor.execute(
      baseInput(cancellation, events, {
        deadlineAt: "2026-07-14T00:00:00.025Z",
      }),
      async ({ signal }) => new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve({
          kind: "failed",
          error: {
            ...retryableError(),
            disposition: "deadline_exceeded",
          },
        }), { once: true });
      }),
    );

    await vi.advanceTimersByTimeAsync(25);
    const result = await run;

    expect(result.kind).toBe("deadline_exhausted");
    expect(events.map((event) => event.type)).toEqual([
      "retry_attempt_started",
      "retry_attempt_finished",
      "retry_exhausted",
    ]);
    expect(cancellation.context.request).toBeNull();
  });
});

function createHarness(input: {
  readonly now?: string;
  readonly clock?: MutableClock;
  readonly cancellation?: ReturnType<typeof createRunCancellationController>;
  readonly wait?: RetryWait;
  readonly randomUnit?: number;
} = {}) {
  const clock = input.clock ?? new MutableClock(input.now ?? "2026-07-14T00:00:00.000Z");
  const cancellation = input.cancellation ?? createRunCancellationController({ runId: "run_001" });
  const events: RetryEvent[] = [];
  const waitedDelays: number[] = [];
  const attemptIds: string[] = [];
  const wait: RetryWait = input.wait ?? {
    async wait(delayMs) {
      waitedDelays.push(delayMs);
      clock.advance(delayMs);
      return { kind: "elapsed" };
    },
  };
  const dependencies: RetryExecutorDependencies = {
    clock,
    ids: {
      createAttemptId(operationId, attemptNumber) {
        const id = `${operationId}:attempt:${attemptNumber}`;
        attemptIds.push(id);
        return id;
      },
    },
    random: { nextUnit: () => input.randomUnit ?? 0.5 },
    wait,
    interruptions: {
      create(_operation, context) {
        return {
          signal: context.signal,
          deadlineReason: null,
          dispose() {},
        };
      },
    },
  };
  const executor = new RetryExecutor(dependencies);

  return {
    clock,
    cancellation,
    events,
    waitedDelays,
    attemptIds,
    executor,
    input(overrides: {
      readonly maxRetries?: number;
      readonly retryableCategories?: readonly string[];
      readonly serverDelay?: { readonly mode: "ignore" } | {
        readonly mode: "prefer_trusted";
        readonly maxServerDelayMs: number;
      };
      readonly deadlineAt?: string;
      readonly priorProgress?: { readonly completedAttempts: number; readonly totalRetryDelayMs: number };
    } = {}) {
      return baseInput(cancellation, events, overrides);
    },
  };
}

function baseInput(
  cancellation: ReturnType<typeof createRunCancellationController>,
  events: RetryEvent[],
  overrides: {
    readonly maxRetries?: number;
    readonly retryableCategories?: readonly string[];
    readonly serverDelay?: { readonly mode: "ignore" } | {
      readonly mode: "prefer_trusted";
      readonly maxServerDelayMs: number;
    };
    readonly deadlineAt?: string;
    readonly priorProgress?: { readonly completedAttempts: number; readonly totalRetryDelayMs: number };
  } = {},
) {
  return {
    operation: {
      operationId: "retry_001",
      owner: "provider_request" as const,
      runId: "run_001",
      subject: {
        kind: "provider_request" as const,
        controllerRequestId: "controller_001",
      },
      startedAt: "2026-07-14T00:00:00.000Z",
      ...(overrides.deadlineAt === undefined ? {} : { deadlineAt: overrides.deadlineAt }),
    },
    budgetId: "budget_001",
    priorProgress: overrides.priorProgress ?? {
      completedAttempts: 0,
      totalRetryDelayMs: 0,
    },
    policy: {
      maxRetries: overrides.maxRetries ?? 2,
      delay: {
        kind: "exponential_jitter" as const,
        baseDelayMs: 100,
        maxDelayMs: 1_000,
        multiplier: 2 as const,
        jitterRatio: 0.1 as const,
      },
      retryableCategories: overrides.retryableCategories ?? ["transport"],
      serverDelay: overrides.serverDelay ?? { mode: "ignore" as const },
    },
    classifier: {
      classify(error: AttemptError) {
        return {
          failure: {
            category: error.category,
            code: error.code,
            message: "Safe failure.",
            retryAfterMs: error.retryAfterMs,
          },
          disposition: error.disposition,
          reasonCode: error.code,
        };
      },
    },
    cancellation: cancellation.context,
    events: {
      emit(event: RetryEvent) {
        events.push(event);
      },
    },
  };
}

function retryableError(overrides: Partial<AttemptError> = {}): AttemptError {
  return {
    category: "transport",
    code: "transport_failed",
    disposition: "retryable",
    ...overrides,
  };
}

class MutableClock implements RetryClock {
  private currentMs: number;

  constructor(value: string) {
    this.currentMs = Date.parse(value);
  }

  now(): Date {
    return new Date(this.currentMs);
  }

  advance(delayMs: number): void {
    this.currentMs += delayMs;
  }
}
