import type { RunCounters } from "../run/index.js";
import type { RunLimits } from "./RunConfig.js";

export interface RunLimitViolation {
  readonly message: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface EvaluateRunLoopLimitsInput {
  readonly counters: RunCounters;
  readonly limits: RunLimits;
  readonly startedAtMs: number;
  readonly nowMs: number;
  readonly cancellationRequested: boolean;
}

export function evaluateRunLoopLimits(
  input: EvaluateRunLoopLimitsInput,
): RunLimitViolation | null {
  if (input.cancellationRequested) {
    return null;
  }
  const duration = evaluateRunDurationLimit(input);
  if (duration !== null) {
    return duration;
  }
  if (input.counters.iterations >= input.limits.maxIterations) {
    return violation("Run exceeded maxIterations.", {
      maxIterations: input.limits.maxIterations,
    });
  }
  if (
    input.counters.consecutiveActionFailures >
    input.limits.maxConsecutiveActionFailures
  ) {
    return violation("Run exceeded maxConsecutiveActionFailures.", {
      maxConsecutiveActionFailures:
        input.limits.maxConsecutiveActionFailures,
      actualConsecutiveActionFailures:
        input.counters.consecutiveActionFailures,
    });
  }
  return null;
}

export function evaluateRunDurationLimit(
  input: Pick<
    EvaluateRunLoopLimitsInput,
    "limits" | "startedAtMs" | "nowMs"
  >,
): RunLimitViolation | null {
  const elapsedMs = input.nowMs - input.startedAtMs;
  return elapsedMs > input.limits.maxDurationMs
    ? violation("Run exceeded maxDurationMs.", {
        maxDurationMs: input.limits.maxDurationMs,
        elapsedMs,
      })
    : null;
}

function violation(
  message: string,
  metadata: Readonly<Record<string, unknown>>,
): RunLimitViolation {
  return Object.freeze({
    message,
    metadata: Object.freeze({ ...metadata }),
  });
}
