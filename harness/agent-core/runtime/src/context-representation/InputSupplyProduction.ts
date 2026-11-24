import {activityToken,activityFactSourceId,type ActivityPathIntent,type ActivityStageState,type ActivityReconsiderationState,type ActivitySchedulingAcceptance} from "../activity/index.js";

/** A reusable producer retains its lifecycle independently of every individual consumer. */
export interface InputSupplyProduction {
  readonly kind:"input_supply_production";
  readonly revision:"1";
  readonly pathId:string;
  readonly firstStageId:string;
  readonly runId:string;
  readonly owner:string;
  readonly workId:string;
  readonly subscriptionId:string;
}
export function confirmInputSupplyProduction(path:ActivityPathIntent,first:ActivityStageState,subscription:ActivityReconsiderationState|null,
  work:ActivitySchedulingAcceptance|null,initial:boolean):InputSupplyProduction {
  const value=(first.request.input as {inputSupplyProduction?:InputSupplyProduction}|null)?.inputSupplyProduction;
  if(!value||value.kind!=="input_supply_production"||value.revision!=="1")throw new TypeError("input_supply_production_missing");
  [value.pathId,value.firstStageId,value.runId,value.owner,value.workId,value.subscriptionId].forEach(activityToken);
  if(value.pathId!==path.id||value.firstStageId!==first.request.id||first.request.pathId!==path.id||value.runId!==path.runId||value.owner!==path.owner||
    value.workId!==path.scheduledWorkId||path.purpose.contract.inputOwner!==path.owner||path.purpose.contract.acceptanceOwner!==path.owner||
    !work||work.intent.workId!==value.workId||work.intent.runId!==path.runId||work.intent.owner!==path.owner||initial&&work.closed||
    work.intent.allowedPathIds&&!work.intent.allowedPathIds.includes(path.id)||
    !subscription||subscription.subscription.id!==value.subscriptionId||subscription.subscription.runId!==path.runId||
    subscription.subscription.owner!==path.owner||subscription.subscription.binding?.kind!=="activity_path"||subscription.subscription.binding.id!==path.id||
    initial&&subscription.closed||!subscription.observedSources.includes(activityFactSourceId("scheduling",value.workId)))
    throw new TypeError("input_supply_production_unconfirmed");
  return value;
}
