import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import type { StopLifecycleEvent } from "../lifecycle/index.js";
import {
  matchingRunLifecycleHooks,
  type RunLifecycleHookComposition,
  type RunLifecycleHookRef,
  type StopFailureHookHandler,
  type StopHookDecision,
  type StopHookHandler,
} from "./RunLifecycleHook.js";

export type StopHookInvocationOutcome =
  | { readonly status: "decided"; readonly decision: StopHookDecision }
  | {
      readonly status: "non_blocking_error";
      readonly code:
        | "hook_unavailable"
        | "hook_timed_out"
        | "hook_cancelled"
        | "hook_output_invalid"
        | "hook_failed";
      readonly message: string;
    };

export interface StopHookInvocationRecord {
  readonly hook: RunLifecycleHookRef;
  readonly eventId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly outcome: StopHookInvocationOutcome;
  readonly stale: boolean;
}

export interface StopHookFeedbackRecord {
  readonly eventId: string;
  readonly epoch: number;
  readonly round: number;
  readonly codes: readonly string[];
  readonly message: string;
  readonly omittedReasonCount: number;
}

export interface RunLifecycleHookState {
  readonly stopEventSequence: number;
  readonly stopFailureEventSequence: number;
  readonly feedbackEpoch: number;
  readonly consecutiveBlockingRounds: number;
  readonly latestEventId: string | null;
  readonly latestInvocations: readonly StopHookInvocationRecord[];
  readonly latestFeedback: StopHookFeedbackRecord | null;
  readonly limitations: readonly string[];
}

export interface RunLifecycleHookProjection extends RunLifecycleHookState {}

export interface MergedStopHookDecision {
  readonly kind: "allow" | "block";
  readonly feedback: string | null;
  readonly blockCodes: readonly string[];
  readonly omittedReasonCount: number;
  readonly invocations: readonly StopHookInvocationRecord[];
}

export async function invokeStopLifecycleHooks(input: {
  readonly composition: RunLifecycleHookComposition;
  readonly runKind: "root" | "descendant";
  readonly event: StopLifecycleEvent;
  readonly interruption: InvocationInterruptionContext;
  readonly runDeadlineAt: string;
  readonly now: () => string;
}): Promise<MergedStopHookDecision> {
  const matches = matchingRunLifecycleHooks(input.composition, "Stop", input.runKind);
  const invocations = await Promise.all(matches.map(async ({ registration, binding }) => {
    const startedAt = input.now();
    const local = new AbortController();
    const abortForRun = () => local.abort();
    if (input.interruption.signal.aborted) local.abort();
    else input.interruption.signal.addEventListener("abort", abortForRun, { once: true });
    const deadlineMs = Math.min(
      Date.parse(input.runDeadlineAt),
      Date.parse(startedAt) + registration.timeoutMs,
    );
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      local.abort();
    }, Math.max(1, deadlineMs - Date.parse(startedAt)));
    let outcome: StopHookInvocationOutcome;
    try {
      const decision = await (binding.handler as StopHookHandler).handle(
        input.event,
        Object.freeze({ signal: local.signal, interruption: input.interruption.interruption }),
      );
      outcome = validateDecision(decision, registration.maximumResultBytes);
    } catch (error) {
      outcome = Object.freeze({
        status: "non_blocking_error" as const,
        code: timedOut
          ? "hook_timed_out" as const
          : input.interruption.signal.aborted
            ? "hook_cancelled" as const
            : "hook_failed" as const,
        message: boundedMessage(error instanceof Error ? error.message : "Lifecycle Hook failed."),
      });
    } finally {
      clearTimeout(timer);
      input.interruption.signal.removeEventListener("abort", abortForRun);
    }
    const completedAt = input.now();
    return Object.freeze({
      hook: registration.ref,
      eventId: input.event.ref.id,
      startedAt,
      completedAt,
      durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
      outcome,
      stale: false,
    });
  }));
  return mergeStopHookInvocations(invocations);
}

