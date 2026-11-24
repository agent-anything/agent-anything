import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import type {MaterialAccessAdmission} from "@agent-anything/context/custody";
import type {RepresentationJudgment} from "@agent-anything/context/representation";
import {ActivityPurposeRegistry,activityFactSourceId,type ActivityPurposeContract,type ActivityPurposeHandler,
  type ActivityPathIntent,type ActivityPathState,type ActivityStageState,type ActivityAttempt,type ActivityRawResult,
  type ActivityHandoffPort,type ActivityReconsiderationHandler,type ActivityReconsiderationSnapshot,
  type SharedAcceptancePart,type ActivityStageRequest,type ActivitySchedulingAcceptance,type ActivityHandoffItem} from "@agent-anything/agent-runtime/activity";
import {confirmNativeInputPreparation,readContextInputReceptionOutcome,type ContextInputReceptionBinding,
  type ContextInputReceptionOutcome,type NativeInputNeedDeclaration,type NativeInputPreparationEvidence,
  type RepresentationMethodWork,type RepresentationMethodRequest,type InputSupplyBinding,type InputSupplyReception} from "@agent-anything/agent-runtime/context-representation";
import {prepareHelarcNativeAccountReception,helarcNativeAccountReceptionAcceptance,
  type HelarcNativeAccountReceptionInput,type HelarcNativeAccountReception} from "./HelarcNativeAccountReception.js";
import type {HelarcNativeResultReceptionPorts} from "./HelarcNativeResultReception.js";
import {helarcNativeInputRequirements} from "./HelarcNativeInputRequirements.js";
import {helarcNativeMeasurementBudget,helarcNativeStageMeasurement} from "./HelarcNativeInputMeasurement.js";

export const HELARC_NATIVE_ACCOUNT_RECEPTION_PURPOSE:ActivityPurposeContract={
  ref:{id:"helarc.native-account-reception",revision:"1"},inputOwner:"context-representation",executionOwner:"helarc-native-input",
  interpretationOwner:"context-representation",acceptanceOwner:"context-representation",recoveryOwner:"context-representation",
  stageKinds:["realize","assess","ready","unavailable"],capabilities:["material-read"],continuationKinds:["stage_request"],
};
export const HELARC_NATIVE_MEASURED_ACCOUNT_RECEPTION_PURPOSE:ActivityPurposeContract={...HELARC_NATIVE_ACCOUNT_RECEPTION_PURPOSE,
  ref:{...HELARC_NATIVE_ACCOUNT_RECEPTION_PURPOSE.ref,revision:"2"},capabilities:["material-read","model-measurement"]};
export interface HelarcNativeAccountReceptionPlan {
  readonly revision:"1";
  readonly binding:ContextInputReceptionBinding;
  readonly input:HelarcNativeAccountReceptionInput;
  readonly inputNeed:NativeInputNeedDeclaration;
  readonly check:Omit<ActivityPathIntent,"owner"|"purpose">;
  readonly checkConditions:Pick<RepresentationMethodRequest,"capacity"|"bounds">;
  readonly inputSupply?:InputSupplyBinding;
}
type Reception=Awaited<ReturnType<typeof prepareHelarcNativeAccountReception>>;
type Ports=HelarcNativeResultReceptionPorts&{
  readonly activities:ActivityHandoffPort;
  readonly methods:Pick<RepresentationMethodWork,"result"|"prepareSubmission"|"prepareInputRelease">;
  readonly authorize:ActivityPurposeHandler["authorize"];
  readonly now:()=>string;
};
interface Assessment {readonly outcome:ContextInputReceptionOutcome;readonly judgmentId:string|null;}

