import {snapshotProviderFailure,type ProviderCallResult} from "@agent-anything/model-interaction";
import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import type {ActivityHandoffPort,ActivityInputNeed,ActivityPathState,ActivityStageState} from "../activity/ActivityHandoff.js";
import type {SharedAcceptancePart} from "../activity/SharedAcceptance.js";
import {validatePreparedContextInput,type PreparedContextInput} from "../context-representation/ContextInputPreparation.js";

export interface RejectedModelInput {
  readonly stageId:string;
  readonly rawResultId:string;
  readonly acceptanceId:string;
  readonly inputId:string;
  readonly encodedInputId:string;
  readonly targetDigest:string;
  readonly bodyDigest:string;
}
export interface ModelInputRecoveryProgress {
  readonly kind:"model_input_recovery";
  readonly sourceStageId:string;
  readonly previousNeedId:string;
  readonly rejected:RejectedModelInput;
  readonly nextNeed:ActivityInputNeed;
}

function rejected(stage:ActivityStageState,acceptanceId:string):RejectedModelInput|null {
  if(stage.result?.completeness!=="complete"||stage.result.outcome!=="returned")return null;
  const result=stage.result.value as ProviderCallResult;
  if(result?.kind!=="failed")return null;
  const failure=snapshotProviderFailure(result.failure);
  if(failure.code!=="provider_context_window_exceeded")return null;
  const prepared=stage.request.input as PreparedContextInput;validatePreparedContextInput(prepared);
  return {stageId:stage.request.id,rawResultId:stage.result.id,acceptanceId,inputId:`${stage.request.id}:input`,
    encodedInputId:prepared.encoded.id,targetDigest:prepared.encoded.targetDigest,bodyDigest:prepared.encoded.bodyDigest};
}

function recoveryNeed(previous:ActivityInputNeed,stageId:string,receiptId:string):ActivityInputNeed {
  const id=`${stageId}:input-recovery`;
  return {id,supplier:previous.supplier,origin:{requestId:stageId,receiptId},
    stage:{...previous.stage,id:`${id}:model`},unavailableStage:{...previous.unavailableStage,id:`${id}:unavailable`}};
}

/** A new input need in the original work, not another task or a retry of the rejected bytes. */
export async function prepareModelInputRecovery(input:{activities:ActivityHandoffPort;path:ActivityPathState;stage:ActivityStageState;
  sourceStageId:string;acceptanceId:string;now:string}) {
  const {path,stage}=input,evidence=rejected(stage,input.acceptanceId);
  if(!evidence||path.cancelled||path.resourceUse.admittedStages>=path.intent.maximumStages||
    path.resourceUse.dispatchedAttempts>=path.intent.maximumAttempts||Date.parse(input.now)>=Date.parse(path.intent.deadlineAt))return null;
  const previous=await input.activities.command({kind:"read_stage_input_need",requestId:stage.request.id}) as ActivityInputNeed|null;
  if(!previous||previous.stage.id!==stage.request.id||previous.stage.pathId!==path.intent.id||
    previous.supplier!==path.intent.purpose.contract.inputOwner)throw new TypeError("model_input_recovery_original_need_missing");
  const nextNeed=recoveryNeed(previous,stage.request.id,input.acceptanceId);
  const progress:ModelInputRecoveryProgress={kind:"model_input_recovery",sourceStageId:input.sourceStageId,previousNeedId:previous.id,rejected:evidence,nextNeed};
  const participants:SharedAcceptancePart[]=[{owner:"activity",kind:"input_need",proposal:nextNeed},
    {owner:"context_delivery",kind:"release_selection",proposal:{inputId:evidence.inputId,basis:"provider_input_rejected"}}];
  return {progress,next:[],participants};
}

