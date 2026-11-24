import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import type {ContextUseScope} from "@agent-anything/context/selection";
import {activityToken,activityFactSourceId,type ActivityPathIntent,type ActivityStageState,type ActivityReconsiderationState,type ActivitySchedulingAcceptance} from "../activity/index.js";
import type {InputSupplyBinding} from "./InputSupplyResponsibility.js";

export interface InputSupplyReceptionOwner {
  prepareClosure(pathId:string,basis:string,signal:AbortSignal):Promise<readonly import("../activity/index.js").SharedAcceptancePart[]>;
}

/** Public ownership/exit facts. Native or generic construction plans remain private to the receiver. */
export interface InputSupplyReception {
  readonly kind:"input_supply_reception";
  readonly revision:"1";
  readonly inputSupply:InputSupplyBinding;
  readonly scope:ContextUseScope;
  readonly pathId:string;
  readonly firstStageId:string;
  readonly workId:string|null;
  readonly subscriptionId:string;
  readonly closureKind:string;
  readonly coveredPathIds:readonly string[];
}
export function validateInputSupplyReception(value:InputSupplyReception):void {
  if(value?.kind!=="input_supply_reception"||value.revision!=="1"||!value.inputSupply||!value.scope)throw new TypeError("input_supply_reception_invalid");
  const b=value.inputSupply,s=value.scope;
  [value.pathId,value.firstStageId,value.subscriptionId,value.closureKind,b.needId,b.runId,b.owner,b.consumerPathId,b.source.stageId,b.source.requestDigest,
    b.configuration.id,b.configuration.revision,s.id,s.runId,s.recipient,s.purpose,s.target,s.continuity,s.owner,s.authorityBasis].forEach(activityToken);
  if(value.workId!==null)activityToken(value.workId);
  if(!Array.isArray(value.coveredPathIds)||!value.coveredPathIds.length||value.coveredPathIds.length>256||
    !value.coveredPathIds.includes(value.pathId)||new Set(value.coveredPathIds).size!==value.coveredPathIds.length||s.runId!==b.runId||s.owner!==b.owner)
    throw new TypeError("input_supply_reception_coverage_invalid");
  value.coveredPathIds.forEach(activityToken);
}
export function confirmInputSupplyReception(binding:InputSupplyBinding,path:ActivityPathIntent,first:ActivityStageState,
  subscription:ActivityReconsiderationState|null,initial:boolean,scheduling:ActivitySchedulingAcceptance|null):InputSupplyReception {
  const value=(first.request.input as {inputSupplyReception?:InputSupplyReception}|null)?.inputSupplyReception;
  if(!value)throw new TypeError("input_supply_reception_missing");
  validateInputSupplyReception(value);
  const equal=(a:unknown,b:unknown)=>digest(a)===digest(b),s=value.scope;
  if(!equal(value.inputSupply,binding)||value.pathId!==path.id||value.firstStageId!==first.request.id||first.request.pathId!==path.id||
    value.workId!==(path.scheduledWorkId??null)||s.runId!==path.runId||s.owner!==path.owner||s.authorityBasis!==path.permissionBasis||
    path.purpose.contract.inputOwner!==s.owner||path.purpose.contract.acceptanceOwner!==s.owner||path.purpose.contract.recoveryOwner!==s.owner||
    !subscription||subscription.subscription.id!==value.subscriptionId||subscription.subscription.owner!==s.owner||subscription.subscription.runId!==s.runId||
    subscription.subscription.binding?.kind!=="activity_path"||subscription.subscription.binding.id!==path.id||initial&&subscription.closed||
    !subscription.observedSources.includes(activityFactSourceId("control",path.id)))throw new TypeError("input_supply_reception_unconfirmed");
  if(value.workId&&(!scheduling||scheduling.intent.workId!==value.workId||scheduling.intent.runId!==s.runId||scheduling.intent.owner!==s.owner||
    !scheduling.intent.allowedPathIds||value.coveredPathIds.some(id=>!scheduling.intent.allowedPathIds!.includes(id))||initial&&scheduling.closed))
    throw new TypeError("input_supply_reception_schedule_unconfirmed");
  return value;
}
