import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {confirmInputSupplyReception,ContextMethodInputSupply,CONTEXT_INPUT_MATERIALIZATION_PURPOSE,
  type InputSupplyBinding,type InputSupplyReception,type ContextMethodInputPlan} from "@agent-anything/agent-runtime/context-representation";
import type {ActivityPathIntent} from "@agent-anything/agent-runtime/activity";
import type {InputSupplyPaths} from "./InputSupplyExitDatabase.js";

/** Original public handoff; only historical generic records need the versioned decoder below. */
export function readInputSupplyReception(binding:InputSupplyBinding,path:ActivityPathIntent,paths:InputSupplyPaths,initial:boolean):InputSupplyReception {
  const first=paths.stage(`${path.id}:stage:1`);
  if(!first)throw new TypeError("input_supply_reception_stage_missing");
  const input=first.request.input as {inputSupplyReception?:InputSupplyReception;methodInputPlan?:ContextMethodInputPlan};
  const schedule=path.scheduledWorkId?paths.scheduling(path.scheduledWorkId):null;
  if(input.inputSupplyReception)return confirmInputSupplyReception(binding,path,first,paths.subscription(input.inputSupplyReception.subscriptionId),initial,schedule);
  if(path.purpose.digest!==digest(CONTEXT_INPUT_MATERIALIZATION_PURPOSE))throw new TypeError("input_supply_reception_handoff_missing");
  ContextMethodInputSupply.validateInputSupply(binding,path,first,paths.subscription(`${path.id}:consumer`),initial,schedule);
  const plan=input.methodInputPlan!;
  return {kind:"input_supply_reception",revision:"1",inputSupply:binding,scope:plan.scope,pathId:path.id,firstStageId:first.request.id,workId:path.scheduledWorkId??null,
    subscriptionId:`${path.id}:consumer`,closureKind:"method_input_closed",coveredPathIds:[path.id,plan.materialization.request.preparationIntent.id,plan.check.intent.id]};
}
