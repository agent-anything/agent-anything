import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import type {SharedAcceptancePort} from "@agent-anything/agent-runtime/activity";
import type {ProtocolExecutionJournal,ProtocolExecutionState,ProtocolPurposeAcceptance} from "@agent-anything/agent-runtime/model-access";
import type {ContextSelectionPort,ContextSelectionSnapshot} from "@agent-anything/context/selection";
import type {HelarcNativeRunTask} from "./HelarcNativePreparedTask.js";
import type {HelarcRetainedNativeInput} from "./HelarcNativeInputAcceptance.js";

/** A local purpose receipt consumes input delivery, not task progress or material detail. */
export async function acceptHelarcNativeInputReceipt(prepared:HelarcNativeRunTask,accepted:ProtocolPurposeAcceptance,
  ports:{journal:ProtocolExecutionJournal;acceptance:SharedAcceptancePort;selections:ContextSelectionPort}):Promise<void>{
  if(!prepared.selectedInputId)return;
  const inputId=prepared.selectedInputId,activityId=prepared.binding.scope.activityId;
  const state=await ports.journal.command({kind:"state",activityId}) as ProtocolExecutionState|null;
  const original=await ports.journal.command({kind:"acceptance",activityId}) as ProtocolPurposeAcceptance|null;
  if(!state||!original||digest(original)!==digest(accepted)||digest(state.activity.scope)!==digest(prepared.binding.scope)||
    digest(accepted.evidence.scope)!==digest(state.activity.scope))throw new TypeError("native_input_receipt_original_acceptance_changed");
  const id=`${inputId}:purpose-received`,prior=await ports.acceptance.query(id);
  if(prior){if(prior.outcome!=="accepted")throw new TypeError("native_input_receipt_previously_rejected");return;}
  const selected=await ports.selections.command({kind:"binding",inputId,checkCurrentControl:false}) as ContextSelectionSnapshot|null;
  const native=selected?.input.exactInput as HelarcRetainedNativeInput|undefined;
  if(!selected?.input.nativeConsumer||!native||native.kind!=="helarc_native_input"||native.wire.digest!==prepared.wire.digest||
    selected.input.activityId!==activityId||selected.scope.runId!==state.activity.scope.runId||
    selected.scope.recipient!==state.activity.scope.recipientId||selected.scope.purpose!==state.activity.scope.purpose.id||
    digest(state.contextInput)!==digest({id:inputId,digest:digest(native)}))throw new TypeError("native_input_receipt_original_input_changed");
  await ports.selections.command({kind:"sent",inputId,attemptId:prepared.binding.operationId,acceptedResponseId:accepted.evidence.acceptance.id});
  const receipt=await ports.acceptance.accept({id,scope:state.activity.scope.runId,actor:accepted.evidence.interpreter.id,
    parts:[{owner:"context_delivery",kind:"accept",proposal:{inputId,responseId:accepted.evidence.acceptance.id,
      detailHolds:selected.deliveries.flatMap(d=>d.detailHoldId?[d.detailHoldId]:[])}}]});
  if(receipt.outcome!=="accepted")throw new TypeError(`native_context_receipt_rejected:${receipt.rejection?.code}`);
}
