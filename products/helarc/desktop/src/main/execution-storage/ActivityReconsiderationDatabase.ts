import type Database from "better-sqlite3";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {activityToken,activityCount,type ActivityFactSource,type ActivityPublishedFact,type ActivityReconsiderationSubscription,
  type ActivityReconsiderationState,type ActivityReconsiderationSnapshot,type ActivityReconsiderationReceipt} from "@agent-anything/agent-runtime/activity";

export const ACTIVITY_RECONSIDERATION_SCHEMA=`
CREATE TABLE activity_fact_sources(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,value TEXT NOT NULL,digest TEXT NOT NULL);
CREATE TABLE activity_published_facts(sequence INTEGER PRIMARY KEY,id TEXT NOT NULL UNIQUE,source_id TEXT NOT NULL REFERENCES activity_fact_sources(id),value TEXT NOT NULL,digest TEXT NOT NULL);
CREATE INDEX activity_publication_source ON activity_published_facts(source_id,sequence);
CREATE TABLE activity_reconsiderations(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,value TEXT NOT NULL,digest TEXT NOT NULL,revision INTEGER NOT NULL,consumed INTEGER NOT NULL,closed INTEGER NOT NULL);
CREATE TABLE activity_reconsideration_receipts(id TEXT PRIMARY KEY,value TEXT NOT NULL,digest TEXT NOT NULL);
`;
type Fact=(runId:string,subject:string,kind:"fact_published"|"reconsideration_registered"|"reconsideration_accepted",details:Readonly<Record<string,unknown>>)=>void;

