import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import {
  matchingAgentHooks,
  type AgentHookBinding,
  type AgentHookComposition,
  type AgentHookExecutionMode,
  type AgentHookRef,
  type AgentStopFailureObserver,
  type AgentStopHandler,
  type AgentStopHandlerResult,
  type AgentStopObserver,
} from "../composition/index.js";
import type { AgentHookPoint, AgentStopEvent, AgentStopFailureEvent } from "../events/index.js";

export type AgentHookInvocationStatus =
  | "allowed"
  | "continued"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "output_invalid";

export interface AgentHookInvocationRecord {
  readonly id: string;
  readonly runId: string;
  readonly eventId: string;
  readonly hook: AgentHookRef;
  readonly point: AgentHookPoint;
  readonly mode: AgentHookExecutionMode;
  readonly status: AgentHookInvocationStatus;
  readonly code: string | null;
  readonly message: string | null;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
}

export interface AgentHookProjection {
  readonly revision: number;
  readonly invocationCount: number;
  readonly recentInvocations: readonly AgentHookInvocationRecord[];
}

export type AgentHookProjectionListener = (projection: AgentHookProjection) => void;

export class AgentHookExecutionStore {
  private records: readonly AgentHookInvocationRecord[] = Object.freeze([]);
  private revision = 0;
  private readonly listeners = new Set<AgentHookProjectionListener>();

  append(record: AgentHookInvocationRecord): void {
    this.revision += 1;
    this.records = Object.freeze([...this.records.slice(-63), record]);
    const projection = this.getProjection();
    for (const listener of [...this.listeners]) {
      try { listener(projection); } catch { /* Projection consumers are non-authoritative. */ }
    }
  }

  getProjection(): AgentHookProjection {
    return Object.freeze({
      revision: this.revision,
      invocationCount: this.revision,
      recentInvocations: Object.freeze([...this.records]),
    });
  }

  subscribe(listener: AgentHookProjectionListener): () => void {
    if (typeof listener !== "function") throw new TypeError("Agent Hook listener must be a function.");
    this.listeners.add(listener);
    try { listener(this.getProjection()); } catch { /* Projection consumers are non-authoritative. */ }
    return () => { this.listeners.delete(listener); };
  }
}

export interface AgentStopDispatchResult {
  readonly disposition: "allow" | "continue";
  readonly codes: readonly string[];
  readonly message: string | null;
  readonly omittedMessageCount: number;
}

export async function dispatchAgentStopHooks(input: {
  readonly composition: AgentHookComposition;
  readonly event: AgentStopEvent;
  readonly interruption: InvocationInterruptionContext;
  readonly deadlineAt: string;
  readonly store: AgentHookExecutionStore;
  readonly now: () => string;
}): Promise<AgentStopDispatchResult> {
  const matches = matchingAgentHooks(input.composition, "Stop", input.event.runKind);
  const blocking = matches.filter((match) => match.registration.mode === "blocking");
  const background = matches.filter((match) => match.registration.mode === "background");
  for (const match of background) {
    void invokeObserver(match, input.event, input.interruption, input.deadlineAt, input.store, input.now);
  }
  const outcomes = await Promise.all(blocking.map((match) =>
    invokeStopHandler(match, input.event, input.interruption, input.deadlineAt, input.store, input.now)));
  const continuations = outcomes.flatMap((outcome) =>
    outcome?.disposition === "continue" ? [outcome] : []);
  const unique = continuations.filter((outcome, index) =>
    continuations.findIndex((candidate) => candidate.code === outcome.code && candidate.message === outcome.message) === index);
  let remaining = 8_192;
  const messages: string[] = [];
  let omittedMessageCount = 0;
  for (const outcome of unique) {
    const line = `[${outcome.code}] ${outcome.message}`;
    if (line.length > remaining) {
      omittedMessageCount += 1;
      continue;
    }
    messages.push(line);
    remaining -= line.length + 1;
  }
  return Object.freeze({
    disposition: unique.length === 0 ? "allow" as const : "continue" as const,
    codes: Object.freeze(unique.map((item) => item.code)),
    message: messages.length === 0 ? null : messages.join("\n"),
    omittedMessageCount,
  });
}

