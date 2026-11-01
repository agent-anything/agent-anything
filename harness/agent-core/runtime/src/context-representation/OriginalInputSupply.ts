import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {activityFactSourceId,type ActivityInputNeed,type ActivityPathIntent,type ActivityPathState,type ActivityStageState,
  type ActivityHandoffPort,type ActivitySchedulingIntent,type ActivityReconsiderationHandler,type ActivityReconsiderationPreparation,
  type ActivityReconsiderationSnapshot,type SharedAcceptancePart} from "../activity/index.js";
import type {ProviderRequest} from "@agent-anything/model-interaction";
import type {SourceMaterialPublicationWork,SourceMaterialPublicationRequest,PublishedSourceMaterial,UnavailableSourceMaterial} from "./SourceMaterialPublication.js";
import {sourceMaterialOutcome} from "./SourceMaterialPublication.js";
import type {ContextInputUnavailability} from "./ContextInputUnavailability.js";
import {CONTEXT_INPUT_PREPARATION_PURPOSE,type ContextInputPreparationRequest,type ContextInputPreparationStageInput} from "./ContextInputPreparation.js";
import type {ContextInputPreparationWork} from "./ContextInputPreparationWork.js";
import {readContextInputEvidence,type ContextInputEvidence} from "./ContextInputEvidence.js";
import {inputSupplyRegistration,inputSupplyResponsibility,inputSupplyFactSource,type InputSupplyBinding,type InputSupplyHead,
  type InputSupplyResponsibilityStore,type InputSupplyResponsibility,type InputSupplyResponsibilityPage} from "./InputSupplyResponsibility.js";
import {SOURCE_MATERIAL_PUBLICATION_PURPOSE} from "./SourceMaterialPublication.js";
import {CONTEXT_INPUT_MATERIALIZATION_PURPOSE} from "./ContextInputMaterialization.js";
import {REPRESENTATION_METHOD_PURPOSE} from "./methods/RepresentationMethod.js";
import {InputSupplyExitWork} from "./InputSupplyExit.js";
import type {ContextMethodInputConsumer} from "./ContextMethodInputConsumer.js";

export interface OriginalInputSourcePublication {
  readonly pathId:string;
  readonly request:SourceMaterialPublicationRequest;
  readonly state:"new"|"pending"|"published"|"unavailable";
  readonly published:PublishedSourceMaterial|null;
  readonly unavailable?:UnavailableSourceMaterial;
}
export interface OriginalInputSupplyBinding {
  readonly configuration:InputSupplyBinding["configuration"];
  readonly schedule:ActivitySchedulingIntent;
  readonly publications:readonly OriginalInputSourcePublication[];
  readonly preparation:Omit<ActivityPathIntent,"purpose"|"owner">;
  readonly input:ContextInputPreparationRequest;
}
export interface OriginalInputSource {readonly request:ProviderRequest;}
export interface OriginalInputSupplyBasis<TSource extends OriginalInputSource = OriginalInputSource> {
  readonly need:ActivityInputNeed;
  readonly consumer:ActivityPathState;
  readonly source:TSource;
  readonly sourceStage:ActivityStageState;
}
export interface OriginalInputSupplyDecision extends ActivityReconsiderationPreparation {
  /** Reuse of already admitted work is explicit, not inferred from the current offer catalogue. */
  readonly supplyDependencies?:readonly InputSupplyResponsibility[];
}

/** Durable source/preparation handoffs. Selection policy and adoption remain separate professional work. */
export class OriginalInputSupply<TSource extends OriginalInputSource> implements ActivityReconsiderationHandler {
  constructor(private readonly ports:{
    readonly source:{
      readonly stageId:(need:ActivityInputNeed,consumer:ActivityPathState)=>string;
      readonly validate:(source:unknown,consumer:ActivityPathState)=>asserts source is TSource;
    };
    readonly activities:ActivityHandoffPort;
    readonly responsibilities:InputSupplyResponsibilityStore;
    readonly publications:Pick<SourceMaterialPublicationWork,"prepareSubmission">;
    readonly preparation:Pick<ContextInputPreparationWork,"prepareSubmission">;
    readonly authorize:(basis:OriginalInputSupplyBasis<TSource>,signal:AbortSignal)=>Promise<void>;
    /** Bounded source lookup and original binding resolution; no external execution or publication. */
    readonly resolve:(basis:OriginalInputSupplyBasis<TSource>,signal:AbortSignal)=>Promise<OriginalInputSupplyBinding>;
    /** CRM evaluates the full prepared input or gap and proposes its next shared acceptance. */
    readonly decide:(basis:OriginalInputSupplyBasis<TSource>,binding:OriginalInputSupplyBinding,result:ContextInputEvidence,
      snapshot:ActivityReconsiderationSnapshot,signal:AbortSignal)=>Promise<OriginalInputSupplyDecision>;
    readonly receivers?:Pick<ContextMethodInputConsumer,"prepareClosure">;
  }) {}

