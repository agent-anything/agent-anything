import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {containsMaterialRange,type MaterialAccess,type MaterialCustodyPort,type MaterialHold,type MaterialAccessDescription} from "@agent-anything/context/custody";
import type {ActivityHandoffPort,ActivityInputNeed,ActivityPathState,SharedAcceptancePart} from "../activity/index.js";
import {activityFactSourceId} from "../activity/index.js";
import type {ContextMethodInputSupply} from "./ContextMethodInputSupply.js";
import type {ContextMethodInputConsumer} from "./ContextMethodInputConsumer.js";
import type {RepresentationMethodWork} from "./methods/RepresentationMethodWork.js";
import {originalInputRepresentationPlan} from "./OriginalInputRepresentationPlan.js";
import {validateOriginalInputRepresentationMembers,type OriginalInputRepresentationMember} from "./OriginalInputRepresentationDemand.js";
import {validateOriginalInputPublication,type OriginalInputPublicationPlan} from "./OriginalInputPublications.js";
import {readContextInputEvidence} from "./ContextInputEvidence.js";
import type {ContextCurrentInput} from "./ContextPreparationPolicy.js";
import {readPreparedInputRejection} from "./PreparedInputRejection.js";

export type OriginalInputRepresentationReceptionBasis=Pick<Parameters<typeof originalInputRepresentationPlan>[0],
  "sources"|"scope"|"preparation"|"inputSupply"|"checkTemplate"> & {readonly members:readonly OriginalInputRepresentationMember[]};
type Arrangement=Pick<Parameters<typeof originalInputRepresentationPlan>[0],"intent"|"checkCapacity"|"checkBounds"|"scheduling">;

/** Recipient organization of an authorized representation. Investment and selection stay with CRM. */
export class OriginalInputRepresentationReception {
  constructor(private readonly ports:{
    readonly activities:ActivityHandoffPort;readonly materials:MaterialCustodyPort;
    readonly inputs:Pick<ContextMethodInputSupply,"readPlan"|"prepare">;
    readonly consumers:Pick<ContextMethodInputConsumer,"prepareStart"|"prepareClosure">;
    readonly methods:Pick<RepresentationMethodWork,"result"|"prepareAdoption">;
  }) {}

  id(basis:OriginalInputRepresentationReceptionBasis):string {
    validateOriginalInputRepresentationMembers(basis.sources,basis.members);
    return `${basis.preparation.demand.id}:representation-consumer:${modelInputValueDigest({scope:basis.scope,
      members:ordered(basis).map(m=>({pathId:m.pathId,kind:m.supply.kind,scope:m.supply.scope,request:m.supply.request})),
      source:basis.sources.id,checkTemplate:basis.checkTemplate,preparation:basis.preparation,...(basis.inputSupply?{inputSupply:basis.inputSupply}:{})})}`;
  }

