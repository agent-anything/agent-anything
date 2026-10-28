import type Database from "better-sqlite3";
import {activityToken, type SharedAcceptancePart, type SharedAcceptanceProposal, type SharedAcceptanceReceipt} from "@agent-anything/agent-runtime/activity";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";

export const SHARED_ACCEPTANCE_SCHEMA = `
CREATE TABLE shared_acceptances(sequence INTEGER PRIMARY KEY,id TEXT NOT NULL UNIQUE,scope TEXT NOT NULL,digest TEXT NOT NULL,
 outcome TEXT NOT NULL,rejection TEXT,participants TEXT NOT NULL,integrity TEXT NOT NULL);
CREATE INDEX shared_acceptance_scope ON shared_acceptances(scope,sequence);
`;
export interface SharedAcceptanceParticipant {
  readonly owner: string;
  readonly kinds: readonly string[];
  /** Complete and protect bodies outside the common transaction; return bounded immutable references. */
  prepare(part: SharedAcceptancePart, proposal: SharedAcceptanceProposal): unknown;
  /** Validate and mutate only this participant's state; no I/O or unbounded semantic processing. */
  apply(prepared: unknown, proposal: SharedAcceptanceProposal): void;
  /** Cross-part postconditions after all owners applied, before the common commit. */
  validate?(prepared:unknown,proposal:SharedAcceptanceProposal):void;
}
export class SharedAcceptanceRejection extends Error {
  constructor(readonly owner: string, readonly code: string) {super(code);}
}

/** A transaction boundary, not a professional state owner or unrestricted key/value API. */
export class SharedAcceptanceDatabase {
  private readonly participants = new Map<string, SharedAcceptanceParticipant>();
  constructor(private readonly db: Database.Database, participants: readonly SharedAcceptanceParticipant[]) {
    for (const participant of participants) {
      if (this.participants.has(participant.owner)) throw new TypeError("acceptance_participant_duplicate");
      this.participants.set(participant.owner,participant);
    }
  }
  accept(proposal: SharedAcceptanceProposal): SharedAcceptanceReceipt {
    [proposal.id,proposal.scope,proposal.actor].forEach(activityToken);
    if (!Array.isArray(proposal.parts) || !proposal.parts.length || proposal.parts.length > 64) throw new TypeError("acceptance_parts_invalid");
    const digest = modelInputValueDigest(proposal), prior = this.query(proposal.id);
    if (prior) {this.same(prior,digest); return prior;}
    let prepared: {participant:SharedAcceptanceParticipant;value:unknown}[];
    try {
      prepared = proposal.parts.map(part => {
        const participant = this.participants.get(part.owner);
        if (!participant || !participant.kinds.includes(part.kind)) throw new SharedAcceptanceRejection(part.owner,"acceptance_participant_unavailable");
        return {participant,value:participant.prepare(part,proposal)};
      });
    } catch (error) {
      if (!(error instanceof SharedAcceptanceRejection)) throw error;
      return this.db.transaction(() => this.record(proposal,digest,error))();
    }
    return this.db.transaction(() => {
      const old = this.query(proposal.id);
      if (old) {this.same(old,digest); return old;}
      let rejection: SharedAcceptanceRejection | null = null;
      try {
        // Savepoint rolls back participant changes while the outer transaction records a known rejection.
        this.db.transaction(() => {
          for (const part of prepared) part.participant.apply(part.value,proposal);
          for (const part of prepared) part.participant.validate?.(part.value,proposal);
        })();
      } catch (error) {
        if (!(error instanceof SharedAcceptanceRejection)) throw error;
        rejection = error;
      }
      return this.record(proposal,digest,rejection);
    })();
  }
  query(id: string): SharedAcceptanceReceipt | null {
    activityToken(id);
    const row = this.db.prepare("SELECT sequence,id,scope,digest,outcome,rejection,participants,integrity FROM shared_acceptances WHERE id=?").get(id) as
      Omit<SharedAcceptanceReceipt,"rejection"> & {rejection:string|null;participants:string;integrity:string} | undefined;
    if (!row) return null;
    const {sequence,integrity,...fact} = row;
    if (modelInputValueDigest(fact) !== integrity || !["accepted","rejected"].includes(row.outcome)) throw new Error("acceptance_record_corrupt");
    return {id:row.id,sequence,scope:row.scope,digest:row.digest,outcome:row.outcome,
      rejection:row.rejection ? JSON.parse(row.rejection) as SharedAcceptanceReceipt["rejection"] : null};
  }
  private record(proposal: SharedAcceptanceProposal, digest:string, rejection:SharedAcceptanceRejection|null): SharedAcceptanceReceipt {
    const old = this.query(proposal.id);
    if (old) {this.same(old,digest); return old;}
    const fact = {id:proposal.id,scope:proposal.scope,digest,outcome:rejection ? "rejected" : "accepted",
      rejection:rejection ? JSON.stringify({owner:rejection.owner,code:rejection.code}) : null,
      participants:JSON.stringify(proposal.parts.map(({owner,kind}) => ({owner,kind})))};
    this.db.prepare("INSERT INTO shared_acceptances(id,scope,digest,outcome,rejection,participants,integrity) VALUES (?,?,?,?,?,?,?)")
      .run(fact.id,fact.scope,fact.digest,fact.outcome,fact.rejection,fact.participants,modelInputValueDigest(fact));
    return this.query(proposal.id)!;
  }
  private same(prior:SharedAcceptanceReceipt,digest:string): void {
    if (prior.digest !== digest) throw new TypeError("acceptance_identity_conflict");
  }
}