export function observeStopFailureLifecycleHooks(input: {
  readonly composition: RunLifecycleHookComposition;
  readonly runKind: "root" | "descendant";
  readonly event: import("../lifecycle/index.js").StopFailureLifecycleEvent;
  readonly interruption: InvocationInterruptionContext;
}): void {
  const matches = matchingRunLifecycleHooks(input.composition, "StopFailure", input.runKind);
  for (const { registration, binding } of matches) {
    const local = new AbortController();
    const abortForRun = () => local.abort();
    if (input.interruption.signal.aborted) local.abort();
    else input.interruption.signal.addEventListener("abort", abortForRun, { once: true });
    const timer = setTimeout(() => local.abort(), registration.timeoutMs);
    try {
      void Promise.resolve((binding.handler as StopFailureHookHandler).observe(
        input.event,
        Object.freeze({
          signal: local.signal,
          interruption: input.interruption.interruption,
        }),
      )).catch(() => undefined).finally(() => {
        clearTimeout(timer);
        input.interruption.signal.removeEventListener("abort", abortForRun);
      });
    } catch {
      clearTimeout(timer);
      input.interruption.signal.removeEventListener("abort", abortForRun);
      // StopFailure is best-effort observation and never a settlement barrier.
    }
  }
}

export function mergeStopHookInvocations(
  invocations: readonly StopHookInvocationRecord[],
): MergedStopHookDecision {
  const blocks = invocations.flatMap((invocation) =>
    invocation.outcome.status === "decided" && invocation.outcome.decision.kind === "block"
      ? [Object.freeze({ hook: invocation.hook, decision: invocation.outcome.decision })]
      : []);
  const seen = new Set<string>();
  const unique = blocks.filter(({ hook, decision }) => {
    const key = `${hook.id}\0${hook.revision}\0${decision.code}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  let remaining = 8_192;
  const reasons: string[] = [];
  let omittedReasonCount = 0;
  for (const { decision } of unique) {
    const value = `[${decision.code}] ${decision.reason}`;
    if (value.length > remaining) {
      omittedReasonCount += 1;
      continue;
    }
    reasons.push(value);
    remaining -= value.length + 1;
  }
  return Object.freeze({
    kind: unique.length === 0 ? "allow" as const : "block" as const,
    feedback: reasons.length === 0 ? null : reasons.join("\n"),
    blockCodes: Object.freeze(unique.map(({ decision }) => decision.code)),
    omittedReasonCount,
    invocations: Object.freeze([...invocations]),
  });
}

export function createInitialRunLifecycleHookState(): RunLifecycleHookState {
  return Object.freeze({
    stopEventSequence: 0,
    stopFailureEventSequence: 0,
    feedbackEpoch: 0,
    consecutiveBlockingRounds: 0,
    latestEventId: null,
    latestInvocations: Object.freeze([]),
    latestFeedback: null,
    limitations: Object.freeze([]),
  });
}

export function projectRunLifecycleHooks(
  state: RunLifecycleHookState,
): RunLifecycleHookProjection {
  return deepFreeze({ ...state });
}

export function advanceRunLifecycleHookFeedbackEpoch(
  state: RunLifecycleHookState,
): RunLifecycleHookState {
  return deepFreeze({
    ...state,
    feedbackEpoch: state.feedbackEpoch + 1,
    consecutiveBlockingRounds: 0,
    latestFeedback: null,
  });
}

function validateDecision(value: unknown, maximumResultBytes: number): StopHookInvocationOutcome {
  let encodedBytes: number;
  try {
    encodedBytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return invalid("Lifecycle Hook returned a non-serializable decision.");
  }
  if (encodedBytes > maximumResultBytes) return invalid("Lifecycle Hook result exceeded its bound.");
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid("Lifecycle Hook decision must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "allow" && Object.keys(record).length === 1) {
    return Object.freeze({ status: "decided", decision: Object.freeze({ kind: "allow" }) });
  }
  if (record.kind === "block" && Object.keys(record).every((key) => ["kind", "code", "reason"].includes(key)) &&
      typeof record.code === "string" && record.code.trim().length > 0 && record.code === record.code.trim() &&
      typeof record.reason === "string" && record.reason.trim().length > 0 && record.reason.length <= 4_096) {
    return Object.freeze({
      status: "decided",
      decision: Object.freeze({ kind: "block", code: record.code, reason: record.reason }),
    });
  }
  return invalid("Lifecycle Hook decision shape is invalid.");
}

function invalid(message: string): StopHookInvocationOutcome {
  return Object.freeze({
    status: "non_blocking_error" as const,
    code: "hook_output_invalid" as const,
    message: boundedMessage(message),
  });
}

function boundedMessage(value: string): string {
  return value.length <= 4_096 ? value : `${value.slice(0, 4_093)}...`;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
