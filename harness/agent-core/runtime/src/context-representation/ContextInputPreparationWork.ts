import type {Provider} from "@agent-anything/model-interaction";
import type {MaterialCustodyPort} from "@agent-anything/context/custody";
import {ActivityPurposeRegistry} from "../activity/ActivityPurpose.js";
import type {ActivityPurposeBinding} from "../activity/ActivityPurpose.js";
import type {ActivityPurposeHandler} from "../activity/ActivityHandoffProcessor.js";
import type {ActivityHandoffPort,ActivityPathIntent,ActivityPathState} from "../activity/ActivityHandoff.js";
import type {SharedAcceptancePart} from "../activity/SharedAcceptance.js";
import {CONTEXT_INPUT_PREPARATION_PURPOSE,ContextInputPreparationHandler,firstContextInputPreparationStage,
  type ContextInputPreparationRequest,type PreparedContextInput,type ContextInputPreparationGap} from "./ContextInputPreparation.js";

/** A professional work entry, driven by the existing execution coordinator's durable handoffs. */
export class ContextInputPreparationWork {
  readonly purpose:ActivityPurposeBinding;
  constructor(private readonly port:ActivityHandoffPort,registry:ActivityPurposeRegistry<ActivityPurposeHandler>,
    dependencies:{provider:Provider;materials:MaterialCustodyPort;authorize:ActivityPurposeHandler["authorize"];now:()=>string}) {
    this.purpose=registry.register(CONTEXT_INPUT_PREPARATION_PURPOSE,new ContextInputPreparationHandler(dependencies));
  }
  async submit(intent:Omit<ActivityPathIntent,"purpose"|"owner">,request:ContextInputPreparationRequest):Promise<void> {
    const parts=this.prepareSubmission(intent,request);
    await this.port.command({kind:"open_path",intent:parts[0].proposal as ActivityPathIntent});
    await this.port.command({kind:"submit",request:parts[1].proposal as import("../activity/ActivityHandoff.js").ActivityStageRequest});
  }
  prepareSubmission(intent:Omit<ActivityPathIntent,"purpose"|"owner">,request:ContextInputPreparationRequest):readonly [SharedAcceptancePart,SharedAcceptancePart] {
    if(intent.runId!==request.demand.runId)throw new TypeError("input_preparation_run_mismatch");
    return [{owner:"activity",kind:"path_opening",proposal:{...intent,owner:this.purpose.contract.acceptanceOwner,purpose:this.purpose}},
      {owner:"activity",kind:"stage_submission",proposal:firstContextInputPreparationStage(intent.id,request)}];
  }
  async result(pathId:string):Promise<{kind:"pending"}|{kind:"cancelled"}|{kind:"prepared";prepared:PreparedContextInput}|{kind:"gap";reason:string;gap:ContextInputPreparationGap|null}> {
    const path=await this.port.command({kind:"read_path",pathId}) as ActivityPathState|null;
    if(!path || path.intent.purpose.digest!==this.purpose.digest)throw new TypeError("input_preparation_path_unavailable");
    if(path.cancelled)return {kind:"cancelled"};
    const progress=path.progress as {state?:string;prepared?:PreparedContextInput;reason?:string;gap?:ContextInputPreparationGap}|null;
    if(progress?.state==="prepared"&&progress.prepared)return {kind:"prepared",prepared:progress.prepared};
    if(progress?.state==="gap")return {kind:"gap",reason:progress.reason??"unknown",gap:progress.gap??null};
    return {kind:"pending"};
  }
}
