import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {readProtocolContent,retainProtocolContent,type ProtocolContentRef} from "@agent-anything/agent-runtime/model-access";
import {ActivityChangeWait,ActivityObservationCursor,ActivityCheckpointError,activityFactSourceId,
  type ActivityPurposeRegistry,type ActivityPurposeHandler,type ActivityPurposeBinding,type ActivityPurposeContract,
  type ActivityPathState,type ActivityStageState,type ActivityAttempt,type ActivityStateObservation,
  type ActivityReconsiderationHandler,type ActivitySchedulingAcceptance,type ActivityScheduledSettlement,
  type SharedAcceptancePart,type ActivityChangeInterest} from "@agent-anything/agent-runtime/activity";
import {prepareHelarcNativeStructuredInput,assertHelarcNativeStructuredInput,validateHelarcNativeStructuredRequest,
  type HelarcNativeStructuredRequest,type HelarcNativeStructuredInputPolicy} from "@agent-anything/helarc/controller";
import type {HelarcExecutionStore} from "../execution-storage/HelarcExecutionStore.js";
import type {HelarcResponsesInputMeasurements} from "./HelarcResponsesInputMeasurement.js";

const PURPOSE:ActivityPurposeContract={ref:{id:"helarc.native-auxiliary-input",revision:"1"},
  inputOwner:"context-representation",executionOwner:"context-representation",interpretationOwner:"context-representation",
  acceptanceOwner:"context-representation",recoveryOwner:"context-representation",stageKinds:["prepare_input"],
  capabilities:["model-measurement"],continuationKinds:[]};
export {PURPOSE as HELARC_NATIVE_AUXILIARY_INPUT_PURPOSE};
interface Source {
  readonly kind:"helarc_native_auxiliary_input";readonly activityId:string;readonly compositionDigest:string;
  readonly source:HelarcNativeStructuredRequest["source"];readonly wireDigest:string;readonly content:ProtocolContentRef;
}
interface FrozenInput {readonly request:HelarcNativeStructuredRequest;readonly capacity:HelarcNativeStructuredInputPolicy}
interface Result {
  readonly kind:"helarc_native_auxiliary_input_result";readonly activityId:string;readonly content:ProtocolContentRef|null;readonly countActivityId:string|null;
  readonly work:{readonly measurementMs:number;readonly totalMs:number;readonly readBytes:number;readonly writeBytes:number};
}
interface Ports {
  readonly store:HelarcExecutionStore;
  readonly registry:ActivityPurposeRegistry<ActivityPurposeHandler>;
  readonly measurement:Pick<HelarcResponsesInputMeasurements,"measureStructured"|"interruptStructured">;
  readonly authorize:ActivityPurposeHandler["authorize"];
  readonly now:()=>string;
  readonly arrangement:(runId:string)=>Promise<{permissionBasis:string;scopeId:string;modelPoolId:string;deadlineAt:string;maximumMeasurements:number}>;
  readonly host:{assertAvailable():void;wake():void;subscribe(listener:()=>void,interest?:ActivityChangeInterest):()=>void};
}

