import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {ActivityPurposeRegistry,type ActivityPurposeContract,type ActivityPurposeHandler,type ActivityHandoffPort,type ActivityPathIntent,
  type ActivityPathState,type ActivityStageState,type ActivityAttempt,type ActivityRawResult,type SharedAcceptancePart,type ActivityInputNeed} from "@agent-anything/agent-runtime/activity";
import {confirmNativeInputPreparation,nativeInputReady,nativeInputSupplyReturnPart,type InputSupplyPreparation,type InputSupplyBinding} from "@agent-anything/agent-runtime/context-representation";
import type {ContextSelectionProposal} from "@agent-anything/context/selection";
import {helarcNativeInputAcceptance} from "./HelarcNativeInputAcceptance.js";
import {prepareHelarcNativeOriginalInput} from "./HelarcNativeOriginalInput.js";
import type {HelarcNativeInputDemandPlan} from "./HelarcNativeInputDemandWork.js";
import {helarcNativeMeasurementBudget,helarcNativeStageMeasurement} from "./HelarcNativeInputMeasurement.js";

export const HELARC_NATIVE_ORIGINAL_INPUT_PURPOSE:ActivityPurposeContract={
  ref:{id:"helarc.native-original-input",revision:"1"},inputOwner:"context-representation",executionOwner:"helarc-native-input",
  interpretationOwner:"context-representation",acceptanceOwner:"context-representation",recoveryOwner:"context-representation",
  stageKinds:["prepare"],capabilities:["material-read"],continuationKinds:[],
};
export const HELARC_NATIVE_MEASURED_ORIGINAL_INPUT_PURPOSE:ActivityPurposeContract={...HELARC_NATIVE_ORIGINAL_INPUT_PURPOSE,
  ref:{id:HELARC_NATIVE_ORIGINAL_INPUT_PURPOSE.ref.id,revision:"2"},capabilities:["material-read","model-measurement"]};
type OptionInput=Parameters<typeof prepareHelarcNativeOriginalInput>[0];
export interface HelarcNativeOriginalInputPlan extends Omit<OptionInput,"plan"|"source"> {
  readonly revision:"1";
  readonly inputSupply:InputSupplyBinding;
  readonly scope:HelarcNativeInputDemandPlan["inputNeed"]["scope"];
}
type Option=Awaited<ReturnType<typeof prepareHelarcNativeOriginalInput>>;
type Ports=Parameters<typeof prepareHelarcNativeOriginalInput>[1]&{
  readonly activities:ActivityHandoffPort;
  readonly authorize:ActivityPurposeHandler["authorize"];
  readonly now:()=>string;
};

