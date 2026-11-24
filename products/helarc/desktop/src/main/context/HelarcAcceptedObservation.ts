import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {protocolObservationStage,type ProtocolExecutionState,type ProtocolObservationReceipt} from "@agent-anything/agent-runtime/model-access";
import type {ActivitySnapshot} from "@agent-anything/agent-runtime/activity";

export const helarcObservationPathId=(activityId:string)=>activityId+":scheduled-observation";

/** Locate an existing receipt, never reconstruct one from the task's terminal status. */
export function helarcAcceptedObservation(state:ProtocolExecutionState,read:(pathId:string,stageId:string)=>ActivitySnapshot):ProtocolObservationReceipt|null{
  const {activityId,runId}=state.activity.scope,pathId=helarcObservationPathId(activityId),stageId=pathId+":observe";
  const {path,stages:[stage]}=read(pathId,stageId);
  if(!path||path.cancelled||!stage||stage.status!=="accepted")return null;
  const original=protocolObservationStage(path,stage);
  if(!original?.limitation)return null;
  const receipt=stage.receipt;
  if(path.intent.id!==pathId||path.intent.runId!==runId||original.activityId!==activityId||
    original.compositionDigest!==state.activity.composition.digest||digest(original.input)!==digest(state.input)||
    stage.request.id!==stageId||!receipt||receipt.owner!==path.intent.purpose.contract.acceptanceOwner||
    receipt.requestId!==stageId||receipt.resultId!==stage.result?.id||stage.result.outcome!=="returned"||stage.result.completeness!=="complete"||
    digest(receipt.progress)!==digest(original.limitation)||digest(path.progress)!==digest(original.limitation))
    throw new TypeError("native_observation_receipt_changed");
  return {stageId,receiptId:receipt.id,limitation:original.limitation};
}
