import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import type {ActivityHandoffPort,ActivityPathIntent,ActivityPathState,SharedAcceptancePart,ActivitySchedulingIntent,ActivityInputNeed} from "@agent-anything/agent-runtime/activity";
import {activityFactSourceId} from "@agent-anything/agent-runtime/activity";
import {nativeInputReady,nativeInputSupplyReturnPart,type InputSupplyBinding} from "@agent-anything/agent-runtime/context-representation";
import {OPENAI_RESPONSES} from "@agent-anything/model-interaction/protocol";
import {validateHelarcNativeAccountMembers} from "./HelarcNativeAccountCombinations.js";
import {helarcNativeAccountReceptionAcceptance,type HelarcNativeAccountReceptionInput} from "./HelarcNativeAccountReception.js";
import {helarcNativeInputRequirements} from "./HelarcNativeInputRequirements.js";
import type {HelarcNativeAccountReceptionWork,HelarcNativeAccountReceptionPlan} from "./HelarcNativeAccountReceptionWork.js";

export interface HelarcNativeAccountReceptionBasis {
  readonly input:Omit<HelarcNativeAccountReceptionInput,"inputId"|"selectionId"|"judgmentId">;
  readonly inputNeed:HelarcNativeAccountReceptionPlan["inputNeed"];
  readonly inputSupply:InputSupplyBinding;
  readonly checkConditions:HelarcNativeAccountReceptionPlan["checkConditions"];
}

