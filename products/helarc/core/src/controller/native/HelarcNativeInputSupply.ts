import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {activityFactSourceId,type ActivityHandoffPort,type ActivityPathIntent,type ActivityPathState,type ActivityStageState,
  type ActivitySchedulingIntent,type ActivityReconsiderationHandler,type ActivityReconsiderationSnapshot,
  type ActivityReconsiderationPreparation,type SharedAcceptancePart} from "@agent-anything/agent-runtime/activity";
import {InputSupplyExitWork,inputSupplyRegistration,inputSupplyResponsibility,inputSupplyFactSource,sourceMaterialOutcome,
  type InputSupplyBinding,type InputSupplyHead,type InputSupplyResponsibility,type InputSupplyResponsibilityStore,
  type InputSupplyResponsibilityPage,type InputSupplyReceptionOwner,type SourceMaterialPublicationWork,
  type OriginalInputSourcePublication,type OriginalInputSupplyDecision} from "@agent-anything/agent-runtime/context-representation";
import type {HelarcNativeInputDemandWork} from "./HelarcNativeInputDemandWork.js";
import type {HelarcNativeOriginalInputWork,HelarcNativeOriginalInputPlan} from "./HelarcNativeOriginalInputWork.js";

type Demand=Extract<Awaited<ReturnType<HelarcNativeInputDemandWork["result"]>>,{kind:"needed"}>;
export interface HelarcNativeInputSupplyArrangement {
  readonly scheduling:ActivitySchedulingIntent;
  readonly publications:readonly OriginalInputSourcePublication[];
  readonly preparation:{readonly intent:Omit<ActivityPathIntent,"owner"|"purpose">;readonly plan:HelarcNativeOriginalInputPlan}|null;
}
interface Ports {
  readonly activities:ActivityHandoffPort;
  readonly responsibilities:InputSupplyResponsibilityStore;
  readonly demand:Pick<HelarcNativeInputDemandWork,"result">;
  readonly publications:Pick<SourceMaterialPublicationWork,"prepareSubmission">;
  readonly original:Pick<HelarcNativeOriginalInputWork,"prepareSubmission"|"result">;
  readonly receivers:InputSupplyReceptionOwner;
  readonly authorize:(demand:Demand,signal:AbortSignal)=>Promise<void>;
  /** Original configuration and local planning only; no execution or policy decisions. */
  readonly resolve:(demand:Demand,origin:InputSupplyBinding,signal:AbortSignal)=>Promise<HelarcNativeInputSupplyArrangement>;
  readonly decide:(demand:Demand,arrangement:HelarcNativeInputSupplyArrangement,snapshot:ActivityReconsiderationSnapshot,
    signal:AbortSignal)=>Promise<OriginalInputSupplyDecision>;
}

/** Owns source/preparation handoffs and supplier exit, not production or selection policy. */
export class HelarcNativeInputSupply implements ActivityReconsiderationHandler {
  constructor(private readonly ports:Ports){}

