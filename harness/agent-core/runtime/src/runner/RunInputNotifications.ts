import { snapshotModelJsonValue } from "@agent-anything/model-interaction";
import { createHash } from "node:crypto";
import { inputNotificationDigest, snapshotInputDeliveryReceipt,
  type ControllerInputDeliveryBatch, type ControllerInputDeliveryReceipt } from "../controller/ControllerInputDelivery.js";

export interface RunInputNotification {
  readonly runId: string;
  readonly sequence: number;
  readonly sourceSequence?: number;
  readonly source: { readonly owner: string; readonly kind: string; readonly id: string; readonly revision: string };
  readonly occurredAt: string;
  readonly data: unknown;
}

export interface RunInputNotificationSource {
  /** Synchronous, immutable facts after this Run's cursor; no destructive reads. */
  read(runId: string, afterSequence: number): readonly RunInputNotification[];
}

export interface RunInputNotificationCheckpoint {
  readonly cursor: number;
  readonly admissionSequence: number;
  readonly pending: readonly RunInputNotification[];
}

/** Admission and delivery cursors are independent of diagnostic observers. */
export class RunInputNotifications {
  private cursor = 0;
  private admissionSequence = 0;
  private pending: RunInputNotification[] = [];
  get checkpoint(): number { return this.cursor; }
  get undelivered(): number { return this.pending.length; }
  get sources(): readonly RunInputNotification["source"][] { return Object.freeze(this.pending.map(fact => fact.source)); }
  get pendingEntries(): readonly RunInputNotification[] { return Object.freeze([...this.pending]); }

  static restore(runId: string, checkpoint: RunInputNotificationCheckpoint): RunInputNotifications {
    if ([checkpoint.cursor, checkpoint.admissionSequence].some(value => !Number.isSafeInteger(value) || value < 0)) {
      throw new TypeError("Invalid retained notification cursor.");
    }
    let sequence = 0;
    for (const entry of checkpoint.pending) {
      if (entry.runId !== runId || !Number.isSafeInteger(entry.sequence) || entry.sequence <= sequence ||
          entry.sequence > checkpoint.admissionSequence || (entry.sourceSequence ?? 0) > checkpoint.cursor) {
        throw new TypeError("Invalid retained notification ownership or order.");
      }
      sequence = entry.sequence;
    }
    const owner = new RunInputNotifications();
    owner.cursor = checkpoint.cursor;
    owner.admissionSequence = checkpoint.admissionSequence;
    owner.pending = structuredClone(checkpoint.pending) as RunInputNotification[];
    return owner;
  }

  collect(runId: string, source: RunInputNotificationSource | undefined, maximumBytes: number): readonly RunInputNotification[] {
    const values = source === undefined ? [] : source.read(runId, this.cursor);
    if (!Array.isArray(values)) throw new TypeError("Run input notification source must return an array.");
    let previous = this.cursor;
    const facts = values.map((value, index) => {
      if (value.runId !== runId || !Number.isSafeInteger(value.sequence) || value.sequence <= previous ||
          !Number.isFinite(Date.parse(value.occurredAt)) ||
          [value.source.owner, value.source.kind, value.source.id, value.source.revision].some(token => typeof token !== "string" || !token.trim())) {
        throw new TypeError("Invalid Run input notification identity, ordering, or ownership.");
      }
      const data = snapshotModelJsonValue(value.data, "RunInputNotification.data");
      const fact: RunInputNotification = Object.freeze({runId, sequence: this.admissionSequence + index + 1, sourceSequence: value.sequence,
        source: Object.freeze({owner: value.source.owner, kind: value.source.kind, id: value.source.id, revision: value.source.revision}),
        occurredAt: value.occurredAt, data});
      if (new TextEncoder().encode(JSON.stringify(fact)).length > maximumBytes) {
        throw new TypeError("Run input notification exceeds the Context contribution bound.");
      }
      previous = value.sequence;
      return fact;
    });
    this.cursor = previous;
    this.admissionSequence += facts.length;
    this.pending.push(...facts);
    return Object.freeze(facts);
  }

  admitOwned(runId: string, input: Omit<RunInputNotification, "runId" | "sequence" | "sourceSequence">,
    maximumBytes: number, unavailableData?: unknown): RunInputNotification {
    if (!Number.isFinite(Date.parse(input.occurredAt)) ||
        [input.source.owner, input.source.kind, input.source.id, input.source.revision].some(value => typeof value !== "string" || !value.trim())) {
      throw new TypeError("Invalid owned input notification identity.");
    }
    const snapshot = (data: unknown): RunInputNotification => {
      const fact = Object.freeze({runId, sequence: this.admissionSequence + 1, source: Object.freeze({...input.source}),
        occurredAt: input.occurredAt, data: snapshotModelJsonValue(data, "RunInputNotification.data")});
      if (new TextEncoder().encode(JSON.stringify(fact)).length > maximumBytes) throw new TypeError("Owned input notification exceeds delivery bound.");
      return fact;
    };
    let fact: RunInputNotification;
    try { fact = snapshot(input.data); }
    catch (error) {
      if (unavailableData === undefined) throw error;
      fact = snapshot(unavailableData);
    }
    this.admissionSequence++;
    this.pending.push(fact);
    return fact;
  }

  prepare(runId: string, controllerRequestId: string): ControllerInputDeliveryBatch | null {
    if (this.pending.length === 0) return null;
    if (this.pending.some(entry => entry.runId !== runId)) throw new TypeError("Input-delivery recipient mismatch.");
    const revision = `sha256:${createHash("sha256").update(JSON.stringify(this.pending)).digest("hex")}`;
    return Object.freeze({id: `${controllerRequestId}:input-delivery`, revision, runId,
      entries: Object.freeze([...this.pending])});
  }

  /** Stage with the accepted Turn and receipt in the same authoritative commit. */
  accepted(batch: ControllerInputDeliveryBatch, receipt: ControllerInputDeliveryReceipt): void {
    snapshotInputDeliveryReceipt(receipt, batch);
    const selected = new Map(batch.entries.map(entry => [entry.sequence, inputNotificationDigest(entry)]));
    if (batch.entries.some(entry => !this.pending.some(pending => pending.sequence === entry.sequence &&
        inputNotificationDigest(pending) === selected.get(entry.sequence)))) {
      throw new TypeError("Input-delivery entries are no longer pending.");
    }
    this.pending = this.pending.filter(entry => !selected.has(entry.sequence));
  }
}
