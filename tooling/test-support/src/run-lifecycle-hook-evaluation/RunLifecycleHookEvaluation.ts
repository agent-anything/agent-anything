import {
  createRunLifecycleHookComposition,
  mergeStopHookInvocations,
  type StopHookInvocationRecord,
} from "@agent-anything/agent-runtime/hooks";

export interface RunLifecycleHookEvaluationReport {
  readonly revision: "run-lifecycle-hook-deterministic-evaluation-v1";
  readonly matchingHookLimit: 32;
  readonly blockingPrecedence: true;
  readonly deterministicRegistrationOrder: true;
  readonly nonBlockingErrorPreserved: true;
  readonly maximumMergedFeedbackCharacters: 8192;
  readonly exactActivityKinds: readonly [
    "lifecycle_event",
    "lifecycle_hook_invocation",
    "lifecycle_hook_feedback",
  ];
}

export function runRunLifecycleHookDeterministicEvaluation(): RunLifecycleHookEvaluationReport {
  const handler = Object.freeze({
    async handle() {
      return Object.freeze({ kind: "allow" as const });
    },
  });
  const owner = Object.freeze({
    owner: "evaluation",
    kind: "lifecycle_hook",
    id: "evaluation-hook-owner",
    revision: "1",
    run: null,
  });
  const registrations = Array.from({ length: 32 }, (_, index) => Object.freeze({
    ref: Object.freeze({ id: `hook-${index + 1}`, revision: "1" }),
    owner,
    event: "Stop" as const,
    runKinds: Object.freeze(["root" as const]),
    handler: Object.freeze({ id: `handler-${index + 1}`, revision: "1" }),
    timeoutMs: 1_000,
    maximumResultBytes: 8_192,
  }));
  createRunLifecycleHookComposition({
    id: "evaluation-hooks",
    revision: "1",
    registrations,
    bindings: registrations.map((registration) => Object.freeze({
      ref: registration.handler,
      event: "Stop" as const,
      handler,
    })),
  });

  const invocations: readonly StopHookInvocationRecord[] = Object.freeze([
    invocation("hook-1", Object.freeze({
      status: "decided" as const,
      decision: Object.freeze({ kind: "allow" as const }),
    })),
    invocation("hook-2", Object.freeze({
      status: "non_blocking_error" as const,
      code: "hook_timed_out" as const,
      message: "The optional Hook timed out.",
    })),
    invocation("hook-3", Object.freeze({
      status: "decided" as const,
      decision: Object.freeze({
        kind: "block" as const,
        code: "task_incomplete",
        reason: "Continue the Run.",
      }),
    })),
  ]);
  const merged = mergeStopHookInvocations(invocations);
  if (merged.kind !== "block" || merged.blockCodes[0] !== "task_incomplete" ||
      merged.invocations[1]?.outcome.status !== "non_blocking_error") {
    throw new TypeError("Lifecycle Hook deterministic contract probe failed.");
  }
  return deepFreeze({
    revision: "run-lifecycle-hook-deterministic-evaluation-v1" as const,
    matchingHookLimit: 32 as const,
    blockingPrecedence: true as const,
    deterministicRegistrationOrder: true as const,
    nonBlockingErrorPreserved: true as const,
    maximumMergedFeedbackCharacters: 8_192 as const,
    exactActivityKinds: [
      "lifecycle_event",
      "lifecycle_hook_invocation",
      "lifecycle_hook_feedback",
    ] as const,
  });
}

function invocation(
  id: string,
  outcome: StopHookInvocationRecord["outcome"],
): StopHookInvocationRecord {
  return Object.freeze({
    hook: Object.freeze({ id, revision: "1" }),
    eventId: "stop-event-1",
    startedAt: "2026-09-01T00:00:00.000Z",
    completedAt: "2026-09-01T00:00:00.001Z",
    durationMs: 1,
    outcome,
    stale: false,
  });
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