  async prepare(snapshot:ActivityReconsiderationSnapshot,signal:AbortSignal):Promise<ActivityReconsiderationPreparation>{
    signal.throwIfAborted();const subscription=snapshot.state.subscription,binding=subscription.binding;
    if(binding?.kind!=="input_need")throw new TypeError("native_supply_subscription_invalid");
    const need=await this.ports.activities.command({kind:"read_input_need",id:binding.id}) as Demand["need"]|null;
    if(!need||need.supplier!==subscription.owner)throw new TypeError("native_supply_need_invalid");
    const demand=await this.ports.demand.result(need.stage.pathId);
    if(!("need" in demand)||!demand.need||digest(demand.need)!==digest(need)||demand.path.intent.runId!==subscription.runId)
      throw new TypeError("native_supply_origin_unavailable");
    const returned=await this.ports.activities.command({kind:"read_stage",requestId:need.stage.id}) as ActivityStageState|null;
    const unavailable=await this.ports.activities.command({kind:"read_stage",requestId:need.unavailableStage.id}) as ActivityStageState|null;
    if(returned&&unavailable)throw new TypeError("native_supply_conflicting_returns");
    if(demand.path.cancelled||returned||unavailable)return new InputSupplyExitWork(this.ports).prepare({need,
      consumer:demand.path,sourceStage:demand.source},subscription.id,unavailable??returned,signal);
    if(demand.kind!=="needed")throw new TypeError("native_supply_demand_changed");
    await this.ports.authorize(demand,signal);
    const origin:InputSupplyBinding={needId:need.id,runId:subscription.runId,owner:need.supplier,consumerPathId:demand.path.intent.id,
      source:{stageId:demand.source.request.id,requestDigest:digest(demand.source.request)},
      configuration:demand.plan.activity.composition.composition.configuration.configuration};
    const arranged=await this.ports.resolve(demand,origin,signal),{scheduling,publications,preparation}=arranged;
    if(scheduling.runId!==origin.runId||scheduling.owner!==origin.owner||!scheduling.delegatedPathOwners?.includes("material-source")||
      new Set(publications.map(p=>p.pathId)).size!==publications.length||publications.some(p=>p.request.intent.activityId!==p.pathId||
        p.request.recipient.runId!==origin.runId||(p.state==="published")!==(p.published!==null)||(p.state==="unavailable")!==(p.unavailable!==undefined)))
      throw new TypeError("native_supply_arrangement_changed");
    if(preparation&&(digest(preparation.plan.inputSupply)!==digest(origin)||digest(preparation.plan.scope)!==digest(demand.plan.inputNeed.scope)||
      preparation.intent.scheduledWorkId!==scheduling.workId||preparation.intent.runId!==origin.runId||
      preparation.intent.permissionBasis!==demand.path.intent.permissionBasis))throw new TypeError("native_supply_preparation_changed");
    const head=await this.ports.responsibilities.query({kind:"head",needId:need.id}) as InputSupplyHead|null;
    if(head&&(digest(head.binding)!==digest(origin)||digest(head.scheduling)!==digest(scheduling)))throw new TypeError("native_supply_binding_changed");
    const registered=new Set<string>();let afterId:string|null=null;
    if(head)do{
      const page=await this.ports.responsibilities.query({kind:"page",needId:need.id,revision:head.revision,afterId,limit:128}) as InputSupplyResponsibilityPage;
      if(page.kind!=="page")throw new TypeError("native_supply_membership_changed");
      page.entries.forEach(e=>registered.add(e.target.pathId));afterId=page.next;signal.throwIfAborted();
    }while(afterId);
    const register=(proposal:OriginalInputSupplyDecision):ActivityReconsiderationPreparation=>{
      const dependencies=[...proposal.supplyDependencies??[]];
      for(const part of proposal.participants)if(part.owner==="activity"&&part.kind==="path_opening"){
        const intent=part.proposal as ActivityPathIntent;
        const stage=proposal.participants.find(p=>p.owner==="activity"&&p.kind==="stage_submission"&&
          (p.proposal as ActivityStageState["request"]).pathId===intent.id)?.proposal as ActivityStageState["request"]|undefined;
        const declaration=stage?.input as {inputSupplyPreparation?:unknown;inputSupplyProduction?:unknown;inputSupplyReception?:unknown}|undefined;
        const role:InputSupplyResponsibility["role"]|null=publications.some(p=>p.pathId===intent.id)?"source_publication":
          declaration?.inputSupplyPreparation?"input_preparation":declaration?.inputSupplyProduction?"method_production":
          declaration?.inputSupplyReception?"method_reception":null;
        if(role)dependencies.push(inputSupplyResponsibility(role,intent));
      }
      const unique=new Map<string,InputSupplyResponsibility>();
      for(const entry of dependencies){const prior=unique.get(entry.id);
        if(prior&&digest(prior)!==digest(entry))throw new TypeError("native_supply_dependency_conflict");unique.set(entry.id,entry);}
      const {supplyDependencies:_,...base}=proposal;
      return {...base,close:false,observeSources:[...new Set([...(proposal.observeSources??snapshot.state.observedSources??[]),
        inputSupplyFactSource(origin).id,activityFactSourceId("control",origin.consumerPathId),activityFactSourceId("progress",origin.consumerPathId)])],
        participants:[{owner:"activity",kind:"input_need_condition",proposal:{needId:need.id,expectedControlRevision:demand.path.controlRevision}},
          ...head?[]:[{owner:"activity",kind:"scheduling_acceptance",proposal:{kind:"schedule_work",intent:scheduling,expectedRevision:0}} satisfies SharedAcceptancePart],
          ...base.participants,inputSupplyRegistration({binding:origin,scheduling,expectedRevision:head?.revision??0,
            expectedConsumerControlRevision:demand.path.controlRevision,responsibilities:[...unique.values()]})],
        ...(proposal.rejected?{rejected:async receipt=>{const next=await proposal.rejected!(receipt);return next?register(next):null;}}:{})};
    };
    const wait=(paths:readonly string[],participants:readonly SharedAcceptancePart[],dependencies:readonly InputSupplyResponsibility[]=[])=>register({
      decision:{owner:origin.owner,kind:"native_input_supply_wait",id:need.id,revision:digest(paths)},participants,supplyDependencies:dependencies,
      observeSources:paths.flatMap(id=>[activityFactSourceId("progress",id),activityFactSourceId("control",id)]),close:false});
    const missing=publications.find(p=>p.state==="unavailable");
    if(missing){
      const path=await this.ports.activities.command({kind:"read_path",pathId:missing.pathId}) as ActivityPathState;
      const stage=await this.ports.activities.command({kind:"read_stage",requestId:`${missing.pathId}:capture`}) as ActivityStageState;
      const outcome=sourceMaterialOutcome(path,stage);
      if(outcome?.kind!=="source_material_unavailable"||digest(outcome)!==digest(missing.unavailable))throw new TypeError("native_supply_source_limitation_changed");
      return register({decision:{owner:origin.owner,kind:"native_input_source_unavailable",id:need.id,revision:"1"},participants:[
        {owner:"activity",kind:"stage_submission",proposal:{...need.unavailableStage,input:{kind:"context_input_unavailable",needId:need.id,supplier:origin.owner,
          boundary:demand.plan.prepared.sourceDigest,reason:"original_source_unavailable",sourceStop:outcome.limitation.kind,
          evidence:[{owner:"shared_acceptance",kind:"professional_stop",id:outcome.stopAcceptanceId,revision:"1"}]}}}],close:false});
    }
    const reused=publications.filter(p=>p.state!=="new"&&!registered.has(p.pathId)).slice(0,32);
    if(reused.length){
      const dependencies=[];
      for(const p of reused){const path=await this.ports.activities.command({kind:"read_path",pathId:p.pathId}) as ActivityPathState|null;
        if(!path)throw new TypeError("native_supply_source_dependency_missing");dependencies.push(inputSupplyResponsibility("source_publication",path.intent));}
      return wait(reused.map(p=>p.pathId),[],dependencies);
    }
    const fresh=publications.filter(p=>p.state==="new").slice(0,16),pending=publications.filter(p=>p.state==="pending").slice(0,16);
    if(fresh.length||pending.length){
      const parts=fresh.flatMap(p=>this.ports.publications.prepareSubmission({id:p.pathId,runId:origin.runId,
        permissionBasis:demand.path.intent.permissionBasis,resourceScope:p.pathId,scheduledWorkId:scheduling.workId,
        maximumStages:1,maximumAttempts:1,maximumConcurrent:1,deadlineAt:demand.path.intent.deadlineAt},p.request));
      return wait([...fresh,...pending].map(p=>p.pathId),parts);
    }
    if(!preparation)throw new TypeError("native_supply_preparation_missing");
    const expected=this.ports.original.prepareSubmission(preparation.intent,preparation.plan);
    const original=await this.ports.activities.command({kind:"read_stage",requestId:`${preparation.intent.id}:stage:1`}) as ActivityStageState|null;
    if(!original)return wait([preparation.intent.id],expected);
    const path=await this.ports.activities.command({kind:"read_path",pathId:preparation.intent.id}) as ActivityPathState|null;
    if(digest(path?.intent)!==digest(expected[0]!.proposal)||digest(original.request)!==digest(expected[1]!.proposal))throw new TypeError("native_supply_original_preparation_changed");
    if(path!.cancelled||original.status==="stopped"){
      if(!path!.cancelled&&!original.stop)throw new TypeError("native_supply_preparation_stop_missing");
      return register({decision:{owner:origin.owner,kind:"native_input_preparation_unavailable",id:need.id,revision:String(path!.controlRevision)},
        participants:[{owner:"activity",kind:"path_condition",proposal:{pathId:path!.intent.id,
          expected:{controlRevision:path!.controlRevision,progressRevision:path!.progressRevision,cancelled:path!.cancelled},requireSettled:false}},
          {owner:"activity",kind:"stage_submission",proposal:{...need.unavailableStage,input:{kind:"context_input_unavailable",needId:need.id,supplier:origin.owner,
            boundary:demand.plan.prepared.sourceDigest,reason:path!.cancelled?"original_preparation_cancelled":"original_preparation_stopped",
            evidence:[{owner:"activity",kind:"fact",id:original.request.id,revision:String(path!.progressRevision)}]}}}],close:false});
    }
    const result=await this.ports.original.result(preparation.intent.id);
    if(result.kind!=="prepared")return wait([preparation.intent.id],[]);
    return register(await this.ports.decide(demand,arranged,snapshot,signal));
  }
}
