import type Database from "better-sqlite3";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";

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
}
export interface ContextFoundationObserver {observe(fact:ContextFoundationFact):void;}
export class ContextFoundationRecords {
  private readonly statements=new Map<string,Database.Statement>();
  private observationCursor:number|null=null;
  constructor(private readonly db:Database.Database) {}
  sql(text:string):Database.Statement {
    let statement=this.statements.get(text);
    if (!statement) {statement=this.db.prepare(text);this.statements.set(text,statement);}
    return statement;
  }
  fact(runId:string,owner:string,subject:string,kind:string,details:Readonly<Record<string,unknown>>):void {
    this.observationCursor??=(this.sql("SELECT COALESCE(MAX(sequence),0) AS n FROM context_foundation_facts").get() as {n:number}).n;
    const value={runId,owner,subject,kind,occurredAt:new Date().toISOString(),details};
    this.sql("INSERT INTO context_foundation_facts(run_id,owner,subject,kind,value,digest) VALUES (?,?,?,?,?,?)")
      .run(runId,owner,subject,kind,JSON.stringify(value),modelInputValueDigest(value));
  }
  takeObservations():readonly ContextFoundationFact[] {
    if(this.observationCursor===null)return [];
    const rows=this.sql("SELECT sequence,value,digest FROM context_foundation_facts WHERE sequence>? ORDER BY sequence LIMIT 256").all(this.observationCursor) as {sequence:number;value:string;digest:string}[];
    const facts=rows.map(row=>({...checkedJson<Omit<ContextFoundationFact,"sequence">>(row),sequence:row.sequence}));
    if(facts.length)this.observationCursor=facts.at(-1)!.sequence;return facts;
  }
  facts(runId:string,after:number,limit:number):readonly ContextFoundationFact[] {
    if (!Number.isSafeInteger(after) || after<0 || !Number.isSafeInteger(limit) || limit<1 || limit>256) throw new TypeError("context_fact_page_invalid");
    const rows=this.sql("SELECT sequence,value,digest FROM context_foundation_facts WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT ?")
      .all(runId,after,limit) as {sequence:number;value:string;digest:string}[];
    return rows.map(row=>{
      const value=checkedJson<Omit<ContextFoundationFact,"sequence">>(row);
      if (value.runId!==runId) throw new Error("context_fact_scope_corrupt");
      return {...value,sequence:row.sequence};
    });
  }
}
export function checkedJson<T>(row:{value:string;digest:string}):T {
  const value=JSON.parse(row.value) as T;
  if (modelInputValueDigest(value)!==row.digest) throw new Error("context_record_corrupt");
  return value;
}
export function requireSame(left:unknown,right:unknown):void {
  if (modelInputValueDigest(left)!==modelInputValueDigest(right)) throw new Error("context_identity_conflict");
}
