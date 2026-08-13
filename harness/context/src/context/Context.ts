import type { AgentTask } from "@agent-anything/agent-core/task";
import type { EvidenceRef } from "../evidence/EvidenceRef.js";
import type { ContextMessage } from "./ContextMessage.js";

export interface ContextObservation {
  readonly id: string;
  readonly runId: string;
  readonly actionId: string;
  readonly kind: string;
  readonly createdAt: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface Context<
  TObservation extends ContextObservation = ContextObservation,
> {
  readonly messages: readonly ContextMessage[];
  readonly observations: readonly TObservation[];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ContextUpdate<
  TObservation extends ContextObservation = ContextObservation,
> {
  readonly messages?: readonly ContextMessage[];
  readonly observations?: readonly TObservation[];
  readonly evidenceRefs?: readonly EvidenceRef[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export function createInitialContext<
  TObservation extends ContextObservation = ContextObservation,
>(task: AgentTask): Context<TObservation> {
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

export function applyContextUpdate<TObservation extends ContextObservation>(
  context: Context<TObservation>,
  update: ContextUpdate<TObservation>,
): Context<TObservation> {
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

function freezeContext<TObservation extends ContextObservation>(
  context: Context<TObservation>,
): Context<TObservation> {
  const observations = context.observations.map(snapshotObservation);
  assertUniqueObservationIds(observations);
  return Object.freeze({
    messages: Object.freeze(context.messages.map(snapshotMessage)),
    observations: Object.freeze(observations),
    evidenceRefs: Object.freeze(context.evidenceRefs.map(snapshotEvidenceRef)),
    metadata: snapshotMetadata(context.metadata, "Context metadata"),
  });
}

function snapshotMessage(message: ContextMessage): ContextMessage {
  assertNonEmpty(message.id, "Context message id");
  if (
    message.role !== "system" &&
    message.role !== "user" &&
    message.role !== "assistant"
  ) {
    throw new TypeError("Context message role is invalid.");
  }
  if (typeof message.content !== "string") {
    throw new TypeError("Context message content must be a string.");
  }
  return Object.freeze({
    id: message.id,
    role: message.role,
    content: message.content,
    metadata: snapshotMetadata(message.metadata, "Context message metadata"),
  });
}

function snapshotObservation<TObservation extends ContextObservation>(
  observation: TObservation,
): TObservation {
  if (!isRecord(observation)) {
    throw new TypeError("Context Observation must be an object.");
  }
  assertNonEmpty(observation.id, "Context Observation id");
  assertNonEmpty(observation.runId, "Context Observation runId");
  assertNonEmpty(observation.actionId, "Context Observation actionId");
  assertNonEmpty(observation.kind, "Context Observation kind");
  assertDateTime(observation.createdAt, "Context Observation createdAt");
  return Object.freeze({
    ...observation,
    metadata: snapshotMetadata(
      observation.metadata,
      "Context Observation metadata",
    ),
  });
}

function snapshotEvidenceRef(reference: EvidenceRef): EvidenceRef {
  assertNonEmpty(reference, "Context EvidenceRef");
  return reference;
}

function snapshotMetadata(
  metadata: Readonly<Record<string, unknown>>,
  field: string,
): Readonly<Record<string, unknown>> {
  if (!isRecord(metadata)) {
    throw new TypeError(`${field} must be a record.`);
  }
  return Object.freeze({ ...metadata });
}

function assertUniqueObservationIds(
  observations: readonly ContextObservation[],
): void {
  const ids = new Set<string>();
  for (const observation of observations) {
    if (ids.has(observation.id)) {
      throw new TypeError(
        `Context Observation id '${observation.id}' is duplicated.`,
      );
    }
    ids.add(observation.id);
  }
}

function assertDateTime(value: string, field: string): void {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new TypeError(`${field} must be an ISO date-time string.`);
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
