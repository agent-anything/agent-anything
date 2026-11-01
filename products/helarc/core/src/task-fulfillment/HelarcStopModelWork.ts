import {snapshotProviderRequest,type Provider,type ProviderCallResult,type ProviderDeliveryObserver} from "@agent-anything/model-interaction";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import type {ContextSelectionPort,ContextSelectionSnapshot} from "@agent-anything/context/selection";
import {ActivityPurposeRegistry,activityFactSourceId,type ActivitySchedulingIntent,type ActivityPurposeContract,type ActivityPurposeHandler,type ActivityHandoffPort,
  type ActivityPathIntent,type ActivityPathState,type ActivityStageState,type ActivityAttempt,type ActivityRawResult,
  type SharedAcceptancePart} from "@agent-anything/agent-runtime/activity";
import {PreparedInputExecution,validateOriginalDataTextPresentations,validateContextInputUnavailability,type ContextInputUnavailability,type PreparedContextInput} from "@agent-anything/agent-runtime/context-representation";
import {MODEL_ATTEMPT_RETRY,prepareModelInputRecovery} from "@agent-anything/agent-runtime/model-access";
import {validateHelarcStopModelSource,interpretHelarcStopModelResult,type HelarcStopModelSource} from "./HelarcTaskFulfillmentHook.js";
import type {HelarcTaskFulfillmentAssessment} from "./HelarcTaskFulfillment.js";
import {createHelarcStopInputSources} from "../prompt/HelarcStopInputSources.js";

export const HELARC_STOP_MODEL_PURPOSE:ActivityPurposeContract={ref:{id:"helarc.stop-model-assessment",revision:"1"},
  inputOwner:"context-representation",executionOwner:"model-access",interpretationOwner:"helarc-stop",acceptanceOwner:"helarc-stop",
  recoveryOwner:"helarc-stop",stageKinds:["source","model","input-unavailable"],capabilities:["model-request"],continuationKinds:[],attemptRetry:MODEL_ATTEMPT_RETRY};

export interface HelarcStopModelProgress {
  readonly kind:"helarc_stop_model_result";
  readonly sourceId:string;
  readonly rawResultId:string;
  readonly inputId:string;
  readonly assessment:HelarcTaskFulfillmentAssessment|null;
  readonly failure:unknown;
}
interface Ports {
  readonly provider:Provider;
  readonly activities:ActivityHandoffPort;
  readonly selections:ContextSelectionPort;
  readonly authorize:ActivityPurposeHandler["authorize"];
  readonly observer?:ProviderDeliveryObserver|((path:ActivityPathState,stage:ActivityStageState)=>ProviderDeliveryObserver);
  readonly now:()=>string;
}

