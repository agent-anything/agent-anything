import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {contextProcessObject as object,contextProcessRelationship as relationship} from "@agent-anything/context/evidence";
import {ContextMethodInputSupply,inputSupplyResponsibility, SOURCE_MATERIAL_PUBLICATION_PURPOSE,CONTEXT_INPUT_PREPARATION_PURPOSE,REPRESENTATION_METHOD_PURPOSE,CONTEXT_INPUT_MATERIALIZATION_PURPOSE,
  type InputSupplyBinding, type InputSupplyHead, type InputSupplyRegistration,
  type InputSupplyResponsibility, type AcceptedInputSupplyResponsibility, type InputSupplyResponsibilityQuery,
  type InputSupplyResponsibilityValue,type InputSupplyExitProposal} from "@agent-anything/agent-runtime/context-representation";
import {activityToken,activityCount,validateActivitySchedulingIntent} from "@agent-anything/agent-runtime/activity";
import {InputSupplyExitDatabase,INPUT_SUPPLY_EXIT_SCHEMA,sameSupplySchedulingBinding,type InputSupplyPaths} from "./InputSupplyExitDatabase.js";
import {ContextFoundationRecords,checkedJson} from "./ContextFoundationRecords.js";
import {SharedAcceptanceRejection,type SharedAcceptanceParticipant} from "./SharedAcceptanceDatabase.js";

export const INPUT_SUPPLY_RESPONSIBILITY_SCHEMA=`
${INPUT_SUPPLY_EXIT_SCHEMA}
CREATE TABLE context_input_supplies(need_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,revision INTEGER NOT NULL,value TEXT NOT NULL,digest TEXT NOT NULL);
CREATE TABLE context_input_supply_responsibilities(sequence INTEGER PRIMARY KEY AUTOINCREMENT,need_id TEXT NOT NULL,id TEXT NOT NULL,path_id TEXT NOT NULL,intent_digest TEXT NOT NULL,relation TEXT NOT NULL,value TEXT NOT NULL,digest TEXT NOT NULL,UNIQUE(need_id,id),UNIQUE(need_id,path_id));
CREATE INDEX context_input_supply_users ON context_input_supply_responsibilities(path_id,intent_digest,sequence);
CREATE UNIQUE INDEX context_input_supply_owned_path ON context_input_supply_responsibilities(path_id) WHERE relation='owned';
`;
interface Row {value:string;digest:string;}
const OWNER="context_input_supply";
const PURPOSES={source_publication:SOURCE_MATERIAL_PUBLICATION_PURPOSE,input_preparation:CONTEXT_INPUT_PREPARATION_PURPOSE,
  method_production:REPRESENTATION_METHOD_PURPOSE,method_reception:CONTEXT_INPUT_MATERIALIZATION_PURPOSE} as const;

/** An accepted responsibility index. Original paths and receipts remain their own authority. */
export class InputSupplyResponsibilityDatabase {
  private readonly exits:InputSupplyExitDatabase;
  constructor(private readonly records:ContextFoundationRecords,private readonly paths:InputSupplyPaths,
    private readonly changed:(binding:Pick<InputSupplyBinding,"needId"|"runId"|"owner">,revision:number,kind:"membership"|"exit")=>void) {
    this.exits=new InputSupplyExitDatabase(records,paths,id=>this.head(id),(needId,id)=>this.readEntry(needId,id),exit=>changed(exit.origin,exit.revision,"exit"));
  }

