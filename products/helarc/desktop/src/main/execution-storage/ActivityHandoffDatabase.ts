import type Database from "better-sqlite3";
import {ActivityWorkViewQuery} from "./ActivityWorkViewQuery.js";
import {isDeepStrictEqual} from "node:util";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {activityCount, activityToken, activityFactSourceId, activityStageEvidence, validateActivityAuthorizationRefusal, validateActivityExecutor, validateActivityPath, validateActivityStage,
  type ActivityHandoffCommand, type ActivityHandoffValue, type ActivityPathIntent, type ActivityPathState,
  type ActivityStageRequest, type ActivityStageState, type ActivityAttempt, type ActivityRawResult,
  type ActivityProcessingReceipt, type ActivitySettlementReceipt, type ActivityProcessingClaim, type ActivityHandoffItem, type ActivityHandoffFact,type ActivityInputNeed} from "@agent-anything/agent-runtime/activity";
import type {ExecutionContentRoot} from "./ExecutionContent.js";
import {isImmutableExecutionContent} from "./ExecutionContent.js";
import {SharedAcceptanceRejection, type SharedAcceptanceParticipant} from "./SharedAcceptanceDatabase.js";
import {ActivitySchedulingDatabase,ACTIVITY_SCHEDULING_SCHEMA} from "./ActivitySchedulingDatabase.js";
import {ActivityReconsiderationDatabase,ACTIVITY_RECONSIDERATION_SCHEMA,PENDING_RECONSIDERATION_FACTS_SQL} from "./ActivityReconsiderationDatabase.js";
import {ActivityResourceDatabase,ACTIVITY_RESOURCE_SCHEMA} from "./ActivityResourceDatabase.js";

export const ACTIVITY_HANDOFF_SCHEMA = `
CREATE TABLE activity_paths(id TEXT PRIMARY KEY, run_id TEXT NOT NULL, intent TEXT NOT NULL, digest TEXT NOT NULL,
 control_revision INTEGER NOT NULL, cancelled INTEGER NOT NULL, progress_revision INTEGER NOT NULL, progress TEXT,
 admitted INTEGER NOT NULL, attempts INTEGER NOT NULL);
CREATE INDEX activity_paths_scheduled_work ON activity_paths(json_extract(intent,'$.scheduledWorkId'),id);
CREATE TABLE activity_stages(id TEXT PRIMARY KEY, path_id TEXT NOT NULL REFERENCES activity_paths(id),
 request TEXT NOT NULL, digest TEXT NOT NULL, status TEXT NOT NULL, attempt_id TEXT, result_id TEXT, receipt_id TEXT, processing TEXT,
 scheduling_metadata TEXT NOT NULL,scheduling_digest TEXT NOT NULL,dispatch_restriction TEXT,authorization_restrictions TEXT,raw_evidence_revision INTEGER NOT NULL);
CREATE INDEX activity_stages_path ON activity_stages(path_id,status);
CREATE TABLE activity_attempts(id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES activity_stages(id), value TEXT NOT NULL, digest TEXT NOT NULL);
CREATE INDEX activity_attempt_request ON activity_attempts(request_id);
CREATE TABLE activity_attempt_retries(id TEXT PRIMARY KEY,request_id TEXT NOT NULL REFERENCES activity_stages(id),attempt_id TEXT NOT NULL UNIQUE REFERENCES activity_attempts(id),value TEXT NOT NULL,digest TEXT NOT NULL);
CREATE INDEX activity_retry_request ON activity_attempt_retries(request_id);
CREATE TABLE activity_raw_results(id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES activity_attempts(id), value TEXT NOT NULL, digest TEXT NOT NULL);
CREATE INDEX activity_raw_attempt ON activity_raw_results(attempt_id);
CREATE TABLE activity_processing_receipts(id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE REFERENCES activity_stages(id), value TEXT NOT NULL, digest TEXT NOT NULL);
CREATE TABLE activity_settlement_receipts(id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE REFERENCES activity_stages(id), value TEXT NOT NULL, digest TEXT NOT NULL);
CREATE TABLE activity_stop_receipts(id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE REFERENCES activity_stages(id), value TEXT NOT NULL, digest TEXT NOT NULL);
CREATE TABLE activity_input_needs(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,unavailable_request_id TEXT NOT NULL UNIQUE,path_id TEXT NOT NULL REFERENCES activity_paths(id),value TEXT NOT NULL,digest TEXT NOT NULL);
CREATE INDEX activity_input_need_path ON activity_input_needs(path_id,request_id,unavailable_request_id);
CREATE TABLE activity_handoffs(sequence INTEGER PRIMARY KEY, run_id TEXT NOT NULL, path_id TEXT NOT NULL,
 request_id TEXT NOT NULL REFERENCES activity_stages(id), kind TEXT NOT NULL, pending INTEGER NOT NULL,
 UNIQUE(request_id,kind));
CREATE INDEX activity_handoff_pending ON activity_handoffs(run_id,pending,sequence);
CREATE INDEX activity_handoff_path_pending ON activity_handoffs(path_id,pending);
CREATE TABLE activity_facts(sequence INTEGER PRIMARY KEY,run_id TEXT NOT NULL,path_id TEXT NOT NULL,request_id TEXT,kind TEXT NOT NULL,occurred_at TEXT NOT NULL,value TEXT NOT NULL,digest TEXT NOT NULL);
CREATE INDEX activity_facts_run ON activity_facts(run_id,sequence);
CREATE INDEX activity_facts_path ON activity_facts(run_id,path_id,sequence);
${ACTIVITY_SCHEDULING_SCHEMA}
${ACTIVITY_RECONSIDERATION_SCHEMA}
${ACTIVITY_RESOURCE_SCHEMA}
`;
interface PathRow {id:string;run_id:string;intent:string;digest:string;control_revision:number;cancelled:number;
  progress_revision:number;progress:string|null;admitted:number;attempts:number;}
interface StageRow {id:string;path_id:string;request:string;digest:string;status:ActivityStageState["status"];
  attempt_id:string|null;result_id:string|null;receipt_id:string|null;processing:string|null;dispatch_restriction:string|null;authorization_restrictions:string|null;raw_evidence_revision:number;}
interface ValueRow {value:string;digest:string;}
interface PreparedContent {
  (value:unknown):string;
  readonly bodies:Map<string,unknown>;
  readonly digests:Map<unknown,string>;
}

/** Activity ownership only. Professional payloads are retained, never interpreted here. */
export class ActivityHandoffDatabase {
  private readonly statements = new Map<string, Database.Statement>();
  private observationCursor: number | null = null;
  private currentPreparation:PreparedContent|null=null;
  private readonly immutableDigests=new WeakMap<object,string>();
  private readonly contentDigests=new Map<string,string>();
  private readonly acceptanceContent=new WeakMap<object,{bodies:Map<string,unknown>;digests:Map<unknown,string>}>();
  private readonly scheduling:ActivitySchedulingDatabase;
  private readonly reconsideration:ActivityReconsiderationDatabase;
  private readonly resources:ActivityResourceDatabase;
  private presentation:ActivityWorkViewQuery|undefined;
  constructor(private readonly db: Database.Database,
    private readonly retain: (value: unknown) => ExecutionContentRoot,
    private readonly hydrate: (root: ExecutionContentRoot) => unknown,
    private readonly generation:()=>number) {
    this.resources=new ActivityResourceDatabase(db);
    this.reconsideration=new ActivityReconsiderationDatabase(db,(runId,subject,kind,details)=>this.recordFact(runId,subject,null,kind,details));
    this.scheduling=new ActivitySchedulingDatabase(db,(runId,workId,kind,details)=>{
      this.recordFact(runId,workId,null,kind,details);
      const sourceId=activityFactSourceId("scheduling",workId),id=`scheduling-fact:${modelInputValueDigest({workId,kind,details})}`;
      this.reconsideration.source({id:sourceId,runId,owner:"activity-scheduling"});
      this.reconsideration.publish({id,sourceId,ref:{owner:"activity-scheduling",kind,id:workId,revision:id}});
    });
  }

  command(command: ActivityHandoffCommand): {activityValue: ActivityHandoffValue} {
    this.beginObservations();
    const prepared = this.prepare(command);
    try {return {activityValue:this.withPrepared(prepared,()=>this.db.transaction(() => this.execute(command, prepared))())};}
    catch(error) {
      if(command.kind==="schedule_work"&&error&&typeof error==="object"&&"code" in error&&["activity_schedule_pool_missing","activity_schedule_resource_unavailable"].includes(String(error.code))) {
        this.db.transaction(()=>this.scheduling.recordLimitation(command.intent,String(error.code)))();
      }
      if(command.kind==="dispatch"&&error&&typeof error==="object"&&"code" in error&&["activity_schedule_not_ready","activity_schedule_turn_waiting"].includes(String(error.code))) {
        this.db.transaction(()=>this.scheduling.recordWait(command.attempt.requestId))();
      }
      throw error;
    }
  }

