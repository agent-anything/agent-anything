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
CREATE UNIQUE INDEX activity_reconsideration_receipt_revision ON activity_reconsideration_receipts(json_extract(value,'$.subscriptionId'),json_extract(value,'$.expectedRevision'));
CREATE TABLE activity_reconsideration_sources(subscription_id TEXT NOT NULL,source_id TEXT NOT NULL,consumed INTEGER NOT NULL,active INTEGER NOT NULL,digest TEXT NOT NULL,
 PRIMARY KEY(subscription_id,source_id));
`;
type Fact=(runId:string,subject:string,kind:"fact_published"|"reconsideration_registered"|"reconsideration_accepted",details:Readonly<Record<string,unknown>>)=>void;

/** Shared by subscription and Host scope discovery; r is the subscription row. */
export const PENDING_RECONSIDERATION_FACTS_SQL=`r.closed=0 AND EXISTS (
  SELECT 1 FROM activity_published_facts f JOIN activity_reconsideration_sources s ON s.subscription_id=r.id AND s.source_id=f.source_id
  WHERE s.active=1 AND f.sequence>s.consumed)`;

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
    if(fact.origin)[fact.origin.stageId,fact.origin.acceptanceId].forEach(activityToken);
    const source=this.read<ActivityFactSource>("activity_fact_sources",fact.sourceId);if(!source||source.owner!==fact.ref.owner)fail("source_invalid");
    const old=this.read<ActivityPublishedFact>("activity_published_facts",fact.id);if(old){same(old,fact);return old;}
    const sequence=Number(this.sql("INSERT INTO activity_published_facts(id,source_id,value,digest) VALUES (?,?,?,?)").run(fact.id,fact.sourceId,JSON.stringify(fact),modelInputValueDigest(fact)).lastInsertRowid);
    this.fact(source.runId,fact.sourceId,"fact_published",{fact,sequence});return fact;
  }
  subscribe(subscription:ActivityReconsiderationSubscription):ActivityReconsiderationState {
    [subscription.id,subscription.runId,subscription.owner].forEach(activityToken);
    this.validateSources(subscription.runId,subscription.sources);
    const old=this.state(subscription.id);if(old){same(old.subscription,subscription);return old;}
    this.sql("INSERT INTO activity_reconsiderations VALUES (?,?,?,?,0,0,0)").run(subscription.id,subscription.runId,JSON.stringify(subscription),modelInputValueDigest(subscription));
    for(const sourceId of subscription.sources)this.writeCursor(subscription.id,sourceId,0,true);
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
    if(!state||state.closed||state.revision!==receipt.expectedRevision||receipt.decision.owner!==state.subscription.owner)fail("acceptance_conflict");
    if(!Array.isArray(receipt.factIds)||receipt.factIds.length>256||typeof receipt.close!=="boolean")fail("receipt_invalid");
    const facts=this.rows(state,receipt.through,257);
    if(facts.length>256||receipt.through!==(facts.at(-1)?.sequence??state.consumedThrough)||modelInputValueDigest(facts.map(fact=>fact.id))!==modelInputValueDigest(receipt.factIds))fail("boundary_mismatch");
    const observedSources=receipt.observeSources??state.observedSources;
    this.validateSources(state.subscription.runId,observedSources);
    this.sql("INSERT INTO activity_reconsideration_receipts VALUES (?,?,?)").run(receipt.id,JSON.stringify(receipt),modelInputValueDigest(receipt));
    const cursors=this.cursors(receipt.subscriptionId),retained=new Set<string>();
    for(const cursor of cursors) {
      retained.add(cursor.source_id);
      const consumed=cursor.active?Math.max(cursor.consumed,receipt.through):cursor.consumed;
      this.writeCursor(receipt.subscriptionId,cursor.source_id,consumed,observedSources.includes(cursor.source_id));
    }
    for(const sourceId of observedSources)if(!retained.has(sourceId))this.writeCursor(receipt.subscriptionId,sourceId,0,true);
    this.sql("UPDATE activity_reconsiderations SET consumed=?,revision=revision+1,closed=? WHERE id=?").run(Math.max(state.consumedThrough,receipt.through),receipt.close?1:0,receipt.subscriptionId);
    this.fact(state.subscription.runId,receipt.subscriptionId,"reconsideration_accepted",{receipt,previousSources:state.observedSources,observedSources});return this.state(receipt.subscriptionId)!;
  }
  state(id:string):ActivityReconsiderationState|null {
    activityToken(id);const row=this.sql("SELECT * FROM activity_reconsiderations WHERE id=?").get(id) as {value:string;digest:string;revision:number;consumed:number;closed:number}|undefined;
    return row?{subscription:checked<ActivityReconsiderationSubscription>(row),observedSources:this.cursors(id).filter(c=>c.active).map(c=>c.source_id),revision:row.revision,consumedThrough:row.consumed,closed:row.closed===1}:null;
  }
  sourceState(id:string):ActivityFactSource|null{return this.read<ActivityFactSource>("activity_fact_sources",id);}
  closure(id:string):ActivityReconsiderationReceipt|null {
    const state=this.state(id);if(!state?.closed)return null;
    const row=this.sql("SELECT value,digest FROM activity_reconsideration_receipts WHERE json_extract(value,'$.subscriptionId')=? AND json_extract(value,'$.expectedRevision')=?")
      .get(id,state.revision-1) as {value:string;digest:string}|undefined;
    if(!row)fail("closure_receipt_missing");
    const receipt=checked<ActivityReconsiderationReceipt>(row);
    if(receipt.subscriptionId!==id||receipt.expectedRevision!==state.revision-1||!receipt.close||receipt.decision.owner!==state.subscription.owner)
      fail("closure_receipt_invalid");
    return receipt;
  }
  publishedFact(id:string):ActivityPublishedFact|null {
    activityToken(id);
    const row=this.sql("SELECT source_id,value,digest FROM activity_published_facts WHERE id=?").get(id) as {source_id:string;value:string;digest:string}|undefined;
    if(!row)return null;
    const fact=checked<ActivityPublishedFact>(row),source=this.sourceState(fact.sourceId);
    if(fact.id!==id||fact.sourceId!==row.source_id||!source||source.id!==fact.sourceId||source.owner!==fact.ref.owner)fail("corrupt");
    return fact;
  }
  pending(runId:string,afterId:string|null,limit:number):readonly ActivityReconsiderationState[] {
    activityToken(runId);if(afterId!==null)activityToken(afterId);activityCount(limit);if(limit>256)fail("page_limit");
    const rows=this.sql(`SELECT r.id FROM activity_reconsiderations r WHERE r.run_id=? AND r.id>? AND ${PENDING_RECONSIDERATION_FACTS_SQL} ORDER BY r.id LIMIT ?`).all(runId,afterId??"",limit) as {id:string}[];
    return rows.map(row=>this.state(row.id)!);
  }
  retainedRuns():readonly string[]{return (this.sql("SELECT DISTINCT run_id FROM activity_reconsiderations WHERE closed=0").all() as {run_id:string}[]).map(row=>row.run_id);}
  private rows(state:ActivityReconsiderationState,through:number,limit:number):readonly (ActivityPublishedFact&{sequence:number})[] {
    return (this.sql(`SELECT f.sequence,f.value,f.digest FROM activity_published_facts f JOIN activity_reconsideration_sources s ON s.source_id=f.source_id
      WHERE s.subscription_id=? AND s.active=1 AND f.sequence>s.consumed AND f.sequence<=? ORDER BY f.sequence LIMIT ?`)
      .all(state.subscription.id,through,limit) as {sequence:number;value:string;digest:string}[]).map(row=>({...checked<ActivityPublishedFact>(row),sequence:row.sequence}));
  }
  private validateSources(runId:string,sources:readonly string[]):void {
    if(!Array.isArray(sources)||!sources.length||sources.length>128||new Set(sources).size!==sources.length)fail("sources_invalid");
    for(const id of sources){activityToken(id);const source=this.read<ActivityFactSource>("activity_fact_sources",id);if(!source||source.runId!==runId)fail("source_scope_invalid");}
  }
  private cursors(id:string):readonly {source_id:string;consumed:number;active:number}[] {
    const rows=this.sql("SELECT source_id,consumed,active,digest FROM activity_reconsideration_sources WHERE subscription_id=? ORDER BY source_id").all(id) as {source_id:string;consumed:number;active:number;digest:string}[];
    for(const {digest,...cursor} of rows)if(modelInputValueDigest({subscription_id:id,...cursor})!==digest)fail("corrupt");
    return rows;
  }
  private writeCursor(subscription_id:string,source_id:string,consumed:number,active:boolean):void {
    const value={subscription_id,source_id,consumed,active:active?1:0};
    this.sql("INSERT INTO activity_reconsideration_sources VALUES (?,?,?,?,?) ON CONFLICT(subscription_id,source_id) DO UPDATE SET consumed=excluded.consumed,active=excluded.active,digest=excluded.digest")
      .run(subscription_id,source_id,consumed,value.active,modelInputValueDigest(value));
  }
  private read<T>(table:"activity_fact_sources"|"activity_published_facts"|"activity_reconsideration_receipts",id:string):T|null{const row=this.sql(`SELECT value,digest FROM ${table} WHERE id=?`).get(id) as {value:string;digest:string}|undefined;return row?checked<T>(row):null;}
  private sql(sql:string):Database.Statement{let value=this.statements.get(sql);if(!value){value=this.db.prepare(sql);this.statements.set(sql,value);}return value;}
}
function checked<T>(row:{value:string;digest:string}):T{const value=JSON.parse(row.value) as T;if(modelInputValueDigest(value)!==row.digest)fail("corrupt");return value;}
function same(a:unknown,b:unknown):void{if(modelInputValueDigest(a)!==modelInputValueDigest(b))fail("identity_conflict");}
function fail(code:string):never{throw Object.assign(new Error(`activity_reconsideration_${code}`),{code:`activity_reconsideration_${code}`});}
