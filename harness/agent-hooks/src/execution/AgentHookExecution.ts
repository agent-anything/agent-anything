import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import { ActivityCheckpointError, type ActivityCheckpointPort } from "@agent-anything/agent-runtime/activity";
import { ExecutionFlowPath, type ExecutionFlowContext } from "@agent-anything/observability/execution-flow";
import { AGENT_HOOK_HANDLER_FLOW } from "./AgentHookExecutionFlow.js";
import { hookInvocationId, interruptedAgentHook, type AgentHookInvocationCheckpoint,
  type AgentHookInvocationOutcome, type AgentHookRecordPort } from "./AgentHookRecordPort.js";
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
  readonly recentDispositions: readonly AgentStopDispositionRecord[];
}

export interface AgentStopDispositionRecord {
  readonly runId: string;
  readonly controllerRequestId: string;
  readonly disposition: "continuation_limit_reached";
  readonly feedbackCount: number;
  readonly recordedAt: string;
}

export type AgentHookProjectionListener = (projection: AgentHookProjection) => void;

export class AgentHookExecutionStore {
  private records: readonly AgentHookInvocationRecord[] = Object.freeze([]);
  private revision = 0;
  private invocationCount = 0;
  private dispositions: readonly AgentStopDispositionRecord[] = Object.freeze([]);
  private readonly listeners = new Set<AgentHookProjectionListener>();
  private readonly recordedIds = new Set<string>();

  append(record: AgentHookInvocationRecord): void {
    if (this.recordedIds.has(record.id)) return;
    this.recordedIds.add(record.id);
    this.revision += 1;
    this.invocationCount += 1;
    this.records = Object.freeze([...this.records.slice(-63), record]);
    const projection = this.getProjection();
    for (const listener of [...this.listeners]) {
      try { listener(projection); } catch { /* Projection consumers are non-authoritative. */ }
    }
  }

  getProjection(): AgentHookProjection {
    return Object.freeze({
      revision: this.revision,
      invocationCount: this.invocationCount,
      recentInvocations: Object.freeze([...this.records]),
      recentDispositions: Object.freeze([...this.dispositions]),
    });
  }

  subscribe(listener: AgentHookProjectionListener): () => void {
    if (typeof listener !== "function") throw new TypeError("Agent Hook listener must be a function.");
    this.listeners.add(listener);
    try { listener(this.getProjection()); } catch { /* Projection consumers are non-authoritative. */ }
    return () => { this.listeners.delete(listener); };
  }

  recordDisposition(record: AgentStopDispositionRecord): void {
    this.revision += 1;
    this.dispositions = Object.freeze([...this.dispositions.slice(-63), Object.freeze({...record})]);
    const projection = this.getProjection();
    for (const listener of [...this.listeners]) {
      try { listener(projection); } catch { /* Observation cannot affect Agent control. */ }
    }
  }
}

export interface AgentStopDispatchResult {
  readonly disposition: "allow" | "continue";
  readonly codes: readonly string[];
  readonly message: string | null;
  readonly omittedMessageCount: number;
}