  acceptanceParticipant(): SharedAcceptanceParticipant {
    return {owner:"activity",kinds:["professional_stop","professional_acceptance","result_settlement","stage_submission","input_need","input_need_condition","path_condition","path_opening","fact_publication","reconsideration_subscription","reconsideration_acceptance","scheduling_acceptance","path_cancellation","scheduling_closure","scheduling_path_seal"],prepare:(part, proposal) => {
      if(part.kind==="professional_stop") {
        const command=part.proposal as Extract<ActivityHandoffCommand,{kind:"stop_professional_path"}>;
        if(command?.kind!=="stop_professional_path"||command.receipt.id!==proposal.id||command.receipt.owner!==proposal.actor)
          throw new SharedAcceptanceRejection("activity","activity_stop_identity_invalid");
        const path=this.requirePath(this.requireStage(command.receipt.requestId).request.pathId);
        if(path.intent.runId!==proposal.scope||path.intent.owner!==proposal.actor||proposal.parts.some(p=>p.owner==="activity"&&
          ["stage_submission","path_opening","professional_acceptance","input_need"].includes(p.kind)))
          throw new SharedAcceptanceRejection("activity","activity_stop_scope_invalid");
        return {command,prepared:this.sharePrepared(proposal,this.prepare(command))};
      }
      if(part.kind==="path_condition") {
        const condition=part.proposal as import("@agent-anything/agent-runtime/activity").ActivityPathCondition;
        activityToken(condition.pathId);
        if(typeof condition.requireSettled!=="boolean"||condition.expected!==null&&
          (!condition.expected||typeof condition.expected.cancelled!=="boolean"))
          throw new SharedAcceptanceRejection("activity","activity_path_condition_invalid");
        if(condition.expected){activityCount(condition.expected.controlRevision,true);activityCount(condition.expected.progressRevision,true);}
        return {pathCondition:structuredClone(condition),scope:proposal.scope,actor:proposal.actor};
      }
      if(part.kind==="input_need_condition") {
        const condition=part.proposal as {needId:string;expectedControlRevision:number};
        const need=this.inputNeed(condition.needId),path=need?this.requirePath(need.stage.pathId):null;
        if(!need||!path||path.intent.runId!==proposal.scope||need.supplier!==proposal.actor)
          throw new SharedAcceptanceRejection("activity","activity_input_need_scope_invalid");
        activityCount(condition.expectedControlRevision,true);
        return {inputNeedCondition:structuredClone(condition)};
      }
      if(part.kind==="reconsideration_subscription") {
        const subscription=part.proposal as import("@agent-anything/agent-runtime/activity").ActivityReconsiderationSubscription;
        if(subscription.runId!==proposal.scope||subscription.owner!==proposal.actor)
          throw new SharedAcceptanceRejection("activity","activity_subscription_scope_invalid");
        const command={kind:"subscribe_reconsideration" as const,subscription};return {command,prepared:this.sharePrepared(proposal,this.prepare(command))};
      }
      if(part.kind==="input_need") {
        const need=part.proposal as ActivityInputNeed,path=this.requirePath(need.stage.pathId);
        if(path.intent.runId!==proposal.scope||path.intent.owner!==proposal.actor)throw new SharedAcceptanceRejection("activity","activity_input_need_owner_invalid");
        const command={kind:"register_input_need" as const,need};return {command,prepared:this.sharePrepared(proposal,this.prepare(command))};
      }
      if(part.kind==="result_settlement") {
        const command=part.proposal as Extract<ActivityHandoffCommand,{kind:"settle"}>;
        if(command?.kind!=="settle"||command.receipt.owner!==proposal.actor||command.receipt.id!==proposal.id)
          throw new SharedAcceptanceRejection("activity","activity_settlement_identity_invalid");
        const path=this.requirePath(this.requireStage(command.receipt.requestId).request.pathId);
        if(path.intent.runId!==proposal.scope||path.intent.purpose.contract.recoveryOwner!==proposal.actor)
          throw new SharedAcceptanceRejection("activity","activity_settlement_scope_invalid");
        // Settlement cannot smuggle new execution or progress into a cancelled scope.
        if(proposal.parts.some(p=>p.owner==="activity"&&p.kind!=="result_settlement"&&p.kind!=="fact_publication"))
          throw new SharedAcceptanceRejection("activity","activity_settlement_continuation_forbidden");
        return {command,prepared:this.sharePrepared(proposal,this.prepare(command))};
      }
      if(part.kind==="path_cancellation") {
        const command=part.proposal as Extract<ActivityHandoffCommand,{kind:"cancel"}>;
        const path=this.requirePath(command.pathId);
        if(command.kind!=="cancel"||path.intent.runId!==proposal.scope||path.intent.owner!==proposal.actor)
          throw new SharedAcceptanceRejection("activity","activity_cancellation_scope_invalid");
        return {command,prepared:this.sharePrepared(proposal,this.prepare(command))};
      }
      if(part.kind==="scheduling_closure"||part.kind==="scheduling_path_seal") {
        const command=part.proposal as Extract<ActivityHandoffCommand,{kind:"close_scheduled_work"|"seal_scheduled_paths"}>;
        const work=this.scheduling.read(command.workId);
        const creation=proposal.parts.find(p=>p.owner==="activity"&&p.kind==="scheduling_acceptance"&&
          (p.proposal as Extract<ActivityHandoffCommand,{kind:"schedule_work"}>)?.expectedRevision===0&&
          (p.proposal as Extract<ActivityHandoffCommand,{kind:"schedule_work"}>)?.intent?.workId===command.workId)?.proposal as Extract<ActivityHandoffCommand,{kind:"schedule_work"}>|undefined;
        const intent=work?.intent??creation?.intent;
        if(command.kind!==(part.kind==="scheduling_closure"?"close_scheduled_work":"seal_scheduled_paths")||!intent||intent.runId!==proposal.scope||intent.owner!==proposal.actor)
          throw new SharedAcceptanceRejection("activity","activity_closure_scope_invalid");
        return {command,prepared:this.sharePrepared(proposal,this.prepare(command))};
      }
      this.beginObservations();
      const permitsPath=(intent:ActivityPathIntent)=>{
        if(intent.runId!==proposal.scope)return false;
        if(intent.owner===proposal.actor)return true;
        if(!intent.scheduledWorkId)return false;
        const pending=proposal.parts.find(p=>p.owner==="activity"&&p.kind==="scheduling_acceptance"&&
          (p.proposal as Extract<ActivityHandoffCommand,{kind:"schedule_work"}>)?.intent?.workId===intent.scheduledWorkId)?.proposal as Extract<ActivityHandoffCommand,{kind:"schedule_work"}>|undefined;
        const schedule=pending?.intent??this.scheduling.read(intent.scheduledWorkId)?.intent;
        return schedule?.owner===proposal.actor&&schedule.runId===proposal.scope&&schedule.delegatedPathOwners?.includes(intent.owner)===true;
      };
      if(part.kind==="path_opening") {
        const command={kind:"open_path" as const,intent:part.proposal as ActivityPathIntent};
        validateActivityPath(command.intent);
        if(!permitsPath(command.intent))throw new SharedAcceptanceRejection("activity","activity_path_delegation_invalid");
        return {command,prepared:this.sharePrepared(proposal,this.prepare(command))};
      }
      if(part.kind==="fact_publication") {
        const command={kind:"publish_fact" as const,fact:part.proposal as import("@agent-anything/agent-runtime/activity").ActivityPublishedFact};
        const source=this.reconsideration.sourceState(command.fact.sourceId);
        if(!source||source.runId!==proposal.scope||source.owner!==proposal.actor)throw new SharedAcceptanceRejection("activity","activity_publication_scope_invalid");
        return {command,prepared:this.sharePrepared(proposal,this.prepare(command))};
      }
      if(part.kind==="reconsideration_acceptance") {
        const command={kind:"accept_reconsideration" as const,receipt:part.proposal as import("@agent-anything/agent-runtime/activity").ActivityReconsiderationReceipt};
        const state=this.reconsideration.state(command.receipt.subscriptionId);
        if(!state||state.subscription.runId!==proposal.scope||state.subscription.owner!==proposal.actor||command.receipt.id!==proposal.id)throw new SharedAcceptanceRejection("activity","activity_reconsideration_scope_invalid");
        return {command,prepared:this.sharePrepared(proposal,this.prepare(command))};
      }
      if(part.kind==="scheduling_acceptance") {
        const command=part.proposal as Extract<ActivityHandoffCommand,{kind:"schedule_work"}>;
        if(command?.kind!=="schedule_work"||command.intent.runId!==proposal.scope||command.intent.owner!==proposal.actor)throw new SharedAcceptanceRejection("activity","activity_schedule_scope_invalid");
        return {command,prepared:this.sharePrepared(proposal,this.prepare(command))};
      }
      if(part.kind==="stage_submission") {
        const command={kind:"submit" as const,request:part.proposal as ActivityStageRequest};
        const opening=proposal.parts.find(p=>p.owner==="activity"&&p.kind==="path_opening"&&(p.proposal as ActivityPathIntent)?.id===command.request.pathId)?.proposal as ActivityPathIntent|undefined;
        const intent=opening??this.requirePath(command.request.pathId).intent;
        const need=this.inputNeedForStage(command.request.id),{input:_,...stage}=command.request;
        const supplied=need&&intent.runId===proposal.scope&&need.supplier===proposal.actor&&
          [need.stage,need.unavailableStage].some(entry=>modelInputValueDigest(entry)===modelInputValueDigest(stage));
        if(!permitsPath(intent)&&!supplied)throw new SharedAcceptanceRejection("activity","activity_submission_scope_invalid");
        return {command,prepared:this.sharePrepared(proposal,this.prepare(command))};
      }
      const command = part.proposal as Extract<ActivityHandoffCommand,{kind:"accept"}>;
      if (!command || command.kind !== "accept" || command.receipt.owner !== proposal.actor || command.receipt.id !== proposal.id) throw new SharedAcceptanceRejection("activity","activity_acceptance_identity_invalid");
      const stage = this.requireStage(command.receipt.requestId), path = this.requirePath(stage.request.pathId);
      if (path.intent.runId !== proposal.scope) throw new SharedAcceptanceRejection("activity","activity_acceptance_scope_invalid");
      return {command,prepared:this.sharePrepared(proposal,this.prepare(command))};
    },apply: (value,proposal) => {
      if(value&&typeof value==="object"&&"pathCondition" in value) {
        this.checkPathCondition(value as Parameters<ActivityHandoffDatabase["checkPathCondition"]>[0]);return;
      }
      if(value&&typeof value==="object"&&"inputNeedCondition" in value) {
        const condition=(value as {inputNeedCondition:{needId:string;expectedControlRevision:number}}).inputNeedCondition;
        const need=this.inputNeed(condition.needId)!,path=this.sql("SELECT cancelled,control_revision FROM activity_paths WHERE id=?").get(need.stage.pathId) as {cancelled:number;control_revision:number}|undefined;
        if(!path||path.cancelled||path.control_revision!==condition.expectedControlRevision||this.sql("SELECT 1 FROM activity_stages WHERE id IN (?,?)").get(need.stage.id,need.unavailableStage.id))
          throw new SharedAcceptanceRejection("activity","activity_input_need_changed");
        return;
      }
      const {command,prepared} = value as {command:ActivityHandoffCommand;prepared:PreparedContent};
      if(command.kind==="seal_scheduled_paths"||command.kind==="close_scheduled_work") {
        const work=this.scheduling.read(command.workId);
        if(!work||work.intent.owner!==proposal.actor||work.intent.runId!==proposal.scope)throw new SharedAcceptanceRejection("activity","activity_closure_scope_invalid");
      }
      try {this.withPrepared(prepared,()=>this.execute(command,prepared));} catch (error) {
        if (error instanceof Error && "code" in error && typeof error.code === "string" && error.code.startsWith("activity_") && error.code !== "activity_corrupt") throw new SharedAcceptanceRejection("activity",error.code);
        throw error;
      }
    },validate:(value,proposal)=>{
      if(value&&typeof value==="object"&&"pathCondition" in value) {
        const condition=value as Parameters<ActivityHandoffDatabase["checkPathCondition"]>[0];
        if(condition.pathCondition.requireSettled)this.checkPathCondition(condition);
      }
      if(value&&typeof value==="object"&&"command" in value) {
        const command=(value as {command:ActivityHandoffCommand}).command;
        if(command.kind==="seal_scheduled_paths"||command.kind==="close_scheduled_work") {
          const work=this.scheduling.read(command.workId);
          if(!work||work.intent.owner!==proposal.actor||work.intent.runId!==proposal.scope)throw new SharedAcceptanceRejection("activity","activity_closure_scope_invalid");
        }
        if(command.kind==="accept"||command.kind==="settle") {
          const {prepared}=value as {command:ActivityHandoffCommand;prepared:PreparedContent};
          const action=command.kind==="accept"?"interpretation":"settlement";
          const blocked=this.withPrepared(prepared,()=>this.requireStage(command.receipt.requestId).authorizationRestrictions?.[action]);
          if(blocked)throw new SharedAcceptanceRejection("activity","activity_authorization_restricted");
        }
        if(command.kind==="close_scheduled_work"&&command.requireSettled) {
          try {this.scheduling.assertSettled(command.workId);} catch(error) {
            if(error instanceof Error&&"code" in error&&typeof error.code==="string"&&error.code.startsWith("activity_schedule_")&&error.code!=="activity_schedule_corrupt")
              throw new SharedAcceptanceRejection("activity",error.code);
            throw error;
          }
        }
      }
    }};
  }

