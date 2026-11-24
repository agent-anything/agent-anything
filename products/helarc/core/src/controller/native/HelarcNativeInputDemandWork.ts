import {modelInputValueDigest as digest,assessInputCapacity} from "@agent-anything/model-interaction/input";
import {ActivityPurposeRegistry,type ActivityPurposeHandler,type ActivityPurposeContract,type ActivityPathIntent,type ActivityPathState,
  type ActivityStageState,type ActivityHandoffPort,type ActivityAttempt,type ActivityRawResult,type ActivityInputNeed,type SharedAcceptancePart} from "@agent-anything/agent-runtime/activity";
import {nativeInputBodyDigest,confirmNativeInputNeed,type NativeInputNeedDeclaration,type NativeInputReady,
  type ContextRecipientInputCapacity,type ContextInputUnavailability,type RepresentationMethodRequest} from "@agent-anything/agent-runtime/context-representation";
import type {ProtocolModelActivity} from "@agent-anything/agent-runtime/model-access";
import type {ContextSelectionPort,ContextSelectionSnapshot} from "@agent-anything/context/selection";
import type {HelarcNativeRunTask} from "./HelarcNativePreparedTask.js";
import {helarcNativeTaskResultDeliveries,type HelarcNativeTaskResultSources} from "./HelarcNativeTaskResultDelivery.js";

export const HELARC_NATIVE_INPUT_DEMAND_PURPOSE:ActivityPurposeContract={
  ref:{id:"helarc.native-input-demand",revision:"1"},inputOwner:"context-representation",executionOwner:"helarc-native-input",
  interpretationOwner:"context-representation",acceptanceOwner:"context-representation",recoveryOwner:"context-representation",
  stageKinds:["source","ready","unavailable"],capabilities:[],continuationKinds:[],
};
export interface HelarcNativeInputDemandPlan {
  readonly revision:"1";
  readonly activity:ProtocolModelActivity;
  readonly prepared:HelarcNativeRunTask;
  readonly inputNeed:NativeInputNeedDeclaration;
  readonly capacity:RepresentationMethodRequest["capacity"];
  readonly resultSources?:HelarcNativeTaskResultSources;
  readonly supplyConditions?:HelarcNativeTaskInputConditions;
  readonly rejectedInputs?:readonly import("@agent-anything/agent-runtime/model-access").ProtocolInputRejectionEvidence[];
}
/** Original accepted Host arrangement, not preferences reread during supply. */
export interface HelarcNativeTaskInputConditions {
  readonly revision:"1";
  readonly settingsRevision:string;
  readonly sequence:number;
  readonly inputRevision:number;
  readonly representationContinuity:string;
  readonly observationContinuity?:string;
  readonly autoPrepare:boolean;
  readonly methodComparisonRevision?:"13"|"14"|"15";
  readonly maximumSourceBytes:number;
  readonly maximumReadBytes:number;
  readonly capacity:RepresentationMethodRequest["capacity"];
  readonly methodCapacity:RepresentationMethodRequest["capacity"];
  readonly bounds:RepresentationMethodRequest["bounds"];
  readonly limits:{readonly maximumStages:number;readonly maximumAttempts:number};
  readonly schedulingScopeId:string;
  readonly resources:import("@agent-anything/agent-runtime/activity").ActivitySchedulingIntent["resources"];
  readonly continuity:import("./HelarcNativeInputAcceptance.js").HelarcRetainedNativeInput["continuity"];
  readonly measurement?:import("./HelarcNativeInputMeasurement.js").HelarcNativeInputMeasurementSelection;
  readonly generationPlanning?:import("./HelarcNativeGenerationPlanning.js").HelarcNativeGenerationPlanning;
  readonly responsesCompact?:{readonly purpose:import("@agent-anything/model-interaction/protocol").ProtocolRevisionRef;readonly probeRequired:boolean;readonly assessmentModelCalls?:number;
    readonly assessmentInput?:import("./HelarcResponsesCompaction.js").HelarcResponsesCompactSource["assessmentInput"]};
  readonly responsesInRequest?:import("./HelarcResponsesInRequestEligibility.js").HelarcResponsesInRequestUse;
}
interface DemandEvidence {
  readonly kind:"native_input_demand";
  readonly sourceDigest:string;
  readonly originalDigest:string;
  readonly bodyDigest:string;
  readonly capacity:ContextRecipientInputCapacity;
}
interface Ports {
  readonly activities:ActivityHandoffPort;
  readonly selections:ContextSelectionPort;
  readonly authorize:ActivityPurposeHandler["authorize"];
  readonly now:()=>string;
}

