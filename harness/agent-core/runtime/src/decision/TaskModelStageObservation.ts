import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import type {ActivityPathState,ActivityStageState} from "../activity/ActivityHandoff.js";
import type {TaskModelSource,TaskModelResponseProgress,TaskModelResponseSettlement} from "./TaskModelResponsePath.js";

/** Read-only evidence from the original task-purpose records, never a new interpretation. */
export function taskModelStageObservation(path:ActivityPathState,stage:ActivityStageState) {
  const runId=path.intent.runId;
  if(stage.request.pathId!==path.intent.id||modelInputValueDigest(path.intent.purpose.contract)!==path.intent.purpose.digest)throw new TypeError("task_observation_scope_invalid");
  const owned=path.intent.purpose.contract.interpretationOwner==="task-decision";
  const source=stage.request.input as TaskModelSource|null;
  const settlement=stage.settlement?.disposition as TaskModelResponseSettlement|undefined;
  const response=(stage.receipt?.progress??(settlement?.kind==="retained_task_result"?settlement.response:null)) as TaskModelResponseProgress|null;
  const task=response?.kind==="task_model_response"?response:null;
  return {scope:{runId,pathId:stage.request.pathId,stageId:stage.request.id,purpose:path.intent.purpose,revision:modelInputValueDigest(stage)},coverage:{source:owned,response:owned},
    source:owned&&source?.kind==="task_model_source"?source.request:null,
    delivery:owned&&task?(task.proposal?.inputDeliveryReceipt??task.exchange?.inputDeliveryReceipt??null):null,
    presentation:owned?task?.exchange?.resultPresentationReceipt??null:null};
}
export type TaskModelStageObservation=ReturnType<typeof taskModelStageObservation>;