  private checkPathCondition({pathCondition:condition,scope,actor}:{pathCondition:import("@agent-anything/agent-runtime/activity").ActivityPathCondition;scope:string;actor:string}):void {
    const row=this.sql("SELECT id,run_id,intent,digest,control_revision,progress_revision,cancelled FROM activity_paths WHERE id=?").get(condition.pathId) as PathRow|undefined;
    const intent=row?JSON.parse(row.intent) as ActivityPathIntent:null,expected=condition.expected;
    if(intent){validateActivityPath(intent);if(row!.digest!==modelInputValueDigest(intent)||intent.id!==row!.id||intent.runId!==row!.run_id)fail("corrupt");}
    if(intent&&(intent.runId!==scope||intent.owner!==actor))throw new SharedAcceptanceRejection("activity","activity_path_condition_scope_invalid");
    if(expected===null?row!==undefined:!row||row.control_revision!==expected.controlRevision||
      row.progress_revision!==expected.progressRevision||(row.cancelled===1)!==expected.cancelled)
      throw new SharedAcceptanceRejection("activity","activity_path_condition_changed");
    if(condition.requireSettled&&this.hasPending(condition.pathId))throw new SharedAcceptanceRejection("activity","activity_path_responsibility_unsettled");
  }

  private sharePrepared(proposal:object,prepared:PreparedContent):PreparedContent {
    const shared=this.acceptanceContent.get(proposal)??{bodies:new Map<string,unknown>(),digests:new Map<unknown,string>()};
    for(const [key,value] of prepared.bodies)shared.bodies.set(key,value);
    for(const [key,value] of prepared.digests)shared.digests.set(key,value);
    this.acceptanceContent.set(proposal,shared);
    // One acceptance may update progress and submit another stage. Both see the same prepared immutable roots.
    return Object.assign(prepared,shared);
  }

  private prepare(command: ActivityHandoffCommand): PreparedContent {
    // Content completion precedes publication. Execution content is not collected while this store exists.
    const staged = new Map<unknown, string>();
    const bodies=new Map<string,unknown>(),digests=new Map<unknown,string>();
    const remember=(root:string,value:unknown)=>{bodies.set(root,value);digests.set(value,this.contentDigest(root,value));};
    const prepare = (value: unknown) => {const root = JSON.stringify(this.retain(value)); staged.set(value, root);remember(root,value); return root;};
    const warm=(root:string|null)=>{if(root===null)return null;if(!bodies.has(root))remember(root,this.hydrate(JSON.parse(root)));return bodies.get(root);};
    const visited=new Set<string>();
    const path=(id:string)=>{const row=this.sql("SELECT progress FROM activity_paths WHERE id=?").get(id) as {progress:string|null}|undefined;if(row)warm(row.progress);};
    const stage=(id:string,readOnly=false)=>{
      if(visited.has(id))return;visited.add(id);
      const row=this.sql("SELECT * FROM activity_stages WHERE id=?").get(id) as StageRow|undefined;if(!row)return;
      const request=warm(row.request) as ActivityStageRequest;
      if(!readOnly){digests.set(request.input,this.digest(request.input));path(row.path_id);}
      for(const [table,key] of [["activity_raw_results",row.result_id],["activity_processing_receipts",row.receipt_id]] as const){
        if(key){const value=this.sql(`SELECT value FROM ${table} WHERE id=?`).get(key) as {value:string}|undefined;if(value)warm(value.value);}
      }
      const settlement=this.sql("SELECT value FROM activity_settlement_receipts WHERE request_id=?").get(id) as ValueRow|undefined;
      if(settlement)warm(settlement.value);
      const stop=this.sql("SELECT value FROM activity_stop_receipts WHERE request_id=?").get(id) as ValueRow|undefined;
      if(stop)warm(stop.value);
    };
    if(command.kind!=="facts"&&"pathId" in command&&command.pathId!==undefined)path(command.pathId);
    if(command.kind==="register_input_need") {path(command.need.stage.pathId);if(command.need.origin)stage(command.need.origin.requestId);}
    if(command.kind==="subscribe_reconsideration"&&command.subscription.binding){
      if(command.subscription.binding.kind==="activity_path")path(command.subscription.binding.id);
      else {const need=this.inputNeed(command.subscription.binding.id);if(need)path(need.stage.pathId);}
    }
    if(command.kind==="reserve_resources")stage(command.reservation.requestId);
    if("requestId" in command)stage(command.requestId,command.kind==="read_stage");
    if(command.kind==="open_path")path(command.intent.id);
    if(command.kind==="dispatch") {
      stage(command.attempt.requestId);
      const row=this.sql("SELECT request FROM activity_stages WHERE id=?").get(command.attempt.requestId) as {request:string}|undefined;
      if(row)for(const dependency of (warm(row.request) as ActivityStageRequest).dependencies)stage(dependency.requestId);
    }
    if(command.kind==="claim_processing")stage(command.claim.requestId);
    if(command.kind==="retry_attempt")stage(command.receipt.requestId);
    if(command.kind==="read_raw_result") {
      const row=this.sql("SELECT value FROM activity_raw_results WHERE id=?").get(command.resultId) as ValueRow|undefined;
      if(row)warm(row.value);
    }
    if(command.kind==="save_raw"){
      const attempt=this.requireAttempt(command.result.attemptId);stage(attempt.requestId);
      const old=this.sql("SELECT value FROM activity_raw_results WHERE id=?").get(command.result.id) as {value:string}|undefined;if(old)warm(old.value);
    }
    const warmSubmission=(request:ActivityStageRequest)=>{stage(request.id);path(request.pathId);for(const dependency of request.dependencies)stage(dependency.requestId);};
    if(command.kind==="submit")warmSubmission(command.request);
    if (command.kind === "open_path") validateActivityPath(command.intent);
    if (command.kind === "submit") prepare(command.request);
    if (command.kind === "save_raw") prepare(command.result);
    if (command.kind === "accept") {
      stage(command.receipt.requestId);
      prepare(command.receipt); prepare(command.receipt.progress);
      for (const request of command.receipt.next) {warmSubmission(request);prepare(request);digests.set(request.input,modelInputValueDigest(request.input));}
    }
    if(command.kind==="settle") {stage(command.receipt.requestId);prepare(command.receipt);}
    if(command.kind==="stop_professional_path") {stage(command.receipt.requestId);prepare(command.receipt);prepare(command.receipt.progress);}
    if(command.kind==="submit")digests.set(command.request.input,modelInputValueDigest(command.request.input));
    return Object.assign((value:unknown) => {
      const root = staged.get(value);
      if (root === undefined) fail("content_not_prepared");
      return root;
    },{bodies,digests});
  }
  private withPrepared<T>(prepared:PreparedContent,action:()=>T):T {
    const previous=this.currentPreparation;this.currentPreparation=prepared;
    try{return action();}finally{this.currentPreparation=previous;}
  }
  private body(root:string):unknown {
    if(this.currentPreparation?.bodies.has(root))return this.currentPreparation.bodies.get(root);
    if(this.db.inTransaction)fail("content_not_prepared");
    return this.hydrate(JSON.parse(root));
  }
  private digest(value:unknown):string {
    const prepared=this.currentPreparation?.digests.get(value);if(prepared!==undefined)return prepared;
    // Only reuse a pure calculation for a content-owned, deeply immutable identity.
    const immutable=isImmutableExecutionContent(value),known=immutable?this.immutableDigests.get(value):undefined;
    if(known!==undefined)return known;
    const digest=modelInputValueDigest(value);if(immutable)this.immutableDigests.set(value,digest);return digest;
  }
  private contentDigest(root:string,value:unknown):string {
    // Hydration has already validated this immutable content graph. A root cache
    // keeps only the calculation, not the large decoded graph or its availability.
    if(!isImmutableExecutionContent(value))return this.digest(value);
    let digest=this.contentDigests.get(root);
    if(digest===undefined)digest=this.digest(value);
    this.contentDigests.delete(root);this.contentDigests.set(root,digest);
    if(this.contentDigests.size>256)this.contentDigests.delete(this.contentDigests.keys().next().value!);
    this.immutableDigests.set(value,digest);return digest;
  }
  private same(left:unknown,right:unknown):void{if(this.digest(left)!==this.digest(right))fail("identity_conflict");}

