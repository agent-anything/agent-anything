import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import type { AgentHookPoint, AgentStopEvent, AgentStopFailureEvent } from "../events/index.js";

export type AgentHookExecutionMode = "blocking" | "background";

export interface AgentHookRef {
  readonly owner: string;
  readonly id: string;
  readonly revision: string;
}

export interface AgentHookHandlerRef {
  readonly id: string;
  readonly revision: string;
}

export interface AgentHookRegistration {
  readonly ref: AgentHookRef;
  readonly point: AgentHookPoint;
  readonly mode: AgentHookExecutionMode;
  readonly runKinds: readonly ("root" | "descendant")[];
  readonly handler: AgentHookHandlerRef;
  readonly timeoutMs: number;
  readonly maximumResultBytes: number;
}

export type AgentStopHandlerResult =
  | { readonly disposition: "allow" }
  | { readonly disposition: "continue"; readonly code: string; readonly message: string };

export interface AgentStopHandler {
  handle(
    event: AgentStopEvent,
    interruption: InvocationInterruptionContext,
  ): Promise<AgentStopHandlerResult> | AgentStopHandlerResult;
}

export interface AgentStopObserver {
  observe(
    event: AgentStopEvent,
    interruption: InvocationInterruptionContext,
  ): Promise<void> | void;
}

export interface AgentStopFailureObserver {
  observe(
    event: AgentStopFailureEvent,
    interruption: InvocationInterruptionContext,
  ): Promise<void> | void;
}

export type AgentHookBinding =
  | {
      readonly ref: AgentHookHandlerRef;
      readonly point: "Stop";
      readonly mode: "blocking";
      readonly handler: AgentStopHandler;
    }
  | {
      readonly ref: AgentHookHandlerRef;
      readonly point: "Stop";
      readonly mode: "background";
      readonly handler: AgentStopObserver;
    }
  | {
      readonly ref: AgentHookHandlerRef;
      readonly point: "StopFailure";
      readonly mode: AgentHookExecutionMode;
      readonly handler: AgentStopFailureObserver;
    };

export interface AgentHookComposition {
  readonly id: string;
  readonly revision: string;
  readonly registrations: readonly AgentHookRegistration[];
  readonly bindings: readonly AgentHookBinding[];
}

export function createAgentHookComposition(input: {
  readonly id: string;
  readonly revision: string;
  readonly registrations?: readonly AgentHookRegistration[];
  readonly bindings?: readonly AgentHookBinding[];
}): AgentHookComposition {
  const registrations = Object.freeze((input.registrations ?? []).map(snapshotRegistration));
  const bindings = Object.freeze((input.bindings ?? []).map(snapshotBinding));
  const registrationKeys = new Set<string>();
  for (const registration of registrations) {
    const key = refKey(registration.ref);
    if (registrationKeys.has(key)) throw new TypeError("Agent Hook refs must be unique.");
    registrationKeys.add(key);
    const binding = bindings.find((candidate) => refKey(candidate.ref) === refKey(registration.handler));
    if (binding === undefined) throw new TypeError(`Agent Hook '${registration.ref.id}' has no binding.`);
    if (binding.point !== registration.point || binding.mode !== registration.mode) {
      throw new TypeError(`Agent Hook '${registration.ref.id}' binding is incompatible.`);
    }
  }
  const registeredHandlers = new Set(registrations.map((item) => refKey(item.handler)));
  if (bindings.some((binding) => !registeredHandlers.has(refKey(binding.ref)))) {
    throw new TypeError("Agent Hook composition contains an unregistered binding.");
  }
  // Handler instances may own runtime state. Freeze the composition structure,
  // but never recursively freeze executable dependencies supplied by Product.
  return Object.freeze({
    id: token(input.id, "AgentHookComposition.id"),
    revision: token(input.revision, "AgentHookComposition.revision"),
    registrations,
    bindings,
  });
}

export function createEmptyAgentHookComposition(): AgentHookComposition {
  return createAgentHookComposition({ id: "agent-hooks.empty", revision: "1" });
}

export function matchingAgentHooks(
  composition: AgentHookComposition,
  point: AgentHookPoint,
  runKind: "root" | "descendant",
): readonly Readonly<{ registration: AgentHookRegistration; binding: AgentHookBinding }>[] {
  return Object.freeze(composition.registrations.flatMap((registration) => {
    if (registration.point !== point || !registration.runKinds.includes(runKind)) return [];
    const binding = composition.bindings.find((candidate) => refKey(candidate.ref) === refKey(registration.handler));
    if (binding === undefined) throw new TypeError("Agent Hook binding disappeared after composition.");
    return [Object.freeze({ registration, binding })];
  }));
}

function snapshotRegistration(value: AgentHookRegistration): AgentHookRegistration {
  if (value.point !== "Stop" && value.point !== "StopFailure") {
    throw new TypeError("Agent Hook point is unsupported.");
  }
  if (value.mode !== "blocking" && value.mode !== "background") {
    throw new TypeError("Agent Hook mode is unsupported.");
  }
  const runKinds = Object.freeze([...new Set(value.runKinds)]);
  if (runKinds.length === 0 || runKinds.some((kind) => kind !== "root" && kind !== "descendant")) {
    throw new TypeError("Agent Hook registration requires at least one supported Run kind.");
  }
  boundedInteger(value.timeoutMs, 1, 3_600_000, "Agent Hook timeoutMs");
  boundedInteger(value.maximumResultBytes, 1, 1_048_576, "Agent Hook maximumResultBytes");
  return deepFreeze({
    ...value,
    ref: {
      owner: token(value.ref.owner, "AgentHookRef.owner"),
      id: token(value.ref.id, "AgentHookRef.id"),
      revision: token(value.ref.revision, "AgentHookRef.revision"),
    },
    runKinds,
    handler: snapshotHandlerRef(value.handler),
  });
}

function snapshotBinding(value: AgentHookBinding): AgentHookBinding {
  if (value.point === "Stop" && value.mode === "blocking") {
    if (typeof value.handler?.handle !== "function") throw new TypeError("Blocking Stop Handler requires handle().");
  } else if (typeof value.handler?.observe !== "function") {
    throw new TypeError("Agent Hook observer requires observe().");
  }
  return Object.freeze({ ...value, ref: snapshotHandlerRef(value.ref) });
}

function snapshotHandlerRef(value: AgentHookHandlerRef): AgentHookHandlerRef {
  return Object.freeze({
    id: token(value.id, "AgentHookHandlerRef.id"),
    revision: token(value.revision, "AgentHookHandlerRef.revision"),
  });
}

function refKey(value: { readonly id: string; readonly revision: string }): string {
  return `${value.id}\0${value.revision}`;
}

function token(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${field} must be a canonical non-empty string.`);
  }
  return value;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, field: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${field} is outside the supported range.`);
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
