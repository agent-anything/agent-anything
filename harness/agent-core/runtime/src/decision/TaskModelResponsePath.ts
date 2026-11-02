import type {AgentDefinition} from "@agent-anything/agent-core/agent";
import {snapshotProviderRequest,snapshotProviderResponse,type Provider,type ProviderRequest,type ProviderCallResult,type ProviderDeliveryObserver} from "@agent-anything/model-interaction";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import type {ContextSelectionPort,ContextSelectionSnapshot} from "@agent-anything/context/selection";
import {ActivityPurposeRegistry,type ActivityPurposeContract,type ActivityPurposeBinding} from "../activity/ActivityPurpose.js";
import type {ActivityPurposeHandler} from "../activity/ActivityHandoffProcessor.js";
import type {ActivityHandoffPort,ActivityPathIntent,ActivityPathState,ActivityStageState,ActivityAttempt,ActivityRawResult} from "../activity/ActivityHandoff.js";
import type {SharedAcceptancePart} from "../activity/SharedAcceptance.js";
import {PreparedInputExecution} from "../context-representation/PreparedInputExecution.js";
import {MODEL_ATTEMPT_RETRY} from "../model-access/ProviderAttemptRecovery.js";
import {prepareModelInputRecovery} from "../model-access/ModelInputRecovery.js";
import type {PreparedContextInput} from "../context-representation/ContextInputPreparation.js";
import {validateContextInputUnavailability,type ContextInputUnavailability} from "../context-representation/ContextInputUnavailability.js";
import {ModelResponseTaskDecisionMaker,type InterpretTaskResponse,type TaskResponseProtocol} from "./ModelResponseTaskDecisionMaker.js";
import {restoreTaskDecisionSource,validateTaskDecisionSource,type TaskDecisionSourceRecord} from "./TaskDecisionSourceRecord.js";
import {TaskDecisionActivityError} from "./TaskDecisionActivityError.js";
import {StructuredOutputError} from "./StructuredOutput.js";
import {TaskResponseBindingError} from "./TaskResponseBindingError.js";
import type {TaskDecisionProposal,TaskModelExchange} from "./TaskDecisionActivity.js";
import {createControllerModelItems} from "./TaskDecisionModelItems.js";
import {createSelectedInputDeliveryReceipt} from "./SelectedInputDelivery.js";
import {createSelectedResultPresentationReceipt} from "./SelectedResultPresentation.js";
import {createConversationOpeningReceipt} from "./TaskConversation.js";
import {snapshotTaskModelExchange,validateTaskDecisionProposal} from "./TaskDecisionValidation.js";
import {createTaskModelResponseRejection, type TaskModelResponseRejection} from "./TaskModelResponseRejection.js";
import {TaskModelResponseLifecycle} from "./TaskModelResponseLifecycle.js";
import {activityFactSourceId} from "../activity/ActivityReconsideration.js";