/** Native receiving plans and outcomes. It neither chooses investment nor runs an execution loop. */
export class HelarcNativeAccountReceptionCatalog {
  constructor(private readonly ports:{readonly activities:ActivityHandoffPort;readonly work:HelarcNativeAccountReceptionWork}){}
  id(basis:HelarcNativeAccountReceptionBasis){
    this.validate(basis);
    return `${basis.inputNeed.needId}:account-reception:${digest({...basis,input:this.originalInput(basis)})}`;
  }
  async inspect(basis:HelarcNativeAccountReceptionBasis,signal:AbortSignal){
    signal.throwIfAborted();const id=this.id(basis),plan=await this.ports.work.readPlan(id);
    const observeSources=[activityFactSourceId("progress",id),activityFactSourceId("control",id)];
    if(!plan)return {kind:"not_started" as const,id,observeSources};
    if(digest(plan.inputNeed)!==digest(basis.inputNeed)||digest(plan.inputSupply)!==digest(basis.inputSupply)||
      digest(plan.checkConditions)!==digest(basis.checkConditions)||digest(plan.input)!==digest(this.input(basis,id)))
      throw new TypeError("native_reception_original_basis_changed");
    const path=await this.path(id,basis),result=await this.ports.work.result(id);
    const evidence={id:path.intent.id,owner:path.intent.owner,revision:`${path.progressRevision}:${path.controlRevision}`,kind:"fact" as const};
    const common={id,workId:path.intent.scheduledWorkId!,revision:`${path.progressRevision}:${path.controlRevision}`,observeSources,evidence,plan,path};
    if(result.kind==="pending")return {kind:"waiting" as const,...common};
    if(result.kind==="checked")return {...result,...common};
    return {kind:"unavailable" as const,...common,reason:result.kind==="gap"?result.outcome.result.kind==="gap"?result.outcome.result.gap.reason:"receiver_gap":"receiver_cancelled",
      outcome:result.outcome??null};
  }
  async prepareStart(basis:HelarcNativeAccountReceptionBasis,arrangement:{readonly intent:Omit<ActivityPathIntent,"owner"|"purpose">;
    readonly scheduling:ActivitySchedulingIntent},signal:AbortSignal){
    const state=await this.inspect(basis,signal);
    if(state.kind!=="not_started")return {participants:[] as readonly SharedAcceptancePart[],observeSources:state.observeSources};
    const {intent,scheduling}=arrangement,scope=basis.input.scope;
    if(intent.id!==state.id||intent.runId!==scope.runId||intent.permissionBasis!==scope.authorityBasis||intent.scheduledWorkId!==scheduling.workId||
      scheduling.owner!==scope.owner||scheduling.runId!==scope.runId)throw new TypeError("native_reception_arrangement_changed");
    const members:HelarcNativeAccountReceptionPlan["binding"]["members"][number][]=[],parts:SharedAcceptancePart[]=[];
    for(const member of this.originalInput(basis).members){
      signal.throwIfAborted();const path=await this.path(member.methodPathId,basis);
      if(path.cancelled||!path.intent.scheduledWorkId)throw new TypeError("native_reception_producer_unavailable");
      members.push({pathId:member.methodPathId,workId:path.intent.scheduledWorkId,requestDigest:digest(member.supply.request)});
      parts.push(this.condition(path));
    }
    const check={...intent,id:`${state.id}:combination-check`,resourceScope:`${state.id}:combination-check`};
    const plan:HelarcNativeAccountReceptionPlan={revision:"1",input:this.input(basis,state.id),inputNeed:basis.inputNeed,inputSupply:basis.inputSupply,
      check,checkConditions:basis.checkConditions,binding:{revision:"1",pathId:state.id,workId:scheduling.workId,scope,
        boundary:basis.input.prepared.sourceDigest,requirementsDigest:digest(helarcNativeInputRequirements(basis.input.prepared.workingSources!.groups)),members}};
    parts.push({owner:"activity",kind:"scheduling_acceptance",proposal:{kind:"schedule_work",intent:{...scheduling,allowedPathIds:[intent.id,check.id]},expectedRevision:0}},
      ...this.ports.work.prepareSubmission(intent,plan));
    return {participants:parts,observeSources:state.observeSources};
  }
  async prepareAdoption(basis:HelarcNativeAccountReceptionBasis,input:{readonly id:string;readonly need:ActivityInputNeed;
    readonly expectedSelectionId:string|null;readonly expectedControlRevision:number},signal:AbortSignal){
    const current=await this.inspect(basis,signal),scope=basis.input.scope;
    if(current.kind!=="checked"||input.need.id!==basis.inputNeed.needId||!input.need.origin||input.need.supplier!==scope.owner)
      throw new TypeError("native_reception_adoption_unconfirmed");
    const accepted=helarcNativeAccountReceptionAcceptance({...input,reception:current.reception,judgment:current.judgment,activityId:basis.inputNeed.consumer.activityId});
    const returned={needId:input.need.id,origin:input.need.origin,inputId:current.reception.preparation.inputId,
      inputDigest:digest(current.reception.selected),readyStageId:input.need.stage.id};
    return {...accepted,parts:[this.condition(current.path),{owner:"context_selection",kind:"scope",proposal:scope},...accepted.parts,
      nativeInputSupplyReturnPart(returned),{owner:"activity",kind:"stage_submission",proposal:{...input.need.stage,input:nativeInputReady(returned)}}]};
  }
  private input(basis:HelarcNativeAccountReceptionBasis,id:string):HelarcNativeAccountReceptionInput {
    return {...this.originalInput(basis),inputId:`${id}:input`,selectionId:`${id}:selection`,judgmentId:`${id}:combination-check:job:initial:judgment`};
  }
  private originalInput(basis:HelarcNativeAccountReceptionBasis){
    return {...basis.input,members:basis.input.members.map(m=>({methodPathId:m.methodPathId,candidateId:m.candidateId,
      supply:{scope:m.supply.scope,request:m.supply.request}})).sort((a,b)=>a.methodPathId.localeCompare(b.methodPathId))};
  }
  private validate(basis:HelarcNativeAccountReceptionBasis){
    const {input:i,inputNeed:n,inputSupply:b}=basis,scope=i.scope;
    if(digest(n.scope)!==digest(scope)||b.needId!==n.needId||b.runId!==scope.runId||b.owner!==scope.owner||
      `${b.configuration.id}:${b.configuration.revision}`!==scope.target||n.consumer.activityId!==i.activity.scope.activityId||
      n.consumer.compositionDigest!==i.activity.composition.digest||digest(n.consumer.protocol)!==digest(i.activity.composition.composition.protocol))
      throw new TypeError("native_reception_basis_invalid");
    const body=JSON.parse(i.prepared.wire.body),all=(body.input??body.messages) as Record<string,unknown>[];
    const prefix=i.activity.composition.composition.protocol.id!==OPENAI_RESPONSES.id&&all[0]?.role==="system"?1:0;
    validateHelarcNativeAccountMembers({runId:scope.runId,items:all.slice(prefix),sources:i.prepared.workingSources!},i.members);
  }
  private async path(pathId:string,basis:HelarcNativeAccountReceptionBasis){
    const path=await this.ports.activities.command({kind:"read_path",pathId}) as ActivityPathState|null,scope=basis.input.scope;
    if(!path||path.intent.owner!==scope.owner||path.intent.runId!==scope.runId||path.intent.permissionBasis!==scope.authorityBasis)
      throw new TypeError("native_reception_path_binding_changed");return path;
  }
  private condition(path:ActivityPathState):SharedAcceptancePart {
    return {owner:"activity",kind:"path_condition",proposal:{pathId:path.intent.id,
      expected:{controlRevision:path.controlRevision,progressRevision:path.progressRevision,cancelled:path.cancelled},requireSettled:false}};
  }
}
