import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {activityFactSourceId,type ActivityHandoffPort,type ActivityPathState,type ActivityHandoffItem,type ActivityStageState,
  type ActivitySchedulingAcceptance,type ActivityScheduledSettlement,type ActivityReconsiderationPreparation,type SharedAcceptancePart} from "../activity/index.js";
import {inputSupplyExit,inputSupplyFactSource,type InputSupplyResponsibilityStore,type InputSupplyHead,type InputSupplyExit as Exit,
  type InputSupplyExitDisposition,type InputSupplyExitPending} from "./InputSupplyResponsibility.js";
import type {ContextMethodInputConsumer} from "./ContextMethodInputConsumer.js";
import type {OriginalInputSupplyBasis} from "./OriginalInputSupply.js";

/** Return ends the input wait. This owner separately disposes its original accepted responsibilities. */
export class InputSupplyExitWork {
  constructor(private readonly ports:{readonly activities:ActivityHandoffPort;readonly responsibilities:InputSupplyResponsibilityStore;
    readonly receivers?:Pick<ContextMethodInputConsumer,"prepareClosure">}) {}

  async prepare(basis:OriginalInputSupplyBasis,subscriptionId:string,returned:ActivityStageState|null,signal:AbortSignal):Promise<ActivityReconsiderationPreparation> {
    signal.throwIfAborted();const {need,consumer,sourceStage}=basis;
    const exit=await this.ports.responsibilities.query({kind:"exit",needId:need.id}) as Exit|null;
    const origin={needId:need.id,runId:consumer.intent.runId,owner:need.supplier,consumerPathId:consumer.intent.id,
      source:{stageId:sourceStage.request.id,requestDigest:digest(sourceStage.request)}};
    const parts:SharedAcceptancePart[]=[],sources=[inputSupplyFactSource(origin).id,activityFactSourceId("control",consumer.intent.id)];
    const result=(kind:string,close=false):ActivityReconsiderationPreparation=>({
      decision:{owner:need.supplier,kind,id:need.id,revision:digest({exit:exit?.revision??0,parts})},participants:parts,observeSources:[...new Set(sources)].sort(),close});
    if(!exit) {
      if(!consumer.cancelled&&!returned)throw new TypeError("input_supply_exit_basis_missing");
      const head=await this.ports.responsibilities.query({kind:"head",needId:need.id}) as InputSupplyHead|null;
      if(head?.scheduling) {
        const work=await this.schedule(head.scheduling.workId);
        if(!work.pathsSealed)parts.push({owner:"activity",kind:"scheduling_path_seal",proposal:{kind:"seal_scheduled_paths",workId:work.intent.workId,
          expectedRevision:work.revision,basis:`${need.id}:exit`}});
      }
      parts.push(inputSupplyExit({kind:"begin",origin,subscriptionId,expectedMembershipRevision:head?.revision??0,expectedConsumerControlRevision:consumer.controlRevision,
        basis:consumer.cancelled?{kind:"cancelled",controlRevision:consumer.controlRevision}:{kind:"returned",stageId:returned!.request.id,requestDigest:digest(returned!.request)}}));
      return result("input_supply_exit_started");
    }
    if(digest(exit.origin)!==digest(origin)||exit.subscriptionId!==subscriptionId||exit.status!=="closing")throw new TypeError("input_supply_exit_binding_changed");
    const page=await this.ports.responsibilities.query({kind:"exit_pending",needId:need.id,revision:exit.revision,limit:16}) as InputSupplyExitPending;
    if(page.kind!=="exit_pending")throw new Error("input_supply_exit_changed");
    const dispositions:InputSupplyExitDisposition[]=[];
    for(const entry of page.entries) {
      signal.throwIfAborted();
      if(entry.relation==="dependency") {dispositions.push({responsibilityId:entry.id,kind:"dependency_withdrawn"});continue;}
      const path=await this.ports.activities.command({kind:"read_path",pathId:entry.target.pathId}) as ActivityPathState|null;
      if(!path||digest(path.intent)!==entry.target.intentDigest)throw new TypeError("input_supply_exit_target_changed");
      sources.push(activityFactSourceId("control",path.intent.id),activityFactSourceId("progress",path.intent.id));
      if(entry.role==="method_reception") {
        if(!this.ports.receivers)throw new TypeError("input_supply_reception_owner_unavailable");
        parts.push(...await this.ports.receivers.prepareClosure(path.intent.id,`${need.id}:exit`,signal));
        dispositions.push({responsibilityId:entry.id,kind:"reception_transferred"});continue;
      }
      if(entry.role!=="input_preparation")throw new TypeError("input_supply_exit_role_invalid");
      parts.push({owner:"activity",kind:"path_condition",proposal:{pathId:path.intent.id,
        expected:{controlRevision:path.controlRevision,progressRevision:path.progressRevision,cancelled:path.cancelled},requireSettled:false}});
      if(!path.cancelled) {
        parts.push({owner:"activity",kind:"path_cancellation",proposal:{kind:"cancel",pathId:path.intent.id,expectedControlRevision:path.controlRevision}});continue;
      }
      const pending=await this.ports.activities.command({kind:"pending",runId:origin.runId,pathId:path.intent.id,after:0,limit:1}) as readonly ActivityHandoffItem[];
      if(!pending.length)dispositions.push({responsibilityId:entry.id,kind:"owned_settled"});
    }
    if(dispositions.length)parts.push(inputSupplyExit({kind:"dispose",needId:need.id,expectedRevision:exit.revision,dispositions}));
    if(page.entries.length)return result("input_supply_exit_progress");
    if(page.uncoveredPathId)throw new TypeError(`input_supply_exit_schedule_responsibility_missing:${page.uncoveredPathId}`);
    if(exit.scheduling) {
      const work=await this.schedule(exit.scheduling.workId);
      const settlement=await this.ports.activities.command({kind:"scheduled_settlement",workId:work.intent.workId}) as ActivityScheduledSettlement;
      sources.push(activityFactSourceId("scheduling",work.intent.workId));
      if(settlement.remaining) {
        sources.push(activityFactSourceId("progress",settlement.remaining.pathId),activityFactSourceId("control",settlement.remaining.pathId));
        return result("input_supply_exit_waiting");
      }
      parts.push({owner:"activity",kind:"scheduling_closure",proposal:{kind:"close_scheduled_work",workId:work.intent.workId,
        expectedRevision:settlement.revision,basis:`${need.id}:exit`,requireSettled:true}});
    }
    parts.push(inputSupplyExit({kind:"complete",needId:need.id,expectedRevision:exit.revision}));
    signal.throwIfAborted();return result("input_supply_exit_completed",true);
  }
  private async schedule(workId:string):Promise<ActivitySchedulingAcceptance> {
    const work=await this.ports.activities.command({kind:"read_schedule",workId}) as ActivitySchedulingAcceptance|null;
    if(!work)throw new TypeError("input_supply_exit_schedule_missing");return work;
  }
}
