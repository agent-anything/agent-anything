import type { AgentRevisionRef } from "@agent-anything/agent-core/agent";
import type { RunLineage } from "@agent-anything/agent-core/run-tree";
import type { TaskRef } from "@agent-anything/agent-core/task";
import type { RunOperationSnapshot } from "./RunHandle.js";
import type { RunItem } from "../run/index.js";

export interface RunSnapshotObservation {
  readonly agent: AgentRevisionRef;
  readonly task: TaskRef;
  readonly lineage: RunLineage;
  readonly startedAt: string;
  readonly snapshot: RunOperationSnapshot;
}
export interface RunTransitionObservation {
  readonly runId: string;
  readonly previousStatus: RunOperationSnapshot["status"];
  readonly status: RunOperationSnapshot["status"];
  readonly previousRevision: number;
  readonly revision: number;
  readonly occurredAt: string | null;
  readonly causes: readonly RunItem["ref"][];
}
export interface RunObserver {
  observe(observation: RunSnapshotObservation): void;
  transition?(observation: RunTransitionObservation): void;
}

export const RUN_LIFECYCLE_DESCRIPTION = Object.freeze({
  revision: "run-state-writer.v1",
  states: Object.freeze(["initializing", "running", "waiting", "suspended", "cancelling", "succeeded", "stopped", "failed", "cancelled"]),
  transitions: Object.freeze(["initializing", "running", "waiting", "suspended", "cancelling"].flatMap((from) =>
    ["running", "waiting", "suspended", "cancelling", "succeeded", "stopped", "failed", "cancelled"].filter((to) => to !== from).map((to) => Object.freeze({ id: `${from}:${to}`, from, to, trigger: "committed Run State mutation" })))),
});

export function publishRunTransition(observer: RunObserver | undefined, observation: RunTransitionObservation): void {
  if (!observer?.transition) return;
  try { void Promise.resolve(observer.transition(Object.freeze(observation))).catch(() => {}); } catch { /* Non-authoritative observation. */ }
}

export function publishRunObservation(observer: RunObserver | undefined, observation: RunSnapshotObservation): void {
  if (!observer) return;
  try { void Promise.resolve(observer.observe(Object.freeze(observation))).catch(() => {}); } catch { /* Observation carries no execution authority. */ }
}
