import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import type {ContextSelectionProposal,ContextUseScope} from "@agent-anything/context/selection";
import type {RepresentationJudgment} from "@agent-anything/context/representation";
import type {MaterialHold} from "@agent-anything/context/custody";
import type {SharedAcceptanceProposal} from "../activity/SharedAcceptance.js";
import {validatePreparedContextInput,type PreparedContextInput} from "./ContextInputPreparation.js";

/** Packages owner decisions for the shared boundary; it does not invent semantic support. */
export function contextInputAcceptance(input:{
  readonly id:string;
  readonly scope:ContextUseScope;
  readonly expectedSelectionId:string|null;
  readonly expectedControlRevision:number;
  readonly selection:ContextSelectionProposal["selection"];
  readonly retainedSelectionId:string|null;
  readonly prepared:PreparedContextInput;
  readonly judgment:RepresentationJudgment;
  readonly inputId:string;
  readonly activityId:string;
  readonly stageRequestId:string;
  readonly stageKind:string;
  readonly capabilities:readonly string[];
  readonly inputHolds:readonly MaterialHold[];
  readonly releaseHolds:readonly string[];
}):SharedAcceptanceProposal {
  const {scope,prepared,judgment}=input;
  validatePreparedContextInput(prepared);
  const selectionId=input.selection?.id??input.retainedSelectionId;
  if(!selectionId || prepared.demand.runId!==scope.runId || prepared.demand.recipient!==scope.recipient ||
    prepared.demand.purpose!==scope.purpose || prepared.demand.targetRevision!==scope.target ||
    judgment.owner!==scope.owner || judgment.kind!=="combination" || judgment.conclusion!=="supported" ||
    judgment.purpose!==scope.purpose || judgment.target!==scope.target || judgment.dependencies.inputDigest!==modelInputValueDigest(prepared)) {
    throw new TypeError("input_acceptance_owner_basis_invalid");
  }
  const proposal:ContextSelectionProposal={id:input.id,scopeId:scope.id,expectedSelectionId:input.expectedSelectionId,
    expectedControlRevision:input.expectedControlRevision,selection:input.selection,releaseHolds:input.releaseHolds,
    input:{id:input.inputId,activityId:input.activityId,stageRequestId:input.stageRequestId,scopeId:scope.id,selectionId,
      exactInput:prepared,target:scope.target,deliveries:prepared.deliveries,holds:input.inputHolds,combinationJudgmentId:judgment.id}};
  return {id:input.id,scope:scope.runId,actor:scope.owner,parts:[
    {owner:"material_custody",kind:"holds",proposal:{acquire:[...(input.selection?.holds??[]),...input.inputHolds],release:input.releaseHolds,basis:input.id}},
    {owner:"context_selection",kind:"selection_input",proposal},
    {owner:"context_delivery",kind:"select",proposal:{inputId:input.inputId,scopeId:scope.id,deliveryIds:prepared.deliveries.map(d=>d.id)}},
    {owner:"activity",kind:"stage_submission",proposal:{id:input.stageRequestId,pathId:input.activityId,stageKind:input.stageKind,
      input:prepared,capabilities:input.capabilities,dependencies:[]}},
  ]};
}