export function validateModelInputRecoveryStage(path:ActivityPathState,stage:ActivityStageState,sourceStageId:string):ModelInputRecoveryProgress {
  const receipt=stage.receipt,progress=receipt?.progress as ModelInputRecoveryProgress|undefined;
  if(stage.request.pathId!==path.intent.id||stage.status!=="accepted"||receipt?.owner!==path.intent.purpose.contract.acceptanceOwner||
    receipt.requestId!==stage.request.id||receipt.resultId!==stage.result?.id||progress?.kind!=="model_input_recovery"||
    progress.sourceStageId!==sourceStageId||digest(progress.rejected)!==digest(rejected(stage,receipt.id))||
    progress.nextNeed.origin?.requestId!==stage.request.id||progress.nextNeed.origin.receiptId!==receipt.id||
    progress.nextNeed.supplier!==path.intent.purpose.contract.inputOwner||progress.nextNeed.stage.pathId!==path.intent.id||
    progress.nextNeed.unavailableStage.pathId!==path.intent.id)throw new TypeError("model_input_recovery_receipt_changed");
  return progress;
}

/** The input supplier rechecks the accepted ancestry rather than trusting a new request's summary. */
export async function readModelInputRejections(activities:ActivityHandoffPort,path:ActivityPathState,need:ActivityInputNeed,sourceStageId:string):Promise<readonly RejectedModelInput[]> {
  const result:RejectedModelInput[]=[],seen=new Set<string>();let current=need;
  while(current.origin) {
    if(seen.has(current.id)||seen.size>=path.intent.maximumStages)throw new TypeError("model_input_recovery_chain_invalid");seen.add(current.id);
    const stage=await activities.command({kind:"read_stage",requestId:current.origin.requestId}) as ActivityStageState|null;
    if(!stage)throw new TypeError("model_input_recovery_original_result_missing");
    const progress=validateModelInputRecoveryStage(path,stage,sourceStageId);
    if(digest(progress.nextNeed)!==digest(current))throw new TypeError("model_input_recovery_need_changed");
    const previous=await activities.command({kind:"read_input_need",id:progress.previousNeedId}) as ActivityInputNeed|null;
    if(!previous||previous.stage.id!==stage.request.id||previous.stage.pathId!==path.intent.id||previous.supplier!==current.supplier||
      digest(recoveryNeed(previous,stage.request.id,stage.receipt!.id))!==digest(current))
      throw new TypeError("model_input_recovery_previous_need_changed");
    result.unshift(progress.rejected);current=previous;
  }
  return result;
}

/** Observe the original consumer's current need; intermediate recovery acceptance is not its final response. */
export async function readCurrentModelInputNeed(activities:ActivityHandoffPort,path:ActivityPathState,initialNeedId:string,sourceStageId:string):Promise<ActivityInputNeed|null> {
  let need=await activities.command({kind:"read_input_need",id:initialNeedId}) as ActivityInputNeed|null;
  const seen=new Set<string>();
  while(need) {
    if(seen.has(need.id)||seen.size>=path.intent.maximumStages)throw new TypeError("model_input_recovery_chain_invalid");seen.add(need.id);
    if(need.stage.pathId!==path.intent.id||need.unavailableStage.pathId!==path.intent.id||need.supplier!==path.intent.purpose.contract.inputOwner)
      throw new TypeError("model_input_recovery_need_changed");
    const stage=await activities.command({kind:"read_stage",requestId:need.stage.id}) as ActivityStageState|null;
    if(stage?.status!=="accepted"||(stage.receipt?.progress as {kind?:string})?.kind!=="model_input_recovery")return need;
    const progress=validateModelInputRecoveryStage(path,stage,sourceStageId);
    if(progress.previousNeedId!==need.id||digest(recoveryNeed(need,stage.request.id,stage.receipt!.id))!==digest(progress.nextNeed))
      throw new TypeError("model_input_recovery_previous_need_changed");
    const next=await activities.command({kind:"read_input_need",id:progress.nextNeed.id}) as ActivityInputNeed|null;
    if(!next||digest(next)!==digest(progress.nextNeed))throw new TypeError("model_input_recovery_successor_missing");need=next;
  }
  return null;
}