export const TASK_MODEL_RESPONSE_PURPOSE:ActivityPurposeContract={
  ref:{id:"task.model-response",revision:"3"},inputOwner:"context-representation",executionOwner:"model-access",interpretationOwner:"task-decision",
  acceptanceOwner:"task-decision",recoveryOwner:"task-decision",stageKinds:["source","model","input-unavailable"],capabilities:["model-request"],continuationKinds:[],
  attemptRetry:MODEL_ATTEMPT_RETRY,
};
export interface TaskInputUnavailableProgress {
  readonly kind:"task_input_unavailable";
  readonly sourceStageId:string;
  readonly rawResultId:string;
  readonly limitation:ContextInputUnavailability;
}
export interface TaskModelSource {
  readonly kind:"task_model_source";
  readonly record:TaskDecisionSourceRecord;
  readonly request:ProviderRequest;
  readonly protocol:TaskResponseProtocol;
}
export interface TaskModelResponseProgress<T=unknown> {
  readonly kind:"task_model_response";
  readonly sourceStageId:string;
  readonly rawResultId:string;
  readonly inputId:string;
  readonly state:"interpreted"|"response_incomplete"|"response_not_usable"|"transport_result";
  readonly proposal:TaskDecisionProposal<T>|null;
  readonly failure:unknown;
  readonly exchange?:TaskModelExchange|null;
}
export interface TaskModelResponseSettlement<T=unknown> {
  readonly kind:"retained_task_result";
  readonly resultId:string;
  readonly decisionAccepted:false;
  readonly response:TaskModelResponseProgress<T>|null;
}
interface Ports<T> {
  readonly provider:Provider;
  readonly activities:ActivityHandoffPort;
  readonly selections:ContextSelectionPort;
  readonly authorize:ActivityPurposeHandler["authorize"];
  readonly resolveAgent:(definition:TaskDecisionSourceRecord["source"]["agent"])=>AgentDefinition<T>|Promise<AgentDefinition<T>>;
  readonly interpret:InterpretTaskResponse<T>;
  readonly observer?:ProviderDeliveryObserver | ((path:ActivityPathState,stage:ActivityStageState,attempt:ActivityAttempt,signal:AbortSignal)=>ProviderDeliveryObserver);
  readonly interpreted?:(path:ActivityPathState,stage:ActivityStageState,proposal:TaskDecisionProposal<T>|null)=>void;
  readonly requestObserved?:(source:TaskDecisionSourceRecord,request:ProviderRequest)=>void;
  readonly now:()=>string;
}

