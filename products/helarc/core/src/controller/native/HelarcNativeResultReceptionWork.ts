import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import type {ContextSelectionProposal} from "@agent-anything/context/selection";
import {ActivityPurposeRegistry,activityFactSourceId,type ActivityPurposeContract,type ActivityPurposeHandler,
  type ActivityHandoffPort,type ActivityPathIntent,type ActivityPathState,type ActivityStageState,type ActivityAttempt,type ActivityRawResult,
  type ActivityReconsiderationHandler,type ActivityReconsiderationSnapshot,type ActivitySchedulingAcceptance,type ActivityHandoffItem,
  type ActivityInputNeed,type SharedAcceptancePart} from "@agent-anything/agent-runtime/activity";
import {confirmNativeInputPreparation,readContextInputReceptionOutcome,nativeInputReady,nativeInputSupplyReturnPart,
  type ContextInputReceptionBinding,type ContextInputReceptionOutcome,type InputSupplyBinding,type InputSupplyReception,
  type NativeInputNeedDeclaration} from "@agent-anything/agent-runtime/context-representation";
import {prepareHelarcNativeResultReception,type HelarcNativeResultReceptionInput,type HelarcNativeResultReceptionPorts} from "./HelarcNativeResultReception.js";
import {helarcNativeInputAcceptance} from "./HelarcNativeInputAcceptance.js";
import {helarcNativeInputRequirements} from "./HelarcNativeInputRequirements.js";
import {helarcNativeMeasurementBudget,helarcNativeStageMeasurement} from "./HelarcNativeInputMeasurement.js";
import type {HelarcNativeInputDemandPlan} from "./HelarcNativeInputDemandWork.js";
import type {HelarcNativeTaskResultSources} from "./HelarcNativeTaskResultDelivery.js";

export const HELARC_NATIVE_RESULT_RECEPTION_PURPOSE:ActivityPurposeContract={
  ref:{id:"helarc.native-result-reception",revision:"1"},inputOwner:"context-representation",executionOwner:"helarc-native-input",
  interpretationOwner:"context-representation",acceptanceOwner:"context-representation",recoveryOwner:"context-representation",
  stageKinds:["receive"],capabilities:["material-read"],continuationKinds:[],
};
export const HELARC_NATIVE_MEASURED_RESULT_RECEPTION_PURPOSE:ActivityPurposeContract={...HELARC_NATIVE_RESULT_RECEPTION_PURPOSE,
  ref:{...HELARC_NATIVE_RESULT_RECEPTION_PURPOSE.ref,revision:"2"},capabilities:["material-read","model-measurement"]};
export interface HelarcNativeResultReceptionPlan {
  readonly revision:"1";
  readonly binding:ContextInputReceptionBinding;
  readonly input:Omit<HelarcNativeResultReceptionInput,"input">&{readonly input:HelarcNativeTaskResultSources};
  readonly inputNeed:NativeInputNeedDeclaration;
  readonly inputSupply:InputSupplyBinding;
}
type Reception=Awaited<ReturnType<typeof prepareHelarcNativeResultReception>>;
type Ports=HelarcNativeResultReceptionPorts&{readonly activities:ActivityHandoffPort;readonly authorize:ActivityPurposeHandler["authorize"];readonly now:()=>string};

