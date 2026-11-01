import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import type {ActivityHandoffPort, ActivityPathState, ActivityStageState} from "../activity/ActivityHandoff.js";
import {TASK_MODEL_RESPONSE_PURPOSE, type TaskModelSource, type TaskModelResponseProgress, type TaskModelResponseSettlement,type TaskInputUnavailableProgress} from "./TaskModelResponsePath.js";
import {validateContextInputUnavailability,type ContextInputUnavailability} from "../context-representation/ContextInputUnavailability.js";
import {validateTaskDecisionSource} from "./TaskDecisionSourceRecord.js";
import {TaskResponseBindingError} from "./TaskResponseBindingError.js";
import {validateSelectedResultPresentationInput, validateSelectedResultPresentationResponse} from "./SelectedResultPresentation.js";
import {snapshotProviderResponse, type ProviderCallResult} from "@agent-anything/model-interaction";
import {validateTaskModelResponseRejectionRaw} from "./TaskModelResponseRejection.js";
import type {PreparedContextInput} from "../context-representation/ContextInputPreparation.js";
import {readCurrentModelInputNeed} from "../model-access/ModelInputRecovery.js";

export interface TaskModelResponseHandoff {
  readonly kind: "task_model_response_handoff";
  readonly runId: string;
  readonly pathId: string;
  readonly sourceId: string;
  readonly sourceBindingDigest: string;
  readonly controllerRequestId: string;
  readonly purposeDigest: string;
}
export type TaskModelResponseObservation<T = unknown> = {
  /** Observed control only; it is not permission to apply the returned task decision. */
  readonly control: {readonly revision: number; readonly cancelled: boolean};
} & (
  | {readonly kind: "pending"; readonly stage: ActivityStageState | null}
  | {readonly kind: "consumer_closed"; readonly stage: ActivityStageState | null}
  | {readonly kind:"input_unavailable";readonly stage:ActivityStageState;readonly progress:TaskInputUnavailableProgress}
  | {readonly kind: "accepted" | "settled_response"; readonly stage: ActivityStageState; readonly progress: TaskModelResponseProgress<T>}
);

export function createTaskModelResponseHandoff(pathId: string, source: TaskModelSource): TaskModelResponseHandoff {
  validateTaskDecisionSource(source.record);
  if (!pathId.trim() || source.request.correlation?.controllerRequestId !== source.record.source.toolExposure.controllerRequestId)
    throw new TaskResponseBindingError("task_response_handoff_invalid");
  return Object.freeze({kind: "task_model_response_handoff", pathId, runId: source.record.source.runId, sourceId: source.record.id,
    sourceBindingDigest: sourceBindingDigest(source),
    controllerRequestId: source.record.source.toolExposure.controllerRequestId, purposeDigest: modelInputValueDigest(TASK_MODEL_RESPONSE_PURPOSE)});
}