  query(query:InputSupplyResponsibilityQuery):InputSupplyResponsibilityValue {
    if(query.kind==="exit")return this.exits.read(query.needId);
    if(query.kind==="exit_pending")return this.exits.pending(query.needId,query.revision,query.limit);
    if(query.kind==="head")return this.head(query.needId);
    activityCount(query.limit);if(query.limit>128)throw new TypeError("input_supply_page_limit_invalid");
    if(query.kind==="page") {
      activityCount(query.revision);if(query.afterId!==null)activityToken(query.afterId);
      const head=this.head(query.needId);
      if(!head||head.revision!==query.revision)return {kind:"changed",revision:head?.revision??null};
      const rows=this.records.sql("SELECT id,value,digest FROM context_input_supply_responsibilities WHERE need_id=? AND id>? ORDER BY id LIMIT ?")
        .all(query.needId,query.afterId??"",query.limit+1) as (Row&{id:string})[];
      const entries=rows.slice(0,query.limit).map(row=>this.entry(query.needId,row.id,row));
      const complete=rows.length<=query.limit;
      return {kind:"page",head,entries,next:complete?null:entries.at(-1)!.id,complete};
    }
    if(query.kind==="users")validateTarget(query.target);else activityToken(query.workId);
    activityCount(query.afterSequence,true);
    if(query.frontier!==null)activityCount(query.frontier,true);
    if(query.afterSequence>0&&query.frontier===null)throw new TypeError("input_supply_users_frontier_required");
    const frontier=query.frontier??(this.records.sql("SELECT COALESCE(MAX(sequence),0) AS n FROM context_input_supply_responsibilities").get() as {n:number}).n;
    const rows=(query.kind==="users"?this.records.sql("SELECT sequence,need_id,id,value,digest FROM context_input_supply_responsibilities WHERE path_id=? AND intent_digest=? AND sequence>? AND sequence<=? ORDER BY sequence LIMIT ?")
      .all(query.target.pathId,query.target.intentDigest,query.afterSequence,frontier,query.limit+1):
      this.records.sql("SELECT r.sequence,r.need_id,r.id,r.value,r.digest FROM context_input_supply_responsibilities r JOIN activity_paths p ON p.id=r.path_id WHERE json_extract(p.intent,'$.scheduledWorkId')=? AND r.sequence>? AND r.sequence<=? ORDER BY r.sequence LIMIT ?")
      .all(query.workId,query.afterSequence,frontier,query.limit+1)) as (Row&{sequence:number;need_id:string;id:string})[];
    const entries=rows.slice(0,query.limit).map(row=>{
      const responsibility=this.entry(row.need_id,row.id,row),head=this.head(row.need_id);
      if(!head)throw new Error("input_supply_dependency_corrupt");
      if(query.kind==="users") {if(!same(responsibility.target,query.target))throw new Error("input_supply_dependency_corrupt");}
      else {
        const path=this.paths.path(responsibility.target.pathId);
        if(!path||path.intent.scheduledWorkId!==query.workId||responsibility.target.workId!==query.workId||
          responsibility.target.intentDigest!==modelInputValueDigest(path.intent))throw new Error("input_supply_dependency_corrupt");
      }
      return {binding:head.binding,responsibility};
    });
    const complete=rows.length<=query.limit;
    return {kind:"users",frontier,entries,next:complete?null:rows[query.limit-1]!.sequence,complete};
  }

