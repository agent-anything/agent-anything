import { snapshotModelJsonValue } from "@agent-anything/model-interaction";
import type { ContextJsonValue } from "@agent-anything/context/contract";
import { createRunContextContribution } from "../context-contribution/RunContextContribution.js";

export interface RunInputNotification {
  readonly runId: string;
  readonly sequence: number;
  readonly source: { readonly owner: string; readonly kind: string; readonly id: string; readonly revision: string };
  readonly occurredAt: string;
  readonly data: unknown;
}

export interface RunInputNotificationSource {
  /** Synchronous, immutable facts after this Run's cursor; no destructive reads. */
  read(runId: string, afterSequence: number): readonly RunInputNotification[];
}

/** Admission and delivery cursors are independent of diagnostic observers. */
export class RunInputNotifications {
  private cursor = 0;
  private pending: RunInputNotification[] = [];
  get checkpoint(): number { return this.cursor; }
  get undelivered(): number { return this.pending.length; }
  get sources(): readonly RunInputNotification["source"][] { return Object.freeze(this.pending.map(fact => fact.source)); }

  collect(runId: string, source: RunInputNotificationSource | undefined, maximumBytes: number): readonly RunInputNotification[] {
    const values = source === undefined ? [] : source.read(runId, this.cursor);
    if (!Array.isArray(values)) throw new TypeError("Run input notification source must return an array.");
    let previous = this.cursor;
    const facts = values.map(value => {
      if (value.runId !== runId || !Number.isSafeInteger(value.sequence) || value.sequence <= previous ||
          !Number.isFinite(Date.parse(value.occurredAt)) ||
          [value.source.owner, value.source.kind, value.source.id, value.source.revision].some(token => typeof token !== "string" || !token.trim())) {
        throw new TypeError("Invalid Run input notification identity, ordering, or ownership.");
      }
      const data = snapshotModelJsonValue(value.data, "RunInputNotification.data");
      const fact: RunInputNotification = Object.freeze({runId, sequence: value.sequence,
        source: Object.freeze({owner: value.source.owner, kind: value.source.kind, id: value.source.id, revision: value.source.revision}),
        occurredAt: value.occurredAt, data});
      if (new TextEncoder().encode(JSON.stringify(fact)).length > maximumBytes) {
        throw new TypeError("Run input notification exceeds the Context contribution bound.");
      }
      previous = value.sequence;
      return fact;
    });
    this.cursor = previous;
    this.pending.push(...facts);
    return Object.freeze(facts);
  }

  delivered(checkpoint: number): void {
    this.pending = this.pending.filter(fact => fact.sequence > checkpoint);
  }

  contribution(runId: string) {
    if (this.pending.length === 0) return null;
    const revision = `${this.pending[0]!.sequence}-${this.cursor}`;
    const contribution = createRunContextContribution({
      id: `${runId}:input-notifications`, revision, runId, owner: "agent-runtime",
      sourceKind: "input_notifications", sourceId: `${runId}:input-notifications`, sourceRevision: revision, observedAt: this.pending.at(-1)!.occurredAt,
      payload: snapshotModelJsonValue({kind: "input_notifications", notifications: this.pending}, "InputNotifications") as ContextJsonValue,
      payloadKind: "structured", retention: "current", replacementKey: "input_notifications", instructionRole: "data", necessity: "mandatory",
      precedence: 95, audiences: ["model"], provenanceKind: "input_notifications", provenanceId: runId, provenanceRevision: revision,
    });
    return Object.freeze({...contribution, handling: Object.freeze({...contribution.handling, allowedTransformations: Object.freeze([])})});
  }
}
