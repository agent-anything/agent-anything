import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import type {ActivityHandoffPort,ActivityInputNeed,ActivityPathState,ActivityStageState} from "../activity/ActivityHandoff.js";
import {readModelInputRejections} from "../model-access/ModelInputRecovery.js";
import type {PreparedContextInput} from "./ContextInputPreparation.js";
import type {InputSupplyBinding} from "./InputSupplyResponsibility.js";
import type {ContextPreparationPolicyInput} from "./ContextPreparationPolicy.js";

/** A confirmed capacity refusal excludes bytes; it says nothing about semantic quality. */
export async function readPreparedInputRejection(activities:ActivityHandoffPort,binding:InputSupplyBinding|undefined,
  prepared:PreparedContextInput):Promise<NonNullable<ContextPreparationPolicyInput["rejectedInputs"]>[number]|null> {
  if(!binding)return null;
  const need=await activities.command({kind:"read_input_need",id:binding.needId}) as ActivityInputNeed|null;
  if(!need||need.stage.pathId!==binding.consumerPathId||need.supplier!==binding.owner)
    throw new TypeError("prepared_input_rejection_need_changed");
  if(!need.origin)return null;
  const path=await activities.command({kind:"read_path",pathId:binding.consumerPathId}) as ActivityPathState|null;
  const source=await activities.command({kind:"read_stage",requestId:binding.source.stageId}) as ActivityStageState|null;
  if(!path||path.intent.runId!==binding.runId||!source||source.request.pathId!==path.intent.id||
    digest(source.request)!==binding.source.requestDigest||prepared.demand.runId!==binding.runId)
    throw new TypeError("prepared_input_rejection_source_changed");
  const rejected=(await readModelInputRejections(activities,path,need,source.request.id)).find(r=>
    r.targetDigest===prepared.encoded.targetDigest&&r.bodyDigest===prepared.encoded.bodyDigest);
  if(!rejected)return null;
  const stage=await activities.command({kind:"read_stage",requestId:rejected.stageId}) as ActivityStageState;
  const original=stage.request.input as PreparedContextInput;
  if(original.demand.historyBoundary!==prepared.demand.historyBoundary||original.demand.recipient!==prepared.demand.recipient||
    original.demand.purpose!==prepared.demand.purpose)throw new TypeError("prepared_input_rejection_scope_changed");
  return {stageId:rejected.stageId,targetRevision:rejected.targetDigest,bodyDigest:rejected.bodyDigest,
    evidence:{owner:"model-access",kind:"fact",id:rejected.rawResultId,revision:rejected.acceptanceId}};
}
