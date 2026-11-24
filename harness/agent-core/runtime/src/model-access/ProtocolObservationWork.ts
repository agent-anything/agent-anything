import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import type {ProtocolRevisionRef} from "@agent-anything/model-interaction/protocol";
import {activityFactSourceId,ActivityPurposeRegistry,type ActivityPurposeBinding,type ActivityPurposeContract,type ActivityPurposeHandler,
  type ActivityPathIntent,type ActivityPathState,type ActivityStageState,type ActivityAttempt,type ActivityRawResult,type ActivityHandoffPort,
  type ActivitySchedulingIntent,type ActivitySchedulingAcceptance,type ActivityScheduledSettlement,type ActivityReconsiderationHandler,
  type SharedAcceptancePart,type SharedAcceptancePort} from "../activity/index.js";
import type {ProtocolExecutionJournal,ProtocolExecutionState,ProtocolJournalRecord,ProtocolContentRef} from "./ProtocolExecutionJournal.js";
import type {ProtocolEvidenceRevision} from "./ProtocolEvidenceIndex.js";

export const PROTOCOL_OBSERVATION_PURPOSE:ActivityPurposeContract={ref:{id:"model-access.protocol-observation",revision:"1"},
  inputOwner:"model-access",executionOwner:"model-access",interpretationOwner:"model-access",acceptanceOwner:"model-access",recoveryOwner:"model-access",
  stageKinds:["observe"],capabilities:["model-request"],continuationKinds:[]};

export interface ProtocolObservationSource {
  readonly kind:"protocol_observation_source";
  readonly activityId:string;
  readonly compositionDigest:string;
  readonly input:ProtocolContentRef;
}
interface ObservedResult {
  readonly kind:"protocol_observation_result";
  readonly activityId:string;
  readonly observation:ProtocolRevisionRef|null;
}
export interface ProtocolObservationLimitation {
  readonly kind:"protocol_observation_unavailable";
  readonly activityId:string;
  readonly reason:string;
  readonly basis:Pick<ProtocolEvidenceRevision,"scopeId"|"kind"|"key"|"revision"> & {readonly digest:string};
}
type ObservationResult=ObservedResult|ProtocolObservationLimitation;

/** An original owner has retained its disposition; this is not a lost checkpoint or a model response. */
export class ProtocolObservationUnavailable extends Error {
  constructor(readonly limitation:ProtocolObservationLimitation){
    super(`Original protocol observation unavailable: ${limitation.reason}`);
    this.name="ProtocolObservationUnavailable";
  }
}

/** Read-only projection of this owner's handoff; not evidence that task purpose was accepted. */
export function protocolObservationStage(path:ActivityPathState,stage:ActivityStageState){
  if(path.intent.purpose.digest!==digest(PROTOCOL_OBSERVATION_PURPOSE))return null;
  const source=stage.request.input as ProtocolObservationSource;
  if(stage.request.pathId!==path.intent.id||stage.request.stageKind!=="observe"||source?.kind!=="protocol_observation_source")
    throw new TypeError("protocol_observation_source_invalid");
  const result=stage.result?.value as ObservationResult|undefined;
  if(result&&(result.activityId!==source.activityId||!(result.kind==="protocol_observation_unavailable"&&result.basis||
    result.kind==="protocol_observation_result"&&result.observation!==undefined)))
    throw new TypeError("protocol_observation_result_scope_invalid");
  return {activityId:source.activityId,compositionDigest:source.compositionDigest,input:source.input,
    observation:result?.kind==="protocol_observation_result"?result.observation:null,
    limitation:result?.kind==="protocol_observation_unavailable"?result:null,scheduledWorkId:path.intent.scheduledWorkId??null};
}
interface Ports {
  readonly journal:ProtocolExecutionJournal;
  readonly activities:ActivityHandoffPort;
  readonly acceptance:SharedAcceptancePort;
  readonly generation:number;
  readonly authorize:ActivityPurposeHandler["authorize"];
  /** The original protocol owner decides reconciliation; a shared Attempt never means repeat POST. */
  readonly observe:(state:ProtocolExecutionState,mode:"execute"|"recover",signal:AbortSignal)=>Promise<ProtocolJournalRecord|null>;
  readonly now:()=>string;
}