/** Task interpretation owns neither input choice nor retries, model slots or operation execution. */
export class TaskModelResponsePath<T=unknown> implements ActivityPurposeHandler {
  private readonly execution:PreparedInputExecution;
  constructor(private readonly ports:Ports<T>) {
    this.execution=new PreparedInputExecution({provider:ports.provider,selections:ports.selections,inputId:s=>`${s.request.id}:input`,
      authorize:ports.authorize,now:ports.now,observer:ports.observer,interpret:(...args)=>this.interpretModel(...args)});
  }
  async authorize(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal,action:Parameters<ActivityPurposeHandler["authorize"]>[3]):ReturnType<ActivityPurposeHandler["authorize"]> {
    if(path.intent.purpose.digest!==modelInputValueDigest(TASK_MODEL_RESPONSE_PURPOSE))throw new TaskResponseBindingError("task_response_purpose_unavailable");
    const original=await this.source(path,stage);
    if(original.record.source.runId!==path.intent.runId)throw new TaskResponseBindingError("task_response_source_scope_changed");
    if(stage.request.stageKind==="model") {
      const prepared=stage.request.input as PreparedContextInput;
      if(prepared.request.correlation?.controllerRequestId!==original.record.source.toolExposure.controllerRequestId||prepared.demand.runId!==path.intent.runId)
        throw new TaskResponseBindingError("task_response_source_request_changed");
      if(modelInputValueDigest(prepared.request.interaction)!==modelInputValueDigest(original.request.interaction)||
        modelInputValueDigest(prepared.request.instructions)!==modelInputValueDigest(original.request.instructions)||
        modelInputValueDigest(prepared.request.metadata)!==modelInputValueDigest(original.request.metadata)||
        prepared.request.purpose!==original.request.purpose)
        throw new TaskResponseBindingError("task_response_fixed_protocol_changed");
      return this.execution.authorize(path,stage,signal,action);
    } else {
      if(stage.request.stageKind==="input-unavailable")await this.limitation(path,stage);
      return this.ports.authorize(path,stage,signal,action);
    }
  }
  async execute(path:ActivityPathState,stage:ActivityStageState,attempt:ActivityAttempt,signal:AbortSignal,timing?:ActivityWorkTiming):Promise<ActivityRawResult> {
    if(stage.request.stageKind==="model") {
      if(this.ports.requestObserved) {
        const original=await this.source(path,stage);
        try {
          const result:unknown=this.ports.requestObserved(original.record,(stage.request.input as PreparedContextInput).request);
          if(result&&typeof (result as PromiseLike<unknown>).then==="function")void Promise.resolve(result).catch(()=>{});
        } catch { /* Observation does not authorize or change the accepted input. */ }
      }
      return this.execution.execute(path,stage,attempt,signal,timing);
    }
    if(stage.request.stageKind==="input-unavailable") {
      signal.throwIfAborted();const limitation=await this.limitation(path,stage);
      return {id:`${attempt.id}:raw`,attemptId:attempt.id,outcome:"returned",completeness:"complete",value:{kind:"input_limitation_recorded",digest:modelInputValueDigest(limitation)},usage:{},recordedAt:this.ports.now()};
    }
    signal.throwIfAborted();const source=await this.source(path,stage);
    return {id:`${attempt.id}:raw`,attemptId:attempt.id,outcome:"returned",completeness:"complete",value:{kind:"task_source_recorded",id:source.record.id},usage:{},recordedAt:this.ports.now()};
  }
  async reconcile(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal):Promise<ActivityRawResult|null> {
    return stage.request.stageKind!=="model"?this.execute(path,stage,stage.attempt!,signal):null;
  }
  prepareRetry(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal) {
    return stage.request.stageKind==="model"?this.execution.prepareRetry(path,stage,signal):Promise.resolve(null);
  }
  async interpret(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal,acceptance:{id:string}) {
    if(stage.request.stageKind==="model") {
      const result=await this.execution.interpret(path,stage,signal,acceptance);
      const progress=result.progress as TaskModelResponseProgress<T>;
      try {
        const observed:unknown=this.ports.interpreted?.(path,stage,progress.kind==="task_model_response"&&progress.state==="interpreted"?progress.proposal:null);
        if(observed&&typeof (observed as PromiseLike<unknown>).then==="function")void Promise.resolve(observed).catch(()=>{});
      }catch{/* Observation cannot accept or reject the decision. */}
      return result;
    }
    if(stage.request.stageKind==="input-unavailable") {
      signal.throwIfAborted();const limitation=await this.limitation(path,stage);
      if(stage.result?.completeness!=="complete"||stage.result.outcome!=="returned"||
        modelInputValueDigest(stage.result.value)!==modelInputValueDigest({kind:"input_limitation_recorded",digest:modelInputValueDigest(limitation)}))
        throw new TaskResponseBindingError("task_input_limitation_result_invalid");
      return {progress:{kind:"task_input_unavailable",sourceStageId:`${path.intent.id}:source`,rawResultId:stage.result.id,limitation} satisfies TaskInputUnavailableProgress,next:[]};
    }
    signal.throwIfAborted();const original=await this.source(path,stage);
    if(stage.result?.completeness!=="complete"||stage.result.outcome!=="returned"||
      modelInputValueDigest(stage.result.value)!==modelInputValueDigest({kind:"task_source_recorded",id:original.record.id}))
      throw new TaskResponseBindingError("task_source_result_invalid");
    const need={id:`${path.intent.id}:input-need`,supplier:path.intent.purpose.contract.inputOwner,
      stage:{id:`${path.intent.id}:model`,pathId:path.intent.id,stageKind:"model",capabilities:["model-request"],dependencies:[]},
      unavailableStage:{id:`${path.intent.id}:input-unavailable`,pathId:path.intent.id,stageKind:"input-unavailable",capabilities:[],dependencies:[]}};
    return {progress:{kind:"task_input_needed",sourceStageId:stage.request.id,sourceId:original.record.id,inputNeedId:need.id},next:[],
      participants:[{owner:"activity",kind:"input_need",proposal:need}]};
  }
  async settle(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal,acceptance:{readonly id:string}) {
    signal.throwIfAborted();
    // Local interpretation retains an exchange; it cannot advance a cancelled path.
    if(stage.request.stageKind==="model"&&stage.result?.completeness==="complete"&&stage.result.outcome==="returned") {
      const result=await this.interpretModel(path,stage,signal,acceptance);
      if(result.progress.kind==="model_input_recovery")throw new TaskResponseBindingError("task_cancelled_input_recovery_invalid");
      return {disposition:{kind:"retained_task_result",resultId:stage.result.id,decisionAccepted:false,response:result.progress} satisfies TaskModelResponseSettlement<T>,
        participants:result.participants??[{owner:"context_delivery",kind:"release_selection",proposal:{inputId:`${stage.request.id}:input`,basis:"task_consumer_cancelled"}}]};
    }
    return {disposition:{kind:"retained_task_result",resultId:stage.result!.id,decisionAccepted:false,response:null} satisfies TaskModelResponseSettlement<T>,
      participants:stage.request.stageKind==="model"?[{owner:"context_delivery",kind:"release_selection",proposal:{inputId:`${stage.request.id}:input`,basis:"task_consumer_cancelled"}}] as SharedAcceptancePart[]:[]};
  }
  private async interpretModel(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal,acceptance:{id:string}) {
    if(stage.result?.completeness!=="complete"||stage.result.outcome!=="returned")throw new TaskResponseBindingError("task_response_unsettled");
    const original=await this.source(path,stage),prepared=stage.request.input as PreparedContextInput,result=stage.result.value as ProviderCallResult;
    if(!result||!["succeeded","failed","cancelled","cancellation_unconfirmed","continuation_rejected"].includes(result.kind))throw new TaskResponseBindingError("task_transport_result_invalid");
    const progress:TaskModelResponseProgress<T>={kind:"task_model_response",sourceStageId:`${path.intent.id}:source`,rawResultId:stage.result.id,
      inputId:`${stage.request.id}:input`,state:"transport_result",proposal:null,failure:null};
    if(result.kind!=="succeeded") {
      const recovery=await prepareModelInputRecovery({activities:this.ports.activities,path,stage,sourceStageId:`${path.intent.id}:source`,acceptanceId:acceptance.id,now:this.ports.now()});
      if(recovery)return recovery;
      return {progress:{...progress,failure:result},next:[],participants:[{owner:"context_delivery",kind:"release_selection",proposal:{inputId:progress.inputId,basis:"task_model_without_accepted_response"}}] as SharedAcceptancePart[]};
    }
    if(result.response?.kind==="native_tool_turn"&&result.response.turn?.responseRef?.requestId!=null&&result.response.turn.responseRef.requestId!==prepared.request.requestId)
      throw new TaskResponseBindingError("task_response_request_mismatch");
    if(result.response?.kind==="native_tool_turn"&&result.response.turn?.responseRef?.providerId!=null&&result.response.turn.responseRef.providerId!==prepared.request.composition.providerId)
      throw new TaskResponseBindingError("task_response_provider_mismatch");
    signal.throwIfAborted();
    const binding=await this.ports.selections.command({kind:"binding",inputId:progress.inputId,checkCurrentControl:false}) as ContextSelectionSnapshot;
    if(binding.input.id!==progress.inputId||binding.input.activityId!==path.intent.id||binding.input.stageRequestId!==stage.request.id||
      binding.scope.runId!==path.intent.runId||modelInputValueDigest(binding.input.exactInput)!==modelInputValueDigest(prepared))
      throw new TaskResponseBindingError("task_response_original_input_changed");
    const participants:SharedAcceptancePart[]=[{owner:"context_delivery",kind:"accept",proposal:{inputId:binding.input.id,responseId:stage.result.id,
      detailHolds:binding.deliveries.flatMap(d=>d.detailHoldId?[d.detailHoldId]:[])}}];
    if(binding.deliveries.length)participants.push({owner:"material_custody",kind:"holds",proposal:{acquire:[],
      release:binding.deliveries.map(delivery=>delivery.holdId),basis:acceptance.id}});
    const retainedSource=original.record.source;
    let rejectedReason:TaskModelResponseRejection["reason"]|null=null,modelFailure:unknown=null,nativeExchange:TaskModelExchange|null=null;
    if(result.response?.kind==="native_tool_turn"&&result.response.turn?.finish?.kind==="output_limit") rejectedReason="output_limit";
    else if(original.protocol.kind==="native_tool_turn") {
      // Model-turn validation must not be attributed to input presentation or escape as an activity processing failure.
      try {
        if(result.response?.kind!=="native_tool_turn")throw new TypeError("task_native_response_required");
        snapshotProviderResponse(result.response);
        nativeExchange=snapshotTaskModelExchange({modelItems:createControllerModelItems(result.response.turn,{})},retainedSource);
      } catch(error) {
        if(!(error instanceof TypeError)&&!(error instanceof StructuredOutputError))throw error;
        rejectedReason="invalid_turn";
        modelFailure={kind:"model",failure:{code:"model_output_invalid",message:"The original native response is not a valid model turn.",retryable:false,
          metadata:{errorName:error.name}}};
      }
    }
    const responseRejection=rejectedReason?createTaskModelResponseRejection({runId:path.intent.runId,request:prepared.request,response:result.response,
      rawResultId:stage.result.id,responseAcceptanceId:acceptance.id,reason:rejectedReason}):null;
    const inputDeliveryReceipt=createSelectedInputDeliveryReceipt({batch:retainedSource.inputDelivery,binding,response:result.response,
      rawResultId:stage.result.id,responseAcceptanceId:acceptance.id,responseRejection});
    const resultPresentationReceipt=createSelectedResultPresentationReceipt({originalRequest:original.request,binding,response:result.response,
      rawResultId:stage.result.id,responseAcceptanceId:acceptance.id,responseRejection});
    const openingReceipt=retainedSource.interaction.opening?null:createConversationOpeningReceipt(path.intent.runId,prepared.request);
    const receipts={...(inputDeliveryReceipt?{inputDeliveryReceipt}:{}),...(openingReceipt?{openingReceipt}:{}),
      ...(resultPresentationReceipt?{resultPresentationReceipt}:{}),...(responseRejection?{responseRejection}:{})};
    const exchange=responseRejection||nativeExchange?snapshotTaskModelExchange({modelItems:nativeExchange?.modelItems??[],
      ...receipts},retainedSource):null;
    if(responseRejection)return {progress:{...progress,state:rejectedReason==="output_limit"?"response_incomplete" as const:"response_not_usable" as const,
      failure:modelFailure,exchange},next:[],participants};
    const agent=await this.ports.resolveAgent(original.record.source.agent),source=restoreTaskDecisionSource(original.record,agent);
    const maker=new ModelResponseTaskDecisionMaker(original.protocol,this.ports.interpret);
    try {
      const interpreted=await maker.decide({kind:"model_response",source,request:prepared.request,response:result.response,
        activity:{kind:"task_response_interpretation",runId:path.intent.runId,activityId:path.intent.id,purpose:prepared.request.purpose,contract:path.intent.purpose}},{signal});
      const proposal=validateTaskDecisionProposal({...interpreted,...receipts},source);
      return {progress:{...progress,state:"interpreted" as const,proposal,exchange:snapshotTaskModelExchange(proposal,source)},next:[],participants};
    } catch(error) {
      if(error instanceof TaskDecisionActivityError)return {progress:{...progress,state:"response_not_usable" as const,failure:error.failure,exchange},next:[],participants};
      if(error instanceof StructuredOutputError)return {progress:{...progress,state:"response_not_usable" as const,failure:error.failure,exchange},next:[],participants};
      throw error;
    }
  }
  private async limitation(path:ActivityPathState,stage:ActivityStageState):Promise<ContextInputUnavailability> {
    const value=stage.request.input as ContextInputUnavailability;
    validateContextInputUnavailability(value);
    const need=await this.ports.activities.command({kind:"read_stage_input_need",requestId:stage.request.id}) as import("../activity/ActivityHandoff.js").ActivityInputNeed|null;
    if(!need||stage.request.id!==need.unavailableStage.id||need.stage.pathId!==path.intent.id||stage.request.capabilities.length||
      value.needId!==need.id||value.supplier!==path.intent.purpose.contract.inputOwner)
      throw new TaskResponseBindingError("task_input_limitation_binding_changed");
    return value;
  }
  private async source(path:ActivityPathState,stage:ActivityStageState):Promise<TaskModelSource> {
    const original=stage.request.stageKind==="source"?stage:await this.ports.activities.command({kind:"read_stage",requestId:`${path.intent.id}:source`}) as ActivityStageState|null;
    if(!original||original.request.pathId!==path.intent.id||original.request.stageKind!=="source"||
      (stage.request.stageKind!=="source"&&original.status!=="accepted"))throw new TaskResponseBindingError("task_response_original_source_unavailable");
    const input=original.request.input as TaskModelSource;
    if(input?.kind!=="task_model_source"||!["native_tool_turn","structured_output"].includes(input.protocol?.kind))throw new TaskResponseBindingError("task_source_contract_invalid");
    validateTaskDecisionSource(input.record);
    const request=snapshotProviderRequest(input.request);
    if(request.correlation?.controllerRequestId!==input.record.source.toolExposure.controllerRequestId||request.composition.lineage.auxiliary)
      throw new TaskResponseBindingError("task_source_original_request_invalid");
    return {...input,request};
  }
}

