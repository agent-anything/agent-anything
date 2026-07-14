import type {
  CancellationAttribution,
  CancellationContext,
  RunCancellationRequest,
} from "../runner/RunCancellation.js";
import type {
  RetryAttemptInterruption,
  RetryAttemptInterruptionFactory,
  RetryClock,
  RetryDeadlineExceeded,
  RetryIdGenerator,
  RetryRandomSource,
  RetryWait,
} from "./RetryExecution.js";
import type { RetryOperation } from "./RetryOperation.js";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export const systemRetryClock: RetryClock = Object.freeze({
  now: () => new Date(),
});

export const defaultRetryIdGenerator: RetryIdGenerator = Object.freeze({
  createAttemptId: (operationId: string, attemptNumber: number) =>
    `${operationId}:attempt:${attemptNumber}`,
});

export const systemRetryRandomSource: RetryRandomSource = Object.freeze({
  nextUnit: () => Math.random(),
});

export function createRetryWait(clock: RetryClock = systemRetryClock): RetryWait {
  const retryWait: RetryWait = {
    wait(delayMs: number, cancellation: CancellationContext) {
      assertDelay(delayMs);
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback: () => void): void => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          cancellation.signal.removeEventListener("abort", onAbort);
          callback();
        };
        const onAbort = (): void => {
          try {
            const attribution = cancellationAttribution(cancellation, clock);
            finish(() => resolve({ kind: "cancelled", attribution }));
          } catch (error) {
            finish(() => reject(error));
          }
        };
        const timer = setTimeout(() => finish(() => resolve({ kind: "elapsed" })), delayMs);
        cancellation.signal.addEventListener("abort", onAbort, { once: true });
        if (cancellation.signal.aborted) {
          onAbort();
        }
      });
    },
  };
  return Object.freeze(retryWait);
}

export function createRetryAttemptInterruptionFactory(
  clock: RetryClock = systemRetryClock,
): RetryAttemptInterruptionFactory {
  const factory: RetryAttemptInterruptionFactory = {
    create(operation: RetryOperation, cancellation: CancellationContext) {
      return createRetryAttemptInterruption(operation, cancellation, clock);
    },
  };
  return Object.freeze(factory);
}

export function cancellationAttribution(
  cancellation: CancellationContext,
  clock: RetryClock,
): CancellationAttribution {
  const request = exactCancellationRequest(cancellation);
  return Object.freeze({
    requestId: request.id,
    runId: request.runId,
    boundary: "retry_wait",
    observedAt: now(clock).toISOString(),
  });
}

export function exactCancellationRequest(
  cancellation: CancellationContext,
): RunCancellationRequest {
  if (!cancellation.signal.aborted || cancellation.request === null) {
    throw new TypeError("Retry cancellation requires an aborted signal with an accepted request.");
  }
  if (cancellation.request.runId !== cancellation.runId) {
    throw new TypeError("Retry cancellation request runId does not match its context.");
  }
  return cancellation.request;
}

function createRetryAttemptInterruption(
  operation: RetryOperation,
  cancellation: CancellationContext,
  clock: RetryClock,
): RetryAttemptInterruption {
  const controller = new AbortController();
  let deadlineReason: RetryDeadlineExceeded | null = null;
  let cause: "cancellation" | "deadline" | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const abortFromCancellation = (): void => {
    if (cause !== null) {
      return;
    }
    cause = "cancellation";
    controller.abort(cancellation.signal.reason);
  };

  const abortFromDeadline = (): void => {
    if (cause !== null || operation.deadlineAt === undefined) {
      return;
    }
    cause = "deadline";
    deadlineReason = Object.freeze({
      kind: "retry_deadline_exceeded",
      operationId: operation.operationId,
      deadlineAt: operation.deadlineAt,
    });
    controller.abort(deadlineReason);
  };

  const scheduleDeadline = (): void => {
    if (cause !== null || operation.deadlineAt === undefined) {
      return;
    }
    const remainingMs = Date.parse(operation.deadlineAt) - now(clock).getTime();
    if (remainingMs <= 0) {
      abortFromDeadline();
      return;
    }
    timer = setTimeout(
      scheduleDeadline,
      Math.min(remainingMs, MAX_TIMER_DELAY_MS),
    );
  };

  cancellation.signal.addEventListener("abort", abortFromCancellation, { once: true });
  if (cancellation.signal.aborted) {
    abortFromCancellation();
  }
  scheduleDeadline();

  return Object.freeze({
    signal: controller.signal,
    get deadlineReason() {
      return deadlineReason;
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
      cancellation.signal.removeEventListener("abort", abortFromCancellation);
    },
  });
}

function now(clock: RetryClock): Date {
  const value = clock.now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("RetryClock.now() must return a valid Date.");
  }
  return value;
}

function assertDelay(delayMs: number): void {
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > MAX_TIMER_DELAY_MS) {
    throw new TypeError(`Retry delay must be between 0 and ${MAX_TIMER_DELAY_MS}.`);
  }
}