/** Owns the input preparation only; native counting and Hook judgment keep their own acceptance. */
export class HelarcNativeAuxiliaryInputPreparation {
  readonly purpose:ActivityPurposeBinding;
  readonly lifecycle:ActivityReconsiderationHandler;
  constructor(private readonly ports:Ports){
    const handler:ActivityPurposeHandler={
      authorize:async(path,stage,signal,action)=>{this.source(path,stage);return ports.authorize(path,stage,signal,action);},
      execute:(path,stage,attempt,signal)=>this.run(path,stage,attempt,signal),
      reconcile:async(path,stage,signal)=>{
        if(!stage.attempt)throw new TypeError("native_auxiliary_input_attempt_missing");
        return this.run(path,stage,stage.attempt,signal);
      },
      interpret:async(path,stage,signal)=>{await this.result(path,stage);signal.throwIfAborted();return {progress:stage.result!.value,next:[]};},
      settle:async(path,stage,signal)=>{
        const source=this.source(path,stage);await ports.measurement.interruptStructured(source,signal);
        if(stage.result?.outcome==="returned")await this.result(path,stage);
        return {disposition:{kind:"native_auxiliary_input_disposed",activityId:source.activityId,generationAccepted:false}};
      },
      handleLimitation:async(_path,_stage,limitation)=>({kind:"stop",progress:{kind:"native_auxiliary_input_limited",limitation}})};
    this.purpose=ports.registry.register(PURPOSE,handler);
    this.lifecycle={prepare:async(snapshot,signal)=>{
      const sub=snapshot.state.subscription,id=sub.binding?.id;
      if(!id||sub.binding?.kind!=="activity_path"||sub.owner!==PURPOSE.acceptanceOwner||sub.id!==`${id}:input-lifecycle`)
        throw new TypeError("native_auxiliary_input_subscription_invalid");
      const path=await ports.store.activityHandoffs.command({kind:"read_path",pathId:id}) as ActivityPathState|null;
      const stage=await ports.store.activityHandoffs.command({kind:"read_stage",requestId:`${id}:prepare`}) as ActivityStageState|null;
      if(!path||!stage||path.intent.runId!==sub.runId||!path.intent.scheduledWorkId)throw new TypeError("native_auxiliary_input_path_missing");
      this.source(path,stage);
      const work=await ports.store.activityHandoffs.command({kind:"read_schedule",workId:path.intent.scheduledWorkId}) as ActivitySchedulingAcceptance|null;
      if(!work||work.intent.owner!==sub.owner||work.intent.runId!==sub.runId||!work.pathsSealed||
        work.intent.delegatedPathOwners?.length||digest(work.intent.allowedPathIds)!==digest([id]))throw new TypeError("native_auxiliary_input_schedule_changed");
      const settled=await ports.store.activityHandoffs.command({kind:"scheduled_settlement",workId:work.intent.workId}) as ActivityScheduledSettlement;
      const closed=(path.cancelled||["accepted","settled","stopped"].includes(stage.status))&&settled.remaining===null;
      const decision={owner:sub.owner,kind:closed?"native_auxiliary_input_closed":"native_auxiliary_input_waiting",id,
        revision:digest({control:path.controlRevision,progress:path.progressRevision,schedule:work.revision,closed})};
      const participants:SharedAcceptancePart[]=[{owner:"activity",kind:"path_condition",proposal:{pathId:id,
        expected:{controlRevision:path.controlRevision,progressRevision:path.progressRevision,cancelled:path.cancelled},requireSettled:closed}}];
      if(closed)participants.push({owner:"activity",kind:"scheduling_closure",proposal:{kind:"close_scheduled_work",workId:work.intent.workId,
        expectedRevision:settled.revision,basis:`${id}:input-lifecycle`,requireSettled:true}},
        {owner:"activity",kind:"fact_publication",proposal:{id:`${id}:closed:${decision.revision}`,sourceId:activityFactSourceId("progress",id),ref:decision}});
      signal.throwIfAborted();return {decision,participants,close:closed,observeSources:[activityFactSourceId("control",id),
        activityFactSourceId("progress",id),activityFactSourceId("scheduling",work.intent.workId)]};
    }};
  }
  private pathId(activityId:string){return `${activityId}:input-preparation`;}
  private source(path:ActivityPathState,stage:ActivityStageState):Source{
    const source=stage.request.input as Source;
    if(path.intent.purpose.digest!==this.purpose.digest||path.intent.owner!==PURPOSE.acceptanceOwner||
      stage.request.stageKind!=="prepare_input"||stage.request.pathId!==path.intent.id||source?.kind!=="helarc_native_auxiliary_input"||
      path.intent.id!==this.pathId(source.activityId)||stage.request.id!==`${path.intent.id}:prepare`)
      throw new TypeError("native_auxiliary_input_source_invalid");
    return source;
  }
  private async frozen(path:ActivityPathState,stage:ActivityStageState):Promise<FrozenInput>{
    const source=this.source(path,stage),p=this.ports;
    const value=JSON.parse((await readProtocolContent(p.store.protocolJournal,source.content,source.activityId,32*1024*1024)).toString()) as FrozenInput;
    validateHelarcNativeStructuredRequest(value.request);
    const request=value.request;
    if(request.activity.scope.activityId!==source.activityId||request.activity.scope.runId!==path.intent.runId||
      request.activity.composition.digest!==source.compositionDigest||request.wire.digest!==source.wireDigest||
      digest(request.source)!==digest(source.source)||request.activity.conditions.authority.id!==path.intent.permissionBasis)
      throw new TypeError("native_auxiliary_input_original_changed");
    return value;
  }
  private async run(path:ActivityPathState,stage:ActivityStageState,attempt:ActivityAttempt,signal:AbortSignal){
    const p=this.ports,source=this.source(path,stage),started=performance.now();
    let measurementCalls=0,measurementMs=0,readBytes=0,writeBytes=0;
    let content:ProtocolContentRef|null=null;
    if(path.cancelled){await p.measurement.interruptStructured(source,signal);}
    else{
      const original=await this.frozen(path,stage),request=original.request;
      const measurementStarted=performance.now();
      const measured=await p.measurement.measureStructured(request,{activityId:source.activityId,runId:path.intent.runId,
        recipientId:request.activity.scope.recipientId,source:source.source,measurement:{kind:"auxiliary_input",pathId:path.intent.id,
          stageId:stage.request.id,maximumCalls:path.intent.resourceLimits!.measurementCalls!}},signal);
      measurementMs=performance.now()-measurementStarted;
      measurementCalls=measured.usage.measurementCalls;readBytes=source.content.bytes;
      const prepared={...request,inputPreparation:prepareHelarcNativeStructuredInput(request,original.capacity,measured.evidence,measured.refusals)};
      const bytes=Buffer.from(JSON.stringify(prepared));writeBytes=bytes.length;
      content=await retainProtocolContent(p.store.protocolJournal,`${source.activityId}:prepared-input:${digest(prepared)}`,
        source.activityId,bytes);
    }
    const count=await p.store.protocolJournal.command({kind:"state",activityId:`${source.activityId}:input-count`});
    const totalMs=performance.now()-started;
    const value:Result={kind:"helarc_native_auxiliary_input_result",activityId:source.activityId,content,
      countActivityId:count?`${source.activityId}:input-count`:null,work:{measurementMs,totalMs,readBytes,writeBytes}};
    return {id:`${attempt.id}:raw`,attemptId:attempt.id,outcome:"returned" as const,completeness:"complete" as const,
      value,usage:{measurementCalls,readBytes,writeBytes,localMs:Math.max(0,totalMs-measurementMs)},recordedAt:p.now()};
  }
  private async result(path:ActivityPathState,stage:ActivityStageState):Promise<HelarcNativeStructuredRequest|null>{
    const source=this.source(path,stage),result=stage.result,value=result?.value as Result|undefined;
    if(result?.outcome!=="returned"||result.completeness!=="complete"||value?.kind!=="helarc_native_auxiliary_input_result"||value.activityId!==source.activityId)
      throw new TypeError("native_auxiliary_input_result_invalid");
    if(value.content===null){if(!path.cancelled)throw new TypeError("native_auxiliary_input_result_missing");return null;}
    const request=JSON.parse((await readProtocolContent(this.ports.store.protocolJournal,value.content,source.activityId,32*1024*1024)).toString()) as HelarcNativeStructuredRequest;
    validateHelarcNativeStructuredRequest(request);assertHelarcNativeStructuredInput(request);
    const original=await this.frozen(path,stage),{inputPreparation:_input,...body}=request;
    if(digest(body)!==digest(original.request)||digest(request.inputPreparation!.capacity)!==digest(original.capacity))
      throw new TypeError("native_auxiliary_input_result_changed");
    return request;
  }
  async restore(activityId:string,source:HelarcNativeStructuredRequest["source"],signal:AbortSignal):Promise<HelarcNativeStructuredRequest|null>{
    const id=this.pathId(activityId),p=this.ports;
    const path=await p.store.activityHandoffs.command({kind:"read_path",pathId:id}) as ActivityPathState|null;
    if(!path)return null;
    const stage=await p.store.activityHandoffs.command({kind:"read_stage",requestId:`${id}:prepare`}) as ActivityStageState|null;
    if(!stage||digest(this.source(path,stage).source)!==digest(source))throw new TypeError("native_auxiliary_input_restore_changed");
    p.host.assertAvailable();p.host.wake();return this.wait(path,signal);
  }
  async prepare(request:HelarcNativeStructuredRequest,capacity:HelarcNativeStructuredInputPolicy,signal:AbortSignal){
    const restored=await this.restore(request.activity.scope.activityId,request.source,signal);
    if(restored)return restored;
    const p=this.ports,id=this.pathId(request.activity.scope.activityId),runId=request.activity.scope.runId;
    const arrangement=await p.arrangement(runId);
    if(!Number.isSafeInteger(arrangement.maximumMeasurements)||arrangement.maximumMeasurements<1||
      arrangement.permissionBasis!==request.activity.conditions.authority.id)throw new TypeError("native_auxiliary_input_arrangement_invalid");
    const frozen:FrozenInput={request,capacity};
    const content=await retainProtocolContent(p.store.protocolJournal,`${id}:source:${digest(frozen)}`,request.activity.scope.activityId,Buffer.from(JSON.stringify(frozen)));
    const source:Source={kind:"helarc_native_auxiliary_input",activityId:request.activity.scope.activityId,compositionDigest:request.activity.composition.digest,
      source:request.source,wireDigest:request.wire.digest,content};
    const parts:SharedAcceptancePart[]=[{owner:"activity",kind:"scheduling_acceptance",proposal:{kind:"schedule_work",expectedRevision:0,intent:{
      id:`${id}:schedule`,workId:id,runId,scopeId:arrangement.scopeId,owner:PURPOSE.acceptanceOwner,reason:"task",allowedPathIds:[id],
      decisionId:id,policyRevision:"1",delayImpact:"An enabled auxiliary judgment needs its complete input assessment",timing:{kind:"unknown"},
      resources:[{poolId:arrangement.modelPoolId,capability:"model-measurement",units:1}]}}},
      {owner:"activity",kind:"path_opening",proposal:{id,runId,owner:PURPOSE.acceptanceOwner,purpose:this.purpose,
        permissionBasis:arrangement.permissionBasis,resourceScope:id,scheduledWorkId:id,maximumStages:1,maximumAttempts:1,maximumConcurrent:1,
        deadlineAt:arrangement.deadlineAt,resourceLimits:{measurementCalls:arrangement.maximumMeasurements}}},
      {owner:"activity",kind:"stage_submission",proposal:{id:`${id}:prepare`,pathId:id,stageKind:"prepare_input",input:source,capabilities:["model-measurement"],dependencies:[]}},
      {owner:"activity",kind:"scheduling_path_seal",proposal:{kind:"seal_scheduled_paths",workId:id,expectedRevision:1,basis:`${id}:submission`}},
      {owner:"activity",kind:"reconsideration_subscription",proposal:{id:`${id}:input-lifecycle`,runId,owner:PURPOSE.acceptanceOwner,
        binding:{kind:"activity_path",id},sources:[activityFactSourceId("control",id),activityFactSourceId("progress",id),activityFactSourceId("scheduling",id)]}}];
    signal.throwIfAborted();p.host.assertAvailable();
    const receipt=await p.store.sharedAcceptance.accept({id:`${id}:submission`,scope:runId,actor:PURPOSE.acceptanceOwner,parts});
    if(receipt.outcome!=="accepted")throw new TypeError(`native_auxiliary_input_submission_rejected:${receipt.rejection?.code}`);
    p.host.wake();
    const path=await p.store.activityHandoffs.command({kind:"read_path",pathId:id}) as ActivityPathState;
    return this.wait(path,signal);
  }
  async interrupt(activityId:string,source:HelarcNativeStructuredRequest["source"],signal:AbortSignal):Promise<void>{
    const p=this.ports,id=this.pathId(activityId),path=await p.store.activityHandoffs.command({kind:"read_path",pathId:id}) as ActivityPathState|null;
    if(!path)return;
    const stage=await p.store.activityHandoffs.command({kind:"read_stage",requestId:`${id}:prepare`}) as ActivityStageState|null;
    if(!stage||digest(this.source(path,stage).source)!==digest(source))throw new TypeError("native_auxiliary_input_cancel_changed");
    const allowed=await p.authorize(path,stage,signal,"settlement");
    if(allowed.kind!=="allowed")throw new TypeError("native_auxiliary_input_cancel_not_authorized");
    if(!path.cancelled)await p.store.activityHandoffs.command({kind:"cancel",pathId:id,expectedControlRevision:path.controlRevision});
    p.host.wake();await p.measurement.interruptStructured({activityId},signal);
  }
  private async wait(original:ActivityPathState,signal:AbortSignal):Promise<HelarcNativeStructuredRequest>{
    const p=this.ports,id=original.intent.id,deadline=Date.parse(original.intent.deadlineAt);
    const wake=new ActivityChangeWait(p.host,signal,{pathIds:[id]}),cursor=new ActivityObservationCursor(p.store.activityHandoffs,[id]);
    try{for(;;){
      const version=wake.version;
      if(await cursor.changed()){
        const current=await p.store.activityHandoffs.command({kind:"observe_state",pathId:id,requestIds:[`${id}:prepare`],inputNeedIds:[]}) as ActivityStateObservation;
        if(!current.path||current.path.intent.purpose.digest!==this.purpose.digest)throw new TypeError("native_auxiliary_input_path_changed");
        if(current.path.cancelled)throw new TypeError("native_auxiliary_input_cancelled");
        const stage=current.stages[0];
        if(stage?.status==="stopped")throw new TypeError("native_auxiliary_input_limited");
        if(stage?.status==="accepted"){
          const full=await p.store.activityHandoffs.command({kind:"read_stage",requestId:`${id}:prepare`}) as ActivityStageState;
          const path=await p.store.activityHandoffs.command({kind:"read_path",pathId:id}) as ActivityPathState;
          const result=await this.result(path,full);
          if(!result||path.cancelled)throw new TypeError("native_auxiliary_input_cancelled");
          return result;
        }
      }
      signal.throwIfAborted();p.host.assertAvailable();
      const remaining=deadline-Date.now();
      if(!Number.isFinite(remaining)||remaining<=0)throw new ActivityCheckpointError(`${id}:wait`,{cause:new Error("Original auxiliary input preparation remains owned")});
      await wake.wait(version,Math.min(remaining,100));
    }}finally{wake.close();}
  }
}