  participant():SharedAcceptanceParticipant {
    type Prepared={kind:"register";proposal:InputSupplyRegistration}|{kind:"exit";proposal:InputSupplyExitProposal}|{kind:"producer_unreferenced";workId:string};
    return {owner:OWNER,kinds:["register","exit","producer_unreferenced"],prepare:(part,acceptance):Prepared=>{
      if(part.kind==="producer_unreferenced") {
        const {workId}=part.proposal as {workId:string};activityToken(workId);
        const work=this.paths.scheduling(workId);
        if(!work||work.intent.runId!==acceptance.scope||work.intent.owner!==acceptance.actor)reject("producer_owner_mismatch");
        return {kind:"producer_unreferenced",workId};
      }
      if(part.kind==="exit")return {kind:"exit",proposal:this.exits.prepare(part.proposal as InputSupplyExitProposal)};
      const proposal=structuredClone(part.proposal) as InputSupplyRegistration;
      validateRegistration(proposal);
      if(proposal.binding.runId!==acceptance.scope||proposal.binding.owner!==acceptance.actor)reject("actor_mismatch");
      return {kind:"register",proposal};
    },apply:(value,acceptance)=>{
      const prepared=value as Prepared;if(prepared.kind==="exit")return this.exits.apply(prepared.proposal,acceptance);
      if(prepared.kind==="producer_unreferenced")return this.assertUnreferenced(prepared.workId);
      const proposal=prepared.proposal,{binding}=proposal;
      if(this.exits.read(binding.needId))reject("exit_started");
      this.validateOrigin(proposal);
      const current=this.head(binding.needId);
      if((current?.revision??0)!==proposal.expectedRevision)reject("revision_changed");
      if(current&&!same(current.binding,binding))reject("binding_changed");
      const scheduling=proposal.scheduling??null;
      if(current&&!same(current.scheduling,scheduling))reject("scheduling_changed");
      if(scheduling&&!current) {
        const used=this.records.sql("SELECT need_id FROM context_input_supply_schedules WHERE work_id=?").get(scheduling.workId);
        if(used)reject("schedule_already_owned");
        this.records.sql("INSERT INTO context_input_supply_schedules VALUES(?,?)").run(scheduling.workId,binding.needId);
      }
      let changed=!current;
      for(const responsibility of proposal.responsibilities) {
        const old=this.readEntry(binding.needId,responsibility.id);
        if(old) {
          const {needId:_,acceptanceId:__,...original}=old;
          if(!same(original,responsibility))reject("responsibility_changed");
          continue;
        }
        const used=this.records.sql("SELECT id FROM context_input_supply_responsibilities WHERE need_id=? AND path_id=?").get(binding.needId,responsibility.target.pathId);
        if(used)reject("target_role_conflict");
        if(responsibility.relation==="owned"&&this.records.sql("SELECT need_id FROM context_input_supply_responsibilities WHERE path_id=? AND relation='owned'").get(responsibility.target.pathId))
          reject("target_already_owned");
        const entry:AcceptedInputSupplyResponsibility={...responsibility,needId:binding.needId,acceptanceId:acceptance.id};
        this.records.sql("INSERT INTO context_input_supply_responsibilities(need_id,id,path_id,intent_digest,relation,value,digest) VALUES(?,?,?,?,?,?,?)").run(binding.needId,entry.id,entry.target.pathId,entry.target.intentDigest,entry.relation,JSON.stringify(entry),modelInputValueDigest(entry));
        const subject=object(OWNER,entry.id,binding.runId);
        this.records.fact(binding.runId,OWNER,entry.id,"responsibility_registered",{needId:binding.needId,consumerPathId:binding.consumerPathId,
          sourceStageId:binding.source.stageId,acceptanceId:acceptance.id,role:entry.role,relation:entry.relation,target:entry.target},
          {revision:"1",category:"responsibility",subject,state:{phase:"pending",status:"responsibility_registered"},related:[],relationships:[
            ...[binding.needId,binding.consumerPathId,binding.source.stageId,entry.target.pathId,...(entry.target.workId?[entry.target.workId]:[])]
              .map(id=>relationship("observes",subject,object("activity",id,binding.runId))),
            relationship("settles",object("shared_acceptance",acceptance.id,acceptance.scope),subject),
          ]});
        changed=true;
      }
      if(changed) {
        const head:InputSupplyHead={binding,scheduling,revision:(current?.revision??0)+1,acceptanceId:acceptance.id};
        this.records.sql("INSERT INTO context_input_supplies VALUES(?,?,?,?,?) ON CONFLICT(need_id) DO UPDATE SET revision=excluded.revision,value=excluded.value,digest=excluded.digest")
          .run(binding.needId,binding.runId,head.revision,JSON.stringify(head),modelInputValueDigest(head));
        const subject=object(OWNER,binding.needId,binding.runId),status=current?"membership_changed":"supply_registered";
        this.records.fact(binding.runId,OWNER,binding.needId,status,{binding,revision:head.revision,acceptanceId:acceptance.id},
          {revision:"1",category:"responsibility",subject,state:{phase:"pending",status},related:[],relationships:[
            ...[binding.needId,binding.consumerPathId,binding.source.stageId,...(scheduling?[scheduling.workId]:[])]
              .map(id=>relationship("observes",subject,object("activity",id,binding.runId))),
            ...proposal.responsibilities.map(entry=>relationship("includes",subject,object(OWNER,entry.id,binding.runId))),
            relationship("settles",object("shared_acceptance",acceptance.id,acceptance.scope),subject),
          ]});
        this.changed(binding,head.revision,"membership");
      }
    },validate:(value,acceptance)=>{
      const prepared=value as Prepared;if(prepared.kind==="exit")return this.exits.validate(prepared.proposal,acceptance);
      if(prepared.kind==="producer_unreferenced")return this.assertUnreferenced(prepared.workId);
      const proposal=prepared.proposal;
      this.validateOrigin(proposal);
      const exit=this.exits.read(proposal.binding.needId);
      if(exit&&exit.acceptanceId!==acceptance.id)reject("exit_started");
      if(proposal.scheduling) {
        const work=this.paths.scheduling(proposal.scheduling.workId);
        if(!work||work.closed||!sameSupplySchedulingBinding(proposal.scheduling,work.intent))reject("schedule_unconfirmed");
      }
      for(const entry of proposal.responsibilities)this.validateTarget(proposal.binding,entry,this.readEntry(proposal.binding.needId,entry.id)?.acceptanceId===acceptance.id);
    }};
  }

  private assertUnreferenced(workId:string):void {
    let afterSequence=0,frontier:number|null=null;
    do {
      const page=this.query({kind:"work_users",workId,frontier,afterSequence,limit:64}) as import("@agent-anything/agent-runtime/context-representation").InputSupplyUsersPage;
      frontier=page.frontier;
      for(const entry of page.entries)if(this.exits.read(entry.binding.needId)?.status!=="closed")reject("producer_in_use");
      if(page.complete)return;
      afterSequence=page.next!;
    } while(true);
  }