/** Product interpretation of Stop evidence, using the common input and execution handoffs. */
export class HelarcStopModelPath implements ActivityPurposeHandler {
  private readonly execution:PreparedInputExecution;
  constructor(private readonly ports:Ports) {
    this.execution=new PreparedInputExecution({provider:ports.provider,selections:ports.selections,inputId:s=>`${s.request.id}:input`,
      authorize:ports.authorize,observer:ports.observer,now:ports.now,interpret:(...args)=>this.interpretModel(...args)});
  }
  async authorize(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal,action:Parameters<ActivityPurposeHandler["authorize"]>[3]) {
    if(path.intent.purpose.digest!==modelInputValueDigest(HELARC_STOP_MODEL_PURPOSE))throw new TypeError("stop_purpose_changed");
    const original=await this.source(path,stage);
    if(stage.request.stageKind==="model") {
      const prepared=stage.request.input as PreparedContextInput;
      if(prepared.demand.runId!==path.intent.runId||prepared.request.purpose!==original.request.purpose||
        ["interaction","instructions","metadata","correlation"].some(key=>modelInputValueDigest(prepared.request[key as keyof typeof prepared.request])!==
          modelInputValueDigest(original.request[key as keyof typeof original.request])))throw new TypeError("stop_fixed_protocol_changed");
      const data=validateOriginalDataTextPresentations(createHelarcStopInputSources(original),prepared),sections=prepared.request.composition.sections;
      if(sections.length!==original.request.composition.sections.length||sections.some((section,index)=>{
        const source=original.request.composition.sections[index]!;
        return section.id!==source.id||!data.has(section.id)&&modelInputValueDigest(section)!==modelInputValueDigest(source);
      }))throw new TypeError("stop_fixed_evidence_changed");
      return this.execution.authorize(path,stage,signal,action);
    }
    if(stage.request.stageKind==="input-unavailable")await this.limitation(path,stage);
    else if(stage.request.stageKind!=="source")throw new TypeError("stop_stage_invalid");
    return this.ports.authorize(path,stage,signal,action);
  }
  async execute(path:ActivityPathState,stage:ActivityStageState,attempt:ActivityAttempt,signal:AbortSignal):Promise<ActivityRawResult> {
    if(stage.request.stageKind==="model")return this.execution.execute(path,stage,attempt,signal);
    signal.throwIfAborted();
    const value=stage.request.stageKind==="source"?{kind:"stop_source_recorded",id:(await this.source(path,stage)).id}:
      {kind:"stop_input_limitation",digest:modelInputValueDigest(await this.limitation(path,stage))};
    return {id:`${attempt.id}:raw`,attemptId:attempt.id,outcome:"returned",completeness:"complete",value,usage:{},recordedAt:this.ports.now()};
  }
  async reconcile(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal):Promise<ActivityRawResult|null> {
    return stage.request.stageKind==="model"?null:this.execute(path,stage,stage.attempt!,signal);
  }
  async interpret(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal,acceptance:{id:string}) {
    if(stage.request.stageKind==="model")return this.execution.interpret(path,stage,signal,acceptance);
    signal.throwIfAborted();
    const source=await this.source(path,stage);
    const limitation=stage.request.stageKind==="input-unavailable"?await this.limitation(path,stage):null;
    const value=limitation?{kind:"stop_input_limitation",digest:modelInputValueDigest(limitation)}:{kind:"stop_source_recorded",id:source.id};
    if(stage.result?.completeness!=="complete"||stage.result.outcome!=="returned"||modelInputValueDigest(stage.result.value)!==modelInputValueDigest(value))
      throw new TypeError("stop_local_result_invalid");
    if(limitation)return {progress:{kind:"helarc_stop_input_unavailable",sourceId:source.id,rawResultId:stage.result.id,limitation},next:[]};
    const need={id:`${path.intent.id}:input-need`,supplier:HELARC_STOP_MODEL_PURPOSE.inputOwner,
      stage:{id:`${path.intent.id}:model`,pathId:path.intent.id,stageKind:"model",capabilities:["model-request"],dependencies:[]},
      unavailableStage:{id:`${path.intent.id}:input-unavailable`,pathId:path.intent.id,stageKind:"input-unavailable",capabilities:[],dependencies:[]}};
    return {progress:{kind:"helarc_stop_input_needed",sourceId:source.id,inputNeedId:need.id},next:[],
      participants:[{owner:"activity",kind:"input_need",proposal:need}]};
  }
  prepareRetry(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal) {
    return stage.request.stageKind==="model"?this.execution.prepareRetry(path,stage,signal):Promise.resolve(null);
  }
  async settle(_path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal) {
    signal.throwIfAborted();
    return {disposition:{kind:"retained_stop_result",resultId:stage.result!.id,assessmentAccepted:false},
      participants:stage.request.stageKind==="model"?[{owner:"context_delivery",kind:"release_selection",proposal:{inputId:`${stage.request.id}:input`,basis:"stop_consumer_closed"}}]:[]};
  }
  private async interpretModel(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal,acceptance:{id:string}) {
    signal.throwIfAborted();
    if(stage.result?.completeness!=="complete"||stage.result.outcome!=="returned")throw new TypeError("stop_response_unsettled");
    const source=await this.source(path,stage),prepared=stage.request.input as PreparedContextInput,result=stage.result.value as ProviderCallResult;
    if(!result||!["succeeded","failed","cancelled","cancellation_unconfirmed","continuation_rejected"].includes(result.kind))throw new TypeError("stop_transport_result_invalid");
    const inputId=`${stage.request.id}:input`;
    const binding=await this.ports.selections.command({kind:"binding",inputId,checkCurrentControl:false}) as ContextSelectionSnapshot;
    if(binding.scope.runId!==path.intent.runId||binding.input.activityId!==path.intent.id||binding.input.stageRequestId!==stage.request.id||
      modelInputValueDigest(binding.input.exactInput)!==modelInputValueDigest(prepared))throw new TypeError("stop_original_input_changed");
    const recovery=await prepareModelInputRecovery({activities:this.ports.activities,path,stage,sourceStageId:`${path.intent.id}:source`,acceptanceId:acceptance.id,now:this.ports.now()});
    if(recovery)return recovery;
    const {assessment,failure}=interpretHelarcStopModelOutcome(source,result,stage.result.recordedAt);
    const participants:SharedAcceptancePart[]=result.kind==="succeeded"?[{owner:"context_delivery",kind:"accept",proposal:{inputId,responseId:stage.result.id,
      detailHolds:binding.deliveries.flatMap(d=>d.detailHoldId?[d.detailHoldId]:[])}}]:
      [{owner:"context_delivery",kind:"release_selection",proposal:{inputId,basis:"stop_model_without_accepted_response"}}];
    return {progress:{kind:"helarc_stop_model_result",sourceId:source.id,rawResultId:stage.result.id,inputId,assessment,failure} satisfies HelarcStopModelProgress,next:[],participants};
  }
  private async limitation(path:ActivityPathState,stage:ActivityStageState):Promise<ContextInputUnavailability> {
    const value=stage.request.input as ContextInputUnavailability;validateContextInputUnavailability(value);
    const need=await this.ports.activities.command({kind:"read_stage_input_need",requestId:stage.request.id}) as import("@agent-anything/agent-runtime/activity").ActivityInputNeed|null;
    if(!need||stage.request.id!==need.unavailableStage.id||need.stage.pathId!==path.intent.id||stage.request.capabilities.length||value.needId!==need.id||
      value.supplier!==HELARC_STOP_MODEL_PURPOSE.inputOwner)throw new TypeError("stop_input_limitation_changed");
    return value;
  }
  private async source(path:ActivityPathState,stage:ActivityStageState):Promise<HelarcStopModelSource> {
    const original=stage.request.stageKind==="source"?stage:await this.ports.activities.command({kind:"read_stage",requestId:`${path.intent.id}:source`}) as ActivityStageState|null;
    if(!original||original.request.id!==`${path.intent.id}:source`||original.request.pathId!==path.intent.id||original.request.stageKind!=="source"||
      (stage.request.stageKind!=="source"&&original.status!=="accepted"))throw new TypeError("stop_original_source_unavailable");
    const value=original.request.input as HelarcStopModelSource;validateHelarcStopModelSource(value);snapshotProviderRequest(value.request);
    if(value.event.run.id!==path.intent.runId)throw new TypeError("stop_source_run_changed");
    return value;
  }
}