/** Shared work custody for native observation, not a common model-response interpreter. */
export class ProtocolObservationWork {
  readonly purpose:ActivityPurposeBinding;
  readonly lifecycle:ActivityReconsiderationHandler;
  constructor(private readonly ports:Ports,registry:ActivityPurposeRegistry<ActivityPurposeHandler>){
    this.purpose=registry.register(PROTOCOL_OBSERVATION_PURPOSE,new ProtocolObservationHandler(ports));
    this.lifecycle={prepare:async(snapshot,signal)=>{
      const sub=snapshot.state.subscription,id=sub.binding?.id;
      if(sub.binding?.kind!=="activity_path"||sub.id!==`${id}:observation-lifecycle`||sub.owner!==PROTOCOL_OBSERVATION_PURPOSE.acceptanceOwner)
        throw new TypeError("protocol_observation_subscription_invalid");
      const path=await ports.activities.command({kind:"read_path",pathId:id!}) as ActivityPathState|null;
      if(!path||path.intent.runId!==sub.runId||path.intent.purpose.digest!==this.purpose.digest||!path.intent.scheduledWorkId)
        throw new TypeError("protocol_observation_original_path_missing");
      const work=await ports.activities.command({kind:"read_schedule",workId:path.intent.scheduledWorkId}) as ActivitySchedulingAcceptance|null;
      if(!work||!work.pathsSealed||work.intent.owner!==sub.owner||work.intent.runId!==sub.runId||work.intent.delegatedPathOwners?.length||
        digest(work.intent.allowedPathIds)!==digest([id]))throw new TypeError("protocol_observation_schedule_changed");
      const stage=await ports.activities.command({kind:"read_stage",requestId:`${id}:observe`}) as ActivityStageState|null;
      if(!stage||stage.request.pathId!==id||stage.request.stageKind!=="observe")throw new TypeError("protocol_observation_stage_missing");
      const settled=await ports.activities.command({kind:"scheduled_settlement",workId:work.intent.workId}) as ActivityScheduledSettlement;
      const terminal=path.cancelled||["accepted","settled","stopped"].includes(stage.status),closed=terminal&&settled.remaining===null;
      const decision={owner:sub.owner,kind:closed?"protocol_observation_closed":"protocol_observation_waiting",id:id!,
        revision:digest({control:path.controlRevision,progress:path.progressRevision,schedule:work.revision,closed})};
      const participants:SharedAcceptancePart[]=[{owner:"activity",kind:"path_condition",proposal:{pathId:id,
        expected:{controlRevision:path.controlRevision,progressRevision:path.progressRevision,cancelled:path.cancelled},requireSettled:closed}}];
      if(closed)participants.push({owner:"activity",kind:"scheduling_closure",proposal:{kind:"close_scheduled_work",workId:work.intent.workId,
        expectedRevision:settled.revision,basis:`${id}:observation-lifecycle`,requireSettled:true}},
        {owner:"activity",kind:"fact_publication",proposal:{id:`${id}:closed:${decision.revision}`,sourceId:activityFactSourceId("progress",id!),ref:decision}});
      signal.throwIfAborted();return {decision,participants,observeSources:[activityFactSourceId("control",id!),activityFactSourceId("progress",id!),
        activityFactSourceId("scheduling",work.intent.workId)],close:closed};
    }};
  }
  prepareSubmission(identity:Omit<ActivityPathIntent,"owner"|"purpose">,state:ProtocolExecutionState,schedule:ActivitySchedulingIntent):readonly SharedAcceptancePart[]{
    if(identity.runId!==state.activity.scope.runId||schedule.runId!==identity.runId||schedule.owner!==PROTOCOL_OBSERVATION_PURPOSE.acceptanceOwner||
      identity.scheduledWorkId!==schedule.workId||schedule.delegatedPathOwners?.length||schedule.allowedPathIds&&digest(schedule.allowedPathIds)!==digest([identity.id]))
      throw new TypeError("protocol_observation_arrangement_changed");
    const source:ProtocolObservationSource={kind:"protocol_observation_source",activityId:state.activity.scope.activityId,
      compositionDigest:state.activity.composition.digest,input:state.input};
    return [{owner:"activity",kind:"scheduling_acceptance",proposal:{kind:"schedule_work",intent:{...schedule,allowedPathIds:[identity.id]},expectedRevision:0}},
      {owner:"activity",kind:"path_opening",proposal:{...identity,owner:this.purpose.contract.acceptanceOwner,purpose:this.purpose}},
      {owner:"activity",kind:"stage_submission",proposal:{id:`${identity.id}:observe`,pathId:identity.id,stageKind:"observe",input:source,capabilities:["model-request"],dependencies:[]}},
      {owner:"activity",kind:"scheduling_path_seal",proposal:{kind:"seal_scheduled_paths",workId:schedule.workId,expectedRevision:1,basis:`${identity.id}:submission`}},
      {owner:"activity",kind:"reconsideration_subscription",proposal:{id:`${identity.id}:observation-lifecycle`,runId:identity.runId,owner:this.purpose.contract.acceptanceOwner,
        binding:{kind:"activity_path",id:identity.id},sources:[activityFactSourceId("control",identity.id),activityFactSourceId("progress",identity.id),activityFactSourceId("scheduling",schedule.workId)]}}];
  }
  async result(pathId:string):Promise<{kind:"pending"}|{kind:"cancelled"}|{kind:"limited";reason:string}|ProtocolObservationLimitation|{kind:"observed";record:ProtocolJournalRecord|null}>{
    const snapshot=await this.ports.activities.command({kind:"read_snapshot",pathId,requestIds:[`${pathId}:observe`],inputNeedIds:[]}) as import("../activity/index.js").ActivitySnapshot;
    const {path}=snapshot,stage=snapshot.stages[0];
    if(!path||path.intent.purpose.digest!==this.purpose.digest||!stage||stage.request.pathId!==pathId)throw new TypeError("protocol_observation_path_missing");
    if(path.cancelled)return {kind:"cancelled"};
    if(stage.status==="stopped")return {kind:"limited",reason:"observation_work_restricted"};
    if(stage.status!=="accepted")return {kind:"pending"};
    const result=stage.result?.value as ObservationResult;
    if(!result||digest(path.progress)!==digest(result))throw new TypeError("protocol_observation_result_changed");
    const state=await original(this.ports,path,stage);
    if(result.kind==="protocol_observation_unavailable")return confirmLimitation(this.ports,state,result);
    return {kind:"observed",record:await observation(this.ports,state,result)};
  }
}

