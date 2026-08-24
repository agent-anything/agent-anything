import type { RunCounters } from "../run/index.js";
import type { RunLimits } from "./RunConfig.js";

export interface RunLimitViolation {
  readonly code: "runtime_limit_exceeded" | "runtime_deadline_exceeded";
  readonly message: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export function evaluateRunDeadline(input: {
  readonly deadlineAt: string;
  readonly now: string;
}): RunLimitViolation | null {
  if (Date.parse(input.now) >= Date.parse(input.deadlineAt)) {
    return violation("runtime_deadline_exceeded", "Run deadline elapsed.", { deadlineAt: input.deadlineAt });
  }
  return null;
}

export function evaluateRunNumericLimits(input: {
  readonly counters: RunCounters;
  readonly limits: RunLimits;
}): RunLimitViolation | null {
  if (input.counters.controllerTurns >= input.limits.maxIterations) {
    return violation("runtime_limit_exceeded", "Run exceeded maxIterations.", { maxIterations: input.limits.maxIterations });
  }
  if (input.counters.runActions >= input.limits.maxActions) {
    return violation("runtime_limit_exceeded", "Run exceeded maxActions.", { maxActions: input.limits.maxActions });
  }
  if (input.counters.consecutiveActionFailures > input.limits.maxConsecutiveActionFailures) {
    return violation("runtime_limit_exceeded", "Run exceeded maxConsecutiveActionFailures.", { maxConsecutiveActionFailures: input.limits.maxConsecutiveActionFailures });
  }
  return null;
}

function violation(code: RunLimitViolation["code"], message: string, metadata: Readonly<Record<string, unknown>>): RunLimitViolation {
  return Object.freeze({ code, message, metadata: Object.freeze({ ...metadata }) });
}