/** An original recipient need, not a candidate receiver or native network dispatch. */
export class HelarcNativeInputDemandWork implements ActivityPurposeHandler {
  readonly purpose;
  constructor(private readonly ports:Ports,registry:ActivityPurposeRegistry<ActivityPurposeHandler>){
    this.purpose=registry.register(HELARC_NATIVE_INPUT_DEMAND_PURPOSE,this);
  }
  prepareSubmission(intent:Omit<ActivityPathIntent,"owner"|"purpose">,plan:HelarcNativeInputDemandPlan):readonly SharedAcceptancePart[]{
    const path={...intent,owner:this.purpose.contract.acceptanceOwner,purpose:this.purpose};this.validatePlan(path,plan);
    return [{owner:"activity",kind:"path_opening",proposal:path},
      {owner:"activity",kind:"stage_submission",proposal:{id:`${path.id}:stage:1`,pathId:path.id,stageKind:"source",input:{plan},capabilities:[],dependencies:[]}}];
  }
  async authorize(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal,action:Parameters<ActivityPurposeHandler["authorize"]>[3]){
    await this.original(path,stage);return this.ports.authorize(path,stage,signal,action);
  }
  async execute(path:ActivityPathState,stage:ActivityStageState,attempt:ActivityAttempt,signal:AbortSignal):Promise<ActivityRawResult>{
    signal.throwIfAborted();const started=performance.now(),{plan}=await this.original(path,stage);
    const value=stage.request.stageKind==="source"?this.evidence(plan):await this.returned(path,stage,plan);
    return {id:`${attempt.id}:raw`,attemptId:attempt.id,completeness:"complete",outcome:"returned",value,
      usage:{localMs:performance.now()-started},recordedAt:this.ports.now()};
  }
  async reconcile(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal):Promise<ActivityRawResult>{
    if(!path.cancelled)return this.execute(path,stage,stage.attempt!,signal);
    return {id:`${stage.attempt!.id}:raw`,attemptId:stage.attempt!.id,completeness:"complete",outcome:"returned",
      value:{kind:"native_input_demand_cancelled"},usage:null,recordedAt:this.ports.now()};
  }
  async interpret(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal,acceptance:{id:string}){
    signal.throwIfAborted();const {plan}=await this.original(path,stage);
    const expected=stage.request.stageKind==="source"?this.evidence(plan):await this.returned(path,stage,plan);
    if(stage.result?.outcome!=="returned"||stage.result.completeness!=="complete"||digest(stage.result.value)!==digest(expected))
      throw new TypeError("native_input_demand_result_changed");
    if(stage.request.stageKind!=="source")return {progress:{...path.progress as object,returned:expected},next:[]};
    const need:ActivityInputNeed={id:plan.inputNeed.needId,supplier:path.intent.owner,origin:{requestId:stage.request.id,receiptId:acceptance.id},
      stage:{id:`${path.intent.id}:ready`,pathId:path.intent.id,stageKind:"ready",capabilities:[],dependencies:[]},
      unavailableStage:{id:`${path.intent.id}:unavailable`,pathId:path.intent.id,stageKind:"unavailable",capabilities:[],dependencies:[]}};
    return {progress:{contextInputNeed:plan.inputNeed,demand:expected},next:[],
      participants:[{owner:"activity",kind:"input_need",proposal:need}] satisfies SharedAcceptancePart[]};
  }
  async settle(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal){
    signal.throwIfAborted();await this.original(path,stage);
    return {disposition:{kind:"native_input_demand_cancelled",stageId:stage.request.id,resultId:stage.result!.id,nativeDispatch:false}};
  }
  async result(pathId:string){
    const path=await this.ports.activities.command({kind:"read_path",pathId}) as ActivityPathState|null;
    if(!path)throw new TypeError("native_input_demand_missing");
    const first=await this.ports.activities.command({kind:"read_stage",requestId:`${pathId}:stage:1`}) as ActivityStageState;
    const {plan}=await this.original(path,first);
    if(first.status!=="accepted")return {kind:path.cancelled?"cancelled" as const:"pending" as const};
    const need=await this.ports.activities.command({kind:"read_input_need",id:plan.inputNeed.needId}) as ActivityInputNeed|null;
    if(!need||digest(confirmNativeInputNeed(need,first,path))!==digest(plan.inputNeed))throw new TypeError("native_input_demand_origin_changed");
    const [ready,unavailable]=await this.stages([need.stage.id,need.unavailableStage.id]);
    if(ready&&unavailable)throw new TypeError("native_input_demand_return_conflict");
    const returned=ready??unavailable;
    const basis={plan,need,source:first,path};
    if(path.cancelled)return {kind:"cancelled" as const,...basis};
    if(!returned||returned.status!=="accepted")return {kind:"needed" as const,...basis};
    const value=await this.returned(path,returned,plan);
    if(digest(value)!==digest(returned.result!.value))throw new TypeError("native_input_demand_return_changed");
    return value.kind==="native_input_ready"?{kind:"ready" as const,...basis,value}:{kind:"unavailable" as const,...basis,value};
  }
  private evidence(plan:HelarcNativeInputDemandPlan):DemandEvidence {
    const inputId=`${plan.inputNeed.needId}:original`,scope=plan.inputNeed.scope,body=plan.prepared.wire.body;
    const measurements:ContextRecipientInputCapacity["measurements"]=[{id:`${inputId}:bytes`,encodedInputId:inputId,targetRevision:scope.target,
      methodRevision:"native-body-bytes:1",dimension:"request_bytes",coverage:"complete",quantity:{kind:"exact",value:Buffer.byteLength(body)},
      basis:"Complete original native task input; token dimensions remain unmeasured",uncovered:[]}];
    return {kind:"native_input_demand",sourceDigest:plan.prepared.sourceDigest,originalDigest:digest(plan.prepared),bodyDigest:nativeInputBodyDigest(body),
      capacity:{inputId,measurements,limits:plan.capacity.limits,assessment:assessInputCapacity({encodedInputId:inputId,targetRevision:scope.target,
        purpose:scope.purpose,...plan.capacity,evidence:measurements})}};
  }
  private async returned(path:ActivityPathState,stage:ActivityStageState,plan:HelarcNativeInputDemandPlan):Promise<NativeInputReady|ContextInputUnavailability>{
    const value=stage.request.input as NativeInputReady|ContextInputUnavailability;
    if(value.needId!==plan.inputNeed.needId)throw new TypeError("native_input_demand_return_need_changed");
    if(stage.request.stageKind==="unavailable"){
      if(stage.request.id!==`${path.intent.id}:unavailable`||value.kind!=="context_input_unavailable"||value.supplier!==path.intent.owner||
        value.boundary!==plan.prepared.sourceDigest||!value.reason||!Array.isArray(value.evidence))throw new TypeError("native_input_demand_limitation_invalid");
      return value;
    }
    if(stage.request.stageKind!=="ready"||stage.request.id!==`${path.intent.id}:ready`||value.kind!=="native_input_ready"||value.revision!=="1")
      throw new TypeError("native_input_demand_return_invalid");
    const selected=await this.ports.selections.command({kind:"binding",inputId:value.inputId,checkCurrentControl:true}) as ContextSelectionSnapshot|null;
    const n=plan.inputNeed;
    if(!selected||digest(selected.scope)!==digest(n.scope)||digest(selected.input.exactInput)!==value.inputDigest||selected.input.activityId!==n.consumer.activityId||
      digest(selected.input.nativeConsumer)!==digest({protocol:n.consumer.protocol,compositionDigest:n.consumer.compositionDigest}))
      throw new TypeError("native_input_demand_selection_changed");
    return value;
  }
  private async stages(ids:readonly string[]){
    const result:(ActivityStageState|null)[]=[];
    for(const requestId of ids)result.push(await this.ports.activities.command({kind:"read_stage",requestId}) as ActivityStageState|null);
    return result;
  }
  private async original(path:ActivityPathState,stage:ActivityStageState){
    const first=stage.request.id===`${path.intent.id}:stage:1`?stage:(await this.stages([`${path.intent.id}:stage:1`]))[0];
    if(!first||stage.request.pathId!==path.intent.id||path.intent.purpose.digest!==this.purpose.digest||first.request.stageKind!=="source")
      throw new TypeError("native_input_demand_original_missing");
    const plan=(first.request.input as {plan:HelarcNativeInputDemandPlan}).plan;this.validatePlan(path.intent,plan);return {plan,first};
  }
  private validatePlan(path:ActivityPathIntent,plan:HelarcNativeInputDemandPlan){
    const {activity,prepared,inputNeed:n}=plan,scope=n.scope,c=activity.composition.composition;
    if(plan.revision!=="1"||n.kind!=="native_input_need"||n.revision!=="1"||n.needId!==`${path.id}:need`||
      path.owner!==scope.owner||path.runId!==scope.runId||path.permissionBasis!==scope.authorityBasis||
      scope.runId!==activity.scope.runId||scope.recipient!==activity.scope.recipientId||scope.purpose!==activity.scope.purpose.id||
      scope.target!==`${c.configuration.configuration.id}:${c.configuration.configuration.revision}`||
      digest(n.consumer)!==digest({activityId:activity.scope.activityId,protocol:c.protocol,compositionDigest:activity.composition.digest})||
      digest(prepared.binding.scope)!==digest(activity.scope)||digest(prepared.binding.protocol)!==digest(c.protocol)||
      prepared.format!=="helarc.native-prepared-task.v1"||!prepared.sourceDigest||prepared.wire.digest!==digest(JSON.parse(prepared.wire.body)))
      throw new TypeError("native_input_demand_binding_changed");
    if(!Array.isArray(prepared.results)||prepared.results.length&&!plan.resultSources)throw new TypeError("native_input_demand_results_missing");
    if(plan.rejectedInputs?.some(r=>r.kind!=="recipient"||r.scopeId!==scope.id||r.targetRevision!==scope.target||
      r.boundary!==prepared.sourceDigest||r.activityId===activity.scope.activityId||!r.bodyDigest||r.evidence.kind!=="fact"))
      throw new TypeError("native_input_demand_rejection_changed");
    if(plan.resultSources)helarcNativeTaskResultDeliveries(prepared,plan.resultSources);
  }
}
