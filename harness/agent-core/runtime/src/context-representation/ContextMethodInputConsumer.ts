import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {activityFactSourceId,type ActivityReconsiderationHandler,type ActivityReconsiderationSnapshot,type ActivityReconsiderationPreparation,
  type ActivityReconsiderationSubscription,type SharedAcceptancePart,type ActivityHandoffPort,type ActivityPathState,type ActivityHandoffItem} from "../activity/index.js";
import {ContextMethodInputSupply,type ContextMethodInputPlan} from "./ContextMethodInputSupply.js";
import type {RepresentationMethodWork} from "./methods/RepresentationMethodWork.js";
import {sameMethodInputSchedulingBinding,validateMethodInputScheduling} from "./ContextMethodInputScheduling.js";

/** Independent recipient work. A checked frozen input is a result, not a current selection. */
export class ContextMethodInputConsumer implements ActivityReconsiderationHandler {
  constructor(private readonly supply:Pick<ContextMethodInputSupply,"prepare"|"readPlan">,
    private readonly ports:{readonly activities:ActivityHandoffPort;readonly methods:Pick<RepresentationMethodWork,"prepareInputRelease">}) {}

  async prepareStart(plan:ContextMethodInputPlan,signal:AbortSignal):Promise<readonly SharedAcceptancePart[]> {
    validateMethodInputScheduling(plan);
    const result=await this.supply.prepare(plan,signal),id=plan.materialization.intent.id;
    if(result.kind!=="waiting"||!result.participants.some(p=>p.kind==="path_opening"&&(p.proposal as {id?:string}).id===id))
      throw new TypeError("method_input_consumer_start_requires_ready_producer");
    const subscription:ActivityReconsiderationSubscription={id:`${id}:consumer`,runId:plan.scope.runId,owner:plan.scope.owner,
      binding:{kind:"activity_path",id},sources:[...new Set([...result.observeSources,activityFactSourceId("control",id)])].sort()};
    return [...(plan.scheduling?[{owner:"activity",kind:"scheduling_acceptance",proposal:{kind:"schedule_work",intent:plan.scheduling,expectedRevision:0}}]:[]),
      ...result.conditions,...result.participants,{owner:"activity",kind:"reconsideration_subscription",proposal:subscription}];
  }

  async prepare(snapshot:ActivityReconsiderationSnapshot,signal:AbortSignal):Promise<ActivityReconsiderationPreparation> {
    signal.throwIfAborted();const subscription=snapshot.state.subscription;
    if(subscription.binding?.kind!=="activity_path")throw new TypeError("method_input_consumer_binding_missing");
    const id=subscription.binding.id,plan=await this.supply.readPlan(id);
    if(!plan||plan.scope.runId!==subscription.runId||plan.scope.owner!==subscription.owner)throw new TypeError("method_input_consumer_original_plan_missing");
    validateMethodInputScheduling(plan);
    const path=await this.ownedPath(plan,plan.materialization.intent);
    if(!path)throw new TypeError("method_input_consumer_original_path_missing");
    signal.throwIfAborted();
    if(path.cancelled)return this.close(plan,path,signal);
    const result=await this.supply.prepare(plan,signal);
    const decision={owner:subscription.owner,kind:`method_input_${result.kind}`,id:result.kind==="checked"?result.checkPathId:id,
      revision:modelInputValueDigest(result)};
    const observeSources=[...new Set([activityFactSourceId("control",id),...result.observeSources])].sort();
    const guard=pathCondition(id,path,false);
    if(result.kind==="waiting")return {decision,participants:[guard,...result.conditions,...result.participants],observeSources,close:false};
    // The retained plan and original method/check results are the payload, not the notification itself.
    const publication={id:`${id}:outcome:${decision.revision}`,sourceId:activityFactSourceId("progress",id),ref:decision};
    const participants:SharedAcceptancePart[]=[guard,...result.conditions,{owner:"activity",kind:"fact_publication",proposal:publication}];
    if(result.kind==="unavailable")participants.push(...await this.prepareClosure(id,publication.id,signal));
    // A checked input still has an owner until CRM accepts adoption or disposal. Do not orphan that duty.
    return {decision,participants,observeSources:[activityFactSourceId("control",id)],close:false};
  }

  /** CRM may include this in adoption or explicitly dispose a no-longer-needed consumer. */
  async prepareClosure(id:string,basis:string,signal:AbortSignal):Promise<readonly SharedAcceptancePart[]> {
    signal.throwIfAborted();if(!basis)throw new TypeError("method_input_consumer_closure_basis_missing");
    const plan=await this.supply.readPlan(id);
    if(!plan)throw new TypeError("method_input_consumer_original_plan_missing");
    validateMethodInputScheduling(plan);
    const path=await this.ownedPath(plan,plan.materialization.intent);
    if(!path)throw new TypeError("method_input_consumer_original_path_missing");
    signal.throwIfAborted();if(path.cancelled)return [pathCondition(id,path,false)];
    return [pathCondition(id,path,false),{owner:"activity",kind:"path_cancellation",proposal:{kind:"cancel",pathId:id,expectedControlRevision:path.controlRevision}},
      {owner:"activity",kind:"fact_publication",proposal:{id:`${id}:closure:${modelInputValueDigest({basis,control:path.controlRevision})}`,
        sourceId:activityFactSourceId("progress",id),ref:{owner:plan.scope.owner,kind:"method_input_closure",id:basis,revision:String(path.controlRevision)}}}];
  }

