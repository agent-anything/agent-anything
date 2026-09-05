import type { AgentRevisionRef } from "@agent-anything/agent-core/agent";
import type { AgentTask } from "@agent-anything/agent-core/task";
import type { RunRef } from "@agent-anything/agent-core/run";
import type {
  ControllerDecision,
  ControllerInput,
  ModelInteractionProjection,
} from "@agent-anything/agent-runtime/controller";

export type AgentHookPoint = "Stop" | "StopFailure";

export interface AgentHookEventRef {
  readonly run: RunRef;
  readonly id: string;
  readonly sequence: number;
  readonly revision: string;
}

export interface AgentDecisionCandidateRef {
  readonly id: string;
  readonly revision: string;
}

export type AgentTerminalCandidate<TOutput = unknown> =
  | {
      readonly ref: AgentDecisionCandidateRef;
      readonly kind: "complete";
      readonly output: TOutput;
    }
  | {
      readonly ref: AgentDecisionCandidateRef;
      readonly kind: "stop";
      readonly reason: string;
    };

export interface AgentStopEvent<TOutput = unknown> {
  readonly ref: AgentHookEventRef;
  readonly point: "Stop";
  readonly run: RunRef;
  readonly runKind: "root" | "descendant";
  readonly agent: AgentRevisionRef;
  readonly task: AgentTask;
  readonly controllerRequestId: string;
  readonly iteration: number;
  readonly candidate: AgentTerminalCandidate<TOutput>;
  readonly interaction: ModelInteractionProjection;
  readonly plan: ControllerInput<TOutput>["plan"];
  readonly verification: ControllerInput<TOutput>["verification"];
  readonly pending: ControllerInput<TOutput>["pending"];
  readonly emittedAt: string;
}

export interface AgentTurnFailure {
  readonly name: string;
  readonly code: string | null;
  readonly message: string;
}

export interface AgentStopFailureEvent {
  readonly ref: AgentHookEventRef;
  readonly point: "StopFailure";
  readonly run: RunRef;
  readonly runKind: "root" | "descendant";
  readonly agent: AgentRevisionRef;
  readonly task: AgentTask;
  readonly controllerRequestId: string;
  readonly iteration: number;
  readonly failure: AgentTurnFailure;
  readonly emittedAt: string;
}

export type AgentHookEvent<TOutput = unknown> =
  | AgentStopEvent<TOutput>
  | AgentStopFailureEvent;

export function createAgentStopEvent<TOutput>(input: {
  readonly sequence: number;
  readonly runKind: "root" | "descendant";
  readonly controllerInput: ControllerInput<TOutput>;
  readonly decision: Extract<ControllerDecision<TOutput>, { readonly kind: "propose_completion" | "propose_stop" }>;
  readonly emittedAt: string;
}): AgentStopEvent<TOutput> {
  const run = Object.freeze({ id: token(input.controllerInput.runId, "AgentStopEvent.runId") });
  const requestId = token(
    input.controllerInput.contextManifest.requestId,
    "AgentStopEvent.controllerRequestId",
  );
  const candidateKind = input.decision.kind === "propose_completion" ? "complete" : "stop";
  const eventId = `${requestId}:agent-stop:${input.sequence}`;
  const revision = `${input.controllerInput.contextManifest.projectionId}:${candidateKind}:${input.sequence}`;
  const candidateRef = Object.freeze({ id: `${eventId}:candidate`, revision });
  const candidate: AgentTerminalCandidate<TOutput> = input.decision.kind === "propose_completion"
    ? Object.freeze({ ref: candidateRef, kind: "complete" as const, output: input.decision.output })
    : Object.freeze({ ref: candidateRef, kind: "stop" as const, reason: input.decision.reason });
  return deepFreeze({
    ref: { run, id: eventId, sequence: positive(input.sequence, "AgentStopEvent.sequence"), revision },
    point: "Stop" as const,
    run,
    runKind: input.runKind,
    agent: { id: input.controllerInput.agent.id, revision: input.controllerInput.agent.revision },
    task: input.controllerInput.task,
    controllerRequestId: requestId,
    iteration: input.controllerInput.iteration,
    candidate,
    interaction: input.controllerInput.interaction,
    plan: input.controllerInput.plan,
    verification: input.controllerInput.verification,
    pending: input.controllerInput.pending,
    emittedAt: dateTime(input.emittedAt, "AgentStopEvent.emittedAt"),
  });
}

export function createAgentStopFailureEvent<TOutput>(input: {
  readonly sequence: number;
  readonly runKind: "root" | "descendant";
  readonly controllerInput: ControllerInput<TOutput>;
  readonly error: unknown;
  readonly emittedAt: string;
}): AgentStopFailureEvent {
  const run = Object.freeze({ id: token(input.controllerInput.runId, "AgentStopFailureEvent.runId") });
  const requestId = token(
    input.controllerInput.contextManifest.requestId,
    "AgentStopFailureEvent.controllerRequestId",
  );
  const eventId = `${requestId}:agent-stop-failure:${input.sequence}`;
  return deepFreeze({
    ref: {
      run,
      id: eventId,
      sequence: positive(input.sequence, "AgentStopFailureEvent.sequence"),
      revision: `${input.controllerInput.contextManifest.projectionId}:failure:${input.sequence}`,
    },
    point: "StopFailure" as const,
    run,
    runKind: input.runKind,
    agent: { id: input.controllerInput.agent.id, revision: input.controllerInput.agent.revision },
    task: input.controllerInput.task,
    controllerRequestId: requestId,
    iteration: input.controllerInput.iteration,
    failure: snapshotFailure(input.error),
    emittedAt: dateTime(input.emittedAt, "AgentStopFailureEvent.emittedAt"),
  });
}

function snapshotFailure(error: unknown): AgentTurnFailure {
  const candidate = error as {
    readonly name?: unknown;
    readonly message?: unknown;
    readonly failure?: { readonly failure?: { readonly code?: unknown } };
  };
  const name = typeof candidate?.name === "string" && candidate.name.length > 0
    ? candidate.name
    : "AgentExecutionError";
  const message = typeof candidate?.message === "string" && candidate.message.length > 0
    ? bounded(candidate.message)
    : "Agent execution failed before producing a valid decision.";
  const code = typeof candidate?.failure?.failure?.code === "string"
    ? candidate.failure.failure.code
    : null;
  return Object.freeze({ name, code, message });
}

function positive(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${field} must be a positive safe integer.`);
  }
  return value as number;
}

function token(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${field} must be a canonical non-empty string.`);
  }
  return value;
}

function dateTime(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${field} must be a valid date-time string.`);
  }
  return value;
}

function bounded(value: string): string {
  return value.length <= 4_096 ? value : `${value.slice(0, 4_093)}...`;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