  private execute(command: ActivityHandoffCommand, prepared: (value: unknown) => string): ActivityHandoffValue {
    switch (command.kind) {
      case "read_input_need":return this.inputNeed(command.id);
      case "register_input_need": {
        const need=command.need,path=this.requirePath(need.stage.pathId);activityToken(need.id);activityToken(need.supplier);
        if(need.supplier!==path.intent.purpose.contract.inputOwner)fail("input_supplier_invalid");
        if(need.origin) {
          const origin=this.requireStage(need.origin.requestId);
          if(origin.request.pathId!==path.intent.id||origin.status!=="accepted"||origin.receipt?.id!==need.origin.receiptId||
            origin.receipt.owner!==path.intent.purpose.contract.acceptanceOwner)fail("input_need_origin_unconfirmed");
        }
        validateActivityStage({...need.stage,input:null},path.intent);
        validateActivityStage({...need.unavailableStage,input:null},path.intent);
        if(need.unavailableStage.pathId!==need.stage.pathId||need.unavailableStage.id===need.stage.id)fail("input_need_entry_invalid");
        const old=this.inputNeed(need.id);if(old){this.same(old,need);return old;}
        this.scheduling.validatePath(path.intent);
        if(path.cancelled||[need.stage,need.unavailableStage].some(entry=>this.stage(entry.id)||this.inputNeedForStage(entry.id)))fail("input_need_conflict");
        this.sql("INSERT INTO activity_input_needs VALUES (?,?,?,?,?,?)").run(need.id,need.stage.id,need.unavailableStage.id,path.intent.id,JSON.stringify(need),modelInputValueDigest(need));
        this.fact(path.intent,null,"input_needed",{need});
        this.reconsideration.subscribe({id:`${need.id}:supply`,runId:path.intent.runId,owner:need.supplier,
          binding:{kind:"input_need",id:need.id},sources:[activityFactSourceId("progress",path.intent.id),activityFactSourceId("control",path.intent.id)]});
        this.reconsideration.publish({id:`${need.id}:requested`,sourceId:activityFactSourceId("progress",path.intent.id),
          ref:{owner:path.intent.owner,kind:"input_need",id:need.id,revision:"1"}});
        return need;
      }
      case "bind_resource_pool": return this.scheduling.bind(command.pool);
      case "schedule_work": return this.scheduling.accept(command.intent,command.expectedRevision);
      case "read_schedule": return this.scheduling.read(command.workId);
      case "read_work_view": return (this.presentation??=new ActivityWorkViewQuery(this.db,id=>this.scheduling.read(id))).read(command.scopeId,command.limit);
      case "scheduled_settlement": return this.scheduling.settlement(command.workId);
      case "review_scheduling": return this.scheduling.review();
      case "seal_scheduled_paths": return this.scheduling.sealPaths(command.workId,command.expectedRevision,command.basis);
      case "scheduled_paths": return this.scheduling.paths(command.workId,command.expectedRevision,command.afterId,command.limit);
      case "close_scheduled_work": return this.scheduling.close(command.workId,command.expectedRevision,command.basis,command.requireSettled);
      case "scheduling_candidates": return this.scheduling.candidates(command.limit);
      case "register_fact_source": return this.reconsideration.source(command.source);
      case "publish_fact": return this.reconsideration.publish(command.fact);
      case "subscribe_reconsideration": {
        const subscription=command.subscription;
        if(subscription.binding) {
          if(subscription.binding.kind==="activity_path") {
            const path=this.requirePath(subscription.binding.id);
            if(path.intent.owner!==subscription.owner||path.intent.runId!==subscription.runId||
              !subscription.sources.includes(activityFactSourceId("control",path.intent.id)))fail("subscription_binding_invalid");
          } else if(subscription.binding.kind==="input_need") {
            const need=this.inputNeed(subscription.binding.id);
            if(!need||need.supplier!==subscription.owner||this.requirePath(need.stage.pathId).intent.runId!==subscription.runId||
              !subscription.sources.includes(activityFactSourceId("control",need.stage.pathId)))fail("subscription_binding_invalid");
          } else fail("subscription_binding_invalid");
        }
        return this.reconsideration.subscribe(subscription);
      }
      case "read_reconsideration": return this.reconsideration.snapshot(command.subscriptionId,command.limit);
      case "read_reconsideration_state": return this.reconsideration.state(command.subscriptionId);
      case "read_fact": return this.reconsideration.publishedFact(command.id);
      case "pending_reconsiderations": return this.reconsideration.pending(command.runId,command.afterId,command.limit);
      case "accept_reconsideration": {
        const state=this.reconsideration.state(command.receipt.subscriptionId);
        if(command.receipt.observeSources&&state?.subscription.binding?.kind==="input_need") {
          const need=this.inputNeed(state.subscription.binding.id);
          if(!need||!command.receipt.observeSources.includes(activityFactSourceId("control",need.stage.pathId)))fail("subscription_binding_invalid");
        }
        return this.reconsideration.accept(command.receipt);
      }
      case "open_path": {
        const old = this.path(command.intent.id);
        if (old) {this.same(old.intent, command.intent); return old;}
        const intent = command.intent;
        this.scheduling.validatePath(intent,true);
        const peers=this.sql("SELECT intent,digest FROM activity_paths WHERE run_id=? AND json_extract(intent,'$.resourceScope')=?").all(intent.runId,intent.resourceScope) as {intent:string;digest:string}[];
        for(const peer of peers){
          const established=JSON.parse(peer.intent) as ActivityPathIntent;
          if(modelInputValueDigest(established)!==peer.digest)fail("corrupt");
          if(established.maximumStages!==intent.maximumStages || established.maximumAttempts!==intent.maximumAttempts || established.maximumConcurrent!==intent.maximumConcurrent || established.permissionBasis!==intent.permissionBasis||established.deadlineAt!==intent.deadlineAt||modelInputValueDigest(established.resourceLimits??{})!==modelInputValueDigest(intent.resourceLimits??{}))fail("resource_scope_conflict");
        }
        this.sql("INSERT INTO activity_paths VALUES (?,?,?,?,0,0,0,NULL,0,0)")
          .run(intent.id, intent.runId, JSON.stringify(intent), modelInputValueDigest(intent));
        this.fact(intent,null,"path_opened",{purpose:intent.purpose,resourceScope:intent.resourceScope});
        this.reconsideration.source({id:activityFactSourceId("progress",intent.id),runId:intent.runId,owner:intent.owner});
        this.reconsideration.source({id:activityFactSourceId("control",intent.id),runId:intent.runId,owner:"activity-control"});
        return this.path(intent.id);
      }
      case "read_path": return this.path(command.pathId);
      case "resource_allowance":return this.resources.allowance(this.requirePath(command.pathId).intent);
      case "reserve_resources": {
        const reservation=command.reservation,path=this.requirePath(reservation.pathId),stage=this.requireStage(reservation.requestId);
        if(stage.request.pathId!==path.intent.id||!stage.attempt)fail("resource_stage_invalid");
        const old=this.resources.original(reservation.id);
        if(!old){this.control(path,command.expectedControlRevision);if(Date.now()>=Date.parse(path.intent.deadlineAt))fail("deadline_exceeded");}
        const allowance=this.resources.reserve(path.intent,reservation);
        if(!old)this.fact(path.intent,stage.request.id,"resources_reserved",{reservation,allowance});
        return reservation;
      }
      case "read_stage": return this.stage(command.requestId);
      case "submit": {
        this.submit(command.request, prepared(command.request));
        return this.stage(command.request.id);
      }
      case "admit": {
        const stage = this.requireStage(command.requestId), path = this.requirePath(stage.request.pathId);
        if (stage.status !== "submitted") return stage;
        this.control(path, command.expectedControlRevision);
        if(stage.authorizationRestrictions?.admission)fail("authorization_restricted");
        if (this.resourceUse(path.intent).admitted >= path.intent.maximumStages) fail("stage_limit");
        this.sql("UPDATE activity_stages SET status='admitted' WHERE id=?").run(stage.request.id);
        this.sql("UPDATE activity_paths SET admitted=admitted+1 WHERE id=?").run(path.intent.id);
        this.closeHandoff(stage.request.id, "admission"); this.handoff(path, stage.request.id, "execution");
        this.fact(path.intent,stage.request.id,"stage_admitted",{controlRevision:path.controlRevision});
        return this.stage(stage.request.id);
      }
      case "record_authorization_restriction": {
        const stage=this.requireStage(command.requestId),path=this.requirePath(stage.request.pathId);
        if(path.controlRevision!==command.expectedControlRevision)fail("control_conflict");
        if(activityStageEvidence(stage)!==command.expectedStageEvidence)fail("stage_evidence_changed");
        if(!["admission","execution","reconciliation","interpretation","settlement"].includes(command.action))fail("authorization_action_invalid");
        if(command.refusal)validateActivityAuthorizationRefusal(command.refusal);
        const restrictions={...stage.authorizationRestrictions};
        if(isDeepStrictEqual(restrictions[command.action]??null,command.refusal))return stage;
        if(command.refusal)restrictions[command.action]=command.refusal;else delete restrictions[command.action];
        this.sql("UPDATE activity_stages SET authorization_restrictions=? WHERE id=?")
          .run(JSON.stringify({value:restrictions,digest:modelInputValueDigest(restrictions)}),stage.request.id);
        this.fact(path.intent,stage.request.id,"authorization_restricted",{action:command.action,refusal:command.refusal,controlRevision:path.controlRevision});
        this.reconsideration.publish({id:`authorization:${stage.request.id}:${this.lastFactSequence()}`,sourceId:activityFactSourceId("control",path.intent.id),
          ref:{owner:"activity-control",kind:"authorization_restriction",id:stage.request.id,revision:String(this.lastFactSequence())}});
        return this.stage(stage.request.id);
      }
      case "stop_professional_path": {
        const receipt=command.receipt;
        [receipt.id,receipt.requestId,receipt.owner,receipt.expectedStageEvidence].forEach(activityToken);
        const old=this.value<import("@agent-anything/agent-runtime/activity").ActivityProfessionalStopReceipt>("activity_stop_receipts",receipt.id,true);
        if(old){this.same(old,receipt);return this.requireStage(receipt.requestId);}
        const stage=this.requireStage(receipt.requestId),path=this.requirePath(stage.request.pathId);
        this.control(path,receipt.expectedControlRevision);
        if(path.intent.owner!==receipt.owner||path.progressRevision!==receipt.expectedProgressRevision||
          activityStageEvidence(stage)!==receipt.expectedStageEvidence||["accepted","settled","stopped"].includes(stage.status)||receipt.progress===undefined)
          fail("stop_evidence_changed");
        const limit=receipt.limitation;
        if(limit.kind==="deadline") {
          if(stage.attempt||limit.deadlineAt!==path.intent.deadlineAt||!Number.isFinite(Date.parse(limit.observedAt))||
            Date.parse(limit.observedAt)<Date.parse(limit.deadlineAt)||Date.now()<Date.parse(limit.deadlineAt))fail("stop_limitation_changed");
        } else if(limit.kind==="authorization") {
          validateActivityAuthorizationRefusal(limit.refusal);
          if(limit.refusal.kind!=="denied"||!isDeepStrictEqual(stage.authorizationRestrictions?.[limit.action],limit.refusal))fail("stop_limitation_changed");
        } else fail("stop_limitation_invalid");
        this.sql("INSERT INTO activity_stop_receipts VALUES (?,?,?,?)").run(receipt.id,receipt.requestId,prepared(receipt),this.digest(receipt));
        this.execute({kind:"cancel",pathId:path.intent.id,expectedControlRevision:path.controlRevision},prepared);
        this.sql("UPDATE activity_paths SET progress_revision=progress_revision+1,progress=? WHERE id=?").run(prepared(receipt.progress),path.intent.id);
        if(!stage.attempt)this.sql("UPDATE activity_stages SET status='stopped' WHERE id=?").run(stage.request.id);
        this.fact(path.intent,stage.request.id,"professional_stopped",{receiptId:receipt.id,limitation:limit,attemptId:stage.attempt?.id??null,
          resultId:stage.result?.id??null,progressRevision:path.progressRevision+1,unexecuted:stage.attempt===null});
        this.reconsideration.publish({id:`${receipt.id}:stopped`,sourceId:activityFactSourceId("progress",path.intent.id),
          ref:{owner:path.intent.owner,kind:"professional_stop",id:receipt.id,revision:"1"}});
        return this.stage(stage.request.id);
      }
      case "restrict_dispatch": {
        const stage=this.requireStage(command.requestId),path=this.requirePath(stage.request.pathId);
        this.control(path,command.expectedControlRevision);
        if(stage.attempt)fail("dispatch_already_started");
        if(command.restriction){activityToken(command.restriction.code);activityToken(command.restriction.message);}
        if(isDeepStrictEqual(stage.dispatchRestriction??null,command.restriction))return stage;
        this.sql("UPDATE activity_stages SET dispatch_restriction=? WHERE id=?").run(command.restriction?JSON.stringify({value:command.restriction,digest:modelInputValueDigest(command.restriction)}):null,stage.request.id);
        this.fact(path.intent,stage.request.id,"dispatch_restricted",{restriction:command.restriction,controlRevision:path.controlRevision});
        this.reconsideration.publish({id:`dispatch-restriction:${stage.request.id}:${this.lastFactSequence()}`,sourceId:activityFactSourceId("control",path.intent.id),
          ref:{owner:"activity-control",kind:"dispatch_restriction",id:stage.request.id,revision:String(this.lastFactSequence())}});
        return this.stage(stage.request.id);
      }
      case "dispatch": {
        const attempt = command.attempt;
        activityToken(attempt.id); validateActivityExecutor(attempt.executor);
        const old = this.value<ActivityAttempt>("activity_attempts", attempt.id);
        if (old) {this.same(old, attempt); const scheduling=this.scheduling.originalDispatch(attempt.id); return {kind:"dispatch",stage:this.requireStage(attempt.requestId),granted:false,...(scheduling?{scheduling}:{})};}
        if(attempt.executor.generation!==this.generation())fail("execution_owner_stale");
        const stage = this.requireStage(attempt.requestId), path = this.requirePath(stage.request.pathId);
        this.control(path, command.expectedControlRevision);
        if (stage.status !== "admitted" || stage.attempt) fail("dispatch_not_available");
        if(stage.retry&&Date.parse(attempt.startedAt)<Date.parse(stage.retry.notBefore))fail("attempt_retry_waiting");
        if(stage.dispatchRestriction||stage.authorizationRestrictions?.admission||stage.authorizationRestrictions?.execution)fail("dispatch_restricted");
        if (this.digest(stage.request.input) !== attempt.inputDigest) fail("input_mismatch");
        if (!Number.isFinite(Date.parse(attempt.startedAt)) || Date.parse(attempt.startedAt) >= Date.parse(path.intent.deadlineAt)) fail("deadline");
        for (const dependency of stage.request.dependencies) {
          const producer = this.requireStage(dependency.requestId);
          if (dependency.condition === "accepted" ? producer.status !== "accepted" : !producer.result || producer.result.completeness !== "complete" || producer.result.outcome === "unknown") fail("dependency_waiting");
        }
        const inFlight = this.sql("SELECT COUNT(*) AS count FROM activity_stages s JOIN activity_paths p ON p.id=s.path_id WHERE p.run_id=? AND json_extract(p.intent,'$.resourceScope')=? AND s.status='dispatched'").get(path.intent.runId,path.intent.resourceScope) as {count:number};
        if (inFlight.count >= path.intent.maximumConcurrent) fail("slot_waiting");
        if (this.resourceUse(path.intent).attempts >= path.intent.maximumAttempts) fail("attempt_limit");
        const scheduling=this.scheduling.dispatch(path.intent,stage.request,attempt.id);
        this.sql("INSERT INTO activity_attempts VALUES (?,?,?,?)").run(attempt.id, attempt.requestId, JSON.stringify(attempt), modelInputValueDigest(attempt));
        this.sql("UPDATE activity_stages SET status='dispatched',attempt_id=? WHERE id=?").run(attempt.id, attempt.requestId);
        this.sql("UPDATE activity_paths SET attempts=attempts+1 WHERE id=?").run(path.intent.id);
        this.closeHandoff(stage.request.id, "execution");
        this.handoff(path, stage.request.id, "reconciliation",!!stage.retry);
        this.fact(path.intent,stage.request.id,"dispatched",{attempt,...(scheduling?{scheduling}:{})});
        return {kind:"dispatch",stage:this.requireStage(stage.request.id),granted:true,...(scheduling?{scheduling}:{})};
      }
      case "save_raw": {
        const result = command.result;
        activityToken(result.id); activityToken(result.attemptId);
        if (!["complete", "partial"].includes(result.completeness) || !["returned", "failed", "unknown"].includes(result.outcome) ||
            !Number.isFinite(Date.parse(result.recordedAt))) fail("result_invalid");
        const old = this.value<ActivityRawResult>("activity_raw_results", result.id, true);
        if (old) {this.same(old, result); return this.requireStage(this.requireAttempt(result.attemptId).requestId);}
        const attempt = this.requireAttempt(result.attemptId), stage = this.requireStage(attempt.requestId), path = this.requirePath(stage.request.pathId);
        // Raw evidence remains recordable after cancellation; only acceptance may advance progress.
        this.sql("INSERT INTO activity_raw_results VALUES (?,?,?,?)").run(result.id, result.attemptId, prepared(result), this.digest(result));
        this.sql("UPDATE activity_stages SET raw_evidence_revision=raw_evidence_revision+1 WHERE id=?").run(stage.request.id);
        this.fact(path.intent,stage.request.id,"raw_saved",{resultId:result.id,attemptId:result.attemptId,completeness:result.completeness,outcome:result.outcome,usage:result.usage});
        if (stage.attempt?.id === attempt.id && !stage.result && result.completeness === "complete" && result.outcome !== "unknown") {
          this.scheduling.release(attempt.id);
          this.sql("UPDATE activity_stages SET result_id=?,status='raw_result' WHERE id=?").run(result.id, stage.request.id);
          this.closeHandoff(stage.request.id, "reconciliation");
          this.handoff(path, stage.request.id, path.cancelled?"settlement":"interpretation",!!stage.retry);
        }
        return this.stage(stage.request.id);
      }
      case "read_raw_result": return this.value<ActivityRawResult>("activity_raw_results",command.resultId,true);
      case "read_stage_input_need": return this.inputNeedForStage(command.requestId);
      case "retry_attempt": {
        const receipt=command.receipt;
        [receipt.id,receipt.requestId,receipt.attemptId,receipt.resultId,receipt.owner,receipt.reason?.code,receipt.reason?.category].forEach(activityToken);
        validateActivityExecutor(command.executor);
        if(command.executor.generation!==this.generation())fail("execution_owner_stale");
        const old=this.value<NonNullable<ActivityStageState["retry"]>>("activity_attempt_retries",receipt.id);
        if(old){this.same(old,receipt);return this.requireStage(receipt.requestId);}
        const stage=this.requireStage(receipt.requestId),path=this.requirePath(stage.request.pathId),rule=path.intent.purpose.contract.attemptRetry;
        this.control(path,command.expectedControlRevision);
        if(!rule||!rule.stageKinds.includes(stage.request.stageKind)||receipt.owner!==path.intent.purpose.contract.executionOwner||
          modelInputValueDigest(receipt.policy)!==modelInputValueDigest(rule.ref))fail("attempt_retry_policy_invalid");
        if(stage.status!=="raw_result"||stage.processing||stage.receipt||!stage.attempt||!stage.result||
          stage.result.completeness!=="complete"||stage.result.outcome==="unknown"||stage.attempt.id!==receipt.attemptId||stage.result.id!==receipt.resultId||
          activityStageEvidence(stage)!==receipt.expectedStageEvidence)fail("attempt_retry_conflict");
        if(stage.authorizationRestrictions?.interpretation||stage.dispatchRestriction)fail("authorization_restricted");
        if((stage.attemptCount??0)>=rule.maximumAttempts||path.resourceUse.dispatchedAttempts>=path.intent.maximumAttempts)fail("attempt_limit");
        if(!Number.isFinite(Date.parse(receipt.decidedAt))||!Number.isFinite(Date.parse(receipt.notBefore))||
          Date.parse(receipt.notBefore)<Date.parse(receipt.decidedAt)||Date.parse(receipt.notBefore)>=Date.parse(path.intent.deadlineAt))fail("attempt_retry_time_invalid");
        this.sql("INSERT INTO activity_attempt_retries VALUES (?,?,?,?,?)").run(receipt.id,receipt.requestId,receipt.attemptId,JSON.stringify(receipt),modelInputValueDigest(receipt));
        this.sql("UPDATE activity_stages SET status='admitted',attempt_id=NULL,result_id=NULL,processing=NULL WHERE id=?").run(stage.request.id);
        this.closeHandoff(stage.request.id,"interpretation");this.handoff(path,stage.request.id,"execution",true);
        this.fact(path.intent,stage.request.id,"attempt_retry_accepted",{receipt});
        return this.stage(stage.request.id);
      }
      case "claim_processing": {
        const claim = command.claim;
        activityToken(claim.id); validateActivityExecutor(claim.executor);
        if(claim.executor.generation!==this.generation())fail("processing_owner_stale");
        const stage = this.requireStage(claim.requestId), path = this.requirePath(stage.request.pathId);
        if (stage.processing?.id === claim.id) {this.same(stage.processing, claim); return stage;}
        this.control(path, command.expectedControlRevision);
        if (stage.status !== "raw_result" || (stage.processing?.id ?? null) !== claim.previousClaimId) fail("processing_claim_conflict");
        if(stage.authorizationRestrictions?.interpretation)fail("authorization_restricted");
        if (stage.processing && claim.executor.generation <= stage.processing.executor.generation) fail("processing_owner_stale");
        this.sql("UPDATE activity_stages SET processing=? WHERE id=?").run(JSON.stringify(claim), claim.requestId);
        this.fact(path.intent,stage.request.id,"processing_claimed",{claim});
        return this.stage(claim.requestId);
      }
      case "accept": {
        const receipt = command.receipt;
        activityToken(receipt.id); activityToken(receipt.owner); validateActivityExecutor(command.executor);
        if(command.executor.generation!==this.generation())fail("processing_owner_stale");
        activityCount(receipt.expectedProgressRevision, true);
        if(receipt.interpretationMs!==undefined&&(!Number.isFinite(receipt.interpretationMs)||receipt.interpretationMs<0))fail("interpretation_timing_invalid");
        const old = this.value<ActivityProcessingReceipt>("activity_processing_receipts", receipt.id, true);
        if (old) {this.same(old, receipt); return this.requireStage(receipt.requestId);}
        const stage = this.requireStage(receipt.requestId), path = this.requirePath(stage.request.pathId);
        this.control(path, command.expectedControlRevision);
        if (stage.status !== "raw_result" || stage.result?.id !== receipt.resultId || receipt.owner !== path.intent.owner ||
            path.progressRevision !== receipt.expectedProgressRevision || !isDeepStrictEqual(stage.processing?.executor, command.executor)) fail("acceptance_conflict");
        if(stage.authorizationRestrictions?.interpretation)fail("authorization_restricted");
        if (receipt.next.length && !path.intent.purpose.contract.continuationKinds.includes("stage_request")) fail("continuation_not_delegated");
        if (receipt.next.length > path.intent.maximumStages) fail("stage_limit");
        this.sql("INSERT INTO activity_processing_receipts VALUES (?,?,?,?)").run(receipt.id, receipt.requestId, prepared(receipt), this.digest(receipt));
        this.sql("UPDATE activity_stages SET status='accepted',receipt_id=? WHERE id=?").run(receipt.id, receipt.requestId);
        this.sql("UPDATE activity_paths SET progress_revision=progress_revision+1,progress=? WHERE id=?").run(prepared(receipt.progress), path.intent.id);
        this.closeHandoff(receipt.requestId, "interpretation");
        this.fact(path.intent,stage.request.id,"accepted",{receiptId:receipt.id,resultId:receipt.resultId,progressRevision:path.progressRevision+1,next:receipt.next.map(value=>value.id)});
        this.reconsideration.publish({id:`${receipt.id}:progress`,sourceId:activityFactSourceId("progress",path.intent.id),
          ref:{owner:path.intent.owner,kind:"accepted_progress",id:path.intent.id,revision:String(path.progressRevision+1)}});
        for (const next of receipt.next) {
          if (next.pathId !== path.intent.id) fail("continuation_scope_invalid");
          this.submit(next, prepared(next));
        }
        return this.stage(receipt.requestId);
      }
      case "settle": {
        const receipt=command.receipt;
        [receipt.id,receipt.requestId,receipt.resultId,receipt.owner].forEach(activityToken);
        validateActivityExecutor(command.executor);
        if(command.executor.generation!==this.generation())fail("processing_owner_stale");
        if(receipt.disposition===undefined)fail("settlement_disposition_missing");
        const old=this.value<ActivitySettlementReceipt>("activity_settlement_receipts",receipt.id,true);
        if(old){this.same(old,receipt);return this.requireStage(receipt.requestId);}
        const stage=this.requireStage(receipt.requestId),path=this.requirePath(stage.request.pathId);
        if(!path.cancelled||path.controlRevision!==command.expectedControlRevision||stage.status!=="raw_result"||
          stage.result?.id!==receipt.resultId||receipt.owner!==path.intent.purpose.contract.recoveryOwner)fail("settlement_conflict");
        if(stage.authorizationRestrictions?.settlement)fail("authorization_restricted");
        this.sql("INSERT INTO activity_settlement_receipts VALUES (?,?,?,?)").run(receipt.id,receipt.requestId,prepared(receipt),this.digest(receipt));
        this.sql("UPDATE activity_stages SET status='settled' WHERE id=?").run(stage.request.id);
        this.closeHandoff(stage.request.id,"settlement");
        this.fact(path.intent,stage.request.id,"settled",{receiptId:receipt.id,resultId:receipt.resultId,controlRevision:path.controlRevision});
        this.reconsideration.publish({id:`${receipt.id}:settled`,sourceId:activityFactSourceId("progress",path.intent.id),
          ref:{owner:path.intent.owner,kind:"result_settled",id:stage.request.id,revision:receipt.id},
          origin:{stageId:stage.request.id,acceptanceId:receipt.id}});
        return this.stage(stage.request.id);
      }
      case "cancel": {
        const path = this.requirePath(command.pathId);
        if (path.cancelled) return path;
        if (path.controlRevision !== command.expectedControlRevision) fail("control_conflict");
        this.sql("UPDATE activity_paths SET cancelled=1,control_revision=control_revision+1 WHERE id=?").run(command.pathId);
        this.sql("UPDATE activity_handoffs SET pending=0 WHERE path_id=? AND kind<>'reconciliation'").run(command.pathId);
        for(const row of this.sql("SELECT id FROM activity_stages WHERE path_id=? AND status='raw_result'").all(command.pathId) as {id:string}[])this.handoff(path,row.id,"settlement");
        this.fact(path.intent,null,"cancelled",{controlRevision:path.controlRevision+1});
        this.reconsideration.publish({id:`${path.intent.id}:cancelled:${path.controlRevision+1}`,sourceId:activityFactSourceId("control",path.intent.id),
          ref:{owner:"activity-control",kind:"cancelled",id:path.intent.id,revision:String(path.controlRevision+1)}});
        return this.path(command.pathId);
      }
      case "pending_scopes": {
        activityCount(command.limit);
        if(command.afterRunId!==null)activityToken(command.afterRunId);
        if(command.limit>256)fail("page_limit");
        return (this.sql(`SELECT run_id FROM (
          SELECT run_id FROM activity_handoffs WHERE pending=1
          UNION SELECT r.run_id FROM activity_reconsiderations r WHERE ${PENDING_RECONSIDERATION_FACTS_SQL}
          ) WHERE (? IS NULL OR run_id>?) ORDER BY run_id LIMIT ?`)
          .all(command.afterRunId,command.afterRunId,command.limit) as {run_id:string}[]).map(row=>({runId:row.run_id}));
      }
      case "pending": {
        activityToken(command.runId); activityCount(command.after, true); activityCount(command.limit);
        if(command.pathId!==undefined)activityToken(command.pathId);
        if (command.limit > 256) fail("page_limit");
        return (this.sql("SELECT sequence,run_id,path_id,request_id,kind FROM activity_handoffs WHERE run_id=? AND pending=1 AND sequence>? AND (? IS NULL OR path_id=?) ORDER BY sequence LIMIT ?")
          .all(command.runId, command.after, command.pathId??null,command.pathId??null,command.limit) as {sequence:number;run_id:string;path_id:string;request_id:string;kind:ActivityHandoffItem["kind"]}[])
          .map(row => ({sequence:row.sequence, runId:row.run_id, pathId:row.path_id, requestId:row.request_id, kind:row.kind}));
      }
      case "facts": return this.facts(command.runId,command.after,command.limit,command.pathId);
    }
  }

