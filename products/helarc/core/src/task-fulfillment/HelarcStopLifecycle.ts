import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {activityFactSourceId,type ActivityHandoffPort,type ActivityPathState,type ActivityStageState,
  type ActivitySchedulingAcceptance,type ActivityScheduledSettlement,type ActivityReconsiderationHandler,
  type ActivityReconsiderationSnapshot,type ActivityReconsiderationPreparation,type SharedAcceptancePart} from "@agent-anything/agent-runtime/activity";
import {HELARC_STOP_MODEL_PURPOSE} from "./HelarcStopModelWork.js";
import {readCurrentModelInputNeed} from "@agent-anything/agent-runtime/model-access";

/** The Stop purpose closes its own execution duty, independently of the waiting Hook caller. */
export class HelarcStopLifecycle implements ActivityReconsiderationHandler {
  constructor(private readonly activities:ActivityHandoffPort) {}
  async prepare(snapshot:ActivityReconsiderationSnapshot,signal:AbortSignal):Promise<ActivityReconsiderationPreparation> {
    signal.throwIfAborted();const sub=snapshot.state.subscription,id=sub.binding?.id;
    if(sub.binding?.kind!=="activity_path"||sub.id!==`${id}:stop-lifecycle`||sub.owner!==HELARC_STOP_MODEL_PURPOSE.acceptanceOwner)
      throw new TypeError("stop_lifecycle_subscription_invalid");
    const path=await this.activities.command({kind:"read_path",pathId:id!}) as ActivityPathState|null;
    if(!path||path.intent.runId!==sub.runId||path.intent.owner!==sub.owner||path.intent.purpose.digest!==digest(HELARC_STOP_MODEL_PURPOSE)||!path.intent.scheduledWorkId)
      throw new TypeError("stop_lifecycle_original_binding_missing");
    const work=await this.activities.command({kind:"read_schedule",workId:path.intent.scheduledWorkId}) as ActivitySchedulingAcceptance|null;
    if(!work||!work.pathsSealed||work.intent.runId!==sub.runId||work.intent.owner!==sub.owner||work.intent.delegatedPathOwners?.length||
      work.intent.allowedPathIds?.length!==1||work.intent.allowedPathIds[0]!==id)throw new TypeError("stop_lifecycle_schedule_changed");
    const need=await readCurrentModelInputNeed(this.activities,path,`${id}:input-need`,`${id}:source`),stages=[];
    for(const [requestId,kind] of [[`${id}:source`,"source"],[need?.stage.id,"model"],[need?.unavailableStage.id,"input-unavailable"]] as const) {
      const stage=requestId?await this.activities.command({kind:"read_stage",requestId}) as ActivityStageState|null:null;
      if(stage&&(stage.request.pathId!==id||stage.request.stageKind!==kind))throw new TypeError("stop_lifecycle_stage_changed");stages.push(stage);
    }
    if(!stages[0]||stages[1]&&stages[2])throw new TypeError("stop_lifecycle_outcomes_invalid");
    const terminal=path.cancelled||stages.slice(1).some(s=>s?.status==="accepted")||stages.some(s=>s?.status==="stopped"||s?.status==="settled");
    const settlement=await this.activities.command({kind:"scheduled_settlement",workId:work.intent.workId}) as ActivityScheduledSettlement;
    const closed=terminal&&settlement.remaining===null;
    const decision={owner:sub.owner,kind:closed?"stop_work_closed":"stop_work_waiting",id:id!,
      revision:digest({path:path.intent.id,control:path.controlRevision,progress:path.progressRevision,schedule:work.revision,closed})};
    const participants:SharedAcceptancePart[]=[{owner:"activity",kind:"path_condition",proposal:{pathId:id,
      expected:{controlRevision:path.controlRevision,progressRevision:path.progressRevision,cancelled:path.cancelled},requireSettled:closed}}];
    if(closed)participants.push({owner:"activity",kind:"scheduling_closure",proposal:{kind:"close_scheduled_work",workId:work.intent.workId,
      expectedRevision:settlement.revision,basis:`${id}:stop-lifecycle`,requireSettled:true}},
      {owner:"activity",kind:"fact_publication",proposal:{id:`${id}:closed:${decision.revision}`,sourceId:activityFactSourceId("progress",id!),ref:decision}});
    signal.throwIfAborted();
    return {decision,participants,observeSources:[activityFactSourceId("control",id!),activityFactSourceId("progress",id!),
      activityFactSourceId("scheduling",work.intent.workId)],close:closed};
  }
}
