import type Database from "better-sqlite3";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {activityCount,activityToken,validateActivitySchedulingIntent,type ActivityResourcePool,type ActivityResourceClaim,
  type ActivitySchedulingIntent,type ActivitySchedulingAcceptance,type ActivitySchedulingDispatch,type ActivitySchedulingCandidate,
  type ActivityPathIntent,type ActivityStageRequest,type ActivitySchedulingReview} from "@agent-anything/agent-runtime/activity";

export const ACTIVITY_SCHEDULING_SCHEMA=`
CREATE TABLE activity_resource_pools(id TEXT PRIMARY KEY,value TEXT NOT NULL,digest TEXT NOT NULL);
CREATE TABLE activity_scheduled_work(work_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,scope_id TEXT NOT NULL,owner TEXT NOT NULL,
 revision INTEGER NOT NULL,acceptance_id TEXT NOT NULL,service TEXT NOT NULL,eligibility INTEGER NOT NULL,closed INTEGER NOT NULL,last_served INTEGER NOT NULL);
CREATE TABLE activity_schedule_acceptances(sequence INTEGER PRIMARY KEY,id TEXT NOT NULL UNIQUE,work_id TEXT NOT NULL,value TEXT NOT NULL,digest TEXT NOT NULL);
CREATE TABLE activity_schedule_rounds(id INTEGER PRIMARY KEY,scope_id TEXT NOT NULL);
CREATE TABLE activity_schedule_tickets(sequence INTEGER PRIMARY KEY,round_id INTEGER NOT NULL,work_id TEXT NOT NULL,served INTEGER NOT NULL,
 UNIQUE(round_id,work_id));
CREATE INDEX activity_schedule_remaining ON activity_schedule_tickets(served,sequence);
CREATE TABLE activity_schedule_scope_rounds(id INTEGER PRIMARY KEY);
CREATE TABLE activity_schedule_scope_tickets(sequence INTEGER PRIMARY KEY,round_id INTEGER NOT NULL,scope_id TEXT NOT NULL,served INTEGER NOT NULL,
 UNIQUE(round_id,scope_id));
CREATE TABLE activity_schedule_dispatches(attempt_id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,work_id TEXT NOT NULL,
 value TEXT NOT NULL,digest TEXT NOT NULL,released INTEGER NOT NULL);
`;
interface WorkRow {work_id:string;run_id:string;scope_id:string;owner:string;revision:number;acceptance_id:string;service:"guaranteed"|"spare";eligibility:number;closed:number;last_served:number;}
interface Ready extends ActivitySchedulingCandidate {readonly capabilities:readonly string[];readonly claims:readonly ActivityResourceClaim[];readonly work:WorkRow;}
interface Ticket {sequence:number;round_id:number;work_id:string;}
type SchedulingFact=(runId:string,workId:string,kind:"scheduling_accepted"|"scheduling_closed"|"scheduling_limited"|"scheduling_wait",details:Readonly<Record<string,unknown>>)=>void;

/** Shared dispatch acceptance. It never interprets a preparation's value or model output. */
export class ActivitySchedulingDatabase {
  private readonly statements=new Map<string,Database.Statement>();
  constructor(private readonly db:Database.Database,private readonly fact:SchedulingFact) {}