  async inspect(basis:OriginalInputRepresentationReceptionBasis,signal:AbortSignal) {
    signal.throwIfAborted();
    const id=this.id(basis),plan=await this.ports.inputs.readPlan(id);
    const observeSources=[activityFactSourceId("progress",id),activityFactSourceId("control",id)];
    if(!plan)return {kind:"not_started" as const,id,observeSources};
    const members=ordered(basis);
    if(plan.producers.length!==members.length||members.some((m,i)=>plan.producers[i]!.pathId!==m.pathId||
      plan.materialization.request.demand.dependencies[`representationProducer:${i}:producerRequest`]!==modelInputValueDigest(m.supply.request))||
      modelInputValueDigest(plan.check.template)!==modelInputValueDigest(basis.checkTemplate)||
      modelInputValueDigest(plan.inputSupply??null)!==modelInputValueDigest(basis.inputSupply??null)||modelInputValueDigest(plan.scope)!==modelInputValueDigest(basis.scope)||
      modelInputValueDigest(plan.materialization.request.preparation.template)!==modelInputValueDigest(basis.preparation.template))
      throw new TypeError("representation_reception_original_binding_changed");
    const path=await this.path(basis,id);signal.throwIfAborted();
    const accepted={id,workId:path.intent.scheduledWorkId??null,revision:`${path.progressRevision}:${path.controlRevision}`,observeSources};
    if(path.cancelled) {
      const organization=await this.ports.activities.command({kind:"read_path",pathId:plan.materialization.request.preparationIntent.id}) as ActivityPathState|null;
      let inputGap:Extract<ContextCurrentInput,{kind:"gap"}>|undefined;
      let providerRejection:Awaited<ReturnType<typeof readPreparedInputRejection>>=null;
      if(organization) {
        const original=await readContextInputEvidence({activities:this.ports.activities,pathId:organization.intent.id,scope:basis.scope,
          demandId:plan.materialization.request.demand.id,boundary:basis.sources.boundary,includeCancelledOutcome:true},signal);
        const assessment=original.kind==="cancelled"?original.acceptedOutcome:original;
        if(assessment?.kind==="available"&&assessment.current.kind==="gap")inputGap=assessment.current;
        if(assessment?.kind==="available"&&assessment.current.kind==="prepared")
          providerRejection=await readPreparedInputRejection(this.ports.activities,plan.inputSupply,assessment.current.prepared);
      }
      return {kind:"unavailable" as const,...accepted,reason:providerRejection?"provider_input_previously_rejected":"consumer_closed",...(inputGap?{inputGap}:{}),...(providerRejection?{providerRejection}:{})};
    }
    const result=await this.ports.inputs.prepare(plan,signal);
    if(result.kind==="checked")return {...result,...accepted,plan};
    if(result.kind==="unavailable")return {kind:"unavailable" as const,...accepted,reason:result.reason,...(result.inputGap?{inputGap:result.inputGap}:{}),...(result.providerRejection?{providerRejection:result.providerRejection}:{})};
    // Only the independent consumer owns the successors returned by its original plan.
    return {kind:"waiting" as const,...accepted};
  }

  async prepareStart(basis:OriginalInputRepresentationReceptionBasis,arrangement:Arrangement,signal:AbortSignal) {
    const current=await this.inspect(basis,signal);
    if(current.kind!=="not_started")return {participants:[] as readonly SharedAcceptancePart[],observeSources:current.observeSources};
    if(arrangement.intent.id!==current.id)throw new TypeError("representation_reception_identity_changed");
    const members:Parameters<typeof originalInputRepresentationPlan>[0]["members"][number][]=[],conditions:SharedAcceptancePart[]=[];
    for(const member of ordered(basis)) {
      const producer=await this.path(basis,member.pathId),result=await this.ports.methods.result(member.pathId);signal.throwIfAborted();
      if(result.kind!=="ready"||producer.cancelled)throw new TypeError("representation_reception_producer_not_ready");
      members.push({...member,progress:result.progress});conditions.push(this.condition(producer));
    }
    const plan=await originalInputRepresentationPlan({...basis,...arrangement,members,materials:this.ports.materials,signal});
    return {participants:[...conditions,...await this.ports.consumers.prepareStart(plan,signal)],observeSources:current.observeSources};
  }

