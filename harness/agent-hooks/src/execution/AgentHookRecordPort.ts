import type { AgentHookRegistration } from "../composition/index.js";
import type { AgentStopEvent, AgentStopFailureEvent } from "../events/index.js";
import { ControllerCheckpointError } from "@agent-anything/agent-runtime/controller";

export type AgentHookInvocationOutcome =
  | {readonly status: "completed"; readonly value: unknown; readonly startedAt: string; readonly completedAt: string}
  | {readonly status: "failed" | "timed_out" | "cancelled" | "output_invalid"; readonly message: string; readonly startedAt: string; readonly completedAt: string};

export interface AgentHookInvocationCheckpoint {
  readonly id: string;
  readonly version: 1;
  readonly event: AgentStopEvent | AgentStopFailureEvent;
  readonly registration: AgentHookRegistration;
  readonly startedAt: string;
  readonly outcome: AgentHookInvocationOutcome | null;
}

/** Independent owner records may settle after the associated Run has ended. */
export interface AgentHookRecordPort {
  readHookInvocation(id: string): Promise<AgentHookInvocationCheckpoint | null>;
  commitHookInvocation(checkpoint: AgentHookInvocationCheckpoint): Promise<void>;
}

export function validateAgentHookCheckpoint(next: AgentHookInvocationCheckpoint, previous: AgentHookInvocationCheckpoint | null): void {
  if (next.version !== 1 || next.id !== hookInvocationId(next.event, next.registration) ||
      !Number.isFinite(Date.parse(next.startedAt)) ||
      next.event.point !== next.registration.point || !next.registration.runKinds.includes(next.event.runKind)) {
    throw new ControllerCheckpointError("agent_hook_record_invalid");
  }
  if (previous && (JSON.stringify({...next, outcome: null}) !== JSON.stringify({...previous, outcome: null}) ||
      previous.outcome !== null && JSON.stringify(previous.outcome) !== JSON.stringify(next.outcome))) {
    throw new ControllerCheckpointError("agent_hook_record_conflict");
  }
  if (!previous && next.outcome !== null) throw new ControllerCheckpointError("agent_hook_intent_missing");
  const outcome = next.outcome;
  if (outcome && (outcome.startedAt !== next.startedAt || !Number.isFinite(Date.parse(outcome.completedAt)) ||
      !["completed", "failed", "timed_out", "cancelled", "output_invalid"].includes(outcome.status))) {
    throw new ControllerCheckpointError("agent_hook_outcome_invalid");
  }
}

export function hookInvocationId(event: AgentStopEvent | AgentStopFailureEvent, registration: AgentHookRegistration): string {
  return JSON.stringify([event.ref.id, registration.ref, registration.mode]);
}

export function interruptedAgentHook(checkpoint: AgentHookInvocationCheckpoint, completedAt: string): AgentHookInvocationCheckpoint {
  if (checkpoint.outcome !== null) return checkpoint;
  return {...checkpoint, outcome: {status: "failed", startedAt: checkpoint.startedAt, completedAt,
    message: "Agent Hook invocation was interrupted; its effects are unknown and it was not replayed."}};
}