export async function dispatchAgentStopFailureHooks(input: {
  readonly composition: AgentHookComposition;
  readonly event: AgentStopFailureEvent;
  readonly interruption: InvocationInterruptionContext;
  readonly deadlineAt: string;
  readonly store: AgentHookExecutionStore;
  readonly now: () => string;
}): Promise<void> {
  const matches = matchingAgentHooks(input.composition, "StopFailure", input.event.runKind);
  const blocking = matches.filter((match) => match.registration.mode === "blocking");
  const background = matches.filter((match) => match.registration.mode === "background");
  for (const match of background) {
    void invokeObserver(match, input.event, input.interruption, input.deadlineAt, input.store, input.now);
  }
  await Promise.all(blocking.map((match) =>
    invokeObserver(match, input.event, input.interruption, input.deadlineAt, input.store, input.now)));
}

async function invokeStopHandler(
  match: ReturnType<typeof matchingAgentHooks>[number],
  event: AgentStopEvent,
  interruption: InvocationInterruptionContext,
  deadlineAt: string,
  store: AgentHookExecutionStore,
  now: () => string,
): Promise<AgentStopHandlerResult | null> {
  const result = await invokeBounded(match, event, interruption, deadlineAt, now, async (context) =>
    (match.binding.handler as AgentStopHandler).handle(event, context));
  let decision: AgentStopHandlerResult | null = null;
  let status: AgentHookInvocationStatus;
  let code: string | null = null;
  let message: string | null = null;
  if (result.status === "completed") {
    const validated = validateStopResult(result.value, match.registration.maximumResultBytes);
    status = validated.status;
    decision = validated.decision;
    code = decision?.disposition === "continue" ? decision.code : null;
    message = decision?.disposition === "continue" ? decision.message : validated.message;
  } else {
    status = result.status;
    message = result.message;
  }
  store.append(record(match.registration.ref, event, match.registration.mode, status, code, message, result, now));
  return decision;
}

async function invokeObserver(
  match: ReturnType<typeof matchingAgentHooks>[number],
  event: AgentStopEvent | AgentStopFailureEvent,
  interruption: InvocationInterruptionContext,
  deadlineAt: string,
  store: AgentHookExecutionStore,
  now: () => string,
): Promise<void> {
  const result = await invokeBounded(match, event, interruption, deadlineAt, now, async (context) => {
    if (event.point === "Stop") {
      await (match.binding.handler as AgentStopObserver).observe(event, context);
    } else {
      await (match.binding.handler as AgentStopFailureObserver).observe(event, context);
    }
  });
  store.append(record(
    match.registration.ref,
    event,
    match.registration.mode,
    result.status === "completed" ? "completed" : result.status,
    null,
    result.status === "completed" ? null : result.message,
    result,
    now,
  ));
}

type InvocationResult =
  | { readonly status: "completed"; readonly value: unknown; readonly startedAt: string; readonly completedAt: string }
  | { readonly status: "failed" | "timed_out" | "cancelled"; readonly message: string; readonly startedAt: string; readonly completedAt: string };