export async function dispatchAgentStopHooks(input: {
  readonly invocationRecords?: AgentHookRecordPort;
  readonly checkpoints?: ActivityCheckpointPort;
  readonly executionFlow?: ExecutionFlowContext;
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
  if (input.checkpoints && !input.invocationRecords && background.length > 0) throw new ActivityCheckpointError("background_hook_recovery_port_unavailable");
  for (const match of background) {
    await startBackgroundObserver(match, input);
  }
  const outcomes = await Promise.all(blocking.map((match) =>
    invokeStopHandler(match, input.event, input.interruption, input.deadlineAt, input.store, input.now, input.executionFlow, input.checkpoints, input.invocationRecords)));
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
  readonly invocationRecords?: AgentHookRecordPort;
  readonly checkpoints?: ActivityCheckpointPort;
  readonly executionFlow?: ExecutionFlowContext;
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
  if (input.checkpoints && !input.invocationRecords && background.length > 0) throw new ActivityCheckpointError("background_hook_recovery_port_unavailable");
  for (const match of background) {
    await startBackgroundObserver(match, input);
  }
  await Promise.all(blocking.map((match) =>
    invokeObserver(match, input.event, input.interruption, input.deadlineAt, input.store, input.now, input.executionFlow, input.checkpoints, input.invocationRecords)));
}

async function invokeStopHandler(
  match: ReturnType<typeof matchingAgentHooks>[number],
  event: AgentStopEvent,
  interruption: InvocationInterruptionContext,
  deadlineAt: string,
  store: AgentHookExecutionStore,
  now: () => string,
  executionFlow?: ExecutionFlowContext,
  checkpoints?: ActivityCheckpointPort,
  records?: AgentHookRecordPort,
): Promise<AgentStopHandlerResult | null> {
  const flow = new ExecutionFlowPath(AGENT_HOOK_HANDLER_FLOW, executionFlow ?? {}, event.run.id, []);
  flow.advance("invoke", {hookId:match.registration.ref.id, timeoutMs:match.registration.timeoutMs, mode:match.registration.mode}, [flow.material("Hook event and registration", "received", {event, registration: match.registration})]);
  const result = await checkpointInvocation(match, event, checkpoints, now, async () => {
    const returned = await invokeBounded(match, event, interruption, deadlineAt, now, async (context) =>
      (match.binding.handler as AgentStopHandler).handle(event, context, flow.callContext));
    if (returned.status !== "completed") return returned;
    const validated = validateStopResult(returned.value, match.registration.maximumResultBytes);
    return validated.decision ? {...returned, value: validated.decision}
      : {status: "output_invalid", message: validated.message!, startedAt: returned.startedAt, completedAt: returned.completedAt};
  }, records);
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
  const resultRef = flow.material("Hook handler result", "returned", result);
  flow.current?.output(resultRef);
  const settlementStep = flow.advance("settle", {status, code}, [resultRef]);
  settlementStep.check("result_contract", status === "allowed" || status === "continued" ? "passed" : "error");
  settlementStep.output(flow.material("Validated Hook decision", "validated", {status, code, message, decision}));
  flow.close(status === "allowed" || status === "continued" ? "returned" : status === "cancelled" ? "cancelled" : "failed");
  return decision;
}

async function invokeObserver(
  match: ReturnType<typeof matchingAgentHooks>[number],
  event: AgentStopEvent | AgentStopFailureEvent,
  interruption: InvocationInterruptionContext,
  deadlineAt: string,
  store: AgentHookExecutionStore,
  now: () => string,
  executionFlow?: ExecutionFlowContext,
  checkpoints?: ActivityCheckpointPort,
  records?: AgentHookRecordPort,
  prepared?: AgentHookInvocationCheckpoint,
): Promise<void> {
  const flow = new ExecutionFlowPath(AGENT_HOOK_HANDLER_FLOW, {...executionFlow, relationship:match.registration.mode === "background" ? "spawn" : "call"}, event.run.id, []);
  flow.advance("invoke", {hookId:match.registration.ref.id, mode:match.registration.mode, timeoutMs:match.registration.timeoutMs}, [flow.material("Hook event and registration", "received", {event, registration: match.registration})]);
  const result = await checkpointInvocation(match, event, checkpoints, now, () => invokeBounded(match, event, interruption, deadlineAt, now, async (context) => {
    if (event.point === "Stop") {
      await (match.binding.handler as AgentStopObserver).observe(event, context, flow.callContext);
    } else {
      await (match.binding.handler as AgentStopFailureObserver).observe(event, context, flow.callContext);
    }
    return null;
  }), records, prepared);
  const resultRef = flow.material("Hook observer result", "returned", result);
  flow.current?.output(resultRef);
  flow.advance("settle", {status:result.status}, [resultRef]).check("result_contract", "not_applicable", {reason: "observer_has_no_decision_result"});
  flow.close(result.status === "completed" ? "returned" : result.status === "cancelled" ? "cancelled" : "failed");
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

type InvocationResult = AgentHookInvocationOutcome;

async function checkpointInvocation(
  match: ReturnType<typeof matchingAgentHooks>[number], event: AgentStopEvent | AgentStopFailureEvent,
  port: ActivityCheckpointPort | undefined, now: () => string, invoke: () => Promise<InvocationResult>,
  records?: AgentHookRecordPort, prepared?: AgentHookInvocationCheckpoint,
): Promise<InvocationResult> {
  try {
    return await invokeRecorded(match, event, port, now, invoke, records, prepared);
  } catch (error) {
    if (error instanceof ActivityCheckpointError) throw error;
    throw new ActivityCheckpointError(hookInvocationId(event, match.registration), {cause: error});
  }
}

async function invokeRecorded(
  match: ReturnType<typeof matchingAgentHooks>[number], event: AgentStopEvent | AgentStopFailureEvent,
  port: ActivityCheckpointPort | undefined, now: () => string, invoke: () => Promise<InvocationResult>,
  records?: AgentHookRecordPort, prepared?: AgentHookInvocationCheckpoint,
): Promise<InvocationResult> {
  if (!port && !records) return invoke();
  const key = JSON.stringify(["hook", event.ref.id, match.registration.ref]);
  const saved = prepared ? null : records ? await records.readHookInvocation(hookInvocationId(event, match.registration))
    : port!.read(key) as AgentHookInvocationCheckpoint | null;
  if (saved && (JSON.stringify(saved.event) !== JSON.stringify(event) || JSON.stringify(saved.registration) !== JSON.stringify(match.registration))) {
    throw new ActivityCheckpointError(key);
  }
  if (saved?.outcome) return saved.outcome;
  const intent: AgentHookInvocationCheckpoint = saved ?? prepared ?? {id: hookInvocationId(event, match.registration), version: 1,
    event, registration: match.registration, startedAt: now(), outcome: null};
  const commit = (value: AgentHookInvocationCheckpoint) => records ? records.commitHookInvocation(value) : port!.commit(key, value);
  if (!saved && !prepared) await commit(intent);
  // Arbitrary handler code is not replay-safe. Existing handler-failure policy
  // receives an explicit interrupted outcome instead of an invented allow.
  const result: InvocationResult = saved
    ? interruptedAgentHook(intent, now()).outcome!
    : await invoke();
  const outcome = {...result, startedAt: intent.startedAt};
  await commit({...intent, outcome});
  return outcome;
}

async function startBackgroundObserver(match: ReturnType<typeof matchingAgentHooks>[number], input: {
  readonly invocationRecords?: AgentHookRecordPort; readonly event: AgentStopEvent | AgentStopFailureEvent;
  readonly interruption: InvocationInterruptionContext; readonly deadlineAt: string; readonly store: AgentHookExecutionStore;
  readonly now: () => string; readonly executionFlow?: ExecutionFlowContext;
}): Promise<void> {
  let prepared: AgentHookInvocationCheckpoint | undefined;
  if (input.invocationRecords) {
    const id = hookInvocationId(input.event, match.registration);
    let saved: AgentHookInvocationCheckpoint | null;
    try { saved = await input.invocationRecords.readHookInvocation(id); }
    catch (error) { throw new ActivityCheckpointError(id, {cause: error}); }
    if (!saved) {
      prepared = {id, version: 1, event: input.event, registration: match.registration, startedAt: input.now(), outcome: null};
      try { await input.invocationRecords.commitHookInvocation(prepared); }
      catch (error) { throw new ActivityCheckpointError(id, {cause: error}); }
    } else {
      await invokeObserver(match, input.event, input.interruption, input.deadlineAt, input.store, input.now,
        input.executionFlow, undefined, input.invocationRecords);
      return;
    }
  }
  // Admission is durable before returning; late settlement belongs to the Hook
  // owner. A failed acknowledgement leaves intent unresolved, never rerun.
  void invokeObserver(match, input.event, input.interruption, input.deadlineAt, input.store, input.now,
    input.executionFlow, undefined, input.invocationRecords, prepared).catch(() => {
      input.store.append(record(match.registration.ref, input.event, match.registration.mode, "failed",
        "hook_settlement_unconfirmed", "Hook settlement could not be durably confirmed; recovery must reconcile its intent.",
        {startedAt: prepared?.startedAt ?? input.now(), completedAt: input.now()}, input.now));
    });
}

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
