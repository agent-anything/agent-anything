import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import type {ContextUseScope} from "@agent-anything/context/selection";
import type {ActivityPathIntent,ActivityStageState} from "../activity/index.js";
import type {InputSupplyBinding} from "./InputSupplyResponsibility.js";

/** Owned local preparation uses the supplier's schedule and exit, not a private producer lifecycle. */
export interface InputSupplyPreparation {
  readonly kind:"input_supply_preparation";
  readonly revision:"1";
  readonly inputSupply:InputSupplyBinding;
  readonly scope:ContextUseScope;
  readonly pathId:string;
  readonly firstStageId:string;
  readonly workId:string;
}
export function confirmInputSupplyPreparation(binding:InputSupplyBinding,path:ActivityPathIntent,first:ActivityStageState,workId:string|null):InputSupplyPreparation {
  const value=(first.request.input as {inputSupplyPreparation?:InputSupplyPreparation}|null)?.inputSupplyPreparation;
  if(!value||value.kind!=="input_supply_preparation"||value.revision!=="1"||digest(value.inputSupply)!==digest(binding)||
    value.pathId!==path.id||value.firstStageId!==`${path.id}:stage:1`||first.request.id!==value.firstStageId||first.request.pathId!==path.id||
    !workId||value.workId!==workId||path.scheduledWorkId!==workId||value.scope.owner!==binding.owner||value.scope.runId!==binding.runId||
    path.owner!==binding.owner||path.runId!==binding.runId||path.permissionBasis!==value.scope.authorityBasis||
    value.scope.target!==`${binding.configuration.id}:${binding.configuration.revision}`)
    throw new TypeError("input_supply_preparation_unconfirmed");
  return value;
}