export function interpretHelarcStopModelOutcome(source:HelarcStopModelSource,result:ProviderCallResult,recordedAt:string):Pick<HelarcStopModelProgress,"assessment"|"failure"> {
  if(!result||!["succeeded","failed","cancelled","cancellation_unconfirmed","continuation_rejected"].includes(result.kind))throw new TypeError("stop_transport_result_invalid");
  if(result.kind!=="succeeded")return {assessment:null,failure:result};
  try {return {assessment:interpretHelarcStopModelResult(source,result,recordedAt),failure:null};}
  catch(error) {if(!(error instanceof TypeError))throw error;return {assessment:null,failure:{code:"stop_response_invalid",message:error.message}};}
}

export class HelarcStopModelWork {
  readonly purpose;
  constructor(registry:ActivityPurposeRegistry<ActivityPurposeHandler>,ports:Ports) {
    this.purpose=registry.register(HELARC_STOP_MODEL_PURPOSE,new HelarcStopModelPath(ports));
  }
  prepareSubmission(identity:Omit<ActivityPathIntent,"owner"|"purpose">,source:HelarcStopModelSource,schedule:ActivitySchedulingIntent):readonly SharedAcceptancePart[] {
    validateHelarcStopModelSource(source);snapshotProviderRequest(source.request);
    if(identity.runId!==source.event.run.id||schedule.runId!==identity.runId||schedule.owner!==HELARC_STOP_MODEL_PURPOSE.acceptanceOwner||
      schedule.workId!==identity.scheduledWorkId||schedule.delegatedPathOwners?.length||schedule.allowedPathIds?.length!==1||schedule.allowedPathIds[0]!==identity.id)
      throw new TypeError("stop_submission_scope_changed");
    return [{owner:"activity",kind:"scheduling_acceptance",proposal:{kind:"schedule_work",intent:schedule,expectedRevision:0}},
      {owner:"activity",kind:"path_opening",proposal:{...identity,purpose:this.purpose,owner:HELARC_STOP_MODEL_PURPOSE.acceptanceOwner}},
      {owner:"activity",kind:"stage_submission",proposal:{id:`${identity.id}:source`,pathId:identity.id,stageKind:"source",input:source,capabilities:[],dependencies:[]}},
      {owner:"activity",kind:"scheduling_path_seal",proposal:{kind:"seal_scheduled_paths",workId:schedule.workId,expectedRevision:1,basis:`${identity.id}:submission`}},
      {owner:"activity",kind:"reconsideration_subscription",proposal:{id:`${identity.id}:stop-lifecycle`,runId:identity.runId,
        owner:HELARC_STOP_MODEL_PURPOSE.acceptanceOwner,binding:{kind:"activity_path",id:identity.id},
        sources:[activityFactSourceId("control",identity.id),activityFactSourceId("progress",identity.id),activityFactSourceId("scheduling",schedule.workId)]}}];
  }
}
