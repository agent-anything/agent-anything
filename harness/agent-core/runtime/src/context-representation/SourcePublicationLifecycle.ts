import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {activityFactSourceId,validateActivitySchedulingIntent,type ActivityHandoffPort,type ActivityPathIntent,type ActivityPathState,
  type ActivityStageState,type ActivityPurposeBinding,type ActivitySchedulingIntent,type ActivitySchedulingAcceptance,
  type ActivityScheduledSettlement,type ActivityReconsiderationHandler,type ActivityReconsiderationSnapshot,
  type ActivityReconsiderationPreparation,type SharedAcceptancePart} from "../activity/index.js";
import type {SourceMaterialPublicationRequest,PublishedSourceMaterial,UnavailableSourceMaterial} from "./SourceMaterialPublication.js";

export interface SourcePublicationLifecyclePlan {
  readonly revision:"1";
  readonly scheduling:ActivitySchedulingIntent;
}

export function validateSourcePublicationLifecycle(plan:SourcePublicationLifecyclePlan,path:ActivityPathIntent):void {
  if(plan.revision!=="1")throw new TypeError("source_lifecycle_revision_unavailable");
  const work=plan.scheduling;validateActivitySchedulingIntent(work);
  if(work.owner!==path.owner||work.runId!==path.runId||work.workId!==path.scheduledWorkId||
    work.delegatedPathOwners?.length||work.allowedPathIds?.length!==1||work.allowedPathIds[0]!==path.id||path.maximumStages!==1)
    throw new TypeError("source_lifecycle_scope_invalid");
}

/** Closes explicitly owned publication work, not its retained material or recipient delivery. */
export class SourcePublicationLifecycle implements ActivityReconsiderationHandler {
  constructor(private readonly activities:ActivityHandoffPort,private readonly purpose:ActivityPurposeBinding,
    private readonly outcome:(pathId:string)=>Promise<PublishedSourceMaterial|UnavailableSourceMaterial|null>) {}

  async prepare(snapshot:ActivityReconsiderationSnapshot,signal:AbortSignal):Promise<ActivityReconsiderationPreparation> {
    signal.throwIfAborted();const sub=snapshot.state.subscription,id=sub.binding?.id;
    if(sub.binding?.kind!=="activity_path"||sub.id!==`${id}:source-lifecycle`||sub.owner!==this.purpose.contract.acceptanceOwner)
      throw new TypeError("source_lifecycle_subscription_invalid");
    const path=await this.activities.command({kind:"read_path",pathId:id!}) as ActivityPathState|null;
    const stage=await this.activities.command({kind:"read_stage",requestId:`${id}:capture`}) as ActivityStageState|null;
    const plan=(stage?.request.input as SourceMaterialPublicationRequest|undefined)?.lifecycle;
    if(!path||!stage||!plan||path.intent.purpose.digest!==this.purpose.digest||path.intent.owner!==sub.owner||
      path.intent.runId!==sub.runId||stage.request.pathId!==id)throw new TypeError("source_lifecycle_original_binding_missing");
    validateSourcePublicationLifecycle(plan,path.intent);
    const work=await this.activities.command({kind:"read_schedule",workId:plan.scheduling.workId}) as ActivitySchedulingAcceptance|null;
    if(!work||!work.pathsSealed||!sameScope(plan.scheduling,work.intent))throw new TypeError("source_lifecycle_schedule_changed");
    const outcome=await this.outcome(id!);
    const settlement=await this.activities.command({kind:"scheduled_settlement",workId:work.intent.workId}) as ActivityScheduledSettlement;
    const closed=(path.cancelled||outcome!==null)&&settlement.remaining===null;
    const decision={owner:sub.owner,kind:closed?"source_publication_closed":"source_publication_waiting",id:id!,
      revision:digest({source:stage.request,control:path.controlRevision,progress:path.progressRevision,schedule:work.revision,closed})};
    const participants:SharedAcceptancePart[]=[{owner:"activity",kind:"path_condition",proposal:{pathId:id,
      expected:{controlRevision:path.controlRevision,progressRevision:path.progressRevision,cancelled:path.cancelled},requireSettled:closed}}];
    if(closed)participants.push(
      {owner:"activity",kind:"scheduling_closure",proposal:{kind:"close_scheduled_work",workId:work.intent.workId,
        expectedRevision:settlement.revision,basis:`${id}:source-lifecycle`,requireSettled:true}},
      {owner:"activity",kind:"fact_publication",proposal:{id:`${id}:source-closed:${decision.revision}`,
        sourceId:activityFactSourceId("progress",id!),ref:decision}});
    signal.throwIfAborted();
    return {decision,participants,observeSources:[activityFactSourceId("control",id!),activityFactSourceId("progress",id!),
      activityFactSourceId("scheduling",work.intent.workId)],close:closed};
  }
}

function sameScope(a:ActivitySchedulingIntent,b:ActivitySchedulingIntent):boolean {
  const identity=(work:ActivitySchedulingIntent)=>({workId:work.workId,runId:work.runId,scopeId:work.scopeId,owner:work.owner,
    resources:work.resources,allowedPathIds:work.allowedPathIds,delegatedPathOwners:work.delegatedPathOwners??[]});
  return digest(identity(a))===digest(identity(b));
}