async function invokeBounded(
  match: ReturnType<typeof matchingAgentHooks>[number],
  _event: AgentStopEvent | AgentStopFailureEvent,
  interruption: InvocationInterruptionContext,
  deadlineAt: string,
  now: () => string,
  invoke: (context: InvocationInterruptionContext) => Promise<unknown> | unknown,
): Promise<InvocationResult> {
  const startedAt = now();
  const local = new AbortController();
  const effectiveDeadline = Math.min(Date.parse(deadlineAt), Date.parse(startedAt) + match.registration.timeoutMs);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let abortListenerRegistered = false;
  const operation = Promise.resolve()
    .then(() => invoke(Object.freeze({
      signal: local.signal,
      interruption: interruption.interruption,
    })))
    .then<InvocationResult, InvocationResult>(
      (value) => Object.freeze({
        status: "completed" as const,
        value,
        startedAt,
        completedAt: now(),
      }),
      (error) => Object.freeze({
        status: interruption.signal.aborted ? "cancelled" as const : "failed" as const,
        message: bounded(error instanceof Error ? error.message : "Agent Hook Handler failed."),
        startedAt,
        completedAt: now(),
      }),
    );
  const timeout = new Promise<InvocationResult>((resolve) => {
    timer = setTimeout(() => {
      local.abort();
      resolve(Object.freeze({
        status: "timed_out" as const,
        message: "Agent Hook Handler exceeded its deadline.",
        startedAt,
        completedAt: now(),
      }));
    }, Math.max(1, effectiveDeadline - Date.parse(startedAt)));
  });
  let resolveCancelled!: (result: InvocationResult) => void;
  const cancelled = new Promise<InvocationResult>((resolve) => {
    resolveCancelled = resolve;
  });
  const abortForRun = () => {
      local.abort();
      resolveCancelled(Object.freeze({
        status: "cancelled" as const,
        message: "Agent Hook Handler was cancelled with the Run.",
        startedAt,
        completedAt: now(),
      }));
  };
  if (interruption.signal.aborted) abortForRun();
  else {
    interruption.signal.addEventListener("abort", abortForRun, { once: true });
    abortListenerRegistered = true;
  }
  try {
    return await Promise.race([operation, timeout, cancelled]);
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (abortListenerRegistered) {
      interruption.signal.removeEventListener("abort", abortForRun);
    }
  }
}

function validateStopResult(value: unknown, maximumBytes: number): {
  readonly status: "allowed" | "continued" | "output_invalid";
  readonly decision: AgentStopHandlerResult | null;
  readonly message: string | null;
} {
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maximumBytes) {
      return Object.freeze({ status: "output_invalid", decision: null, message: "Agent Stop Handler output exceeded its bound." });
    }
  } catch {
    return Object.freeze({ status: "output_invalid", decision: null, message: "Agent Stop Handler output is not serializable." });
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const candidate = value as Record<string, unknown>;
    if (candidate.disposition === "allow" && Object.keys(candidate).length === 1) {
      return Object.freeze({ status: "allowed", decision: Object.freeze({ disposition: "allow" }), message: null });
    }
    if (candidate.disposition === "continue" &&
        Object.keys(candidate).every((key) => ["disposition", "code", "message"].includes(key)) &&
        canonical(candidate.code) && typeof candidate.message === "string" &&
        candidate.message.trim().length > 0 && candidate.message.length <= 4_096) {
      return Object.freeze({
        status: "continued",
        decision: Object.freeze({ disposition: "continue", code: candidate.code, message: candidate.message }),
        message: null,
      });
    }
  }
  return Object.freeze({ status: "output_invalid", decision: null, message: "Agent Stop Handler result shape is invalid." });
}

function record(
  hook: AgentHookRef,
  event: AgentStopEvent | AgentStopFailureEvent,
  mode: AgentHookExecutionMode,
  status: AgentHookInvocationStatus,
  code: string | null,
  message: string | null,
  timing: Pick<InvocationResult, "startedAt" | "completedAt">,
  _now: () => string,
): AgentHookInvocationRecord {
  return Object.freeze({
    id: `${event.ref.id}:${hook.id}:${hook.revision}:${mode}`,
    runId: event.run.id,
    eventId: event.ref.id,
    hook,
    point: event.point,
    mode,
    status,
    code,
    message,
    startedAt: timing.startedAt,
    completedAt: timing.completedAt,
    durationMs: Math.max(0, Date.parse(timing.completedAt) - Date.parse(timing.startedAt)),
  });
}

function canonical(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

function bounded(value: string): string {
  return value.length <= 4_096 ? value : `${value.slice(0, 4_093)}...`;
}
