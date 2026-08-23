
import {
  RUNTIME_EVENT_SCHEMA_VERSION,
  type RuntimeEvent,
  type RuntimeEventPublisher,
} from "./RuntimeEvent.js";
import type {
  RuntimeEventName,
  RuntimeEventPayloadMap,
} from "./RuntimeEventPayload.js";
import { snapshotRuntimeEventPayload } from "./snapshotRuntimeEventPayload.js";
import { snapshotRunLineage } from "./snapshotRunLineage.js";
import type { RunLineage } from "@agent-anything/agent-core/run-tree";

export interface RuntimeEventIdentityInput {
  readonly runId: string;
  readonly sequence: number;
}

export type RuntimeEventIdentityFactory = (
  input: RuntimeEventIdentityInput,
) => string;

export interface CreateRuntimeEventStreamInput {
  readonly runId: string;
  readonly taskId: string;
  readonly lineage: RunLineage;
  readonly now: () => string;
  readonly createEventId: RuntimeEventIdentityFactory;
  readonly publishers?: readonly RuntimeEventPublisher[];
}

export class RuntimeEventStream {
  private readonly runId: string;
  private readonly taskId: string;
  private readonly lineage: RunLineage;
  private readonly now: () => string;
  private readonly createEventId: RuntimeEventIdentityFactory;
  private readonly publishers: readonly RuntimeEventPublisher[];
  private sequence = 0;

  constructor(input: CreateRuntimeEventStreamInput) {
    this.runId = text(input.runId, "RuntimeEventStream.runId");
    this.taskId = text(input.taskId, "RuntimeEventStream.taskId");
    this.lineage = snapshotRunLineage(input.lineage, this.runId);
    if (typeof input.now !== "function") {
      throw new TypeError("RuntimeEventStream.now must be a function.");
    }
    if (typeof input.createEventId !== "function") {
      throw new TypeError(
        "RuntimeEventStream.createEventId must be a function.",
      );
    }
    this.now = input.now;
    this.createEventId = input.createEventId;
    this.publishers = Object.freeze(uniquePublishers(input.publishers ?? []));
  }

  emit<TName extends RuntimeEventName>(
    name: TName,
    payload: RuntimeEventPayloadMap[TName],
    occurredAt: string = this.now(),
  ): RuntimeEvent<TName> {
    const nextSequence = this.sequence + 1;
    const eventId = text(
      this.createEventId({ runId: this.runId, sequence: nextSequence }),
      "RuntimeEvent.id",
    );
    const event = Object.freeze({
      schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
      id: eventId,
      runId: this.runId,
      taskId: this.taskId,
      lineage: this.lineage,
      sequence: nextSequence,
      name,
      occurredAt: dateTime(occurredAt),
      payload: snapshotRuntimeEventPayload(name, payload),
    }) as RuntimeEvent<TName>;
    this.sequence = nextSequence;

    for (const publisher of this.publishers) {
      try {
        publisher.publish(event as unknown as RuntimeEvent);
      } catch {
        // RuntimeEvent delivery is non-authoritative and publisher-local.
      }
    }

    return event;
  }
}

function uniquePublishers(
  candidates: readonly RuntimeEventPublisher[],
): RuntimeEventPublisher[] {
  const publishers: RuntimeEventPublisher[] = [];
  for (const candidate of candidates) {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      typeof candidate.publish !== "function"
    ) {
      throw new TypeError("RuntimeEvent publisher must implement publish(event).");
    }
    if (!publishers.includes(candidate)) {
      publishers.push(candidate);
    }
  }
  return publishers;
}

function text(candidate: unknown, field: string): string {
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
  return candidate;
}

function dateTime(candidate: unknown): string {
  if (
    typeof candidate !== "string" ||
    candidate.trim().length === 0 ||
    !Number.isFinite(Date.parse(candidate))
  ) {
    throw new TypeError("RuntimeEvent.occurredAt must be an ISO date-time string.");
  }
  return candidate;
}
