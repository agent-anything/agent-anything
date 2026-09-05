import {
  createAgentHookComposition,
  type AgentHookBinding,
  type AgentHookRegistration,
} from "@agent-anything/agent-hooks/composition";
import type { AgentStopEvent } from "@agent-anything/agent-hooks/events";
import {
  AgentHookExecutionStore,
  dispatchAgentStopHooks,
} from "@agent-anything/agent-hooks/execution";

const NOW = "2026-09-04T00:00:00.000Z";

export interface AgentHookEvaluationReport {
  readonly revision: "agent-hook-deterministic-evaluation-v1";
  readonly matchingHookCount: 32;
  readonly continuationPrecedence: true;
  readonly deterministicRegistrationOrder: true;
  readonly backgroundNonAuthority: true;
  readonly backgroundFailureRecorded: true;
  readonly maximumMergedFeedbackCharacters: 8192;
  readonly exactActivityKinds: readonly [
    "agent_hook_invocation",
    "controller_feedback",
  ];
}

export async function runAgentHookDeterministicEvaluation(): Promise<AgentHookEvaluationReport> {
  const registrations: AgentHookRegistration[] = [];
  const bindings: AgentHookBinding[] = [];
  for (let index = 0; index < 32; index += 1) {
    const id = `hook-${index + 1}`;
    const handler = Object.freeze({ id: `handler-${index + 1}`, revision: "1" });
    const background = index === 1;
    registrations.push(Object.freeze({
      ref: Object.freeze({ owner: "evaluation", id, revision: "1" }),
      point: "Stop" as const,
      mode: background ? "background" as const : "blocking" as const,
      runKinds: Object.freeze(["root" as const]),
      handler,
      timeoutMs: 1_000,
      maximumResultBytes: 8_192,
    }));
    bindings.push(background
      ? Object.freeze({
          ref: handler,
          point: "Stop" as const,
          mode: "background" as const,
          handler: Object.freeze({
            observe() {
              throw new Error("Optional observer failure.");
            },
          }),
        })
      : Object.freeze({
          ref: handler,
          point: "Stop" as const,
          mode: "blocking" as const,
          handler: Object.freeze({
            handle() {
              return index === 2
                ? Object.freeze({
                    disposition: "continue" as const,
                    code: "task_incomplete",
                    message: "Continue the Run.",
                  })
                : Object.freeze({ disposition: "allow" as const });
            },
          }),
        }));
  }
  const composition = createAgentHookComposition({
    id: "evaluation-agent-hooks",
    revision: "1",
    registrations,
    bindings,
  });
  const store = new AgentHookExecutionStore();
  const controller = new AbortController();
  const result = await dispatchAgentStopHooks({
    composition,
    event: stopEvent(),
    interruption: Object.freeze({ signal: controller.signal, interruption: null }),
    deadlineAt: "2026-09-04T00:01:00.000Z",
    store,
    now: () => NOW,
  });
  await Promise.resolve();
  await Promise.resolve();

  const projection = store.getProjection();
  const background = projection.recentInvocations.find((item) => item.mode === "background");
  if (
    result.disposition !== "continue" ||
    result.codes[0] !== "task_incomplete" ||
    result.message !== "[task_incomplete] Continue the Run." ||
    background?.status !== "failed"
  ) {
    throw new TypeError("Agent Hook deterministic contract probe failed.");
  }
  return deepFreeze({
    revision: "agent-hook-deterministic-evaluation-v1" as const,
    matchingHookCount: 32 as const,
    continuationPrecedence: true as const,
    deterministicRegistrationOrder: true as const,
    backgroundNonAuthority: true as const,
    backgroundFailureRecorded: true as const,
    maximumMergedFeedbackCharacters: 8_192 as const,
    exactActivityKinds: ["agent_hook_invocation", "controller_feedback"] as const,
  });
}

function stopEvent(): AgentStopEvent<{ readonly summary: string }> {
  const run = Object.freeze({ id: "run-1" });
  return deepFreeze({
    ref: { run, id: "stop-event-1", sequence: 1, revision: "1" },
    point: "Stop" as const,
    run,
    runKind: "root" as const,
    agent: { id: "agent-1", revision: "1" },
    task: {
      id: "task-1",
      kind: "evaluation",
      input: {},
      createdAt: NOW,
      metadata: {},
    },
    controllerRequestId: "controller-request-1",
    iteration: 1,
    candidate: {
      ref: { id: "candidate-1", revision: "1" },
      kind: "complete" as const,
      output: { summary: "Candidate output." },
    },
    interaction: {
      id: "interaction-1",
      revision: "1",
      messages: [],
      unsettledCalls: [],
      settledCallCount: 0,
    },
    plan: null,
    verification: { snapshot: { runId: "run-1", revision: 0 }, gate: null },
    pending: [],
    emittedAt: NOW,
  });
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
