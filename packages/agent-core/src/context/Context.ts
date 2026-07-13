import type { EvidenceRef, Metadata } from "@agent-anything/shared";
import { projectPlan, type Plan, type PlanProjection } from "../plan/index.js";
import type { Observation } from "../runner/Observation.js";
import type { AgentTask } from "../task/index.js";
import type { ContextMessage } from "./ContextMessage.js";

export interface Context {
  readonly messages: readonly ContextMessage[];
  readonly observations: readonly Observation[];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly metadata: Metadata;
}

export interface ContextUpdate {
  readonly messages?: readonly ContextMessage[];
  readonly observations?: readonly Observation[];
  readonly evidenceRefs?: readonly EvidenceRef[];
  readonly metadata?: Metadata;
}

export interface ContextProjection {
  readonly messages: readonly ContextMessage[];
  readonly observations: readonly Observation[];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly plan: PlanProjection | null;
  readonly metadata: Metadata;
}

export function createInitialContext(task: AgentTask): Context {
  return freezeContext({
    messages: [],
    observations: [],
    evidenceRefs: [],
    metadata: {
      ...task.metadata,
      taskKind: task.kind,
      createdAt: task.createdAt,
    },
  });
}

export function applyContextUpdate(
  context: Context,
  update: ContextUpdate,
): Context {
  return freezeContext({
    messages: [...context.messages, ...(update.messages ?? [])],
    observations: [...context.observations, ...(update.observations ?? [])],
    evidenceRefs: appendUnique(context.evidenceRefs, update.evidenceRefs ?? []),
    metadata: {
      ...context.metadata,
      ...update.metadata,
    },
  });
}

export function projectContext(
  context: Context,
  plan: Plan | null,
): ContextProjection {
  return Object.freeze({
    messages: Object.freeze([...context.messages]),
    observations: Object.freeze([...context.observations]),
    evidenceRefs: Object.freeze([...context.evidenceRefs]),
    plan: plan === null ? null : projectPlan(plan),
    metadata: Object.freeze({ ...context.metadata }),
  });
}

function freezeContext(context: Context): Context {
  return Object.freeze({
    messages: Object.freeze([...context.messages]),
    observations: Object.freeze([...context.observations]),
    evidenceRefs: Object.freeze([...context.evidenceRefs]),
    metadata: Object.freeze({ ...context.metadata }),
  });
}

function appendUnique<TValue>(
  current: readonly TValue[],
  next: readonly TValue[],
): readonly TValue[] {
  const values = [...current];

  for (const value of next) {
    if (!values.includes(value)) {
      values.push(value);
    }
  }

  return values;
}