/** Local result-body reception; the shared policy still decides investment and adoption. */
export class HelarcNativeResultReceptionWork implements ActivityPurposeHandler,ActivityReconsiderationHandler {
  readonly purpose;
  readonly measuredPurpose;
  constructor(private readonly ports:Ports,registry:ActivityPurposeRegistry<ActivityPurposeHandler>){
    this.purpose=registry.register(HELARC_NATIVE_RESULT_RECEPTION_PURPOSE,this);
    this.measuredPurpose=registry.register(HELARC_NATIVE_MEASURED_RESULT_RECEPTION_PURPOSE,this);
  }
  ownsPurpose(value:string){return value===this.purpose.digest||value===this.measuredPurpose.digest;}
  prepareSubmission(intent:Omit<ActivityPathIntent,"owner"|"purpose">,plan:HelarcNativeResultReceptionPlan):readonly SharedAcceptancePart[]{
    const purpose=plan.input.measurement?this.measuredPurpose:this.purpose;
    const path={...helarcNativeMeasurementBudget(intent,plan.input.measurement),owner:purpose.contract.acceptanceOwner,purpose};this.validate(path,plan);
    return [{owner:"activity",kind:"path_opening",proposal:path},{owner:"activity",kind:"stage_submission",proposal:{
      id:`${path.id}:stage:1`,pathId:path.id,stageKind:"receive",input:{plan,inputReception:plan.binding,inputSupplyReception:this.responsibility(plan)},
      capabilities:purpose.contract.capabilities,dependencies:[]}},
      {owner:"activity",kind:"reconsideration_subscription",proposal:{id:`${path.id}:reception`,runId:path.runId,owner:path.owner,
        binding:{kind:"activity_path",id:path.id},sources:[activityFactSourceId("control",path.id),activityFactSourceId("progress",path.id)]}}];
  }
  async authorize(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal,action:Parameters<ActivityPurposeHandler["authorize"]>[3]){
    this.plan(path,stage);return this.ports.authorize(path,stage,signal,action);
  }
  async execute(path:ActivityPathState,stage:ActivityStageState,attempt:ActivityAttempt,signal:AbortSignal):Promise<ActivityRawResult>{
    signal.throwIfAborted();const started=performance.now(),plan=this.plan(path,stage);
    await this.originalDemand(plan);
    const member=plan.binding.members[0]!,producer=await this.ports.activities.command({kind:"read_path",pathId:member.pathId}) as ActivityPathState|null;
    const result=await this.ports.methods.result(member.pathId);
    if(!producer||producer.cancelled||producer.intent.runId!==path.intent.runId||producer.intent.permissionBasis!==path.intent.permissionBasis||
      producer.intent.scheduledWorkId!==member.workId||result.kind!=="ready"||digest(result.progress.request)!==member.requestDigest)
      throw new TypeError("native_result_reception_producer_changed");
    const value=await prepareHelarcNativeResultReception(plan.input,helarcNativeStageMeasurement(this.ports,path,stage),signal);
    return {id:`${attempt.id}:raw`,attemptId:attempt.id,completeness:"complete",outcome:"returned",value,
      usage:{localMs:performance.now()-started,..."readBytes" in value?{readBytes:value.readBytes}:{},
        ..."measurementUsage" in value?value.measurementUsage:{}},recordedAt:this.ports.now()};
  }
  async reconcile(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal):Promise<ActivityRawResult>{
    if(!path.cancelled)return this.execute(path,stage,stage.attempt!,signal);
    const plan=this.plan(path,stage);
    if(plan.input.measurement){
      if(!this.ports.measurement)throw new TypeError("native_result_measurement_unavailable");
      await this.ports.measurement.interrupt(plan.input.inputId,signal);
    }
    return {id:`${stage.attempt!.id}:raw`,attemptId:stage.attempt!.id,completeness:"complete",outcome:"returned",
      value:{kind:"native_result_reception_cancelled"},usage:null,recordedAt:this.ports.now()};
  }
  async interpret(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal){
    signal.throwIfAborted();const plan=this.plan(path,stage),value=this.value(stage,plan);
    const outcome:ContextInputReceptionOutcome={kind:"context_input_reception_outcome",revision:"1",bindingDigest:digest(plan.binding),
      result:value.kind==="ready"?{kind:"checked",input:value.readiness}:{kind:"gap",gap:{reason:value.reason,demandId:plan.inputNeed.needId,
        targetRevision:plan.binding.scope.target,information:[],capacity:value.capacity?[value.capacity]:[],
        untested:!value.capacity,responsibility:"request_owner"}}};
    return {progress:{inputReception:plan.binding,contextInputNeed:plan.inputNeed,inputReceptionOutcome:outcome,
      ...value.kind==="ready"?{nativeInputPreparation:value.preparation}:{}},next:[],
      participants:value.kind==="ready"?[{owner:"representation",kind:"judge",proposal:value.judgment}] satisfies SharedAcceptancePart[]:[]};
  }
  async settle(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal){
    signal.throwIfAborted();this.plan(path,stage);
    return {disposition:{kind:"native_result_reception_cancelled",stageId:stage.request.id,resultId:stage.result!.id,selectionAccepted:false,sourceCustody:"retained"}};
  }
  async readPlan(pathId:string){
    const path=await this.ports.activities.command({kind:"read_path",pathId}) as ActivityPathState|null;
    return path?this.plan(path,await this.stage(pathId)):null;
  }
  async result(pathId:string){
    const snapshot=await this.ports.activities.command({kind:"read_snapshot",pathId,requestIds:[`${pathId}:stage:1`],inputNeedIds:[]}) as import("@agent-anything/agent-runtime/activity").ActivitySnapshot;
    const path=snapshot.path,stage=snapshot.stages[0];
    if(!path||!stage)throw new TypeError("native_result_reception_path_missing");
    const plan=this.plan(path,stage);
    if(stage.status!=="accepted")return {kind:path.cancelled?"cancelled" as const:"pending" as const,path,plan};
    const value=this.value(stage,plan),outcome=readContextInputReceptionOutcome(plan.binding,path,stage);
    if(value.kind==="ready")confirmNativeInputPreparation({value:value.preparation,origin:{pathId,stageId:stage.request.id,
      rawResultId:stage.result!.id,receiptId:stage.receipt!.id}},stage);
    if(path.cancelled)return {kind:"cancelled" as const,path,plan,outcome};
    return value.kind==="ready"?{kind:"checked" as const,path,plan,outcome,value}:{kind:"gap" as const,path,plan,outcome,value};
  }
  async prepareAdoption(pathId:string,input:{readonly id:string;readonly need:ActivityInputNeed;
    readonly expectedSelectionId:string|null;readonly expectedControlRevision:number},signal:AbortSignal){
    signal.throwIfAborted();const r=await this.result(pathId);
    if(r.kind!=="checked"||!input.need.origin||input.need.id!==r.plan.inputNeed.needId||input.need.supplier!==r.plan.binding.scope.owner||
      input.need.origin.requestId!==r.plan.inputSupply.source.stageId)throw new TypeError("native_result_reception_adoption_unconfirmed");
    await this.originalDemand(r.plan);
    const {value,plan,path}=r,scope=plan.binding.scope;
    const proposed=value.proposal.parts.find(p=>p.owner==="context_selection"&&p.kind==="selection_input")!.proposal as ContextSelectionProposal;
    const materialAdmissions=value.proposal.parts.filter(p=>p.owner==="material_custody"&&p.kind==="admit_access").map(p=>p.proposal) as
      NonNullable<Parameters<typeof helarcNativeInputAcceptance>[0]["materialAdmissions"]>;
    const accepted=helarcNativeInputAcceptance({...input,scope,retainedSelectionId:null,selection:proposed.selection,native:value.selected,judgment:value.judgment,
      inputId:proposed.input.id,activityId:proposed.input.activityId,stageRequestId:null,nativeConsumer:proposed.input.nativeConsumer,
      inputHolds:proposed.input.holds,materialAdmissions,releaseHolds:[]});
    const returned={needId:input.need.id,origin:input.need.origin,inputId:proposed.input.id,inputDigest:digest(value.selected),readyStageId:input.need.stage.id};
    return {...accepted,parts:[this.condition(path),{owner:"context_selection",kind:"scope",proposal:scope},...accepted.parts,
      nativeInputSupplyReturnPart(returned),{owner:"activity",kind:"stage_submission",proposal:{...input.need.stage,input:nativeInputReady(returned)}}]};
  }
  async prepareClosure(pathId:string,basis:string,signal:AbortSignal):Promise<readonly SharedAcceptancePart[]>{
    signal.throwIfAborted();if(!basis)throw new TypeError("native_result_reception_closure_basis_missing");
    const path=await this.path(pathId);this.plan(path,await this.stage(pathId));
    return [this.condition(path),...path.cancelled?[]:[{owner:"activity",kind:"path_cancellation",proposal:{kind:"cancel",pathId,expectedControlRevision:path.controlRevision}}]];
  }
  async prepare(snapshot:ActivityReconsiderationSnapshot,signal:AbortSignal){
    signal.throwIfAborted();const subscription=snapshot.state.subscription;
    if(subscription.binding?.kind!=="activity_path")throw new TypeError("native_result_reception_subscription_invalid");
    const path=await this.path(subscription.binding.id),plan=this.plan(path,await this.stage(path.intent.id));
    if(subscription.id!==`${path.intent.id}:reception`||subscription.owner!==path.intent.owner||subscription.runId!==path.intent.runId)
      throw new TypeError("native_result_reception_subscription_changed");
    const participants:SharedAcceptancePart[]=[this.condition(path)];let pending=false;
    if(path.cancelled){
      const work=await this.ports.activities.command({kind:"read_schedule",workId:plan.binding.workId}) as ActivitySchedulingAcceptance|null;
      if(!work||work.intent.runId!==path.intent.runId||work.intent.owner!==path.intent.owner||digest(work.intent.allowedPathIds)!==digest([path.intent.id]))
        throw new TypeError("native_result_reception_schedule_changed");
      pending=(await this.ports.activities.command({kind:"pending",runId:path.intent.runId,pathId:path.intent.id,after:0,limit:1}) as readonly ActivityHandoffItem[]).length>0;
      if(!work.pathsSealed)participants.push({owner:"activity",kind:"scheduling_path_seal",proposal:{kind:"seal_scheduled_paths",workId:work.intent.workId,
        expectedRevision:work.revision,basis:`${path.intent.id}:closing`}});
      if(!pending&&!work.closed)participants.push({...this.condition(path),proposal:{...(this.condition(path).proposal as object),requireSettled:true}},
        {owner:"activity",kind:"scheduling_closure",proposal:{kind:"close_scheduled_work",workId:work.intent.workId,
          expectedRevision:work.revision+(work.pathsSealed?0:1),basis:`${path.intent.id}:closed`,requireSettled:true}});
    }
    return {decision:{owner:path.intent.owner,kind:path.cancelled&&!pending?"native_result_reception_closed":"native_result_reception_observed",
      id:path.intent.id,revision:String(path.controlRevision)},participants,close:path.cancelled&&!pending,
      observeSources:[activityFactSourceId("control",path.intent.id),activityFactSourceId("progress",path.intent.id)]};
  }
  private async originalDemand(plan:HelarcNativeResultReceptionPlan){
    const source=await this.ports.activities.command({kind:"read_stage",requestId:plan.inputSupply.source.stageId}) as ActivityStageState|null;
    const original=(source?.request.input as {plan?:HelarcNativeInputDemandPlan}|undefined)?.plan;
    if(!source||source.status!=="accepted"||!source.receipt||source.request.pathId!==plan.inputSupply.consumerPathId||
      digest(source.request)!==plan.inputSupply.source.requestDigest||!original||digest(original.inputNeed)!==digest(plan.inputNeed)||
      digest(original.prepared)!==digest(plan.input.prepared)||digest(original.activity)!==digest(plan.input.activity)||
      digest(original.resultSources)!==digest(plan.input.input))throw new TypeError("native_result_reception_demand_changed");
  }
  private value(stage:ActivityStageState,plan:HelarcNativeResultReceptionPlan):Reception {
    const v=stage.result?.value as Reception;
    if(stage.result?.outcome!=="returned"||stage.result.completeness!=="complete"||!v||v.kind!=="ready"&&v.kind!=="unavailable")
      throw new TypeError("native_result_reception_result_invalid");
    if(v.kind==="ready"&&(v.preparation.inputId!==plan.input.inputId||digest(v.preparation.scope)!==digest(plan.binding.scope)||
      digest(v.preparation.exactInput)!==digest(v.selected)||v.readiness.judgmentId!==v.judgment.id))throw new TypeError("native_result_reception_result_changed");
    return v;
  }
  private validate(path:ActivityPathIntent,plan:HelarcNativeResultReceptionPlan){
    const b=plan?.binding,i=plan?.input,n=plan?.inputNeed,s=plan?.inputSupply;
    if(plan?.revision!=="1"||!b||!i||!n||!s||path.purpose.digest!==(i.measurement?this.measuredPurpose:this.purpose).digest||path.owner!==b.scope.owner||
      path.runId!==b.scope.runId||path.id!==b.pathId||path.permissionBasis!==b.scope.authorityBasis||path.scheduledWorkId!==b.workId||
      b.members.length!==1||b.members[0]!.pathId!==i.methodPathId||!b.members[0]!.requestDigest||!b.members[0]!.workId||
      b.boundary!==i.prepared.sourceDigest||!i.prepared.workingSources||b.requirementsDigest!==digest(helarcNativeInputRequirements(i.prepared.workingSources.groups))||
      digest(i.scope)!==digest(b.scope)||digest(n.scope)!==digest(b.scope)||s.needId!==n.needId||s.owner!==b.scope.owner||s.runId!==b.scope.runId||
      `${s.configuration.id}:${s.configuration.revision}`!==b.scope.target||i.input.runId!==b.scope.runId||n.consumer.activityId!==i.activity.scope.activityId||
      n.consumer.compositionDigest!==i.activity.composition.digest||digest(n.consumer.protocol)!==digest(i.activity.composition.composition.protocol))
      throw new TypeError("native_result_reception_plan_invalid");
  }
  private responsibility(plan:HelarcNativeResultReceptionPlan):InputSupplyReception {
    const {pathId,workId,scope}=plan.binding;return {kind:"input_supply_reception",revision:"1",inputSupply:plan.inputSupply,scope,pathId,
      firstStageId:`${pathId}:stage:1`,workId,subscriptionId:`${pathId}:reception`,closureKind:"native_result_reception_closed",coveredPathIds:[pathId]};
  }
  private plan(path:ActivityPathState,stage:ActivityStageState){
    const plan=(stage.request.input as {plan:HelarcNativeResultReceptionPlan}).plan;this.validate(path.intent,plan);
    if(digest(stage.request)!==digest(this.prepareSubmission(path.intent,plan)[1]!.proposal))throw new TypeError("native_result_reception_submission_changed");return plan;
  }
  private condition(path:ActivityPathState):SharedAcceptancePart{return {owner:"activity",kind:"path_condition",proposal:{pathId:path.intent.id,
    expected:{controlRevision:path.controlRevision,progressRevision:path.progressRevision,cancelled:path.cancelled},requireSettled:false}};}
  private async path(pathId:string){const p=await this.ports.activities.command({kind:"read_path",pathId}) as ActivityPathState|null;
    if(!p||!this.ownsPurpose(p.intent.purpose.digest))throw new TypeError("native_result_reception_path_missing");return p;}
  private async stage(pathId:string){const s=await this.ports.activities.command({kind:"read_stage",requestId:`${pathId}:stage:1`}) as ActivityStageState|null;
    if(!s)throw new TypeError("native_result_reception_stage_missing");return s;}
}
