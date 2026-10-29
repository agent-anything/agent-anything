import type Database from "better-sqlite3";
import {isDeepStrictEqual} from "node:util";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {activityCount, activityToken, activityFactSourceId, validateActivityExecutor, validateActivityPath, validateActivityStage,
  type ActivityHandoffCommand, type ActivityHandoffValue, type ActivityPathIntent, type ActivityPathState,
  type ActivityStageRequest, type ActivityStageState, type ActivityAttempt, type ActivityRawResult,
  type ActivityProcessingReceipt, type ActivityProcessingClaim, type ActivityHandoffItem, type ActivityHandoffFact} from "@agent-anything/agent-runtime/activity";
import type {ExecutionContentRoot} from "./ExecutionContent.js";
import {SharedAcceptanceRejection, type SharedAcceptanceParticipant} from "./SharedAcceptanceDatabase.js";
import {ActivitySchedulingDatabase,ACTIVITY_SCHEDULING_SCHEMA} from "./ActivitySchedulingDatabase.js";
import {ActivityReconsiderationDatabase,ACTIVITY_RECONSIDERATION_SCHEMA} from "./ActivityReconsiderationDatabase.js";
import {ActivityResourceDatabase,ACTIVITY_RESOURCE_SCHEMA} from "./ActivityResourceDatabase.js";

export const ACTIVITY_HANDOFF_SCHEMA = `
CREATE TABLE activity_paths(id TEXT PRIMARY KEY, run_id TEXT NOT NULL, intent TEXT NOT NULL, digest TEXT NOT NULL,
 control_revision INTEGER NOT NULL, cancelled INTEGER NOT NULL, progress_revision INTEGER NOT NULL, progress TEXT,
 admitted INTEGER NOT NULL, attempts INTEGER NOT NULL);
CREATE TABLE activity_stages(id TEXT PRIMARY KEY, path_id TEXT NOT NULL REFERENCES activity_paths(id),
 request TEXT NOT NULL, digest TEXT NOT NULL, status TEXT NOT NULL, attempt_id TEXT, result_id TEXT, receipt_id TEXT, processing TEXT,
 scheduling_metadata TEXT NOT NULL,scheduling_digest TEXT NOT NULL,dispatch_restriction TEXT);
CREATE INDEX activity_stages_path ON activity_stages(path_id,status);
CREATE TABLE activity_attempts(id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES activity_stages(id), value TEXT NOT NULL, digest TEXT NOT NULL);
CREATE TABLE activity_raw_results(id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES activity_attempts(id), value TEXT NOT NULL, digest TEXT NOT NULL);
CREATE INDEX activity_raw_attempt ON activity_raw_results(attempt_id);
CREATE TABLE activity_processing_receipts(id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE REFERENCES activity_stages(id), value TEXT NOT NULL, digest TEXT NOT NULL);
CREATE TABLE activity_handoffs(sequence INTEGER PRIMARY KEY, run_id TEXT NOT NULL, path_id TEXT NOT NULL,
 request_id TEXT NOT NULL REFERENCES activity_stages(id), kind TEXT NOT NULL, pending INTEGER NOT NULL,
 UNIQUE(request_id,kind));
CREATE INDEX activity_handoff_pending ON activity_handoffs(run_id,pending,sequence);
CREATE TABLE activity_facts(sequence INTEGER PRIMARY KEY,run_id TEXT NOT NULL,path_id TEXT NOT NULL,request_id TEXT,kind TEXT NOT NULL,occurred_at TEXT NOT NULL,value TEXT NOT NULL,digest TEXT NOT NULL);
CREATE INDEX activity_facts_run ON activity_facts(run_id,sequence);
${ACTIVITY_SCHEDULING_SCHEMA}
${ACTIVITY_RECONSIDERATION_SCHEMA}
${ACTIVITY_RESOURCE_SCHEMA}
`;
interface PathRow {id:string;run_id:string;intent:string;digest:string;control_revision:number;cancelled:number;
  progress_revision:number;progress:string|null;admitted:number;attempts:number;}
