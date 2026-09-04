import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import type {
  RunLifecycleEventName,
  StopFailureLifecycleEvent,
  StopLifecycleEvent,
} from "../lifecycle/index.js";
import type { RunCauseSourceRef } from "../run/index.js";

export interface RunLifecycleHookRef {
  readonly id: string;
  readonly revision: string;
}

export interface RunLifecycleHookHandlerRef {
  readonly id: string;
  readonly revision: string;
}

export interface RunLifecycleHookRegistration {
  readonly ref: RunLifecycleHookRef;
  readonly owner: RunCauseSourceRef;
  readonly event: RunLifecycleEventName;
  readonly runKinds: readonly ("root" | "descendant")[];
  readonly handler: RunLifecycleHookHandlerRef;
  readonly timeoutMs: number;
  readonly maximumResultBytes: number;
}

export interface RunLifecycleHookSet {
  readonly id: string;
  readonly revision: string;
  readonly registrations: readonly RunLifecycleHookRegistration[];
}

export type StopHookDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "block"; readonly code: string; readonly reason: string };

export interface StopHookHandler {
  handle(
    event: StopLifecycleEvent,
    interruption: InvocationInterruptionContext,
  ): Promise<StopHookDecision>;
}

export interface StopFailureHookHandler {
  observe(
    event: StopFailureLifecycleEvent,
    interruption: InvocationInterruptionContext,
  ): Promise<void>;
}

export type RunLifecycleHookHandler = StopHookHandler | StopFailureHookHandler;

export interface RunLifecycleHookBinding {
  readonly ref: RunLifecycleHookHandlerRef;
  readonly event: RunLifecycleEventName;
  readonly handler: RunLifecycleHookHandler;
}

export interface RunLifecycleHookComposition {
  readonly set: RunLifecycleHookSet;
  readonly bindings: readonly RunLifecycleHookBinding[];
}

export interface StopHookFeedbackPolicy {
  readonly maxConsecutiveBlockingRounds: number;
}

export function createRunLifecycleHookComposition(input: {
  readonly id: string;
  readonly revision: string;
  readonly registrations?: readonly RunLifecycleHookRegistration[];
  readonly bindings?: readonly RunLifecycleHookBinding[];
}): RunLifecycleHookComposition {
  const registrations = snapshotRegistrations(input.registrations ?? []);
  const bindings = snapshotBindings(input.bindings ?? []);
  const bindingKeys = new Set(bindings.map((binding) => refKey(binding.ref)));
  for (const registration of registrations) {
    if (!bindingKeys.has(refKey(registration.handler))) {
      throw new TypeError(`Lifecycle Hook '${registration.ref.id}' has no executable binding.`);
    }
    const binding = bindings.find((candidate) =>
      refKey(candidate.ref) === refKey(registration.handler));
    if (binding?.event !== registration.event) {
      throw new TypeError(`Lifecycle Hook '${registration.ref.id}' binding event is inconsistent.`);
    }
  }
  const registrationHandlers = new Set(registrations.map((item) => refKey(item.handler)));
  if (bindings.some((binding) => !registrationHandlers.has(refKey(binding.ref)))) {
    throw new TypeError("Lifecycle Hook composition contains an unregistered binding.");
  }
  return Object.freeze({
    set: Object.freeze({
      id: token(input.id, "RunLifecycleHookSet.id"),
      revision: token(input.revision, "RunLifecycleHookSet.revision"),
      registrations,
    }),
    bindings,
  });
}

export function createEmptyRunLifecycleHookComposition(): RunLifecycleHookComposition {
  return createRunLifecycleHookComposition({
    id: "agent-runtime.lifecycle-hooks.empty",
    revision: "1",
  });
}

export function matchingRunLifecycleHooks(
  composition: RunLifecycleHookComposition,
  event: RunLifecycleEventName,
  runKind: "root" | "descendant",
): readonly Readonly<{
  registration: RunLifecycleHookRegistration;
  binding: RunLifecycleHookBinding;
}>[] {
  return Object.freeze(composition.set.registrations.flatMap((registration) => {
    if (registration.event !== event || !registration.runKinds.includes(runKind)) return [];
    const binding = composition.bindings.find((candidate) =>
      refKey(candidate.ref) === refKey(registration.handler));
    if (binding === undefined) throw new TypeError("Lifecycle Hook binding disappeared after composition.");
    return [Object.freeze({ registration, binding })];
  }));
}