export class TaskModelResponseWork<T=unknown> {
  readonly purpose:ActivityPurposeBinding;
  readonly lifecycle:TaskModelResponseLifecycle;
  constructor(registry:ActivityPurposeRegistry<ActivityPurposeHandler>,ports:Ports<T>) {
    this.purpose=registry.register(TASK_MODEL_RESPONSE_PURPOSE,new TaskModelResponsePath(ports));
    this.lifecycle=new TaskModelResponseLifecycle(ports.activities);
  }
  prepareSubmission(identity:Omit<ActivityPathIntent,"purpose"|"owner">,source:TaskModelSource):readonly SharedAcceptancePart[] {
    validateTaskDecisionSource(source.record);
    const request=snapshotProviderRequest(source.request);
    if(source.record.source.runId!==identity.runId)throw new TaskResponseBindingError("task_source_run_mismatch");
    if(request.correlation?.controllerRequestId!==source.record.source.toolExposure.controllerRequestId||request.composition.lineage.auxiliary)
      throw new TaskResponseBindingError("task_source_original_request_invalid");
    return [{owner:"activity",kind:"path_opening",proposal:{...identity,purpose:this.purpose,owner:TASK_MODEL_RESPONSE_PURPOSE.acceptanceOwner}},
      {owner:"activity",kind:"stage_submission",proposal:{id:`${identity.id}:source`,pathId:identity.id,stageKind:"source",input:source,capabilities:[],dependencies:[]}},
      ...(identity.scheduledWorkId?[
        {owner:"activity",kind:"scheduling_path_seal",proposal:{kind:"seal_scheduled_paths",workId:identity.scheduledWorkId,expectedRevision:1,basis:`${identity.id}:submission`}},
        {owner:"activity",kind:"reconsideration_subscription",proposal:{id:`${identity.id}:response-lifecycle`,runId:identity.runId,
          owner:TASK_MODEL_RESPONSE_PURPOSE.acceptanceOwner,binding:{kind:"activity_path",id:identity.id},sources:[
            activityFactSourceId("control",identity.id),activityFactSourceId("progress",identity.id),activityFactSourceId("scheduling",identity.scheduledWorkId)]}}
      ]:[])];
  }
}
import type {ActivityWorkTiming} from "../activity/ActivityWorkTiming.js";