/** Accepted local evidence is reused by policy; policy callbacks do not read the whole body again. */
export class HelarcNativeOriginalInputWork implements ActivityPurposeHandler {
  readonly purpose;
  readonly measuredPurpose;
  constructor(private readonly ports:Ports,registry:ActivityPurposeRegistry<ActivityPurposeHandler>){
    this.purpose=registry.register(HELARC_NATIVE_ORIGINAL_INPUT_PURPOSE,this);
    this.measuredPurpose=registry.register(HELARC_NATIVE_MEASURED_ORIGINAL_INPUT_PURPOSE,this);
  }
  prepareSubmission(intent:Omit<ActivityPathIntent,"owner"|"purpose">,plan:HelarcNativeOriginalInputPlan):readonly SharedAcceptancePart[]{
    const purpose=plan.measurement?this.measuredPurpose:this.purpose;
    const path={...helarcNativeMeasurementBudget(intent,plan.measurement),owner:purpose.contract.acceptanceOwner,purpose};this.validate(path,plan);
    const declaration:InputSupplyPreparation={kind:"input_supply_preparation",revision:"1",inputSupply:plan.inputSupply,scope:plan.scope,
      pathId:path.id,firstStageId:`${path.id}:stage:1`,workId:path.scheduledWorkId!};
    return [{owner:"activity",kind:"path_opening",proposal:path},{owner:"activity",kind:"stage_submission",
      proposal:{id:declaration.firstStageId,pathId:path.id,stageKind:"prepare",input:{plan,inputSupplyPreparation:declaration},capabilities:purpose.contract.capabilities,dependencies:[]}}];
  }
  async authorize(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal,action:Parameters<ActivityPurposeHandler["authorize"]>[3]){
    this.plan(path,stage);return this.ports.authorize(path,stage,signal,action);
  }
  async execute(path:ActivityPathState,stage:ActivityStageState,attempt:ActivityAttempt,signal:AbortSignal):Promise<ActivityRawResult>{
    signal.throwIfAborted();const started=performance.now(),input=this.plan(path,stage);
    const source=await this.ports.activities.command({kind:"read_stage",requestId:input.inputSupply.source.stageId}) as ActivityStageState|null;
    if(!source||source.request.pathId!==input.inputSupply.consumerPathId||digest(source.request)!==input.inputSupply.source.requestDigest)
      throw new TypeError("native_original_input_origin_changed");
    const plan=(source.request.input as {plan:HelarcNativeInputDemandPlan}).plan;
    if(digest(plan.inputNeed.scope)!==digest(input.scope)||plan.inputNeed.needId!==input.inputSupply.needId)
      throw new TypeError("native_original_input_need_changed");
    const value=await prepareHelarcNativeOriginalInput({...input,plan,source},helarcNativeStageMeasurement(this.ports,path,stage),signal);
    return {id:`${attempt.id}:raw`,attemptId:attempt.id,completeness:"complete",outcome:"returned",value,
      usage:{localMs:performance.now()-started,readBytes:value.readBytes,...value.measurementUsage},recordedAt:this.ports.now()};
  }
  async reconcile(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal):Promise<ActivityRawResult>{
    if(!path.cancelled)return this.execute(path,stage,stage.attempt!,signal);
    const plan=this.plan(path,stage);
    if(plan.measurement){
      if(!this.ports.measurement)throw new TypeError("native_original_measurement_unavailable");
      await this.ports.measurement.interrupt(plan.inputId,signal);
    }
    return {id:`${stage.attempt!.id}:raw`,attemptId:stage.attempt!.id,completeness:"complete",outcome:"returned",
      value:{kind:"native_original_input_cancelled"},usage:null,recordedAt:this.ports.now()};
  }
  async interpret(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal){
    signal.throwIfAborted();const plan=this.plan(path,stage),value=stage.result?.value as Option;
    if(stage.result?.outcome!=="returned"||stage.result.completeness!=="complete"||value.preparation.inputId!==plan.inputId||
      digest(value.preparation.scope)!==digest(plan.scope)||digest(value.preparation.exactInput)!==digest(value.selected))
      throw new TypeError("native_original_input_result_changed");
    return {progress:{nativeInputPreparation:value.preparation,readiness:value.readiness},next:[],
      participants:[{owner:"representation",kind:"judge",proposal:value.judgment}] satisfies SharedAcceptancePart[]};
  }
  async settle(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal){
    signal.throwIfAborted();this.plan(path,stage);
    return {disposition:{kind:"native_original_input_cancelled",stageId:stage.request.id,resultId:stage.result!.id,selectionAccepted:false}};
  }
  async result(pathId:string){
    const snapshot=await this.ports.activities.command({kind:"read_snapshot",pathId,requestIds:[`${pathId}:stage:1`],inputNeedIds:[]}) as import("@agent-anything/agent-runtime/activity").ActivitySnapshot;
    const path=snapshot.path,stage=snapshot.stages[0];
    if(!path||!stage)throw new TypeError("native_original_input_missing");this.plan(path,stage);
    if(path.cancelled)return {kind:"cancelled" as const};
    if(stage.status!=="accepted")return {kind:"pending" as const};
    const value=stage.result!.value as Option;
    confirmNativeInputPreparation({value:value.preparation,origin:{pathId,stageId:stage.request.id,rawResultId:stage.result!.id,receiptId:stage.receipt!.id}},stage);
    return {kind:"prepared" as const,value,stage,path};
  }
  async prepareAdoption(pathId:string,input:{readonly id:string;readonly need:ActivityInputNeed;
    readonly expectedSelectionId:string|null;readonly expectedControlRevision:number},signal:AbortSignal){
    signal.throwIfAborted();const result=await this.result(pathId);
    if(result.kind!=="prepared"||!result.value.proposal||!input.need.origin)throw new TypeError("native_original_input_not_usable");
    const {value,path,stage}=result,plan=this.plan(path,stage),scope=plan.scope;
    if(input.need.id!==plan.inputSupply.needId||input.need.origin.requestId!==plan.inputSupply.source.stageId||input.need.supplier!==scope.owner)
      throw new TypeError("native_original_input_adoption_need_changed");
    const proposed=value.proposal!.parts.find(p=>p.owner==="context_selection"&&p.kind==="selection_input")!.proposal as ContextSelectionProposal;
    const acceptance=helarcNativeInputAcceptance({...input,scope,retainedSelectionId:null,selection:proposed.selection,native:value.selected,
      judgment:value.judgment,inputId:proposed.input.id,activityId:proposed.input.activityId,stageRequestId:null,nativeConsumer:proposed.input.nativeConsumer,
      inputHolds:proposed.input.holds,releaseHolds:[]});
    const returned={needId:input.need.id,origin:input.need.origin,inputId:proposed.input.id,inputDigest:digest(value.selected),readyStageId:input.need.stage.id};
    return {...acceptance,parts:[{owner:"activity",kind:"path_condition",proposal:{pathId,expected:{controlRevision:path.controlRevision,
      progressRevision:path.progressRevision,cancelled:false},requireSettled:false}},
      {owner:"context_selection",kind:"scope",proposal:scope},{owner:"representation",kind:"judge",proposal:value.judgment},...acceptance.parts,
      nativeInputSupplyReturnPart(returned),{owner:"activity",kind:"stage_submission",proposal:{...input.need.stage,input:nativeInputReady(returned)}}]};
  }
  private validate(path:ActivityPathIntent,plan:HelarcNativeOriginalInputPlan){
    const {scope,inputSupply:b}=plan;
    if(plan.revision!=="1"||path.purpose.digest!==(plan.measurement?this.measuredPurpose:this.purpose).digest||path.owner!==scope.owner||path.runId!==scope.runId||
      path.permissionBasis!==scope.authorityBasis||!path.scheduledWorkId||b.runId!==scope.runId||b.owner!==scope.owner||
      scope.target!==`${b.configuration.id}:${b.configuration.revision}`||!plan.inputId||!plan.selectionId)
      throw new TypeError("native_original_input_plan_invalid");
  }
  private plan(path:ActivityPathState,stage:ActivityStageState){
    const input=stage.request.input as {plan:HelarcNativeOriginalInputPlan;inputSupplyPreparation:InputSupplyPreparation};
    this.validate(path.intent,input.plan);
    const expected=(this.prepareSubmission(path.intent,input.plan)[1]!.proposal as ActivityStageState["request"]);
    if(digest(stage.request)!==digest(expected))throw new TypeError("native_original_input_submission_changed");
    return input.plan;
  }
}
