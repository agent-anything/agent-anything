import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import type {ContextSelectionProposal,ContextUseScope} from "@agent-anything/context/selection";
import type {RepresentationJudgment} from "@agent-anything/context/representation";
import type {MaterialHold,MaterialAccessAdmission} from "@agent-anything/context/custody";
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
  readonly stageRequestId:string|null;
  readonly nativeConsumer?:import("@agent-anything/context/selection").ContextInputBinding["nativeConsumer"];
  readonly stageKind?:string;
  readonly capabilities?:readonly string[];
  readonly dependencies?:import("../activity/ActivityHandoff.js").ActivityStageRequest["dependencies"];
  readonly inputHolds:readonly MaterialHold[];
  readonly materialAdmissions?:readonly MaterialAccessAdmission[];
  readonly releaseHolds:readonly string[];
}):SharedAcceptanceProposal {
  const {prepared}=input;
  validatePreparedContextInput(prepared);
  return contextPreparedInputAcceptance({...input,preparedValue:prepared,preparedScope:{runId:prepared.demand.runId,
    recipient:prepared.demand.recipient,purpose:prepared.demand.purpose,target:prepared.demand.targetRevision},deliveries:prepared.deliveries});
}

/** Shared custody handoff. The input owner has already checked its protocol-native realization. */
export function contextPreparedInputAcceptance(input: Omit<Parameters<typeof contextInputAcceptance>[0],"prepared"> & {
  readonly preparedValue:unknown;
  readonly preparedScope:{readonly runId:string;readonly recipient:string;readonly purpose:string;readonly target:string};
  readonly deliveries:readonly {readonly id:string;readonly position:string}[];
}):SharedAcceptanceProposal {
  const {scope,preparedValue,preparedScope,judgment}=input;
  if((input.stageRequestId===null)!==Boolean(input.nativeConsumer))throw new TypeError("input_consumer_binding_invalid");
  if(input.nativeConsumer?input.stageKind!==undefined||input.capabilities!==undefined||input.dependencies!==undefined:
    !input.stageKind||!Array.isArray(input.capabilities))throw new TypeError("input_consumer_stage_fields_invalid");
  const selectionId=input.selection?.id??input.retainedSelectionId;
  if(!selectionId || preparedScope.runId!==scope.runId || preparedScope.recipient!==scope.recipient ||
    preparedScope.purpose!==scope.purpose || preparedScope.target!==scope.target ||
    judgment.owner!==scope.owner || judgment.runId!==scope.runId || judgment.kind!=="combination" || judgment.conclusion!=="supported" ||
    judgment.purpose!==scope.purpose || judgment.target!==scope.target || judgment.dependencies.inputDigest!==modelInputValueDigest(preparedValue)) {
    throw new TypeError("input_acceptance_owner_basis_invalid");
  }
  const proposal:ContextSelectionProposal={id:input.id,scopeId:scope.id,expectedSelectionId:input.expectedSelectionId,
    expectedControlRevision:input.expectedControlRevision,selection:input.selection,releaseHolds:input.releaseHolds,
    input:{id:input.inputId,activityId:input.activityId,stageRequestId:input.stageRequestId,scopeId:scope.id,selectionId,
      ...(input.nativeConsumer?{nativeConsumer:input.nativeConsumer}:{}),
      exactInput:preparedValue,target:scope.target,deliveries:input.deliveries,holds:input.inputHolds,combinationJudgmentId:judgment.id}};
  const holds=[...(input.selection?.holds??[]),...input.inputHolds];
  for(const admission of input.materialAdmissions??[]) {
    const recipient={runId:scope.runId,recipient:scope.recipient,purpose:scope.purpose};
    if(admission.grant.basis!==scope.authorityBasis||modelInputValueDigest(admission.grant.recipient)!==modelInputValueDigest(recipient)||
      !holds.some(hold=>modelInputValueDigest(hold)===modelInputValueDigest(admission.hold)))
      throw new TypeError("input_acceptance_material_admission_mismatch");
  }
  return {id:input.id,scope:scope.runId,actor:scope.owner,parts:[
    ...(input.materialAdmissions??[]).map(proposal=>({owner:"material_custody",kind:"admit_access",proposal})),
    {owner:"material_custody",kind:"holds",proposal:{acquire:holds,release:input.releaseHolds,basis:input.id}},
    {owner:"context_selection",kind:"selection_input",proposal},
    {owner:"context_delivery",kind:"select",proposal:{inputId:input.inputId,scopeId:scope.id,deliveryIds:input.deliveries.map(d=>d.id)}},
    ...(input.stageRequestId===null?[]:[{owner:"activity",kind:"stage_submission",proposal:{id:input.stageRequestId,pathId:input.activityId,stageKind:input.stageKind!,
      input:preparedValue,capabilities:input.capabilities!,dependencies:input.dependencies??[]}}]),
  ]};
}