/** Publication and finite consumption share the execution transaction, not a notification queue. */
export class ActivityReconsiderationDatabase {
  private readonly statements=new Map<string,Database.Statement>();
  constructor(private readonly db:Database.Database,private readonly fact:Fact) {}
  source(source:ActivityFactSource):ActivityFactSource {
    [source.id,source.runId,source.owner].forEach(activityToken);
    const old=this.read<ActivityFactSource>("activity_fact_sources",source.id);if(old){same(old,source);return old;}
    this.sql("INSERT INTO activity_fact_sources VALUES (?,?,?,?)").run(source.id,source.runId,JSON.stringify(source),modelInputValueDigest(source));return source;
  }
  publish(fact:ActivityPublishedFact):ActivityPublishedFact {
    [fact.id,fact.sourceId,fact.ref.owner,fact.ref.kind,fact.ref.id,fact.ref.revision].forEach(activityToken);
    const source=this.read<ActivityFactSource>("activity_fact_sources",fact.sourceId);if(!source||source.owner!==fact.ref.owner)fail("source_invalid");
    const old=this.read<ActivityPublishedFact>("activity_published_facts",fact.id);if(old){same(old,fact);return old;}
    const sequence=Number(this.sql("INSERT INTO activity_published_facts(id,source_id,value,digest) VALUES (?,?,?,?)").run(fact.id,fact.sourceId,JSON.stringify(fact),modelInputValueDigest(fact)).lastInsertRowid);
    this.fact(source.runId,fact.sourceId,"fact_published",{fact,sequence});return fact;
  }
  subscribe(subscription:ActivityReconsiderationSubscription):ActivityReconsiderationState {
    [subscription.id,subscription.runId,subscription.owner].forEach(activityToken);
    if(!Array.isArray(subscription.sources)||!subscription.sources.length||subscription.sources.length>128||new Set(subscription.sources).size!==subscription.sources.length)fail("sources_invalid");
    for(const id of subscription.sources){activityToken(id);const source=this.read<ActivityFactSource>("activity_fact_sources",id);if(!source||source.runId!==subscription.runId)fail("source_scope_invalid");}
    const old=this.state(subscription.id);if(old){same(old.subscription,subscription);return old;}
    this.sql("INSERT INTO activity_reconsiderations VALUES (?,?,?,?,0,0,0)").run(subscription.id,subscription.runId,JSON.stringify(subscription),modelInputValueDigest(subscription));
    this.fact(subscription.runId,subscription.id,"reconsideration_registered",{subscription});return this.state(subscription.id)!;
  }
  snapshot(subscriptionId:string,limit:number):ActivityReconsiderationSnapshot {
    activityCount(limit);if(limit>256)fail("page_limit");const state=this.state(subscriptionId);if(!state)fail("subscription_missing");
    const rows=state.closed?[]:this.rows(state,Number.MAX_SAFE_INTEGER,limit+1);
    const more=rows.length>limit,facts=rows.slice(0,limit);
    return {state,through:facts.at(-1)?.sequence??state.consumedThrough,facts,more};
  }
  accept(receipt:ActivityReconsiderationReceipt):ActivityReconsiderationState {
    [receipt.id,receipt.subscriptionId,receipt.decision.owner,receipt.decision.kind,receipt.decision.id,receipt.decision.revision].forEach(activityToken);
    activityCount(receipt.expectedRevision,true);activityCount(receipt.through,true);
    const old=this.read<ActivityReconsiderationReceipt>("activity_reconsideration_receipts",receipt.id);
    if(old){same(old,receipt);return this.state(receipt.subscriptionId)!;}
    const state=this.state(receipt.subscriptionId);
    if(!state||state.closed||state.revision!==receipt.expectedRevision||receipt.decision.owner!==state.subscription.owner||receipt.through<state.consumedThrough)fail("acceptance_conflict");
    if(!Array.isArray(receipt.factIds)||receipt.factIds.length>256||typeof receipt.close!=="boolean")fail("receipt_invalid");
    const facts=this.rows(state,receipt.through,257);
    if(facts.length>256||receipt.through!==(facts.at(-1)?.sequence??state.consumedThrough)||modelInputValueDigest(facts.map(fact=>fact.id))!==modelInputValueDigest(receipt.factIds))fail("boundary_mismatch");
    this.sql("INSERT INTO activity_reconsideration_receipts VALUES (?,?,?)").run(receipt.id,JSON.stringify(receipt),modelInputValueDigest(receipt));
    this.sql("UPDATE activity_reconsiderations SET consumed=?,revision=revision+1,closed=? WHERE id=?").run(receipt.through,receipt.close?1:0,receipt.subscriptionId);
    this.fact(state.subscription.runId,receipt.subscriptionId,"reconsideration_accepted",{receipt});return this.state(receipt.subscriptionId)!;
  }
  state(id:string):ActivityReconsiderationState|null {
    activityToken(id);const row=this.sql("SELECT * FROM activity_reconsiderations WHERE id=?").get(id) as {value:string;digest:string;revision:number;consumed:number;closed:number}|undefined;
    return row?{subscription:checked<ActivityReconsiderationSubscription>(row),revision:row.revision,consumedThrough:row.consumed,closed:row.closed===1}:null;
  }
  sourceState(id:string):ActivityFactSource|null{return this.read<ActivityFactSource>("activity_fact_sources",id);}
  pending(runId:string,afterId:string|null,limit:number):readonly ActivityReconsiderationState[] {
    activityToken(runId);if(afterId!==null)activityToken(afterId);activityCount(limit);if(limit>256)fail("page_limit");
    const rows=this.sql(`SELECT r.id FROM activity_reconsiderations r WHERE r.run_id=? AND r.closed=0 AND r.id>? AND EXISTS (
      SELECT 1 FROM activity_published_facts f WHERE f.sequence>r.consumed AND f.source_id IN (
        SELECT value FROM json_each(r.value,'$.sources'))) ORDER BY r.id LIMIT ?`).all(runId,afterId??"",limit) as {id:string}[];
    return rows.map(row=>this.state(row.id)!);
  }
  retainedRuns():readonly string[]{return (this.sql("SELECT DISTINCT run_id FROM activity_reconsiderations WHERE closed=0").all() as {run_id:string}[]).map(row=>row.run_id);}
  private rows(state:ActivityReconsiderationState,through:number,limit:number):readonly (ActivityPublishedFact&{sequence:number})[] {
    const sources=JSON.stringify(state.subscription.sources);
    return (this.sql("SELECT sequence,value,digest FROM activity_published_facts WHERE source_id IN (SELECT value FROM json_each(?)) AND sequence>? AND sequence<=? ORDER BY sequence LIMIT ?")
      .all(sources,state.consumedThrough,through,limit) as {sequence:number;value:string;digest:string}[]).map(row=>({...checked<ActivityPublishedFact>(row),sequence:row.sequence}));
  }
  private read<T>(table:"activity_fact_sources"|"activity_published_facts"|"activity_reconsideration_receipts",id:string):T|null{const row=this.sql(`SELECT value,digest FROM ${table} WHERE id=?`).get(id) as {value:string;digest:string}|undefined;return row?checked<T>(row):null;}
  private sql(sql:string):Database.Statement{let value=this.statements.get(sql);if(!value){value=this.db.prepare(sql);this.statements.set(sql,value);}return value;}
}
function checked<T>(row:{value:string;digest:string}):T{const value=JSON.parse(row.value) as T;if(modelInputValueDigest(value)!==row.digest)fail("corrupt");return value;}
function same(a:unknown,b:unknown):void{if(modelInputValueDigest(a)!==modelInputValueDigest(b))fail("identity_conflict");}
function fail(code:string):never{throw Object.assign(new Error(`activity_reconsideration_${code}`),{code:`activity_reconsideration_${code}`});}