  async prepare(snapshot:ActivityReconsiderationSnapshot,signal:AbortSignal):Promise<ActivityReconsiderationPreparation> {
    signal.throwIfAborted();const subscription=snapshot.state.subscription;
    if(subscription.binding?.kind!=="input_need")throw new TypeError("input_supply_subscription_binding_missing");
    const need=await this.ports.activities.command({kind:"read_input_need",id:subscription.binding.id}) as ActivityInputNeed|null;
    if(!need||need.supplier!==subscription.owner)throw new TypeError("input_supply_supplier_changed");
    const consumer=await this.ports.activities.command({kind:"read_path",pathId:need.stage.pathId}) as ActivityPathState|null;
    if(!consumer||consumer.intent.runId!==subscription.runId||consumer.intent.purpose.contract.inputOwner!==subscription.owner)
      throw new TypeError("input_supply_consumer_binding_changed");
    const sourceStageId=this.ports.source.stageId(need,consumer);
    const sourceStage=await this.ports.activities.command({kind:"read_stage",requestId:sourceStageId}) as ActivityStageState|null;
    if(!sourceStage||sourceStage.request.id!==sourceStageId||sourceStage.request.pathId!==consumer.intent.id||
      sourceStage.status!=="accepted"||sourceStage.result?.completeness!=="complete"||sourceStage.result.outcome!=="returned"||
      sourceStage.receipt?.requestId!==sourceStage.request.id||sourceStage.receipt.resultId!==sourceStage.result.id||
      sourceStage.receipt.owner!==consumer.intent.purpose.contract.acceptanceOwner)
      throw new TypeError("input_supply_original_source_unconfirmed");
    const source:unknown=sourceStage.request.input;
    this.ports.source.validate(source,consumer);
    const basis={need,consumer,source,sourceStage};
    const supplied=await this.ports.activities.command({kind:"read_stage",requestId:need.stage.id}) as ActivityStageState|null;
    const unavailable=await this.ports.activities.command({kind:"read_stage",requestId:need.unavailableStage.id}) as ActivityStageState|null;
    if(supplied&&unavailable)throw new TypeError("input_supply_conflicting_outcomes");
    if(consumer.cancelled||supplied||unavailable)return new InputSupplyExitWork(this.ports).prepare(basis,subscription.id,unavailable??supplied,signal);
    await this.ports.authorize(basis,signal);
    const binding=await this.ports.resolve(basis,signal);
    this.validateBinding(basis,binding);
    const origin:InputSupplyBinding={needId:need.id,runId:consumer.intent.runId,owner:need.supplier,consumerPathId:consumer.intent.id,
      source:{stageId:sourceStage.request.id,requestDigest:modelInputValueDigest(sourceStage.request)},configuration:binding.configuration};
    const head=await this.ports.responsibilities.query({kind:"head",needId:need.id}) as InputSupplyHead|null;
    if(head&&modelInputValueDigest(head.binding)!==modelInputValueDigest(origin))throw new TypeError("input_supply_supply_binding_changed");
    const registered=new Set<string>();let afterId:string|null=null;
    if(head)do {
      signal.throwIfAborted();const page=await this.ports.responsibilities.query({kind:"page",needId:need.id,revision:head.revision,afterId,limit:128}) as InputSupplyResponsibilityPage;
      if(page.kind!=="page")throw new Error("input_supply_supply_membership_changed");
      page.entries.forEach(entry=>registered.add(entry.target.pathId));afterId=page.next;
    }while(afterId!==null);
    const register=(proposal:OriginalInputSupplyDecision):ActivityReconsiderationPreparation=>{
      const responsibilities=[...proposal.supplyDependencies??[]];
      const purposes=[["source_publication",SOURCE_MATERIAL_PUBLICATION_PURPOSE],["input_preparation",CONTEXT_INPUT_PREPARATION_PURPOSE],
        ["method_production",REPRESENTATION_METHOD_PURPOSE],["method_reception",CONTEXT_INPUT_MATERIALIZATION_PURPOSE]] as const;
      for(const part of proposal.participants)if(part.owner==="activity"&&part.kind==="path_opening") {
        const intent=part.proposal as ActivityPathIntent,role=purposes.find(([,purpose])=>intent.purpose.digest===modelInputValueDigest(purpose))?.[0];
        if(role)responsibilities.push(inputSupplyResponsibility(role,intent));
      }
      const indexed=new Map<string,InputSupplyResponsibility>();
      for(const entry of responsibilities){const prior=indexed.get(entry.id);
        if(prior&&modelInputValueDigest(prior)!==modelInputValueDigest(entry))throw new TypeError("input_supply_supply_conflicting_dependency");indexed.set(entry.id,entry);}
      const unique=[...indexed.values()];
      const {supplyDependencies:_,...base}=proposal;
      const schedulePresent=base.participants.some(p=>p.owner==="activity"&&p.kind==="scheduling_acceptance"&&
        (p.proposal as {intent?:{workId?:string}}).intent?.workId===binding.schedule.workId);
      return this.guard(basis,{...base,close:false,observeSources:[...new Set([...(base.observeSources??snapshot.state.observedSources??[]),
        inputSupplyFactSource(origin).id,activityFactSourceId("progress",consumer.intent.id)])],
        participants:[...(schedulePresent?[]:[this.schedule(binding)]),...base.participants,inputSupplyRegistration({binding:origin,scheduling:binding.schedule,expectedRevision:head?.revision??0,
        expectedConsumerControlRevision:consumer.controlRevision,responsibilities:unique})],
        ...(proposal.rejected?{rejected:async receipt=>{const next=await proposal.rejected!(receipt);return next?register(next):null;}}:{})});
    };
    const unavailableSource=binding.publications.find(p=>p.state==="unavailable");
    if(unavailableSource) {
      const path=await this.ports.activities.command({kind:"read_path",pathId:unavailableSource.pathId}) as ActivityPathState|null;
      const stage=await this.ports.activities.command({kind:"read_stage",requestId:`${unavailableSource.pathId}:capture`}) as ActivityStageState|null;
      const outcome=path&&stage?sourceMaterialOutcome(path,stage):null;
      if(outcome?.kind!=="source_material_unavailable"||modelInputValueDigest(outcome)!==modelInputValueDigest(unavailableSource.unavailable))
        throw new TypeError("input_supply_source_limitation_changed");
      const input:ContextInputUnavailability={kind:"context_input_unavailable",needId:need.id,supplier:need.supplier,
        boundary:binding.input.demand.historyBoundary,reason:"original_source_unavailable",
        evidence:[{owner:"shared_acceptance",kind:"professional_stop",id:outcome.stopAcceptanceId,revision:"1"}]};
      return register({decision:{owner:need.supplier,kind:"input_source_unavailable",id:need.id,revision:modelInputValueDigest(input)},
        participants:[{owner:"activity",kind:"stage_submission",proposal:{...need.unavailableStage,input}}],close:false});
    }
    // A recorded unavailable outcome is evidence, not a newly acquired producer dependency.
    const reused=binding.publications.filter(p=>p.state!=="new"&&!registered.has(p.pathId)).slice(0,32);
    if(reused.length) {
      const responsibilities:InputSupplyResponsibility[]=[];
      for(const publication of reused) {
        signal.throwIfAborted();const path=await this.ports.activities.command({kind:"read_path",pathId:publication.pathId}) as ActivityPathState|null;
        if(!path)throw new TypeError("input_supply_source_dependency_missing");
        responsibilities.push(inputSupplyResponsibility("source_publication",path.intent));
      }
      return register({decision:{owner:need.supplier,kind:"input_supply_dependencies",id:need.id,revision:String(head?.revision??0)},
        supplyDependencies:responsibilities,participants:[],
        observeSources:[activityFactSourceId("control",consumer.intent.id),inputSupplyFactSource(origin).id],close:false});
    }
    const preparing=await this.ports.activities.command({kind:"read_path",pathId:binding.preparation.id}) as ActivityPathState|null;
    if(preparing) {
      const original=await this.ports.activities.command({kind:"read_stage",requestId:`${binding.preparation.id}:stage:1`}) as ActivityStageState|null;
      const {purpose,owner,...identity}=preparing.intent;
      if(purpose.digest!==modelInputValueDigest(CONTEXT_INPUT_PREPARATION_PURPOSE)||owner!==need.supplier||
        modelInputValueDigest(identity)!==modelInputValueDigest(binding.preparation)||
        modelInputValueDigest((original?.request.input as ContextInputPreparationStageInput|undefined)?.request)!==modelInputValueDigest(binding.input))
        throw new TypeError("input_supply_preparation_binding_changed");
      const demand=binding.input.demand;
      const result=await readContextInputEvidence({activities:this.ports.activities,pathId:preparing.intent.id,
        scope:{runId:demand.runId,recipient:demand.recipient,purpose:demand.purpose,target:demand.targetRevision,owner:need.supplier},
        demandId:demand.id,boundary:demand.historyBoundary},signal);
      if(result.kind!=="pending"&&result.kind!=="changed") {
        const proposed=await this.ports.decide(basis,binding,result,snapshot,signal);
        return register(proposed);
      }
      return register(this.waitFor(basis,binding,[preparing.intent.id],[]));
    }
    // Bounded admission keeps source publication out of the callback and within the shared acceptance limit.
    const fresh=binding.publications.filter(value=>value.state==="new").slice(0,16);
    const pending=binding.publications.filter(value=>value.state==="pending").slice(0,16);
    if(fresh.length||pending.length) {
      const parts:SharedAcceptancePart[]=fresh.length?[this.schedule(binding)]:[];
      for(const publication of fresh)parts.push(...this.ports.publications.prepareSubmission({id:publication.pathId,runId:consumer.intent.runId,
        permissionBasis:consumer.intent.permissionBasis,resourceScope:publication.pathId,scheduledWorkId:binding.schedule.workId,
        maximumStages:1,maximumAttempts:1,maximumConcurrent:1,deadlineAt:binding.preparation.deadlineAt},publication.request));
      return register(this.waitFor(basis,binding,[...fresh,...pending].map(value=>value.pathId),parts));
    }
    const parts=[this.schedule(binding),...this.ports.preparation.prepareSubmission(binding.preparation,binding.input)];
    return register(this.waitFor(basis,binding,[binding.preparation.id],parts));
  }