  private validateOrigin(proposal:InputSupplyRegistration):void {
    const {binding}=proposal,need=this.paths.need(binding.needId),consumer=this.paths.path(binding.consumerPathId),source=this.paths.stage(binding.source.stageId);
    if(!need||!consumer||need.supplier!==binding.owner||need.stage.pathId!==binding.consumerPathId||consumer.intent.runId!==binding.runId||
      !source||source.request.pathId!==binding.consumerPathId||source.status!=="accepted"||modelInputValueDigest(source.request)!==binding.source.requestDigest)
      reject("original_need_unconfirmed");
    if(consumer.cancelled||consumer.controlRevision!==proposal.expectedConsumerControlRevision)reject("consumer_control_changed");
  }
  private validateTarget(binding:InputSupplyBinding,entry:InputSupplyResponsibility,initial:boolean):void {
    const path=this.paths.path(entry.target.pathId);
    if(!path||path.intent.runId!==binding.runId||!same(inputSupplyResponsibility(entry.role,path.intent),entry)||
      path.intent.purpose.digest!==modelInputValueDigest(PURPOSES[entry.role])||(initial&&path.cancelled))reject("target_unconfirmed");
    if(entry.relation==="owned"&&path.intent.owner!==binding.owner)reject("target_not_owned");
    if(entry.role==="input_preparation"&&entry.target.workId!==(this.head(binding.needId)?.scheduling?.workId??null))reject("preparation_schedule_unconfirmed");
    const stage=this.paths.stage(entry.role==="source_publication"?`${path.intent.id}:capture`:`${path.intent.id}:stage:1`);
    if(!stage||stage.request.pathId!==path.intent.id)reject("target_stage_missing");
    if(entry.role==="method_reception") {
      try {ContextMethodInputSupply.validateInputSupply(binding,path.intent,stage,this.paths.subscription(`${path.intent.id}:consumer`),initial,
        path.intent.scheduledWorkId?this.paths.scheduling(path.intent.scheduledWorkId):null);}
      catch {reject("target_reception_unconfirmed");}
    }
  }
  private head(id:string):InputSupplyHead|null {
    activityToken(id);
    const row=this.records.sql("SELECT run_id,revision,value,digest FROM context_input_supplies WHERE need_id=?").get(id) as (Row&{run_id:string;revision:number})|undefined;
    if(!row)return null;
    const value=checkedJson<InputSupplyHead>(row);
    if(value.binding.needId!==id||value.binding.runId!==row.run_id||value.revision!==row.revision)throw new Error("input_supply_head_corrupt");
    return value;
  }
  private readEntry(needId:string,id:string):AcceptedInputSupplyResponsibility|null {
    const row=this.records.sql("SELECT value,digest FROM context_input_supply_responsibilities WHERE need_id=? AND id=?").get(needId,id) as Row|undefined;
    return row?this.entry(needId,id,row):null;
  }
  private entry(needId:string,id:string,row:Row):AcceptedInputSupplyResponsibility {
    const value=checkedJson<AcceptedInputSupplyResponsibility>(row);
    if(value.needId!==needId||value.id!==id)throw new Error("input_supply_responsibility_corrupt");
    return value;
  }
}
function validateTarget(target:InputSupplyResponsibility["target"]):void {
  [target.pathId,target.owner,target.intentDigest].forEach(activityToken);if(target.workId!==null)activityToken(target.workId);
}
function validateRegistration(value:InputSupplyRegistration):void {
  const b=value.binding;
  [b.needId,b.runId,b.owner,b.consumerPathId,b.source.stageId,b.source.requestDigest,b.configuration.id,b.configuration.revision].forEach(activityToken);
  activityCount(value.expectedRevision,true);activityCount(value.expectedConsumerControlRevision,true);
  if(value.scheduling) {
    validateActivitySchedulingIntent(value.scheduling);
    if(value.scheduling.owner!==b.owner||value.scheduling.runId!==b.runId)throw new TypeError("input_supply_schedule_invalid");
  }
  if(!Array.isArray(value.responsibilities)||value.responsibilities.length>32||new Set(value.responsibilities.map(r=>r.id)).size!==value.responsibilities.length)
    throw new TypeError("input_supply_responsibilities_invalid");
  for(const entry of value.responsibilities) {
    activityToken(entry.id);validateTarget(entry.target);
    if(!Object.hasOwn(PURPOSES,entry.role)||entry.relation!==(["source_publication","method_production"].includes(entry.role)?"dependency":"owned"))
      throw new TypeError("input_supply_role_invalid");
  }
}
function same(a:unknown,b:unknown):boolean {return modelInputValueDigest(a)===modelInputValueDigest(b);}
function reject(code:string):never {throw new SharedAcceptanceRejection(OWNER,`input_supply_${code}`);}