class ProtocolObservationHandler implements ActivityPurposeHandler {
  constructor(private readonly ports:Ports){}
  async authorize(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal,action:Parameters<ActivityPurposeHandler["authorize"]>[3]){
    await original(this.ports,path,stage);signal.throwIfAborted();return this.ports.authorize(path,stage,signal,action);
  }
  async execute(path:ActivityPathState,stage:ActivityStageState,attempt:ActivityAttempt,signal:AbortSignal):Promise<ActivityRawResult>{
    return this.run(path,stage,attempt,signal,"execute");
  }
  async reconcile(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal):Promise<ActivityRawResult>{
    if(!stage.attempt)throw new TypeError("protocol_observation_attempt_missing");
    return this.run(path,stage,stage.attempt,signal,"recover");
  }
  private async run(path:ActivityPathState,stage:ActivityStageState,attempt:ActivityAttempt,signal:AbortSignal,mode:"execute"|"recover"){
    let state=await original(this.ports,path,stage);
    if(state.fence.generation!==this.ports.generation||!state.fence.epoch){
      const id=state.activity.scope.activityId;
      const receipt=await this.ports.acceptance.accept({id:`${id}:claim:${this.ports.generation}:${state.fence.epoch}`,scope:path.intent.runId,
        actor:state.activity.composition.composition.adapter.implementation.id,parts:[{owner:"protocol_execution",kind:"claim",proposal:{activityId:id,expectedEpoch:state.fence.epoch}}]});
      if(receipt.outcome!=="accepted")throw new TypeError(`protocol_observation_claim_rejected:${receipt.rejection?.code}`);
      state=await original(this.ports,path,stage);
    }
    let record:ProtocolJournalRecord|null=null,limitation:ProtocolObservationLimitation|null=null;
    try{
      record=await this.ports.observe(state,mode,signal);
    }catch(error){
      if(error instanceof ProtocolObservationUnavailable)limitation=await confirmLimitation(this.ports,state,error.limitation);
      else throw error;
    }
    const value:ObservationResult=limitation??{kind:"protocol_observation_result",activityId:state.activity.scope.activityId,observation:record?.ref??null};
    if(value.kind==="protocol_observation_result"&&record)await observation(this.ports,state,value);
    return {id:`${attempt.id}:raw`,attemptId:attempt.id,outcome:"returned" as const,completeness:"complete" as const,value,usage:{},recordedAt:this.ports.now()};
  }
  async interpret(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal){
    const state=await original(this.ports,path,stage),result=stage.result;
    if(result?.outcome!=="returned"||result.completeness!=="complete")throw new TypeError("protocol_observation_incomplete");
    const value=result.value as ObservationResult;
    if(value?.kind==="protocol_observation_unavailable")await confirmLimitation(this.ports,state,value);
    else await observation(this.ports,state,value);
    signal.throwIfAborted();
    return {progress:result.value,next:[]};
  }
  async settle(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal){
    const result=await this.interpret(path,stage,signal);
    return {disposition:{kind:"protocol_observation_retained",result:result.progress,purposeAccepted:false}};
  }
  async handleLimitation(_path:ActivityPathState,_stage:ActivityStageState,limitation:Parameters<NonNullable<ActivityPurposeHandler["handleLimitation"]>>[2]){
    return {kind:"stop" as const,progress:{kind:"protocol_observation_limited",limitation}};
  }
}