interface StageRow {id:string;path_id:string;request:string;digest:string;status:ActivityStageState["status"];
  attempt_id:string|null;result_id:string|null;receipt_id:string|null;processing:string|null;dispatch_restriction:string|null;}
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
  private readonly acceptanceContent=new WeakMap<object,{bodies:Map<string,unknown>;digests:Map<unknown,string>}>();
  private readonly scheduling:ActivitySchedulingDatabase;
  private readonly reconsideration:ActivityReconsiderationDatabase;
  private readonly resources:ActivityResourceDatabase;
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
    return {owner:"activity",kinds:["professional_acceptance","stage_submission","path_opening","fact_publication","reconsideration_acceptance","scheduling_acceptance","path_cancellation","scheduling_closure"],prepare:(part, proposal) => {
      if(part.kind==="path_cancellation") {
        const command=part.proposal as Extract<ActivityHandoffCommand,{kind:"cancel"}>;
        const path=this.requirePath(command.pathId);
        if(command.kind!=="cancel"||path.intent.runId!==proposal.scope||path.intent.owner!==proposal.actor)
          throw new SharedAcceptanceRejection("activity","activity_cancellation_scope_invalid");
        return {command,prepared:this.prepare(command)};
      }
      if(part.kind==="scheduling_closure") {
        const command=part.proposal as Extract<ActivityHandoffCommand,{kind:"close_scheduled_work"}>;
        const work=this.scheduling.read(command.workId);
        if(command.kind!=="close_scheduled_work"||!work||work.intent.runId!==proposal.scope||work.intent.owner!==proposal.actor)
          throw new SharedAcceptanceRejection("activity","activity_closure_scope_invalid");
        return {command,prepared:this.prepare(command)};
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
        return {command,prepared:this.prepare(command)};
      }
      if(part.kind==="reconsideration_acceptance") {
        const command={kind:"accept_reconsideration" as const,receipt:part.proposal as import("@agent-anything/agent-runtime/activity").ActivityReconsiderationReceipt};
        const state=this.reconsideration.state(command.receipt.subscriptionId);
        if(!state||state.subscription.runId!==proposal.scope||state.subscription.owner!==proposal.actor||command.receipt.id!==proposal.id)throw new SharedAcceptanceRejection("activity","activity_reconsideration_scope_invalid");
        return {command,prepared:this.prepare(command)};
      }
      if(part.kind==="scheduling_acceptance") {
        const command=part.proposal as Extract<ActivityHandoffCommand,{kind:"schedule_work"}>;
        if(command?.kind!=="schedule_work"||command.intent.runId!==proposal.scope||command.intent.owner!==proposal.actor)throw new SharedAcceptanceRejection("activity","activity_schedule_scope_invalid");
        return {command,prepared:this.prepare(command)};
      }
      if(part.kind==="stage_submission") {
        const command={kind:"submit" as const,request:part.proposal as ActivityStageRequest};
        const opening=proposal.parts.find(p=>p.owner==="activity"&&p.kind==="path_opening"&&(p.proposal as ActivityPathIntent)?.id===command.request.pathId)?.proposal as ActivityPathIntent|undefined;
        const intent=opening??this.requirePath(command.request.pathId).intent;
        if(!permitsPath(intent))throw new SharedAcceptanceRejection("activity","activity_submission_scope_invalid");
        return {command,prepared:this.sharePrepared(proposal,this.prepare(command))};
      }
      const command = part.proposal as Extract<ActivityHandoffCommand,{kind:"accept"}>;
      if (!command || command.kind !== "accept" || command.receipt.owner !== proposal.actor || command.receipt.id !== proposal.id) throw new SharedAcceptanceRejection("activity","activity_acceptance_identity_invalid");
      const stage = this.requireStage(command.receipt.requestId), path = this.requirePath(stage.request.pathId);
      if (path.intent.runId !== proposal.scope) throw new SharedAcceptanceRejection("activity","activity_acceptance_scope_invalid");
      return {command,prepared:this.sharePrepared(proposal,this.prepare(command))};
    },apply: value => {
      const {command,prepared} = value as {command:ActivityHandoffCommand;prepared:PreparedContent};
      try {this.withPrepared(prepared,()=>this.execute(command,prepared));} catch (error) {
        if (error instanceof Error && "code" in error && typeof error.code === "string" && error.code.startsWith("activity_") && error.code !== "activity_corrupt") throw new SharedAcceptanceRejection("activity",error.code);
        throw error;
      }
    }};
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
    const remember=(root:string,value:unknown)=>{bodies.set(root,value);digests.set(value,modelInputValueDigest(value));};
    const prepare = (value: unknown) => {const root = JSON.stringify(this.retain(value)); staged.set(value, root);remember(root,value); return root;};
    const warm=(root:string|null)=>{if(root===null)return null;if(!bodies.has(root))remember(root,this.hydrate(JSON.parse(root)));return bodies.get(root);};
    const visited=new Set<string>();
    const path=(id:string)=>{const row=this.sql("SELECT progress FROM activity_paths WHERE id=?").get(id) as {progress:string|null}|undefined;if(row)warm(row.progress);};
    const stage=(id:string)=>{
      if(visited.has(id))return;visited.add(id);
      const row=this.sql("SELECT * FROM activity_stages WHERE id=?").get(id) as StageRow|undefined;if(!row)return;
      const request=warm(row.request) as ActivityStageRequest;digests.set(request.input,modelInputValueDigest(request.input));path(row.path_id);
      for(const [table,key] of [["activity_raw_results",row.result_id],["activity_processing_receipts",row.receipt_id]] as const){
        if(key){const value=this.sql(`SELECT value FROM ${table} WHERE id=?`).get(key) as {value:string}|undefined;if(value)warm(value.value);}
      }
    };
    if("pathId" in command&&command.pathId!==undefined)path(command.pathId);
    if(command.kind==="reserve_resources")stage(command.reservation.requestId);
    if("requestId" in command)stage(command.requestId);
    if(command.kind==="open_path")path(command.intent.id);
    if(command.kind==="dispatch") {
      stage(command.attempt.requestId);
      const row=this.sql("SELECT request FROM activity_stages WHERE id=?").get(command.attempt.requestId) as {request:string}|undefined;
      if(row)for(const dependency of (warm(row.request) as ActivityStageRequest).dependencies)stage(dependency.requestId);
    }
    if(command.kind==="claim_processing")stage(command.claim.requestId);
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
  private digest(value:unknown):string{return this.currentPreparation?.digests.get(value)??modelInputValueDigest(value);}
  private same(left:unknown,right:unknown):void{if(this.digest(left)!==this.digest(right))fail("identity_conflict");}

  private execute(command: ActivityHandoffCommand, prepared: (value: unknown) => string): ActivityHandoffValue {
    switch (command.kind) {
      case "bind_resource_pool": return this.scheduling.bind(command.pool);
      case "schedule_work": return this.scheduling.accept(command.intent,command.expectedRevision);
      case "read_schedule": return this.scheduling.read(command.workId);
      case "review_scheduling": return this.scheduling.review();
      case "close_scheduled_work": return this.scheduling.close(command.workId,command.expectedRevision,command.basis);
      case "scheduling_candidates": return this.scheduling.candidates(command.limit);
      case "register_fact_source": return this.reconsideration.source(command.source);
      case "publish_fact": return this.reconsideration.publish(command.fact);
      case "subscribe_reconsideration": return this.reconsideration.subscribe(command.subscription);
      case "read_reconsideration": return this.reconsideration.snapshot(command.subscriptionId,command.limit);
      case "pending_reconsiderations": return this.reconsideration.pending(command.runId,command.afterId,command.limit);
      case "accept_reconsideration": return this.reconsideration.accept(command.receipt);
      case "open_path": {
        const old = this.path(command.intent.id);
        if (old) {this.same(old.intent, command.intent); return old;}
        const intent = command.intent;
        this.scheduling.validatePath(intent);
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
        if (this.resourceUse(path.intent).admitted >= path.intent.maximumStages) fail("stage_limit");
        this.sql("UPDATE activity_stages SET status='admitted' WHERE id=?").run(stage.request.id);
        this.sql("UPDATE activity_paths SET admitted=admitted+1 WHERE id=?").run(path.intent.id);
        this.closeHandoff(stage.request.id, "admission"); this.handoff(path, stage.request.id, "execution");
        this.fact(path.intent,stage.request.id,"stage_admitted",{controlRevision:path.controlRevision});
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
        if(stage.dispatchRestriction)fail("dispatch_restricted");
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
        this.handoff(path, stage.request.id, "reconciliation");
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
        this.fact(path.intent,stage.request.id,"raw_saved",{resultId:result.id,attemptId:result.attemptId,completeness:result.completeness,outcome:result.outcome,usage:result.usage});
        if (stage.attempt?.id === attempt.id && !stage.result && result.completeness === "complete" && result.outcome !== "unknown") {
          this.scheduling.release(attempt.id);
          this.sql("UPDATE activity_stages SET result_id=?,status='raw_result' WHERE id=?").run(result.id, stage.request.id);
          this.closeHandoff(stage.request.id, "reconciliation");
          if(!path.cancelled)this.handoff(path, stage.request.id, "interpretation");
        }
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
      case "cancel": {
        const path = this.requirePath(command.pathId);
        if (path.cancelled) return path;
        if (path.controlRevision !== command.expectedControlRevision) fail("control_conflict");
        this.sql("UPDATE activity_paths SET cancelled=1,control_revision=control_revision+1 WHERE id=?").run(command.pathId);
        this.sql("UPDATE activity_handoffs SET pending=0 WHERE path_id=? AND kind<>'reconciliation'").run(command.pathId);
        this.fact(path.intent,null,"cancelled",{controlRevision:path.controlRevision+1});
        this.reconsideration.publish({id:`${path.intent.id}:cancelled:${path.controlRevision+1}`,sourceId:activityFactSourceId("control",path.intent.id),
          ref:{owner:"activity-control",kind:"cancelled",id:path.intent.id,revision:String(path.controlRevision+1)}});
        return this.path(command.pathId);
      }
      case "pending": {
        activityToken(command.runId); activityCount(command.after, true); activityCount(command.limit);
        if(command.pathId!==undefined)activityToken(command.pathId);
        if (command.limit > 256) fail("page_limit");
        return (this.sql("SELECT sequence,run_id,path_id,request_id,kind FROM activity_handoffs WHERE run_id=? AND pending=1 AND sequence>? AND (? IS NULL OR path_id=?) ORDER BY sequence LIMIT ?")
          .all(command.runId, command.after, command.pathId??null,command.pathId??null,command.limit) as {sequence:number;run_id:string;path_id:string;request_id:string;kind:ActivityHandoffItem["kind"]}[])
          .map(row => ({sequence:row.sequence, runId:row.run_id, pathId:row.path_id, requestId:row.request_id, kind:row.kind}));
      }
      case "facts": return this.facts(command.runId,command.after,command.limit);
    }
  }

  private submit(request: ActivityStageRequest, root: string): void {
    const path = this.requirePath(request.pathId);
    validateActivityStage(request, path.intent);
    const old = this.stage(request.id);
    if (old) {this.same(old.request, request); return;}
    if (path.cancelled) fail("cancelled");
    const count = this.sql("SELECT COUNT(*) AS count FROM activity_stages WHERE path_id=?").get(path.intent.id) as {count:number};
    if (count.count >= path.intent.maximumStages) fail("stage_limit");
    // Only existing producers may be referenced: incremental extension cannot create a cycle.
    for (const dependency of request.dependencies) if (this.requireStage(dependency.requestId).request.pathId !== path.intent.id) fail("dependency_scope_invalid");
    const schedulingMetadata={capabilities:request.capabilities,dependencies:request.dependencies};
    this.sql("INSERT INTO activity_stages VALUES (?,?,?,?,'submitted',NULL,NULL,NULL,NULL,?,?,NULL)")
      .run(request.id,request.pathId,root,this.digest(request),JSON.stringify(schedulingMetadata),modelInputValueDigest(schedulingMetadata));
    this.handoff(path, request.id, "admission");
    const input = request.input && typeof request.input === "object" ? request.input as Record<string,unknown> : null;
    this.fact(path.intent,request.id,"stage_submitted",{stageKind:request.stageKind,inputDigest:this.digest(request.input),
      modelRequestId:typeof input?.requestId === "string" ? input.requestId : null,dependencies:request.dependencies,capabilities:request.capabilities});
  }
  private control(path: ActivityPathState, revision: number): void {
    if (path.cancelled) fail("cancelled");
    if (path.controlRevision !== revision) fail("control_conflict");
  }
  private resourceUse(intent:ActivityPathIntent):{admitted:number;attempts:number} {
    return this.sql("SELECT COALESCE(SUM(admitted),0) AS admitted,COALESCE(SUM(attempts),0) AS attempts FROM activity_paths WHERE run_id=? AND json_extract(intent,'$.resourceScope')=?")
      .get(intent.runId,intent.resourceScope) as {admitted:number;attempts:number};
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
    if (row.digest !== this.digest(request) || request.id !== row.id || request.pathId !== row.path_id) fail("corrupt");
    return {request, status:row.status, attempt:row.attempt_id ? this.requireAttempt(row.attempt_id) : null,
      result:row.result_id ? this.value<ActivityRawResult>("activity_raw_results", row.result_id, true) : null,
      receipt:row.receipt_id ? this.value<ActivityProcessingReceipt>("activity_processing_receipts", row.receipt_id, true) : null,
      processing: row.processing ? JSON.parse(row.processing) as ActivityProcessingClaim : null,
      dispatchRestriction:this.dispatchRestriction(row.dispatch_restriction)};
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
  private value<T>(table: "activity_attempts" | "activity_raw_results" | "activity_processing_receipts", id: string, packed = false): T | null {
    const row = this.sql(`SELECT value,digest FROM ${table} WHERE id=?`).get(id) as ValueRow | undefined;
    if (!row) return null;
    const value = packed ? this.body(row.value) : JSON.parse(row.value);
    if (this.digest(value) !== row.digest) fail("corrupt");
    return value as T;
  }
  private handoff(path: ActivityPathState, requestId: string, kind: ActivityHandoffItem["kind"]): void {
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
    const row=this.sql("SELECT a.value,a.digest FROM activity_stages s JOIN activity_attempts a ON a.id=s.attempt_id WHERE s.path_id=? AND s.result_id=? AND s.status IN ('raw_result','accepted')")
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
      !this.sql("SELECT 1 FROM activity_handoffs WHERE path_id=? AND pending=1 LIMIT 1").get(pathId);
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
    const fact = {runId,pathId,requestId,kind,occurredAt:new Date().toISOString(),details};
    this.sql("INSERT INTO activity_facts(run_id,path_id,request_id,kind,occurred_at,value,digest) VALUES (?,?,?,?,?,?,?)")
      .run(fact.runId,fact.pathId,fact.requestId,fact.kind,fact.occurredAt,JSON.stringify(fact),modelInputValueDigest(fact));
  }
  private facts(runId:string,after:number,limit:number): readonly ActivityHandoffFact[] {
    activityToken(runId); activityCount(after,true); activityCount(limit);
    if (limit > 256) fail("page_limit");
    return this.factRows(runId,after,limit);
  }
  private factRows(runId:string|null,after:number,limit:number): readonly ActivityHandoffFact[] {
    const rows = runId === null ? this.sql("SELECT sequence,value,digest FROM activity_facts WHERE sequence>? ORDER BY sequence LIMIT ?").all(after,limit) :
      this.sql("SELECT sequence,value,digest FROM activity_facts WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT ?").all(runId,after,limit);
    return (rows as {sequence:number;value:string;digest:string}[]).map(row => {
      const value = JSON.parse(row.value) as Omit<ActivityHandoffFact,"sequence">;
      if (modelInputValueDigest(value) !== row.digest || runId !== null && value.runId !== runId) fail("corrupt");
      return {...value,sequence:row.sequence};
    });
  }
}
function fail(code: string): never {throw Object.assign(new Error(`activity_${code}`), {code: `activity_${code}`});}