function snapshotRegistrations(
  values: readonly RunLifecycleHookRegistration[],
): readonly RunLifecycleHookRegistration[] {
  if (!Array.isArray(values)) throw new TypeError("Lifecycle Hook registrations must be an array.");
  const refs = new Set<string>();
  const eventCounts = new Map<RunLifecycleEventName, number>();
  const result = values.map((registration, index) => {
    if (registration === null || typeof registration !== "object") {
      throw new TypeError(`Lifecycle Hook registration ${index} must be an object.`);
    }
    const ref = snapshotRef(registration.ref, `registrations[${index}].ref`);
    const key = refKey(ref);
    if (refs.has(key)) throw new TypeError("Lifecycle Hook registration refs must be unique.");
    refs.add(key);
    if (registration.event !== "Stop" && registration.event !== "StopFailure") {
      throw new TypeError("Lifecycle Hook event is unsupported.");
    }
    const runKinds = Object.freeze([...new Set(registration.runKinds)]);
    if (runKinds.length === 0 || runKinds.some((kind) => kind !== "root" && kind !== "descendant")) {
      throw new TypeError("Lifecycle Hook registration requires root, descendant, or both.");
    }
    positiveBounded(registration.timeoutMs, 3_600_000, "Lifecycle Hook timeoutMs");
    positiveBounded(registration.maximumResultBytes, 1_048_576, "Lifecycle Hook maximumResultBytes");
    const count = (eventCounts.get(registration.event) ?? 0) + 1;
    if (count > 32) throw new TypeError("Lifecycle Hook set supports at most 32 registrations per event.");
    eventCounts.set(registration.event, count);
    return deepFreeze({
      ...registration,
      ref,
      owner: snapshotOwner(registration.owner),
      runKinds,
      handler: snapshotRef(registration.handler, `registrations[${index}].handler`),
    });
  });
  return Object.freeze(result);
}

function snapshotBindings(values: readonly RunLifecycleHookBinding[]): readonly RunLifecycleHookBinding[] {
  if (!Array.isArray(values)) throw new TypeError("Lifecycle Hook bindings must be an array.");
  const refs = new Set<string>();
  return Object.freeze(values.map((binding, index) => {
    const ref = snapshotRef(binding.ref, `bindings[${index}].ref`);
    const key = refKey(ref);
    if (refs.has(key)) throw new TypeError("Lifecycle Hook binding refs must be unique.");
    refs.add(key);
    if (binding.event !== "Stop" && binding.event !== "StopFailure") {
      throw new TypeError("Lifecycle Hook binding event is unsupported.");
    }
    const expected = binding.event === "Stop" ? "handle" : "observe";
    if (typeof (binding.handler as unknown as Record<string, unknown>)?.[expected] !== "function") {
      throw new TypeError(`Lifecycle Hook binding must implement ${expected}().`);
    }
    return Object.freeze({ ...binding, ref });
  }));
}

function snapshotOwner(value: RunCauseSourceRef): RunCauseSourceRef {
  if (value === null || typeof value !== "object") throw new TypeError("Lifecycle Hook owner is invalid.");
  return deepFreeze({
    owner: token(value.owner, "Lifecycle Hook owner.owner"),
    kind: token(value.kind, "Lifecycle Hook owner.kind"),
    id: token(value.id, "Lifecycle Hook owner.id"),
    revision: value.revision === null ? null : token(value.revision, "Lifecycle Hook owner.revision"),
    run: value.run === null ? null : { id: token(value.run.id, "Lifecycle Hook owner.run.id") },
  });
}

function snapshotRef<T extends RunLifecycleHookRef>(value: T, field: string): T {
  if (value === null || typeof value !== "object") throw new TypeError(`${field} must be an object.`);
  return Object.freeze({
    id: token(value.id, `${field}.id`),
    revision: token(value.revision, `${field}.revision`),
  }) as T;
}

function refKey(ref: RunLifecycleHookRef): string {
  return `${ref.id}\0${ref.revision}`;
}

function token(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) {
    throw new TypeError(`${field} must be a canonical non-empty string.`);
  }
  return value;
}

function positiveBounded(value: unknown, maximum: number, field: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new TypeError(`${field} is outside the supported range.`);
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