async function original(ports:Ports,path:ActivityPathState,stage:ActivityStageState):Promise<ProtocolExecutionState>{
  const source=stage.request.input as ProtocolObservationSource;
  if(path.intent.purpose.digest!==digest(PROTOCOL_OBSERVATION_PURPOSE)||stage.request.pathId!==path.intent.id||stage.request.stageKind!=="observe"||
    source?.kind!=="protocol_observation_source")throw new TypeError("protocol_observation_source_invalid");
  const state=await ports.journal.command({kind:"state",activityId:source.activityId}) as ProtocolExecutionState|null;
  if(!state||state.activity.scope.runId!==path.intent.runId||state.activity.composition.digest!==source.compositionDigest||digest(state.input)!==digest(source.input))
    throw new TypeError("protocol_observation_original_binding_changed");
  return state;
}
async function confirmLimitation(ports:Ports,state:ProtocolExecutionState,value:ProtocolObservationLimitation){
  const id=state.activity.scope.activityId,b=value.basis;
  if(id!==value.activityId||!value.reason||!b||!Number.isSafeInteger(b.revision)||b.revision<0)
    throw new TypeError("protocol_observation_limitation_scope_invalid");
  const saved=await ports.journal.command({kind:"evidence",activityId:id,scopeId:b.scopeId,evidenceKind:b.kind,key:b.key,revision:b.revision}) as ProtocolEvidenceRevision|null;
  if(!saved||saved.activityId!==id||saved.owner!==state.activity.composition.composition.adapter.implementation.id||
    saved.content.digest!==b.digest||!saved.references.some(r=>digest(r)===digest(state.input)))
    throw new TypeError("protocol_observation_limitation_basis_missing");
  return value;
}
async function observation(ports:Ports,state:ProtocolExecutionState,result:ObservedResult){
  if(result?.kind!=="protocol_observation_result"||result.activityId!==state.activity.scope.activityId||
    result.observation===undefined)throw new TypeError("protocol_observation_result_scope_invalid");
  if(result.observation===null)return null;
  const saved=await ports.journal.command({kind:"record",activityId:result.activityId,ref:result.observation}) as ProtocolJournalRecord|null;
  if(!saved||saved.kind!=="observation"||digest(saved.source?.scope)!==digest(state.activity.scope))throw new TypeError("protocol_observation_record_missing");
  return saved;
}