  private schedule(binding:OriginalInputSupplyBinding):SharedAcceptancePart {
    return {owner:"activity",kind:"scheduling_acceptance",proposal:{kind:"schedule_work",intent:binding.schedule,expectedRevision:0}};
  }
  private waitFor(basis:OriginalInputSupplyBasis<TSource>,binding:OriginalInputSupplyBinding,paths:readonly string[],participants:readonly SharedAcceptancePart[]):ActivityReconsiderationPreparation {
    const sources=[...new Set([activityFactSourceId("control",basis.consumer.intent.id),...paths.flatMap(id=>[activityFactSourceId("progress",id),activityFactSourceId("control",id)])])].sort();
    return {decision:{owner:basis.need.supplier,kind:"input_producers",id:modelInputValueDigest({need:basis.need.id,paths,preparation:binding.preparation.id}),revision:"1"},
      participants,observeSources:sources,close:false};
  }
  private condition(basis:OriginalInputSupplyBasis<TSource>):SharedAcceptancePart {
    return {owner:"activity",kind:"input_need_condition",proposal:{needId:basis.need.id,expectedControlRevision:basis.consumer.controlRevision}};
  }
  private guard(basis:OriginalInputSupplyBasis<TSource>,proposal:ActivityReconsiderationPreparation):ActivityReconsiderationPreparation {
    return {...proposal,participants:[this.condition(basis),...proposal.participants],...(proposal.observeSources?{
      observeSources:[...new Set([activityFactSourceId("control",basis.consumer.intent.id),...proposal.observeSources])].sort(),
    }:{})};
  }
  private validateBinding(basis:OriginalInputSupplyBasis<TSource>,binding:OriginalInputSupplyBinding):void {
    const {need,consumer,source}=basis;
    if(binding.schedule.runId!==consumer.intent.runId||binding.schedule.owner!==need.supplier||binding.preparation.runId!==consumer.intent.runId||
      binding.preparation.scheduledWorkId!==binding.schedule.workId||binding.preparation.permissionBasis!==consumer.intent.permissionBasis||binding.input.demand.runId!==consumer.intent.runId||
      modelInputValueDigest(binding.input.template)!==modelInputValueDigest(source.request)||
      new Set(binding.publications.map(value=>value.pathId)).size!==binding.publications.length||
      binding.publications.some(value=>value.request.recipient.runId!==consumer.intent.runId||value.request.intent.activityId!==value.pathId||
        (value.state==="unavailable")!==(value.unavailable!==undefined)||
        (value.state==="published")!==(value.published!==null))||
      !binding.schedule.delegatedPathOwners?.includes("material-source"))throw new TypeError("input_supply_original_binding_changed");
  }
}