/** Recipient work only. Shared execution schedules it; CRM separately accepts selection. */
export class HelarcNativeAccountReceptionWork implements ActivityPurposeHandler,ActivityReconsiderationHandler {
  readonly purpose;
  readonly measuredPurpose;
  constructor(private readonly ports:Ports,registry:ActivityPurposeRegistry<ActivityPurposeHandler>){
    this.purpose=registry.register(HELARC_NATIVE_ACCOUNT_RECEPTION_PURPOSE,this);
    this.measuredPurpose=registry.register(HELARC_NATIVE_MEASURED_ACCOUNT_RECEPTION_PURPOSE,this);
  }
  ownsPurpose(value:string){return value===this.purpose.digest||value===this.measuredPurpose.digest;}
  prepareSubmission(intent:Omit<ActivityPathIntent,"owner"|"purpose">,plan:HelarcNativeAccountReceptionPlan):readonly SharedAcceptancePart[]{
    const purpose=plan.input.measurement?this.measuredPurpose:this.purpose;
    const path={...helarcNativeMeasurementBudget(intent,plan.input.measurement),owner:purpose.contract.acceptanceOwner,purpose};
    this.validatePlan(path,plan);
    return [{owner:"activity",kind:"path_opening",proposal:path},
      {owner:"activity",kind:"stage_submission",proposal:{id:`${path.id}:stage:1`,pathId:path.id,stageKind:"realize",input:{plan,inputReception:plan.binding,
        ...(plan.inputSupply?{inputSupplyReception:this.responsibility(plan)}:{})},capabilities:purpose.contract.capabilities,dependencies:[]} satisfies ActivityStageRequest},
      {owner:"activity",kind:"reconsideration_subscription",proposal:{id:`${path.id}:reception`,runId:path.runId,owner:path.owner,
        binding:{kind:"activity_path",id:path.id},sources:[path.id,...plan.binding.members.map(m=>m.pathId)]
          .flatMap(id=>[activityFactSourceId("control",id),activityFactSourceId("progress",id)])}}];
  }
  async authorize(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal,action:Parameters<ActivityPurposeHandler["authorize"]>[3]){
    await this.original(path,stage);return this.ports.authorize(path,stage,signal,action);
  }
  async execute(path:ActivityPathState,stage:ActivityStageState,attempt:ActivityAttempt,signal:AbortSignal):Promise<ActivityRawResult>{
    const started=performance.now(),{plan,first}=await this.original(path,stage);signal.throwIfAborted();
    let value:unknown;
    if(stage.request.stageKind==="realize"){
      for(const member of plan.binding.members){
        const producer=await this.ports.activities.command({kind:"read_path",pathId:member.pathId}) as ActivityPathState|null;
        if(!producer||producer.intent.runId!==plan.binding.scope.runId||producer.intent.scheduledWorkId!==member.workId||
          producer.intent.permissionBasis!==plan.binding.scope.authorityBasis||producer.cancelled)throw new TypeError("native_account_reception_original_producer_invalid");
      }
      value=await prepareHelarcNativeAccountReception(plan.input,helarcNativeStageMeasurement(this.ports,path,stage),signal);
    }
    else if(stage.request.stageKind==="assess")value=await this.assess(plan,first,signal);
    else value=stage.request.input;
    return {id:`${attempt.id}:raw`,attemptId:attempt.id,completeness:"complete",outcome:"returned",value,
      usage:{localMs:performance.now()-started,...stage.request.stageKind==="realize"&&((value as Reception).kind==="proposed")?
        {readBytes:(value as HelarcNativeAccountReception).readBytes,...(value as HelarcNativeAccountReception).measurementUsage}:{}},recordedAt:this.ports.now()};
  }
  async reconcile(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal):Promise<ActivityRawResult>{
    if(!path.cancelled)return this.execute(path,stage,stage.attempt!,signal);
    const {plan}=await this.original(path,stage);
    if(plan.input.measurement){
      if(!this.ports.measurement)throw new TypeError("native_account_measurement_unavailable");
      await this.ports.measurement.interrupt(plan.input.inputId,signal);
    }
    return {id:`${stage.attempt!.id}:raw`,attemptId:stage.attempt!.id,completeness:"complete",outcome:"returned",
      value:{kind:"reception_cancelled"},usage:null,recordedAt:this.ports.now()};
  }
  async interpret(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal){
    const {plan}=await this.original(path,stage);signal.throwIfAborted();
    if(stage.result?.outcome!=="returned"||stage.result.completeness!=="complete")throw new TypeError("native_account_reception_raw_unavailable");
    if(stage.request.stageKind==="realize"){
      const reception=stage.result.value as Reception;
      if(reception.kind!=="proposed"&&reception.kind!=="unavailable")throw new TypeError("native_account_reception_raw_invalid");
      return {progress:{inputReception:plan.binding,contextInputNeed:plan.inputNeed,
        ...(reception.kind==="proposed"?{nativeInputPreparation:reception.preparation}:{})},next:[]};
    }
    if(stage.request.stageKind==="assess")return {progress:{inputReception:plan.binding,
      inputReceptionOutcome:(stage.result.value as Assessment).outcome,assessment:stage.result.value},next:[]};
    return {progress:{...path.progress as object,readiness:stage.result.value},next:[]};
  }
  async settle(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal){
    await this.original(path,stage);signal.throwIfAborted();
    return {disposition:{kind:"native_account_reception_cancelled",stageId:stage.request.id,resultId:stage.result!.id,
      selectionAccepted:false,sourceCustody:"retained"}};
  }
  async prepare(snapshot:ActivityReconsiderationSnapshot,signal:AbortSignal){
    signal.throwIfAborted();const subscription=snapshot.state.subscription;
    if(subscription.binding?.kind!=="activity_path")throw new TypeError("native_account_reception_subscription_invalid");
    const path=await this.path(subscription.binding.id),first=await this.stage(`${path.intent.id}:stage:1`);
    const {plan}=await this.original(path,first);
    if(subscription.id!==`${path.intent.id}:reception`||subscription.owner!==path.intent.owner||subscription.runId!==path.intent.runId)
      throw new TypeError("native_account_reception_subscription_changed");
    const participants:SharedAcceptancePart[]=[this.condition(path)];
    let observeSources=[...snapshot.state.observedSources];
    const finish=(close=false)=>({decision:{owner:path.intent.owner,kind:"native_account_reception",id:path.intent.id,revision:String(path.progressRevision)},participants,close,observeSources});
    if(snapshot.state.closed)return finish(true);
    if(path.cancelled)return this.close(path,plan,signal);
    if(this.hasOutcome(path)){observeSources=[activityFactSourceId("control",path.intent.id)];return finish();}
    if(first.status!=="accepted")return finish();
    const reception=first.result!.value as Reception;
    if(reception.kind==="proposed"&&reception.preparation.capacity.assessment.allowed){
      const check=await this.check(plan,first,reception,signal);
      observeSources=[...new Set([...observeSources,activityFactSourceId("control",plan.check.id),activityFactSourceId("progress",plan.check.id)])];
      const existing=await this.ports.activities.command({kind:"read_path",pathId:plan.check.id}) as ActivityPathState|null;
      if(!existing){participants.push(...check.parts);return finish();}
      const original=await this.stage(`${plan.check.id}:stage:1`);
      if(digest(existing.intent)!==digest(check.parts.find(p=>p.kind==="path_opening")!.proposal)||
        digest(original.request)!==digest(check.parts.find(p=>p.kind==="stage_submission")!.proposal))throw new TypeError("native_account_reception_check_changed");
      const result=await this.ports.methods.result(plan.check.id);
      if(result.kind==="pending")return finish();
      participants.push(this.condition(existing));
    }
    const id=`${path.intent.id}:assess`;
    if(!await this.ports.activities.command({kind:"read_stage",requestId:id}))participants.push({owner:"activity",kind:"stage_submission",
      proposal:{id,pathId:path.intent.id,stageKind:"assess",input:{planDigest:digest(plan)},capabilities:[],dependencies:[{requestId:first.request.id,condition:"accepted"}]} satisfies ActivityStageRequest});
    return finish();
  }
  async result(pathId:string){
    const snapshot=await this.ports.activities.command({kind:"read_snapshot",pathId,requestIds:[`${pathId}:assess`,`${pathId}:stage:1`,`${pathId}:ready`],inputNeedIds:[]}) as import("@agent-anything/agent-runtime/activity").ActivitySnapshot;
    const path=snapshot.path;
    if(!path||!this.ownsPurpose(path.intent.purpose.digest))throw new TypeError("native_account_reception_path_missing");
    if(path.cancelled&&!this.hasOutcome(path))return {kind:"cancelled" as const};
    if(!this.hasOutcome(path))return {kind:"pending" as const};
    const [stage,first,ready]=snapshot.stages;
    if(!stage||!first)throw new TypeError("native_account_reception_stage_missing");
    const {plan}=await this.original(path,first);
    const outcome=readContextInputReceptionOutcome(plan.binding,path,ready?.status==="accepted"?ready:stage);
    if(path.cancelled)return {kind:"cancelled" as const,outcome};
    if(outcome.result.kind==="gap")return {kind:"gap" as const,outcome};
    const reception=first.result!.value as HelarcNativeAccountReception;
    const judgment=await this.ports.representations.command({kind:"read_judgment",id:(stage.result!.value as Assessment).judgmentId!}) as RepresentationJudgment;
    return {kind:"checked" as const,reception,judgment,outcome,native:this.evidence(first,reception)};
  }
  async readPlan(pathId:string):Promise<HelarcNativeAccountReceptionPlan|null>{
    const path=await this.ports.activities.command({kind:"read_path",pathId}) as ActivityPathState|null;
    if(!path)return null;
    return (await this.original(path,await this.stage(`${pathId}:stage:1`))).plan;
  }
  async prepareClosure(pathId:string,basis:string,signal:AbortSignal):Promise<readonly SharedAcceptancePart[]>{
    signal.throwIfAborted();if(!basis)throw new TypeError("native_account_reception_closure_basis_missing");
    const path=await this.path(pathId);
    return [this.condition(path),...path.cancelled?[]:[{owner:"activity",kind:"path_cancellation",proposal:{kind:"cancel",pathId,expectedControlRevision:path.controlRevision}}]];
  }
  private async close(path:ActivityPathState,plan:HelarcNativeAccountReceptionPlan,signal:AbortSignal){
    const check=await this.ports.activities.command({kind:"read_path",pathId:plan.check.id}) as ActivityPathState|null;
    if(check&&(check.intent.runId!==path.intent.runId||check.intent.owner!==path.intent.owner||
      Object.entries(plan.check).some(([key,value])=>digest(value)!==digest(check.intent[key as keyof ActivityPathIntent]))))
      throw new TypeError("native_account_reception_check_changed");
    const work=await this.ports.activities.command({kind:"read_schedule",workId:plan.binding.workId}) as ActivitySchedulingAcceptance|null;
    if(!work||work.intent.runId!==path.intent.runId||work.intent.owner!==path.intent.owner||
      digest([...(work.intent.allowedPathIds??[])].sort())!==digest([path.intent.id,plan.check.id].sort()))
      throw new TypeError("native_account_reception_schedule_changed");
    const participants:SharedAcceptancePart[]=[],observeSources:string[]=[];
    let pending=false;
    for(const id of [path.intent.id,plan.check.id]){
      signal.throwIfAborted();const state=id===path.intent.id?path:check;
      participants.push({owner:"activity",kind:"path_condition",proposal:{pathId:id,expected:state?{
        controlRevision:state.controlRevision,progressRevision:state.progressRevision,cancelled:state.cancelled}:null,requireSettled:false}});
      if(!state)continue;
      observeSources.push(activityFactSourceId("control",id),activityFactSourceId("progress",id));
      if(!state.cancelled){pending=true;participants.push({owner:"activity",kind:"path_cancellation",proposal:{kind:"cancel",pathId:id,expectedControlRevision:state.controlRevision}});}
      const outstanding=await this.ports.activities.command({kind:"pending",runId:path.intent.runId,pathId:id,after:0,limit:1}) as readonly ActivityHandoffItem[];
      if(outstanding.length)pending=true;
    }
    if(!work.pathsSealed)participants.push({owner:"activity",kind:"scheduling_path_seal",proposal:{kind:"seal_scheduled_paths",workId:work.intent.workId,expectedRevision:work.revision,basis:`${path.intent.id}:closing`}});
    if(!pending){
      if(check){
        participants.push(...await this.ports.methods.prepareInputRelease(check.intent.id));
        const first=await this.stage(`${check.intent.id}:stage:1`),request=(first.request.input as {method:{request:RepresentationMethodRequest}}).method.request;
        const ids=new Set([`${check.intent.id}:fixed-evidence:hold`,...plan.input.publications.map(p=>`${check.intent.id}:source-evidence:${digest(p.group.id)}:hold`)]);
        const owned=request.sources.filter(s=>ids.has(s.access.holdId)).map(s=>s.access.holdId);
        if(owned.length)participants.push({owner:"material_custody",kind:"holds",proposal:{acquire:[],release:owned,basis:`${path.intent.id}:closed`}});
      }
      participants.push(...[path,check].filter((s):s is ActivityPathState=>s!==null).map(s=>({owner:"activity",kind:"path_condition",proposal:{
        pathId:s.intent.id,expected:{controlRevision:s.controlRevision,progressRevision:s.progressRevision,cancelled:s.cancelled},requireSettled:true}})));
      if(!work.closed)participants.push({owner:"activity",kind:"scheduling_closure",proposal:{kind:"close_scheduled_work",workId:work.intent.workId,
        expectedRevision:work.revision+(work.pathsSealed?0:1),basis:`${path.intent.id}:closed`,requireSettled:true}});
    }
    return {decision:{owner:path.intent.owner,kind:pending?"native_account_reception_closing":"native_account_reception_closed",id:path.intent.id,
      revision:digest({control:path.controlRevision,check:check?{control:check.controlRevision,progress:check.progressRevision}:null,pending})},participants,observeSources,close:!pending};
  }
  private async assess(plan:HelarcNativeAccountReceptionPlan,first:ActivityStageState,signal:AbortSignal):Promise<Assessment>{
    signal.throwIfAborted();const reception=first.result?.value as Reception;
    const gap=(reason:string,untested:boolean):Assessment=>({judgmentId:null,outcome:{kind:"context_input_reception_outcome",revision:"1",bindingDigest:digest(plan.binding),
      result:{kind:"gap",gap:{reason,demandId:plan.inputNeed.needId,targetRevision:plan.binding.scope.target,information:[],
        capacity:reception.kind==="proposed"?[reception.preparation.capacity.assessment]:[],untested,responsibility:"request_owner"}}}});
    if(reception.kind==="unavailable")return gap(reception.reason,true);
    this.evidence(first,reception);
    if(!reception.preparation.capacity.assessment.allowed)return gap("native_input_capacity_gap",false);
    const checked=await this.ports.methods.result(plan.check.id);
    if(checked.kind==="pending")throw new TypeError("native_account_reception_check_unsettled");
    if(checked.kind!=="ready")return gap(checked.kind==="gap"?checked.progress.gap?.code??"combination_gap":"combination_cancelled",true);
    const expected=await this.check(plan,first,reception,signal);
    if(digest(checked.progress.request)!==digest(expected.request))throw new TypeError("native_account_reception_check_changed");
    const assessment=checked.progress.assessments.at(-1);
    if(!assessment?.supported||assessment.scope!=="both")return gap("combination_unsupported",false);
    const judgment=await this.ports.representations.command({kind:"read_judgment",id:assessment.judgmentIds[0]!}) as RepresentationJudgment;
    helarcNativeAccountReceptionAcceptance({id:"evidence-check-only",reception,judgment,expectedSelectionId:null,expectedControlRevision:0,activityId:plan.inputNeed.consumer.activityId});
    const p=reception.preparation;
    return {judgmentId:judgment.id,outcome:{kind:"context_input_reception_outcome",revision:"1",bindingDigest:digest(plan.binding),result:{kind:"checked",
      input:{kind:"recipient_prepared",scope:p.scope,inputId:p.inputId,bodyDigest:p.encoded.bodyDigest,exactInputDigest:digest(p.exactInput),
        judgmentId:judgment.id,allowed:true,risks:p.capacity.assessment.decisions.filter(d=>d.conclusion!=="within").map(d=>`${d.limitId}:${d.reason}`),capacity:p.capacity,
        evidence:{owner:"context-representation",kind:"fact",id:judgment.id,revision:"1"}}}}};
  }
  private async check(plan:HelarcNativeAccountReceptionPlan,first:ActivityStageState,r:HelarcNativeAccountReception,signal:AbortSignal){
    signal.throwIfAborted();const native=this.evidence(first,r);
    const sources:RepresentationMethodRequest["sources"][number][]=[],relationships:RepresentationMethodRequest["relationships"][number][]=[];
    const original=plan.input.members[0]!.supply.request;
    for(const [index,member]of plan.input.members.entries()){
      signal.throwIfAborted();const produced=await this.ports.methods.result(member.methodPathId),request=member.supply.request;
      if(produced.kind!=="ready"||digest(produced.progress.request)!==digest(request)||digest(request.recipient)!==digest(original.recipient)||
        digest(request.nativeComposition)!==digest(original.nativeComposition))throw new TypeError("native_account_reception_producer_changed");
      const candidate=produced.progress.candidates.find(c=>c.id===member.candidateId&&produced.progress.resultIds.includes(c.id));
      if(!candidate)throw new TypeError("native_account_reception_candidate_changed");
      const alias=(id:string)=>`member_${index}_${id}`;
      for(const source of request.sources)sources.push({...source,alias:alias(source.alias),order:sources.length,
        indivisibleGroup:alias(source.indivisibleGroup)});
      sources.push({alias:alias("received_account"),role:"candidate",access:candidate.access,representation:candidate.representation,order:sources.length,
        label:"Proposed historical account",originalRole:"derived_account",indivisibleGroup:alias("received_account")});
      relationships.push(...request.relationships.map(relation=>({...relation,id:alias(relation.id),sources:relation.sources.map(alias)})));
    }
    const admissions:MaterialAccessAdmission[]=[];
    const represented=new Set(sources.map(s=>digest(s.representation)));
    for(const publication of plan.input.publications){
      const published=publication.published;
      if(!published)throw new TypeError("native_account_reception_source_unavailable");
      if(represented.has(digest(published.representation.ref)))continue;
      const id=`${plan.check.id}:source-evidence:${digest(publication.group.id)}`,recipient=original.recipient,access=published.access;
      const hold={id:`${id}:hold`,instanceId:publication.request.intent.instanceId,consumer:recipient,responsibility:"preparation" as const,
        range:access.range,basis:plan.check.id,releaseCondition:"Receiving combination check settled"};
      admissions.push({source:access,hold,grant:{id:`${id}:grant`,instanceId:hold.instanceId,recipient,range:hold.range,revision:0,allowed:true,basis:plan.binding.scope.authorityBasis}});
      sources.push({alias:`unchanged_source_${sources.length}`,role:"background",access:{id,holdId:hold.id,recipient,range:hold.range},
        representation:published.representation.ref,order:sources.length,label:"Unchanged original native source",originalRole:"native_working_source",
        indivisibleGroup:publication.group.exchangeId??publication.group.id});
      represented.add(digest(published.representation.ref));
    }
    if(r.representations.some(ref=>digest(ref)===digest(plan.input.history.record.ref))){
      const retained=plan.input.history.hold,recipient=original.recipient,id=`${plan.check.id}:fixed-evidence`;
      const hold={...retained,id:`${id}:hold`,consumer:recipient,responsibility:"preparation" as const,basis:plan.check.id};
      admissions.push({source:{id,holdId:retained.id,recipient:retained.consumer,range:retained.range},hold,
        grant:{id:`${id}:grant`,instanceId:hold.instanceId,recipient,range:hold.range,revision:0,allowed:true,basis:plan.binding.scope.authorityBasis}});
      sources.push({alias:"original_fixed_context",role:"background",access:{id,holdId:hold.id,recipient,range:plan.input.history.record.body},
        representation:plan.input.history.record.ref,order:sources.length,label:"Original native input including fixed context",originalRole:"original_input",indivisibleGroup:"fixed_context"});
    }
    const request:RepresentationMethodRequest={...original,...plan.checkConditions,method:"check_combination",combine:"keep",sources,relationships,
      requirements:helarcNativeInputRequirements(plan.input.prepared.workingSources!.groups),sourceBoundary:digest(plan.binding.members),
      objective:"Check the exact complete native input against original evidence and declared preservation requirements. Distinguish historical data from current instructions and preserve unchanged content.",
      combinationDigest:digest(native.value.exactInput),combination:{native,scope:plan.binding.scope,subjects:r.representations}};
    return {request,parts:[...admissions.map(proposal=>({owner:"material_custody",kind:"admit_access",proposal})),...this.ports.methods.prepareSubmission(plan.check,request)]};
  }
  private evidence(first:ActivityStageState,reception:HelarcNativeAccountReception):NativeInputPreparationEvidence {
    const evidence={value:reception.preparation,origin:{pathId:first.request.pathId,stageId:first.request.id,rawResultId:first.result!.id,receiptId:first.receipt!.id}};
    confirmNativeInputPreparation(evidence,first);return evidence;
  }
  private async original(path:ActivityPathState,stage:ActivityStageState){
    const first=stage.request.stageKind==="realize"?stage:await this.stage(`${path.intent.id}:stage:1`);
    const plan=(first.request.input as {plan:HelarcNativeAccountReceptionPlan}).plan;
    this.validatePlan(path.intent,plan);
    if(digest((first.request.input as {inputReception:unknown}).inputReception)!==digest(plan.binding)||
      digest((first.request.input as {inputSupplyReception?:InputSupplyReception}).inputSupplyReception??null)!==digest(plan.inputSupply?this.responsibility(plan):null)||
      stage.request.pathId!==path.intent.id||stage.request.stageKind==="realize"&&stage.request.id!==`${path.intent.id}:stage:1`||
      stage.request.stageKind==="assess"&&(stage.request.input as {planDigest:string}).planDigest!==digest(plan))throw new TypeError("native_account_reception_original_changed");
    return {plan,first};
  }
  private validatePlan(path:ActivityPathIntent,plan:HelarcNativeAccountReceptionPlan){
    const b=plan?.binding,i=plan?.input;
    if(plan?.revision!=="1"||!b||!i||digest(path.purpose)!==digest(i.measurement?this.measuredPurpose:this.purpose)||path.owner!==b.scope.owner||path.runId!==b.scope.runId||
      path.id!==b.pathId||path.permissionBasis!==b.scope.authorityBasis||path.scheduledWorkId!==b.workId||digest(i.scope)!==digest(b.scope)||
      !i.members.length||i.members.length>128||new Set(i.members.map(m=>m.methodPathId)).size!==i.members.length||b.members.length!==i.members.length||
      i.members.some((m,index)=>b.members[index]!.pathId!==m.methodPathId||b.members[index]!.requestDigest!==digest(m.supply.request))||
      b.boundary!==i.prepared.sourceDigest||!i.prepared.workingSources||b.requirementsDigest!==digest(helarcNativeInputRequirements(i.prepared.workingSources.groups))||
      plan.check.runId!==path.runId||plan.check.permissionBasis!==path.permissionBasis||plan.check.scheduledWorkId!==b.workId||plan.check.id===path.id||i.members.some(m=>plan.check.id===m.methodPathId)||
      !plan.checkConditions||plan.checkConditions.capacity.policy.purpose!==i.members[0]!.supply.request.recipient.purpose||
      plan.inputNeed.kind!=="native_input_need"||plan.inputNeed.revision!=="1"||digest(plan.inputNeed.scope)!==digest(b.scope)||
      plan.inputNeed.consumer.activityId!==i.activity.scope.activityId||plan.inputNeed.consumer.compositionDigest!==i.activity.composition.digest||
      digest(plan.inputNeed.consumer.protocol)!==digest(i.activity.composition.composition.protocol))throw new TypeError("native_account_reception_plan_invalid");
    if(plan.inputSupply&&(plan.inputSupply.owner!==b.scope.owner||plan.inputSupply.runId!==b.scope.runId||
      `${plan.inputSupply.configuration.id}:${plan.inputSupply.configuration.revision}`!==b.scope.target))throw new TypeError("native_account_reception_supply_changed");
  }
  private responsibility(plan:HelarcNativeAccountReceptionPlan):InputSupplyReception {
    const {pathId,workId,scope}=plan.binding;
    return {kind:"input_supply_reception",revision:"1",inputSupply:plan.inputSupply!,scope,pathId,firstStageId:`${pathId}:stage:1`,workId,
      subscriptionId:`${pathId}:reception`,closureKind:"native_account_reception_closed",coveredPathIds:[pathId,plan.check.id]};
  }
  private condition(path:ActivityPathState):SharedAcceptancePart{return {owner:"activity",kind:"path_condition",proposal:{pathId:path.intent.id,
    expected:{controlRevision:path.controlRevision,progressRevision:path.progressRevision,cancelled:path.cancelled},requireSettled:false}};}
  private hasOutcome(path:ActivityPathState){return !!(path.progress as {inputReceptionOutcome?:unknown}|null)?.inputReceptionOutcome;}
  private async path(pathId:string){const path=await this.ports.activities.command({kind:"read_path",pathId}) as ActivityPathState|null;
    if(!path||!this.ownsPurpose(path.intent.purpose.digest))throw new TypeError("native_account_reception_path_unavailable");return path;}
  private async stage(requestId:string){const stage=await this.ports.activities.command({kind:"read_stage",requestId}) as ActivityStageState|null;
    if(!stage)throw new TypeError("native_account_reception_stage_unavailable");return stage;}
}