  private submit(request: ActivityStageRequest, root: string): void {
    const path = this.requirePath(request.pathId);
    validateActivityStage(request, path.intent);
    const old = this.stage(request.id);
    if (old) {this.same(old.request, request); return;}
    if (path.cancelled) fail("cancelled");
    this.scheduling.validatePath(path.intent);
    const need=this.inputNeedForStage(request.id);
    if(need) {
      const {input:_,...entry}=request,original=request.id===need.stage.id?need.stage:need.unavailableStage;
      this.same(entry,original);
      if(this.sql("SELECT 1 FROM activity_stages WHERE id=?").get(request.id===need.stage.id?need.unavailableStage.id:need.stage.id))fail("input_need_already_answered");
    }
    const count = this.sql("SELECT COUNT(*) AS count FROM activity_stages WHERE path_id=?").get(path.intent.id) as {count:number};
    if (count.count >= path.intent.maximumStages) fail("stage_limit");
    // Only existing producers may be referenced: incremental extension cannot create a cycle.
    for (const dependency of request.dependencies) {
      const producer=this.requireStage(dependency.requestId);
      if(this.requirePath(producer.request.pathId).intent.runId!==path.intent.runId)fail("dependency_scope_invalid");
    }
    const schedulingMetadata={capabilities:request.capabilities,dependencies:request.dependencies};
    this.sql("INSERT INTO activity_stages VALUES (?,?,?,?,'submitted',NULL,NULL,NULL,NULL,?,?,NULL,NULL,0)")
      .run(request.id,request.pathId,root,this.digest(request),JSON.stringify(schedulingMetadata),modelInputValueDigest(schedulingMetadata));
    this.handoff(path, request.id, "admission");
    const input = request.input && typeof request.input === "object" ? request.input as Record<string,unknown> : null;
    this.fact(path.intent,request.id,"stage_submitted",{stageKind:request.stageKind,inputDigest:this.digest(request.input),
      inputNeedId:need?.id??null,inputOutcome:need?(need.stage.id===request.id?"supplied":"unavailable"):null,
      modelRequestId:typeof input?.requestId === "string" ? input.requestId : null,dependencies:request.dependencies,capabilities:request.capabilities});
    if(need)this.reconsideration.publish({id:`${need.id}:returned`,sourceId:activityFactSourceId("progress",path.intent.id),
      ref:{owner:path.intent.owner,kind:"input_returned",id:request.id,revision:this.digest(request)}});
  }
  private control(path: ActivityPathState, revision: number): void {
    if (path.cancelled) fail("cancelled");
    if (path.controlRevision !== revision) fail("control_conflict");
  }
  private resourceUse(intent:ActivityPathIntent):{admitted:number;attempts:number} {
    return this.sql("SELECT COALESCE(SUM(admitted),0) AS admitted,COALESCE(SUM(attempts),0) AS attempts FROM activity_paths WHERE run_id=? AND json_extract(intent,'$.resourceScope')=?")
      .get(intent.runId,intent.resourceScope) as {admitted:number;attempts:number};
  }
  private inputNeed(id:string):ActivityInputNeed|null {return this.value<ActivityInputNeed>("activity_input_needs",id);}
  private inputNeedForStage(requestId:string):ActivityInputNeed|null {
    const row=this.sql("SELECT id FROM activity_input_needs WHERE request_id=? OR unavailable_request_id=?").get(requestId,requestId) as {id:string}|undefined;
    return row?this.inputNeed(row.id):null;
  }
  private path(id: string): ActivityPathState | null {
    const row = this.sql("SELECT * FROM activity_paths WHERE id=?").get(id) as PathRow | undefined;
    if (!row) return null;
    const intent = JSON.parse(row.intent) as ActivityPathIntent;
    validateActivityPath(intent);
    if (row.digest !== modelInputValueDigest(intent) || intent.id !== row.id || intent.runId !== row.run_id) fail("corrupt");
    const resources=this.resourceUse(intent);
    return {intent, controlRevision: row.control_revision, cancelled: row.cancelled === 1, progressRevision: row.progress_revision,
      progress: row.progress ? this.body(row.progress) : null, admittedStages: row.admitted, dispatchedAttempts: row.attempts,
      resourceUse:{admittedStages:resources.admitted,dispatchedAttempts:resources.attempts}};
  }
  private stage(id: string): ActivityStageState | null {
    const row = this.sql("SELECT * FROM activity_stages WHERE id=?").get(id) as StageRow | undefined;
    if (!row) return null;
    const request = this.body(row.request) as ActivityStageRequest;
    if(!Number.isSafeInteger(row.raw_evidence_revision)||row.raw_evidence_revision<0)fail("corrupt");
    if (row.digest !== this.contentDigest(row.request,request) || request.id !== row.id || request.pathId !== row.path_id) fail("corrupt");
    return {request, status:row.status, attempt:row.attempt_id ? this.requireAttempt(row.attempt_id) : null,
      result:row.result_id ? this.value<ActivityRawResult>("activity_raw_results", row.result_id, true) : null,
      receipt:row.receipt_id ? this.value<ActivityProcessingReceipt>("activity_processing_receipts", row.receipt_id, true) : null,
      processing: row.processing ? JSON.parse(row.processing) as ActivityProcessingClaim : null,
      settlement:this.settlement(id),
      stop:this.stop(id),authorizationRestrictions:this.authorizationRestrictions(row.authorization_restrictions),rawEvidenceRevision:row.raw_evidence_revision,
      dispatchRestriction:this.dispatchRestriction(row.dispatch_restriction),
      attemptCount:(this.sql("SELECT COUNT(*) AS count FROM activity_attempts WHERE request_id=?").get(id) as {count:number}).count,
      retry:this.retry(id)};
  }
  private retry(requestId:string):ActivityStageState["retry"] {
    const row=this.sql("SELECT id FROM activity_attempt_retries WHERE request_id=? ORDER BY rowid DESC LIMIT 1").get(requestId) as {id:string}|undefined;
    return row?this.value("activity_attempt_retries",row.id):null;
  }
  private settlement(requestId:string):ActivitySettlementReceipt|null {
    const row=this.sql("SELECT id FROM activity_settlement_receipts WHERE request_id=?").get(requestId) as {id:string}|undefined;
    return row?this.value<ActivitySettlementReceipt>("activity_settlement_receipts",row.id,true):null;
  }
  private stop(requestId:string):import("@agent-anything/agent-runtime/activity").ActivityProfessionalStopReceipt|null {
    const row=this.sql("SELECT id FROM activity_stop_receipts WHERE request_id=?").get(requestId) as {id:string}|undefined;
    return row?this.value("activity_stop_receipts",row.id,true):null;
  }
  private authorizationRestrictions(raw:string|null):import("@agent-anything/agent-runtime/activity").ActivityAuthorizationRestrictions {
    if(!raw)return {};
    const parsed=JSON.parse(raw) as {value:import("@agent-anything/agent-runtime/activity").ActivityAuthorizationRestrictions;digest:string};
    if(modelInputValueDigest(parsed.value)!==parsed.digest)fail("corrupt");
    for(const [action,refusal] of Object.entries(parsed.value)) {
      if(!["admission","execution","reconciliation","interpretation","settlement"].includes(action))fail("corrupt");
      validateActivityAuthorizationRefusal(refusal);
    }
    return parsed.value;
  }
  private dispatchRestriction(raw:string|null):ActivityStageState["dispatchRestriction"] {
    if(!raw)return null;
    const parsed=JSON.parse(raw) as {value:NonNullable<ActivityStageState["dispatchRestriction"]>;digest:string};
    if(modelInputValueDigest(parsed.value)!==parsed.digest)fail("corrupt");return parsed.value;
  }
  private lastFactSequence():number{return (this.sql("SELECT COALESCE(MAX(sequence),0) AS n FROM activity_facts").get() as {n:number}).n;}
  private requirePath(id: string): ActivityPathState {const value = this.path(id); if (!value) fail("path_missing"); return value;}
  private requireStage(id: string): ActivityStageState {const value = this.stage(id); if (!value) fail("stage_missing"); return value;}
  private requireAttempt(id: string): ActivityAttempt {const value = this.value<ActivityAttempt>("activity_attempts", id); if (!value) fail("attempt_missing"); return value;}
  private value<T>(table: "activity_attempts" | "activity_attempt_retries" | "activity_raw_results" | "activity_processing_receipts" | "activity_settlement_receipts" | "activity_stop_receipts" | "activity_input_needs", id: string, packed = false): T | null {
    const row = this.sql(`SELECT value,digest FROM ${table} WHERE id=?`).get(id) as ValueRow | undefined;
    if (!row) return null;
    const value = packed ? this.body(row.value) : JSON.parse(row.value);
    if ((packed?this.contentDigest(row.value,value):this.digest(value)) !== row.digest) fail("corrupt");
    return value as T;
  }
  private handoff(path: ActivityPathState, requestId: string, kind: ActivityHandoffItem["kind"],reopen=false): void {
    if(reopen) {
      const changed=this.sql("UPDATE activity_handoffs SET pending=1 WHERE request_id=? AND kind=?").run(requestId,kind).changes;
      if(changed)return;
    }
    this.sql("INSERT INTO activity_handoffs(run_id,path_id,request_id,kind,pending) VALUES (?,?,?,?,1)").run(path.intent.runId, path.intent.id, requestId, kind);
  }
  private closeHandoff(requestId: string, kind: ActivityHandoffItem["kind"]): void {this.sql("UPDATE activity_handoffs SET pending=0 WHERE request_id=? AND kind=?").run(requestId,kind);}
  private sql(sql: string): Database.Statement {let statement = this.statements.get(sql); if (!statement) {statement = this.db.prepare(sql); this.statements.set(sql, statement);} return statement;}
  retainedRuns(): readonly string[] {
    return [...new Set([...(this.sql("SELECT DISTINCT run_id FROM activity_handoffs WHERE pending=1").all() as {run_id:string}[]).map(row=>row.run_id),...this.reconsideration.retainedRuns()])];
  }
  confirmInputResult(runId:string,pathId:string,inputDigest:string,resultId:string):boolean {
    const path=this.sql("SELECT run_id FROM activity_paths WHERE id=?").get(pathId) as {run_id:string}|undefined;
    if(!path || path.run_id!==runId)return false;
    // Input receipt proves an actual response, not permission for professional advancement.
    const row=this.sql("SELECT a.value,a.digest FROM activity_stages s JOIN activity_attempts a ON a.id=s.attempt_id WHERE s.path_id=? AND s.result_id=? AND s.status IN ('raw_result','accepted','settled')")
      .get(pathId,resultId) as ValueRow|undefined;
    if(!row)return false;
    const attempt=JSON.parse(row.value) as ActivityAttempt;
    if(modelInputValueDigest(attempt)!==row.digest)fail("corrupt");
    return attempt.inputDigest===inputDigest;
  }
  confirmInputAttempt(runId:string,pathId:string,requestId:string,inputDigest:string,attemptId:string):boolean {
    const row=this.sql("SELECT a.value,a.digest FROM activity_attempts a JOIN activity_stages s ON s.id=a.request_id JOIN activity_paths p ON p.id=s.path_id WHERE a.id=? AND s.id=? AND p.id=? AND p.run_id=?")
      .get(attemptId,requestId,pathId,runId) as ValueRow|undefined;
    if(!row)return false;
    const attempt=JSON.parse(row.value) as ActivityAttempt;
    if(modelInputValueDigest(attempt)!==row.digest)fail("corrupt");
    return attempt.inputDigest===inputDigest;
  }
  pathSettled(pathId:string):boolean {
    return Boolean(this.sql("SELECT 1 FROM activity_paths WHERE id=?").get(pathId)) &&
      !this.hasPending(pathId);
  }
  reconsiderationClosure(id:string):import("@agent-anything/agent-runtime/activity").ActivityReconsiderationReceipt|null {
    return this.reconsideration.closure(id);
  }
  private hasPending(pathId:string):boolean {
    return Boolean(this.sql("SELECT 1 FROM activity_stages s JOIN activity_handoffs h ON h.request_id=s.id WHERE s.path_id=? AND h.pending=1 LIMIT 1").get(pathId));
  }
  confirmProfessionalResult(runId:string,owner:string,pathId:string,resultId:string,receiptId:string):boolean {
    const row=this.sql("SELECT p.intent,p.digest FROM activity_stages s JOIN activity_paths p ON p.id=s.path_id JOIN activity_processing_receipts r ON r.id=s.receipt_id AND r.request_id=s.id WHERE p.id=? AND p.run_id=? AND s.status='accepted' AND s.result_id=? AND s.receipt_id=?")
      .get(pathId,runId,resultId,receiptId) as {intent:string;digest:string}|undefined;
    if(!row)return false;
    const intent=JSON.parse(row.intent) as ActivityPathIntent;
    if(modelInputValueDigest(intent)!==row.digest || intent.id!==pathId || intent.runId!==runId)fail("corrupt");
    return intent.owner===owner;
  }
  takeObservations(): readonly ActivityHandoffFact[] {
    if (this.observationCursor === null) return [];
    const rows = this.factRows(null,this.observationCursor,256);
    if (rows.length) this.observationCursor = rows.at(-1)!.sequence;
    return rows;
  }
  private beginObservations(): void {
    this.observationCursor ??= (this.sql("SELECT COALESCE(MAX(sequence),0) AS n FROM activity_facts").get() as {n:number}).n;
  }
  private fact(intent:ActivityPathIntent,requestId:string|null,kind:ActivityHandoffFact["kind"],details:Readonly<Record<string,unknown>>): void {
    this.recordFact(intent.runId,intent.id,requestId,kind,details);
  }
  private recordFact(runId:string,pathId:string,requestId:string|null,kind:ActivityHandoffFact["kind"],details:Readonly<Record<string,unknown>>): void {
    const fact = {runId,pathId,requestId,kind,occurredAt:new Date().toISOString(),clock:captureActivityClock(),details};
    this.sql("INSERT INTO activity_facts(run_id,path_id,request_id,kind,occurred_at,value,digest) VALUES (?,?,?,?,?,?,?)")
      .run(fact.runId,fact.pathId,fact.requestId,fact.kind,fact.occurredAt,JSON.stringify(fact),modelInputValueDigest(fact));
  }
  private facts(runId:string,after:number,limit:number,pathId?:string): readonly ActivityHandoffFact[] {
    activityToken(runId); activityCount(after,true); activityCount(limit);
    if (limit > 256) fail("page_limit");
    if(pathId!==undefined) {
      activityToken(pathId);
      const row=this.sql("SELECT id,run_id,intent,digest FROM activity_paths WHERE id=?").get(pathId) as Pick<PathRow,"id"|"run_id"|"intent"|"digest">|undefined;
      if(!row)fail("path_missing");
      const intent=JSON.parse(row.intent) as ActivityPathIntent;validateActivityPath(intent);
      if(row.digest!==modelInputValueDigest(intent)||intent.id!==row.id||intent.runId!==row.run_id)fail("corrupt");
      if(intent.runId!==runId)fail("fact_path_scope_invalid");
    }
    return this.factRows(runId,after,limit,pathId);
  }
  private factRows(runId:string|null,after:number,limit:number,pathId?:string): readonly ActivityHandoffFact[] {
    const rows = pathId!==undefined ? this.sql("SELECT sequence,value,digest FROM activity_facts WHERE run_id=? AND path_id=? AND sequence>? ORDER BY sequence LIMIT ?").all(runId,pathId,after,limit) :
      runId === null ? this.sql("SELECT sequence,value,digest FROM activity_facts WHERE sequence>? ORDER BY sequence LIMIT ?").all(after,limit) :
      this.sql("SELECT sequence,value,digest FROM activity_facts WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT ?").all(runId,after,limit);
    return (rows as {sequence:number;value:string;digest:string}[]).map(row => {
      const value = JSON.parse(row.value) as Omit<ActivityHandoffFact,"sequence">;
      if (modelInputValueDigest(value) !== row.digest || runId !== null && value.runId !== runId || pathId!==undefined&&value.pathId!==pathId) fail("corrupt");
      return {...value,sequence:row.sequence};
    });
  }
}
function fail(code: string): never {throw Object.assign(new Error(`activity_${code}`), {code: `activity_${code}`});}
import {captureActivityClock} from "@agent-anything/agent-runtime/activity";
