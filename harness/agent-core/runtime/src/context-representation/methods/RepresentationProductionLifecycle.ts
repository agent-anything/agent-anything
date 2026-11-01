import {activityFactSourceId,type ActivityHandoffPort,type ActivityPathIntent,type ActivityPathState,
  type ActivityScopeLifetime,type ActivityPublishedFact,type ActivityReconsiderationHandler,type ActivityReconsiderationSnapshot,
  type ActivityReconsiderationPreparation,type ActivitySchedulingAcceptance,type ActivityScheduledSettlement,type SharedAcceptancePart} from "../../activity/index.js";
import {inputSupplyFactSource,type InputSupplyResponsibilityStore,type InputSupplyUsersPage,type InputSupplyExit} from "../InputSupplyResponsibility.js";

export interface RepresentationProductionLifetime {
  readonly scope:(runId:string)=>ActivityScopeLifetime;
  readonly responsibilities:InputSupplyResponsibilityStore;
}

/** Ends production, not retained evidence. Input consumers never own this closure. */
export class RepresentationProductionLifecycle implements ActivityReconsiderationHandler {
  constructor(private readonly activities:ActivityHandoffPort,private readonly lifetime:RepresentationProductionLifetime) {}

  subscription(intent:ActivityPathIntent):SharedAcceptancePart {
    const scope=this.lifetime.scope(intent.runId);
    if(scope.source.runId!==intent.runId||!intent.scheduledWorkId)throw new TypeError("representation_lifetime_scope_invalid");
    return {owner:"activity",kind:"reconsideration_subscription",proposal:{id:`${intent.id}:production-lifecycle`,
      runId:intent.runId,owner:intent.owner,binding:{kind:"activity_path",id:intent.id},sources:[scope.source.id,
        activityFactSourceId("scheduling",intent.scheduledWorkId),activityFactSourceId("progress",intent.id),activityFactSourceId("control",intent.id)]}};
  }

  async prepare(snapshot:ActivityReconsiderationSnapshot,signal:AbortSignal):Promise<ActivityReconsiderationPreparation> {
    signal.throwIfAborted();const binding=snapshot.state.subscription.binding;
    if(binding?.kind!=="activity_path")throw new TypeError("representation_lifetime_binding_invalid");
    const path=await this.activities.command({kind:"read_path",pathId:binding.id}) as ActivityPathState|null;
    if(!path||path.intent.owner!==snapshot.state.subscription.owner||path.intent.runId!==snapshot.state.subscription.runId||!path.intent.scheduledWorkId)
      throw new TypeError("representation_lifetime_path_invalid");
    const scope=this.lifetime.scope(path.intent.runId),work=await this.activities.command({kind:"read_schedule",workId:path.intent.scheduledWorkId}) as ActivitySchedulingAcceptance|null;
    if(!work||work.intent.owner!==path.intent.owner||work.intent.runId!==path.intent.runId)throw new TypeError("representation_lifetime_work_invalid");
    const parts:SharedAcceptancePart[]=[],sources=[scope.source.id,activityFactSourceId("scheduling",work.intent.workId)];
    const result=(kind:string,close=false):ActivityReconsiderationPreparation=>({decision:{owner:path.intent.owner,kind,id:work.intent.workId,
      revision:String(work.revision)},participants:parts,observeSources:[...new Set(sources)].sort(),close});
    if(work.settlementConfirmed)return result("representation_production_already_closed",true);
    const ended=await this.activities.command({kind:"read_fact",id:scope.closedFactId}) as ActivityPublishedFact|null;
    if(!ended)return result("representation_production_scope_open");
    if(ended.sourceId!==scope.source.id||ended.ref.owner!==scope.source.owner)throw new TypeError("representation_lifetime_fact_invalid");

    // Freeze the registered-use frontier; final acceptance rechecks all uses atomically.
    let frontier:number|null=null,afterSequence=0,inUse=false;
    do {
      signal.throwIfAborted();
      const page=await this.lifetime.responsibilities.query({kind:"work_users",workId:work.intent.workId,frontier,afterSequence,limit:64}) as InputSupplyUsersPage;
      frontier=page.frontier;
      for(const entry of page.entries) {
        const exit=await this.lifetime.responsibilities.query({kind:"exit",needId:entry.binding.needId}) as InputSupplyExit|null;
        if(exit?.status!=="closed") {inUse=true;sources.push(inputSupplyFactSource(entry.binding).id);}
      }
      if(page.complete)break;
      afterSequence=page.next!;
    } while(true);
    if(inUse)return result("representation_production_consumers_active");
    parts.push({owner:"context_input_supply",kind:"producer_unreferenced",proposal:{workId:work.intent.workId}});
    if(!work.pathsSealed) {
      parts.push({owner:"activity",kind:"scheduling_path_seal",proposal:{kind:"seal_scheduled_paths",workId:work.intent.workId,
        expectedRevision:work.revision,basis:ended.id}});
      return result("representation_production_paths_sealed");
    }
    const settlement=await this.activities.command({kind:"scheduled_settlement",workId:work.intent.workId}) as ActivityScheduledSettlement;
    if(settlement.remaining) {
      const remaining=await this.activities.command({kind:"read_path",pathId:settlement.remaining.pathId}) as ActivityPathState|null;
      if(!remaining||remaining.intent.scheduledWorkId!==work.intent.workId)throw new TypeError("representation_lifetime_remaining_invalid");
      sources.push(activityFactSourceId("progress",remaining.intent.id),activityFactSourceId("control",remaining.intent.id));
      if(!remaining.cancelled)parts.push({owner:"activity",kind:"path_cancellation",proposal:{kind:"cancel",pathId:remaining.intent.id,expectedControlRevision:remaining.controlRevision}});
      return result("representation_production_settlement_pending");
    }
    parts.push({owner:"activity",kind:"scheduling_closure",proposal:{kind:"close_scheduled_work",workId:work.intent.workId,
      expectedRevision:settlement.revision,basis:ended.id,requireSettled:true}});
    return result("representation_production_closed",true);
  }
}
