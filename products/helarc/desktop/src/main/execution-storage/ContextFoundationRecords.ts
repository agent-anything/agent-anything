import type Database from "better-sqlite3";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {validateContextProcessEvidence,type ContextProcessEvidence} from "@agent-anything/context/evidence";
import {captureActivityClock,type ActivityClockSample} from "@agent-anything/agent-runtime/activity";

export const CONTEXT_FOUNDATION_FACT_SCHEMA = `
CREATE TABLE context_foundation_facts(sequence INTEGER PRIMARY KEY,run_id TEXT NOT NULL,owner TEXT NOT NULL,subject TEXT NOT NULL,kind TEXT NOT NULL,value TEXT NOT NULL,digest TEXT NOT NULL);
CREATE INDEX context_foundation_facts_run ON context_foundation_facts(run_id,sequence);
`;
export interface ContextFoundationFact {
  readonly sequence:number;
  readonly runId:string;
  readonly owner:string;
  readonly subject:string;
  readonly kind:string;
  readonly occurredAt:string;
  readonly details:Readonly<Record<string,unknown>>;
  readonly evidence:ContextProcessEvidence;
  readonly clock?:ActivityClockSample;
}
export interface ContextFoundationObserver {observe(fact:ContextFoundationFact):void;}
interface FactRow {sequence:number;run_id:string;owner:string;subject:string;kind:string;value:string;digest:string;}
export class ContextFoundationRecords {
  private readonly statements=new Map<string,Database.Statement>();
  private observationCursor:number|null=null;
  constructor(private readonly db:Database.Database) {}
  sql(text:string):Database.Statement {
    let statement=this.statements.get(text);
    if (!statement) {statement=this.db.prepare(text);this.statements.set(text,statement);}
    return statement;
  }
  fact(runId:string,owner:string,subject:string,kind:string,details:Readonly<Record<string,unknown>>,evidence:ContextProcessEvidence):void {
    validateEvidence({runId,owner,subject,kind,evidence});
    this.observationCursor??=(this.sql("SELECT COALESCE(MAX(sequence),0) AS n FROM context_foundation_facts").get() as {n:number}).n;
    const value={runId,owner,subject,kind,occurredAt:new Date().toISOString(),clock:captureActivityClock(),details,evidence};
    this.sql("INSERT INTO context_foundation_facts(run_id,owner,subject,kind,value,digest) VALUES (?,?,?,?,?,?)")
      .run(runId,owner,subject,kind,JSON.stringify(value),modelInputValueDigest(value));
  }
  takeObservations():readonly ContextFoundationFact[] {
    if(this.observationCursor===null)return [];
    const rows=this.sql("SELECT sequence,run_id,owner,subject,kind,value,digest FROM context_foundation_facts WHERE sequence>? ORDER BY sequence LIMIT 256").all(this.observationCursor) as FactRow[];
    const facts=rows.map(readFact);
    if(facts.length)this.observationCursor=facts.at(-1)!.sequence;return facts;
  }
  facts(runId:string,after:number,limit:number):readonly ContextFoundationFact[] {
    if (!Number.isSafeInteger(after) || after<0 || !Number.isSafeInteger(limit) || limit<1 || limit>256) throw new TypeError("context_fact_page_invalid");
    const rows=this.sql("SELECT sequence,run_id,owner,subject,kind,value,digest FROM context_foundation_facts WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT ?")
      .all(runId,after,limit) as FactRow[];
    return rows.map(row=>{
      const value=readFact(row);
      if (value.runId!==runId) throw new Error("context_fact_scope_corrupt");
      return value;
    });
  }
}
function readFact(row:FactRow):ContextFoundationFact {
  const value=checkedJson<Omit<ContextFoundationFact,"sequence">>(row);
  if(value.runId!==row.run_id||value.owner!==row.owner||value.subject!==row.subject||value.kind!==row.kind)throw new Error("context_fact_identity_corrupt");
  validateEvidence(value);return {...value,sequence:row.sequence};
}
function validateEvidence(value:Pick<ContextFoundationFact,"runId"|"owner"|"subject"|"kind"|"evidence">):void {
  if(!value.evidence)throw new Error("context_process_evidence_missing");
  validateContextProcessEvidence(value.evidence);
  if(value.evidence.subject.id!==value.subject||value.evidence.subject.runId!==value.runId)throw new Error("context_fact_evidence_scope_invalid");
}
export function checkedJson<T>(row:{value:string;digest:string}):T {
  const value=JSON.parse(row.value) as T;
  if (modelInputValueDigest(value)!==row.digest) throw new Error("context_record_corrupt");
  return value;
}
export function requireSame(left:unknown,right:unknown):void {
  if (modelInputValueDigest(left)!==modelInputValueDigest(right)) throw new Error("context_identity_conflict");
}