  async prepareAdoption(basis:OriginalInputRepresentationReceptionBasis,input:{
    readonly id:string;readonly need:ActivityInputNeed;readonly publications:readonly OriginalInputPublicationPlan[];
    readonly expectedSelectionId:string|null;readonly expectedControlRevision:number;
    readonly selectionId:string;readonly inputId:string;readonly releaseHolds:readonly string[];
  },signal:AbortSignal) {
    const current=await this.inspect(basis,signal);
    if(current.kind!=="checked"||input.need.supplier!==basis.scope.owner)throw new TypeError("representation_reception_input_not_checked");
    const {scope}=basis,recipient={runId:scope.runId,recipient:scope.recipient,purpose:scope.purpose};
    if(input.publications.length!==basis.sources.groups.length||new Set(input.publications.map(p=>p.group.id)).size!==input.publications.length)
      throw new TypeError("representation_reception_source_coverage_missing");
    const accesses:{access:MaterialAccess;instanceId:string}[]=basis.sources.groups.map(group=>{
      const publication=input.publications.find(p=>p.group.id===group.id);
      if(!publication)throw new TypeError("representation_reception_source_coverage_missing");
      const published=validateOriginalInputPublication({...publication,group},recipient,scope.target);
      return {access:published.access,instanceId:publication.request.intent.instanceId};
    });
    // Source detail and recovery duties survive replacement of the recipient's presentation.
    for(const admission of current.plan.materialAdmissions??[])accesses.push({access:admission.source,instanceId:admission.hold.instanceId});
    for(const access of current.progress.request.dependencyAccesses??[]) {
      signal.throwIfAborted();
      if(accesses.some(existing=>containsMaterialRange(existing.access.range,access.range)))continue;
      const description=await this.ports.materials.command({kind:"describe",holdId:access.holdId,recipient:access.recipient}) as MaterialAccessDescription|null;
      if(!description||!containsMaterialRange(description.hold.range,access.range))throw new TypeError("representation_reception_dependency_unavailable");
      accesses.push({access,instanceId:description.hold.instanceId});
    }
    const holds=(responsibility:"selection"|"input"):MaterialHold[]=>accesses.map(({access,instanceId},index)=>({
      id:`${input.inputId}:${responsibility}:${index}`,instanceId,consumer:recipient,responsibility,range:access.range,
      basis:responsibility==="selection"?input.selectionId:input.inputId,releaseCondition:"Explicit release after the recipient responsibility settles"}));
    const selectionHolds=holds("selection");
    const adoption=await this.ports.methods.prepareAdoption(current.checkPathId,{id:input.id,scope,
      expectedSelectionId:input.expectedSelectionId,expectedControlRevision:input.expectedControlRevision,
      selection:{id:input.selectionId,representations:current.progress.request.combination!.subjects,
        judgmentIds:current.progress.assessments.at(-1)!.judgmentIds,holds:selectionHolds},retainedSelectionId:null,
      prepared:current.prepared,inputId:input.inputId,activityId:input.need.stage.pathId,stageRequestId:input.need.stage.id,
      stageKind:input.need.stage.stageKind,capabilities:input.need.stage.capabilities,dependencies:input.need.stage.dependencies,
      inputHolds:holds("input"),releaseHolds:input.releaseHolds,
      materialAdmissions:accesses.map(({access,instanceId},i)=>({source:access,hold:selectionHolds[i]!,grant:{id:`${input.inputId}:grant:${i}`,
        instanceId,recipient,range:access.range,revision:0,allowed:true,basis:scope.authorityBasis}}))});
    signal.throwIfAborted();
    return {...adoption,parts:[...current.conditions,{owner:"context_selection",kind:"scope",proposal:scope},...adoption.parts,
      ...await this.ports.consumers.prepareClosure(current.id,adoption.id,signal)]};
  }

  private async path(basis:OriginalInputRepresentationReceptionBasis,id:string):Promise<ActivityPathState> {
    const path=await this.ports.activities.command({kind:"read_path",pathId:id}) as ActivityPathState|null;
    if(!path||path.intent.runId!==basis.scope.runId||path.intent.owner!==basis.scope.owner||path.intent.permissionBasis!==basis.scope.authorityBasis)
      throw new TypeError("representation_reception_path_binding_changed");
    return path;
  }
  private condition(path:ActivityPathState):SharedAcceptancePart {
    return {owner:"activity",kind:"path_condition",proposal:{pathId:path.intent.id,
      expected:{controlRevision:path.controlRevision,progressRevision:path.progressRevision,cancelled:path.cancelled},requireSettled:false}};
  }
}

function ordered(basis:OriginalInputRepresentationReceptionBasis):OriginalInputRepresentationMember[] {
  return [...basis.members].sort((a,b)=>a.pathId<b.pathId?-1:a.pathId>b.pathId?1:0);
}