/** Reads original accepted work. Current task applicability is checked by its consumer, not by this reader. */
export async function readTaskModelResponseHandoff<T = unknown>(activities: ActivityHandoffPort,
  handoff: TaskModelResponseHandoff): Promise<TaskModelResponseObservation<T>> {
  if (handoff?.kind !== "task_model_response_handoff" || !handoff.pathId || !handoff.runId ||
    handoff.purposeDigest !== modelInputValueDigest(TASK_MODEL_RESPONSE_PURPOSE))
    throw new TaskResponseBindingError("task_response_handoff_invalid");
  const path = await activities.command({kind: "read_path", pathId: handoff.pathId}) as ActivityPathState | null;
  if (!path || path.intent.runId !== handoff.runId || path.intent.owner !== TASK_MODEL_RESPONSE_PURPOSE.acceptanceOwner ||
    path.intent.purpose.digest !== handoff.purposeDigest || modelInputValueDigest(path.intent.purpose.contract) !== handoff.purposeDigest)
    throw new TaskResponseBindingError("task_response_original_path_unavailable");
  const source = await activities.command({kind: "read_stage", requestId: `${handoff.pathId}:source`}) as ActivityStageState | null;
  if (!source || source.request.id !== `${handoff.pathId}:source` || source.request.pathId !== handoff.pathId || source.request.stageKind !== "source")
    throw new TaskResponseBindingError("task_response_original_source_unavailable");
  const original = source.request.input as TaskModelSource;
  if (original?.kind !== "task_model_source") throw new TaskResponseBindingError("task_source_contract_invalid");
  validateTaskDecisionSource(original.record);
  if (original.record.id !== handoff.sourceId || sourceBindingDigest(original) !== handoff.sourceBindingDigest || original.record.source.runId !== handoff.runId ||
    original.record.source.toolExposure.controllerRequestId !== handoff.controllerRequestId ||
    original.request.correlation?.controllerRequestId !== handoff.controllerRequestId)
    throw new TaskResponseBindingError("task_response_handoff_source_changed");
  const control = {revision: path.controlRevision, cancelled: path.cancelled};
  const need=await readCurrentModelInputNeed(activities,path,`${handoff.pathId}:input-need`,source.request.id);
  if(!need&&source.status==="accepted")throw new TaskResponseBindingError("task_response_input_need_missing");
  const stage = need?await activities.command({kind: "read_stage", requestId: need.stage.id}) as ActivityStageState | null:null;
  const unavailable=need?await activities.command({kind:"read_stage",requestId:need.unavailableStage.id}) as ActivityStageState|null:null;
  if(stage&&unavailable)throw new TaskResponseBindingError("task_input_outcomes_conflict");
  if(unavailable) {
    const entry=unavailable.request,limitation=entry.input as ContextInputUnavailability;
    validateContextInputUnavailability(limitation);
    if(source.status!=="accepted"||entry.id!==need!.unavailableStage.id||entry.pathId!==handoff.pathId||
      entry.stageKind!=="input-unavailable"||entry.capabilities.length||limitation.needId!==need!.id||
      limitation.supplier!==path.intent.purpose.contract.inputOwner)throw new TaskResponseBindingError("task_input_limitation_binding_changed");
    if(unavailable.status==="accepted") {
      const {receipt,result}=unavailable,progress=receipt?.progress as TaskInputUnavailableProgress|undefined;
      if(!receipt||receipt.owner!==path.intent.owner||receipt.requestId!==entry.id||!result||result.completeness!=="complete"||result.outcome!=="returned"||
        receipt.resultId!==result.id||progress?.kind!=="task_input_unavailable"||progress.sourceStageId!==source.request.id||progress.rawResultId!==result.id||
        modelInputValueDigest(progress.limitation)!==modelInputValueDigest(limitation)||
        modelInputValueDigest(result.value)!==modelInputValueDigest({kind:"input_limitation_recorded",digest:modelInputValueDigest(limitation)}))
        throw new TaskResponseBindingError("task_input_limitation_receipt_changed");
      return {kind:"input_unavailable",control,stage:unavailable,progress};
    }
    if(unavailable.status==="settled") {
      const {settlement,result}=unavailable,disposition=settlement?.disposition as TaskModelResponseSettlement<T>|undefined;
      if(!settlement||settlement.owner!==TASK_MODEL_RESPONSE_PURPOSE.recoveryOwner||settlement.requestId!==entry.id||
        !result||settlement.resultId!==result.id||disposition?.kind!=="retained_task_result"||disposition.resultId!==result.id||
        disposition.decisionAccepted!==false||disposition.response!==null)
        throw new TaskResponseBindingError("task_input_limitation_settlement_changed");
    }
    return {kind:path.cancelled||unavailable.status==="settled"?"consumer_closed":"pending",control,stage:unavailable};
  }
  if (stage && (stage.request.id !== need!.stage.id || stage.request.pathId !== handoff.pathId || stage.request.stageKind !== "model" || source.status !== "accepted"))
    throw new TaskResponseBindingError("task_response_handoff_stage_changed");
  if (stage?.status === "accepted" || stage?.status === "settled" && stage.settlement) {
    const settled = stage.status === "settled";
    const disposition = stage.settlement?.disposition as TaskModelResponseSettlement<T> | undefined;
    if (settled && (stage.settlement?.owner !== TASK_MODEL_RESPONSE_PURPOSE.recoveryOwner || stage.settlement.requestId !== stage.request.id ||
        stage.settlement.resultId !== stage.result?.id || disposition?.kind !== "retained_task_result" || disposition.resultId !== stage.result?.id || disposition.decisionAccepted !== false))
      throw new TaskResponseBindingError("task_response_handoff_settlement_changed");
    if (settled && disposition!.response === null) return {kind: "consumer_closed", control, stage};
    const receipt = settled ? stage.settlement : stage.receipt;
    const progress = (settled ? disposition!.response : stage.receipt?.progress) as TaskModelResponseProgress<T> | undefined;
    if (!receipt || stage.result?.completeness !== "complete" || stage.result.outcome !== "returned" || receipt.owner !== TASK_MODEL_RESPONSE_PURPOSE.interpretationOwner ||
      receipt.requestId !== stage.request.id || receipt.resultId !== stage.result.id ||
      progress?.kind !== "task_model_response" || progress.sourceStageId !== source.request.id ||
      progress.rawResultId !== stage.result.id || progress.inputId !== `${stage.request.id}:input` ||
      !["interpreted", "response_incomplete", "response_not_usable", "transport_result"].includes(progress.state) ||
      (progress.state === "interpreted" ? !progress.proposal : progress.proposal !== null))
      throw new TaskResponseBindingError("task_response_handoff_receipt_changed");
    const prepared = stage.request.input as PreparedContextInput | undefined;
    const declared = prepared?.kind === "prepared_context_input" && prepared.demand.contributions.some(contribution =>
      contribution.options.find(option => option.id === prepared.choice[contribution.id])?.resultTextBindings?.length);
    const raw = stage.result.value as ProviderCallResult;
    if(prepared?.kind==="prepared_context_input"&&raw?.kind==="succeeded"&&raw.response?.kind==="native_tool_turn"&&
      raw.response.turn?.finish?.kind==="output_limit"&&!progress.exchange?.responseRejection)
      throw new TaskResponseBindingError("task_response_rejection_missing");
    if (declared && raw?.kind === "succeeded" && (!progress.exchange || !["interpreted", "response_incomplete", "response_not_usable"].includes(progress.state)))
      throw new TaskResponseBindingError("task_response_result_presentation_missing");
    const exchanges = [progress.proposal, progress.exchange].filter(value => value != null);
    for (const exchange of exchanges) {
      const rejection=exchange.responseRejection;
      if(rejection) {
        if(!prepared||raw?.kind!=="succeeded"||exchange.modelItems.length||rejection.runId!==handoff.runId||rejection.requestId!==prepared.request.requestId||
          rejection.controllerRequestId!==handoff.controllerRequestId||rejection.rawResultId!==stage.result.id||rejection.responseAcceptanceId!==receipt.id||
          progress.state!==(rejection.reason==="output_limit"?"response_incomplete":"response_not_usable"))
          throw new TaskResponseBindingError("task_response_rejection_binding_changed");
        validateTaskModelResponseRejectionRaw(rejection,raw.response,prepared.request);
      }
      const presentation = exchange.resultPresentationReceipt;
      if (declared && !presentation) throw new TaskResponseBindingError("task_response_result_presentation_missing");
      if (presentation) {
        if (!prepared || presentation.inputId !== progress.inputId) throw new TaskResponseBindingError("task_response_result_presentation_changed");
        validateSelectedResultPresentationInput(presentation, original.request, prepared, stage.result.id, receipt.id);
        if (raw?.kind !== "succeeded" || (!rejection&&(raw.response.kind !== "native_tool_turn" || raw.response.turn.finish.kind === "output_limit" ||
            raw.response.turn.responseRef.requestId !== presentation.requestId || modelInputValueDigest(snapshotProviderResponse(raw.response)) !== presentation.responseDigest)))
          throw new TaskResponseBindingError("task_response_result_presentation_response_changed");
        validateSelectedResultPresentationResponse(presentation, exchange.modelItems, rejection);
      }
    }
    if (progress.proposal && progress.exchange &&
        modelInputValueDigest(progress.proposal.resultPresentationReceipt ?? null) !== modelInputValueDigest(progress.exchange.resultPresentationReceipt ?? null))
      throw new TaskResponseBindingError("task_response_result_presentation_changed");
    return {kind: settled ? "settled_response" : "accepted", control, stage, progress};
  }
  return {kind: path.cancelled || stage?.status === "settled" ? "consumer_closed" : "pending", control, stage};
}

function sourceBindingDigest(source: TaskModelSource): string {
  return modelInputValueDigest({sourceId: source.record.id, request: source.request, protocol: source.protocol});
}