  private async close(plan:ContextMethodInputPlan,path:ActivityPathState,signal:AbortSignal):Promise<ActivityReconsiderationPreparation> {
    const id=path.intent.id,intents=[plan.materialization.intent,plan.materialization.request.preparationIntent,plan.check.intent];
    const states=[path,await this.ownedPath(plan,intents[1]!),await this.ownedPath(plan,intents[2]!)];
    const participants:SharedAcceptancePart[]=[],observeSources:string[]=[];
    let pending=false,cancelling=false;
    for(let i=0;i<intents.length;i++) {
      signal.throwIfAborted();const intent=intents[i]!,state=states[i]??null;
      participants.push(pathCondition(intent.id,state,false));
      if(!state)continue;
      observeSources.push(activityFactSourceId("progress",intent.id),activityFactSourceId("control",intent.id));
      if(!state.cancelled){cancelling=true;participants.push({owner:"activity",kind:"path_cancellation",proposal:{kind:"cancel",pathId:intent.id,expectedControlRevision:state.controlRevision}});}
      const remaining=await this.ports.activities.command({kind:"pending",runId:plan.scope.runId,pathId:intent.id,after:0,limit:1}) as readonly ActivityHandoffItem[];
      if(remaining.length)pending=true;
    }
    const closing=pending||cancelling;
    const work=plan.scheduling?await this.ports.activities.command({kind:"read_schedule",workId:plan.scheduling.workId}) as import("../activity/index.js").ActivitySchedulingAcceptance|null:null;
    if(plan.scheduling&&(!work||!sameMethodInputSchedulingBinding(plan.scheduling,work.intent)))throw new TypeError("method_input_consumer_schedule_changed");
    const decision={owner:plan.scope.owner,kind:closing?"method_input_closing":"method_input_closed",id,
      revision:modelInputValueDigest(states.map(state=>state?{control:state.controlRevision,progress:state.progressRevision,cancelled:state.cancelled}:null))};
    if(!closing) {
      for(let i=0;i<intents.length;i++)participants[i]=pathCondition(intents[i]!.id,states[i]??null,true);
      if(states[2])participants.push(...await this.ports.methods.prepareInputRelease(plan.check.intent.id));
      // Only the original independent recipient holds belong to this consumer. Producer evidence remains protected.
      participants.push({owner:"material_custody",kind:"holds",proposal:{acquire:[],release:(plan.materialAdmissions??[]).map(a=>a.hold.id),basis:`${id}:closed`}});
      participants.push({owner:"activity",kind:"fact_publication",proposal:{id:`${id}:closed:${decision.revision}`,sourceId:activityFactSourceId("progress",id),ref:decision}});
    }
    if(work) {
      if(!work.pathsSealed)participants.push({owner:"activity",kind:"scheduling_path_seal",proposal:{kind:"seal_scheduled_paths",workId:work.intent.workId,expectedRevision:work.revision,basis:`${id}:closing`}});
      if(!closing)participants.push({owner:"activity",kind:"scheduling_closure",proposal:{kind:"close_scheduled_work",workId:work.intent.workId,
        expectedRevision:work.revision+(work.pathsSealed?0:1),basis:`${id}:closed`,requireSettled:true}});
    }
    signal.throwIfAborted();return {decision,participants,observeSources:[...new Set(observeSources)].sort(),close:!closing};
  }

  private async ownedPath(plan:ContextMethodInputPlan,intent:ContextMethodInputPlan["materialization"]["intent"]):Promise<ActivityPathState|null> {
    const path=await this.ports.activities.command({kind:"read_path",pathId:intent.id}) as ActivityPathState|null;
    if(path&&(path.intent.runId!==plan.scope.runId||path.intent.owner!==plan.scope.owner||
      Object.entries(intent).some(([key,value])=>modelInputValueDigest(path.intent[key as keyof typeof path.intent])!==modelInputValueDigest(value))))
      throw new TypeError("method_input_consumer_path_binding_changed");
    return path;
  }
}

function pathCondition(pathId:string,path:ActivityPathState|null,requireSettled:boolean):SharedAcceptancePart {
  return {owner:"activity",kind:"path_condition",proposal:{pathId,expected:path?{controlRevision:path.controlRevision,progressRevision:path.progressRevision,cancelled:path.cancelled}:null,requireSettled}};
}