  bind(pool:ActivityResourcePool):ActivityResourcePool {
    [pool.id,pool.revision,pool.authority].forEach(activityToken);activityCount(pool.capacity);
    const old=this.readValue<ActivityResourcePool>("activity_resource_pools",pool.id);
    if(old){same(old,pool);return old;}
    this.sql("INSERT INTO activity_resource_pools VALUES (?,?,?)").run(pool.id,JSON.stringify(pool),modelInputValueDigest(pool));return pool;
  }
  accept(intent:ActivitySchedulingIntent,expectedRevision:number):ActivitySchedulingAcceptance {
    validateActivitySchedulingIntent(intent);activityCount(expectedRevision,true);
    const previous=this.readValue<ActivitySchedulingAcceptance>("activity_schedule_acceptances",intent.id);
    if(previous){same(previous.intent,intent);return previous;}
    const old=this.work(intent.workId);
    if((old?.revision??0)!==expectedRevision||old?.closed)fail("revision_conflict");
    if(old&&(old.run_id!==intent.runId||old.scope_id!==intent.scopeId||old.owner!==intent.owner))fail("work_identity_conflict");
    for(const claim of intent.resources){const pool=this.pool(claim.poolId);if(claim.units>pool.capacity)fail("resource_unavailable");}
    // Resources are an execution binding. A changed treatment cannot change that binding.
    if(old){const prior=this.read(intent.workId)!.intent;same(prior.resources,intent.resources);same(prior.delegatedPathOwners??[],intent.delegatedPathOwners??[]);}
    const service=intent.reason==="optional"?"spare":"guaranteed";
    const sequence=(this.sql("SELECT COALESCE(MAX(sequence),0)+1 AS n FROM activity_schedule_acceptances").get() as {n:number}).n;
    const eligibility=old?.service==="guaranteed"&&service==="guaranteed"?old.eligibility:sequence;
    const accepted:ActivitySchedulingAcceptance={intent,revision:expectedRevision+1,service,eligibilitySequence:eligibility,acceptedAt:new Date().toISOString(),closed:false};
    this.sql("INSERT INTO activity_schedule_acceptances VALUES (?,?,?,?,?)").run(sequence,intent.id,intent.workId,JSON.stringify(accepted),modelInputValueDigest(accepted));
    this.sql(`INSERT INTO activity_scheduled_work VALUES (?,?,?,?,?,?,?,?,0,0)
      ON CONFLICT(work_id) DO UPDATE SET revision=excluded.revision,acceptance_id=excluded.acceptance_id,service=excluded.service,eligibility=excluded.eligibility`)
      .run(intent.workId,intent.runId,intent.scopeId,intent.owner,accepted.revision,intent.id,service,eligibility);
    if(service==="spare")this.sql("UPDATE activity_schedule_tickets SET served=1 WHERE work_id=? AND served=0").run(intent.workId);
    this.fact(intent.runId,intent.workId,"scheduling_accepted",{acceptance:accepted,previousAcceptanceId:old?.acceptance_id??null,
      pools:[...new Set(intent.resources.map(r=>r.poolId))].map(id=>this.pool(id))});return accepted;
  }
  read(workId:string):ActivitySchedulingAcceptance|null {
    activityToken(workId);const row=this.work(workId);if(!row)return null;
    const value=this.readValue<ActivitySchedulingAcceptance>("activity_schedule_acceptances",row.acceptance_id);
    if(!value||value.intent.workId!==row.work_id||value.intent.runId!==row.run_id||value.intent.scopeId!==row.scope_id||value.intent.owner!==row.owner||value.service!==row.service||value.eligibilitySequence!==row.eligibility)fail("corrupt");
    return {...value,revision:row.revision,closed:row.closed===1};
  }
  close(workId:string,expectedRevision:number,basis:string):ActivitySchedulingAcceptance {
    activityToken(basis);activityCount(expectedRevision,true);const old=this.read(workId);if(!old)fail("work_missing");
    if(old.closed)return old;if(old.revision!==expectedRevision)fail("revision_conflict");
    this.sql("UPDATE activity_scheduled_work SET closed=1,revision=revision+1 WHERE work_id=?").run(workId);
    this.sql("UPDATE activity_schedule_tickets SET served=1 WHERE work_id=? AND served=0").run(workId);
    this.fact(old.intent.runId,workId,"scheduling_closed",{basis,revision:expectedRevision+1});return this.read(workId)!;
  }
  validatePath(intent:ActivityPathIntent):void {
    if(!intent.scheduledWorkId)return;
    const work=this.read(intent.scheduledWorkId);
    if(!work||work.closed||work.intent.runId!==intent.runId||work.intent.owner!==intent.owner&&!work.intent.delegatedPathOwners?.includes(intent.owner))fail("path_binding_invalid");
  }
  recordLimitation(intent:ActivitySchedulingIntent,code:string,requestId:string|null=null):void {
    validateActivitySchedulingIntent(intent);
    const key=modelInputValueDigest({intentId:intent.id,code,requestId});
    if(this.sql("SELECT 1 FROM activity_facts WHERE kind='scheduling_limited' AND json_extract(value,'$.details.key')=? LIMIT 1").get(key))return;
    this.fact(intent.runId,intent.workId,"scheduling_limited",{key,intent,code,requestId,timingGuarantee:"not_claimed"});
  }
  recordWait(requestId:string):void {
    const stage=this.ready().find(item=>item.requestId===requestId);if(!stage)return;
    const available=this.available();
    const resources=stage.claims.map(claim=>({...claim,available:available.get(claim.poolId)??0}));
    const ticket=this.tickets().find(t=>t.work_id===stage.workId)??null;
    const reason=resources.some(r=>r.available<r.units)?"resource_occupied":"service_turn";
    const details={requestId,acceptanceId:stage.work.acceptance_id,reason,resources,ticket};
    const key=modelInputValueDigest(details);
    if(this.sql("SELECT 1 FROM activity_facts WHERE kind='scheduling_wait' AND json_extract(value,'$.details.key')=? LIMIT 1").get(key))return;
    this.fact(stage.runId,stage.workId,"scheduling_wait",{key,...details});
  }
  candidates(limit:number):readonly ActivitySchedulingCandidate[] {
    activityCount(limit);if(limit>256)fail("page_limit");
    this.review();
    return this.ordered().slice(0,limit).map(({requestId,pathId,runId,workId})=>({requestId,pathId,runId,workId}));
  }
  review():ActivitySchedulingReview {
    const observedAt=new Date().toISOString(),due:string[]=[];
    const query=`SELECT a.value,a.digest FROM activity_scheduled_work w JOIN activity_schedule_acceptances a ON a.id=w.acceptance_id
      WHERE w.closed=0 AND json_extract(a.value,'$.intent.timing.kind')='review_at'
      AND NOT EXISTS (SELECT 1 FROM activity_facts f WHERE f.kind='scheduling_limited'
        AND json_extract(f.value,'$.details.intent.id')=a.id AND json_extract(f.value,'$.details.code')='timing_review_due')
      ORDER BY json_extract(a.value,'$.intent.timing.at') LIMIT 256`;
    for(const row of this.sql(query).all() as {value:string;digest:string}[]) {
      const {intent}=checked<ActivitySchedulingAcceptance>(row);
      if(intent.timing.kind!=="review_at")fail("corrupt");
      if(Date.parse(intent.timing.at)>Date.parse(observedAt))break;
      this.recordLimitation(intent,"timing_review_due");due.push(intent.workId);
    }
    const next=this.sql(query).get() as {value:string;digest:string}|undefined;
    const intent=next?checked<ActivitySchedulingAcceptance>(next).intent:null;
    return {observedAt,due,nextReviewAt:intent?.timing.kind==="review_at"?intent.timing.at:null};
  }
  dispatch(path:ActivityPathIntent,request:ActivityStageRequest,attemptId:string):ActivitySchedulingDispatch|undefined {
    if(!path.scheduledWorkId)return undefined;
    this.validatePath(path);
    const ready=this.ordered();const index=ready.findIndex(item=>item.requestId===request.id);
    if(index<0)fail("not_ready");
    const selected=ready[index]!;
    if(ready.slice(0,index).some(item=>competes(item.claims,selected.claims)))fail("turn_waiting");
    const ticket=this.sql("SELECT sequence,round_id,work_id FROM activity_schedule_tickets WHERE work_id=? AND served=0 ORDER BY sequence LIMIT 1").get(selected.workId) as Ticket|undefined;
    const round=ticket?.round_id??(this.sql("SELECT COALESCE(MAX(id),0) AS n FROM activity_schedule_rounds").get() as {n:number}).n;
    const scopeTicket=selected.work.service==="guaranteed"?this.sql("SELECT sequence,round_id FROM activity_schedule_scope_tickets WHERE scope_id=? AND served=0 ORDER BY sequence LIMIT 1").get(selected.work.scope_id) as {sequence:number;round_id:number}|undefined:undefined;
    const dispatch:ActivitySchedulingDispatch={workId:selected.workId,acceptanceId:selected.work.acceptance_id,round,ticket:ticket?.sequence??null,
      scopeRound:scopeTicket?.round_id??null,scopeTicket:scopeTicket?.sequence??null,claims:selected.claims};
    this.sql("INSERT INTO activity_schedule_dispatches VALUES (?,?,?,?,?,0)").run(attemptId,request.id,selected.workId,JSON.stringify(dispatch),modelInputValueDigest(dispatch));
    if(ticket)this.sql("UPDATE activity_schedule_tickets SET served=1 WHERE sequence=?").run(ticket.sequence);
    if(scopeTicket)this.sql("UPDATE activity_schedule_scope_tickets SET served=1 WHERE sequence=?").run(scopeTicket.sequence);
    const order=(this.sql("SELECT COUNT(*) AS n FROM activity_schedule_dispatches").get() as {n:number}).n;
    this.sql("UPDATE activity_scheduled_work SET last_served=? WHERE work_id=?").run(order,selected.workId);
    return dispatch;
  }
  release(attemptId:string):void {this.sql("UPDATE activity_schedule_dispatches SET released=1 WHERE attempt_id=?").run(attemptId);}
  originalDispatch(attemptId:string):ActivitySchedulingDispatch|undefined {
    return this.readValue<ActivitySchedulingDispatch>("activity_schedule_dispatches",attemptId)??undefined;
  }
  private ordered():Ready[] {
    const runnable=this.ready(),guaranteed=runnable.filter(item=>item.work.service==="guaranteed");
    let tickets=this.tickets();const works=new Set(guaranteed.map(item=>item.workId));
    // A finite round excludes later arrivals. Non-runnable members do not hold a resource.
    for(const ticket of tickets)if(!works.has(ticket.work_id))this.sql("UPDATE activity_schedule_tickets SET served=1 WHERE sequence=?").run(ticket.sequence);
    tickets=this.tickets();
    const scopes=new Map<string,WorkRow[]>();
    for(const item of guaranteed) {
      const group=scopes.get(item.work.scope_id)??[];
      if(!group.some(work=>work.work_id===item.workId))group.push(item.work);scopes.set(item.work.scope_id,group);
    }
    // Finite membership is per scope. Another scope's larger backlog cannot freeze this scope's next round.
    for(const [scope,group] of scopes)if(!tickets.some(ticket=>group.some(work=>work.work_id===ticket.work_id))) {
      const round=Number(this.sql("INSERT INTO activity_schedule_rounds(scope_id) VALUES (?)").run(scope).lastInsertRowid);
      group.sort((a,b)=>a.last_served-b.last_served||a.eligibility-b.eligibility);
      for(const work of group)this.sql("INSERT INTO activity_schedule_tickets(round_id,work_id,served) VALUES (?,?,0)").run(round,work.work_id);
    }
    tickets=this.tickets();
    const scopeService=new Map((this.sql("SELECT scope_id,MAX(last_served) AS served FROM activity_scheduled_work GROUP BY scope_id").all() as {scope_id:string;served:number}[]).map(row=>[row.scope_id,row.served]));
    const available=this.available();
    const fits=(item:Ready)=>item.claims.every(claim=>(available.get(claim.poolId)??0)>=claim.units);
    const groups=[...scopes].map(([scope])=>({scope,items:tickets.flatMap(ticket=>{
      const first=guaranteed.find(item=>item.work.scope_id===scope&&item.workId===ticket.work_id);return first&&fits(first)?[first]:[];
    })})).filter(group=>group.items.length).sort((a,b)=>(scopeService.get(a.scope)??0)-(scopeService.get(b.scope)??0)||a.items[0]!.work.eligibility-b.items[0]!.work.eligibility)
      ;
    let outer=this.scopeTickets();
    for(const ticket of outer)if(!groups.some(group=>group.scope===ticket.scope_id))this.sql("UPDATE activity_schedule_scope_tickets SET served=1 WHERE sequence=?").run(ticket.sequence);
    outer=this.scopeTickets();
    if(!outer.length&&groups.length) {
      const round=Number(this.sql("INSERT INTO activity_schedule_scope_rounds DEFAULT VALUES").run().lastInsertRowid);
      for(const group of groups)this.sql("INSERT INTO activity_schedule_scope_tickets(round_id,scope_id,served) VALUES (?,?,0)").run(round,group.scope);
      outer=this.scopeTickets();
    }
    const eligible=outer.flatMap(ticket=>{const group=groups.find(group=>group.scope===ticket.scope_id);return group?[group]:[];});
    const selected:Ready[]=[];
    for(let offset=0;eligible.some(group=>offset<group.items.length);offset++)for(const group of eligible) {
      const item=group.items[offset];if(item)selected.push(item);
    }
    // A dispatch updates the durable scope position, even when it was that scope's last runnable stage.
    const optionalPools=new Set<string>();
    for(const row of this.sql(`SELECT d.value,d.digest FROM activity_schedule_dispatches d
      JOIN activity_schedule_acceptances a ON a.id=json_extract(d.value,'$.acceptanceId')
      WHERE d.released=0 AND json_extract(a.value,'$.service')='spare'`).all() as {value:string;digest:string}[]) {
      for(const claim of checked<ActivitySchedulingDispatch>(row).claims)optionalPools.add(claim.poolId);
    }
    const optional=runnable.filter(item=>item.work.service==="spare"&&fits(item)&&!item.claims.some(claim=>optionalPools.has(claim.poolId))&&
      !guaranteed.some(other=>fits(other)&&competes(item.claims,other.claims)))
      .sort((a,b)=>a.work.last_served-b.work.last_served||a.work.eligibility-b.work.eligibility);
    return [...selected.filter(fits),...optional];
  }
  private ready():Ready[] {
    const rows=this.sql(`SELECT s.id,s.path_id,s.scheduling_metadata,s.scheduling_digest,p.intent,p.digest FROM activity_stages s
      JOIN activity_paths p ON p.id=s.path_id WHERE s.status='admitted' AND s.dispatch_restriction IS NULL AND p.cancelled=0 AND json_extract(p.intent,'$.scheduledWorkId') IS NOT NULL ORDER BY s.rowid`).all() as
      {id:string;path_id:string;scheduling_metadata:string;scheduling_digest:string;intent:string;digest:string}[];
    const ready:Ready[]=[];
    for(const row of rows) {
      const intent=checked<ActivityPathIntent>({value:row.intent,digest:row.digest});const work=this.work(intent.scheduledWorkId!);
      if(!work||work.closed||Date.parse(intent.deadlineAt)<=Date.now())continue;
      const accepted=this.read(work.work_id)!;
      if(accepted.intent.timing.kind==="review_at"&&Date.parse(accepted.intent.timing.at)<=Date.now())this.recordLimitation(accepted.intent,"timing_review_due");
      const meta=checked<Pick<ActivityStageRequest,"capabilities"|"dependencies">>({value:row.scheduling_metadata,digest:row.scheduling_digest});
      if(meta.dependencies.some(dependency=>{
        const producer=this.sql("SELECT status,result_id FROM activity_stages WHERE id=?").get(dependency.requestId) as {status:string;result_id:string|null}|undefined;
        return !producer||(dependency.condition==="accepted"?producer.status!=="accepted":!producer.result_id);
      }))continue;
      const use=this.sql(`SELECT COALESCE(SUM(attempts),0) AS attempts FROM activity_paths WHERE run_id=? AND json_extract(intent,'$.resourceScope')=?`).get(intent.runId,intent.resourceScope) as {attempts:number};
      const flight=this.sql(`SELECT COUNT(*) AS n FROM activity_stages s JOIN activity_paths p ON p.id=s.path_id WHERE p.run_id=? AND json_extract(p.intent,'$.resourceScope')=? AND s.status='dispatched'`).get(intent.runId,intent.resourceScope) as {n:number};
      if(use.attempts>=intent.maximumAttempts||flight.n>=intent.maximumConcurrent)continue;
      const amounts=new Map<string,number>();
      for(const resource of accepted.intent.resources)if(meta.capabilities.includes(resource.capability))amounts.set(resource.poolId,(amounts.get(resource.poolId)??0)+resource.units);
      const claims=[...amounts].map(([poolId,units])=>({poolId,units}));
      if(claims.some(claim=>claim.units>this.pool(claim.poolId).capacity)){this.recordLimitation(accepted.intent,"resource_combination_unavailable",row.id);continue;}
      ready.push({requestId:row.id,pathId:row.path_id,runId:intent.runId,workId:work.work_id,capabilities:meta.capabilities,claims,work});
    }
    return ready;
  }
  private available():Map<string,number> {
    const available=new Map<string,number>();
    for(const row of this.sql("SELECT value,digest FROM activity_resource_pools").all() as {value:string;digest:string}[]){const pool=checked<ActivityResourcePool>(row);available.set(pool.id,pool.capacity);}
    for(const row of this.sql("SELECT value,digest FROM activity_schedule_dispatches WHERE released=0").all() as {value:string;digest:string}[]) {
      const dispatch=checked<ActivitySchedulingDispatch>(row);for(const claim of dispatch.claims)available.set(claim.poolId,(available.get(claim.poolId)??0)-claim.units);
    }
    return available;
  }
  private tickets():Ticket[]{return this.sql("SELECT sequence,round_id,work_id FROM activity_schedule_tickets WHERE served=0 ORDER BY sequence").all() as Ticket[];}
  private scopeTickets():{sequence:number;scope_id:string}[]{return this.sql("SELECT sequence,scope_id FROM activity_schedule_scope_tickets WHERE served=0 ORDER BY sequence").all() as {sequence:number;scope_id:string}[];}
  private work(id:string):WorkRow|undefined{return this.sql("SELECT * FROM activity_scheduled_work WHERE work_id=?").get(id) as WorkRow|undefined;}
  private pool(id:string):ActivityResourcePool{const pool=this.readValue<ActivityResourcePool>("activity_resource_pools",id);if(!pool)fail("pool_missing");return pool;}
  private readValue<T>(table:"activity_resource_pools"|"activity_schedule_acceptances"|"activity_schedule_dispatches",id:string):T|null {
    const row=this.sql(`SELECT value,digest FROM ${table} WHERE ${table==="activity_schedule_dispatches"?"attempt_id":"id"}=?`).get(id) as {value:string;digest:string}|undefined;
    return row?checked<T>(row):null;
  }
  private sql(sql:string):Database.Statement{let value=this.statements.get(sql);if(!value){value=this.db.prepare(sql);this.statements.set(sql,value);}return value;}
}
function checked<T>(row:{value:string;digest:string}):T{const value=JSON.parse(row.value) as T;if(modelInputValueDigest(value)!==row.digest)fail("corrupt");return value;}
function same(a:unknown,b:unknown):void{if(modelInputValueDigest(a)!==modelInputValueDigest(b))fail("identity_conflict");}
function competes(a:readonly ActivityResourceClaim[],b:readonly ActivityResourceClaim[]):boolean{return a.some(left=>b.some(right=>left.poolId===right.poolId));}
function fail(code:string):never{throw Object.assign(new Error(`activity_schedule_${code}`),{code:`activity_schedule_${code}`});}
