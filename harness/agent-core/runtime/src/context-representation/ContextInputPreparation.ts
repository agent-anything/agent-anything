import {assessModelContext, snapshotProviderRequest, type Provider, type ProviderRequest, type ModelInputMeasurement} from "@agent-anything/model-interaction";
import {snapshotModelInputMeasurement} from "@agent-anything/model-interaction/context";
import {assessInputCapacity, assertEncodedModelInputIntegrity, composeInputChoice, inputChoiceGaps, modelInputValueDigest, nextInputCombination, recordInputCombination,
  startInputCombinationSearch, chargeInputCombination, type InputOrganizationDemand, type InputCombinationProgress, type InputCapacityLimit,
  type InputCapacityPolicy, type InputMeasurementEvidence, type CapacityReservation, type EncodedModelInput, type InputCapacityAssessment,
  modelInputSectionLocations, allocateInputCapacity, type RemoteInputMeasurementRequest, type LocalInputMeasurement, type SharedInputCapacity, type ModelInputSectionLocation, type InputChoice} from "@agent-anything/model-interaction/input";
import type {ActivityPurposeContract} from "../activity/ActivityPurpose.js";
import type {ActivityPurposeHandler} from "../activity/ActivityHandoffProcessor.js";
import type {ActivityPathState,ActivityStageState,ActivityStageRequest,ActivityAttempt,ActivityRawResult} from "../activity/ActivityHandoff.js";
import {containsMaterialRange,type MaterialAccess,type MaterialAccessDescription,type MaterialCustodyPort} from "@agent-anything/context/custody";

export const CONTEXT_INPUT_PREPARATION_PURPOSE:ActivityPurposeContract={
  ref:{id:"context.input-preparation",revision:"1"},inputOwner:"context-representation",executionOwner:"model-input",interpretationOwner:"context-representation",
  acceptanceOwner:"context-representation",recoveryOwner:"context-representation",stageKinds:["organize","measure"],capabilities:["model-measurement"],continuationKinds:["stage_request","next_combination","measurement_result"],
};
export interface ContextInputPreparationRequest {
  readonly kind:"context_input_preparation";
  readonly demand:InputOrganizationDemand;
  readonly template:ProviderRequest;
  readonly limits:readonly InputCapacityLimit[];
  readonly reservations:readonly CapacityReservation[];
  readonly policy:InputCapacityPolicy;
  readonly allowExternalMeasurement:boolean;
  readonly deliveryMode:"buffered"|"streaming";
  readonly localMeasurements:readonly LocalInputMeasurement[];
  readonly sharedCapacity:SharedInputCapacity|null;
  readonly materialAccesses:readonly MaterialAccess[];
}
export interface PreparedContextInput {
  readonly kind:"prepared_context_input";
  readonly preparationStageId:string;
  readonly demand:InputOrganizationDemand;
  readonly choice:InputChoice;
  readonly request:ProviderRequest;
  readonly encoded:EncodedModelInput;
  readonly measurement:readonly InputMeasurementEvidence[];
  readonly limits:readonly InputCapacityLimit[];
  readonly capacity:InputCapacityAssessment;
  readonly progress:InputCombinationProgress;
  readonly locations:readonly ModelInputSectionLocation[];
  readonly deliveries:readonly {readonly id:string;readonly position:string}[];
  readonly allocation:ReturnType<typeof allocateInputCapacity>;
  readonly localMeasurements:readonly LocalInputMeasurement[];
  readonly sharedCapacity:SharedInputCapacity|null;
}
export interface ContextInputPreparationGap {
  readonly reason:string;
  readonly demandId:string;
  readonly targetRevision:string;
  readonly information:readonly import("@agent-anything/model-interaction/input").InputCompositionGap[];
  readonly capacity:readonly InputCapacityAssessment[];
  readonly untested:boolean;
  /** Only the owning path can decide to request new work; a gap is not a waiting producer. */
  readonly responsibility:"request_owner";
}
export interface ContextInputPreparationStageInput {
  readonly request:ContextInputPreparationRequest;
  readonly progress:InputCombinationProgress;
  readonly pending?:{readonly request:ProviderRequest;readonly encoded:EncodedModelInput;readonly choice:InputChoice;readonly candidateId:string;readonly remote:RemoteInputMeasurementRequest};
}
type PreparationStageInput=ContextInputPreparationStageInput;
type PreparationResult =
  | {readonly kind:"prepared";readonly prepared:PreparedContextInput;readonly elapsedMs:number}
  | {readonly kind:"continue";readonly input:PreparationStageInput;readonly stageKind:"organize"|"measure";readonly elapsedMs:number}
  | {readonly kind:"remote_returned";readonly raw:unknown;readonly elapsedMs:number}
  | {readonly kind:"gap";readonly reason:string;readonly gap:ContextInputPreparationGap;readonly progress:InputCombinationProgress;readonly elapsedMs:number};
type WithoutTiming<T> = T extends unknown ? Omit<T,"elapsedMs"> : never;

/** Professional input preparation; shared execution owns admission, cancellation and durable results. */
export class ContextInputPreparationHandler implements ActivityPurposeHandler {
  constructor(private readonly dependencies:{
    provider:Provider;
    materials:MaterialCustodyPort;
    authorize:(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal)=>Promise<void>;
    now:()=>string;
    purpose?:ActivityPurposeContract;
  }) {}

  async authorize(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal):Promise<void> {
    const input=readInput(stage);
    if(modelInputValueDigest(path.intent.purpose.contract)!==modelInputValueDigest(this.dependencies.purpose??CONTEXT_INPUT_PREPARATION_PURPOSE) || input.request.demand.runId!==path.intent.runId ||
        input.request.demand.purpose!==input.request.template.purpose || !this.dependencies.provider.encodeInput) throw new TypeError("input_preparation_binding_invalid");
    if(input.request.template.composition.providerId!==this.dependencies.provider.descriptor.id ||
      input.request.template.composition.model!==this.dependencies.provider.modelContext.target.model)throw new TypeError("input_preparation_target_unavailable");
    for(const access of input.request.materialAccesses) {
      signal.throwIfAborted();
      if(access.recipient.runId!==input.request.demand.runId || access.recipient.recipient!==input.request.demand.recipient ||
        access.recipient.purpose!==input.request.demand.purpose)throw new TypeError("input_preparation_material_scope_invalid");
      const description=await this.dependencies.materials.command({kind:"describe",holdId:access.holdId,recipient:access.recipient}) as MaterialAccessDescription;
      if(!description || !containsMaterialRange(description.hold.range,access.range))throw new TypeError("input_preparation_material_unavailable");
    }
    if(stage.request.stageKind==="measure") {
      const pending=input.pending,measurement=this.dependencies.provider.inputMeasurement;
      if(!pending || !measurement || measurement.revision!==pending.remote.methodRevision || pending.remote.encodedInputId!==pending.encoded.id ||
        pending.remote.targetRevision!==input.request.demand.targetRevision)throw new TypeError("input_remote_measurement_binding_invalid");
      this.dependencies.provider.verifyEncodedInput?.(pending.request,pending.encoded);
    }
    await this.dependencies.authorize(path,stage,signal);
  }

  async execute(_path:ActivityPathState,stage:ActivityStageState,attempt:ActivityAttempt,signal:AbortSignal):Promise<ActivityRawResult> {
    signal.throwIfAborted();
    const started=performance.now(),input=readInput(stage);
    const value=stage.request.stageKind==="measure"?
      {kind:"remote_returned" as const,raw:await this.dependencies.provider.inputMeasurement!.send(input.pending!.remote,signal)}:
      await this.process(stage,input,signal);
    return {id:`${attempt.id}:raw`,attemptId:attempt.id,completeness:"complete",outcome:"returned",value:{...value,elapsedMs:performance.now()-started},
      usage:{externalMeasurements:stage.request.stageKind==="measure"?1:0},recordedAt:this.dependencies.now()};
  }

  async reconcile(_path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal):Promise<ActivityRawResult|null> {
    // Pure local work may be recalculated; an unknown remote measurement is not resent.
    if(stage.request.stageKind!=="organize")return null;
    return this.execute(_path,stage,stage.attempt!,signal);
  }

  async interpret(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal) {
    signal.throwIfAborted();
    if(stage.result?.outcome!=="returned" || stage.result.completeness!=="complete")throw new TypeError("input_preparation_result_incomplete");
    let value=stage.result.value as PreparationResult;
    if(value.kind==="remote_returned") {
      const input=readInput(stage),pending=input.pending!;
      let measurement:ModelInputMeasurement;
      try {
        measurement=snapshotModelInputMeasurement(this.dependencies.provider.inputMeasurement!.interpret(pending.remote,value.raw,pending.request.composition.id,stage.result.recordedAt),pending.request.composition.id);
      } catch(error) {
        return {progress:{kind:"input_preparation",state:"gap",reason:"remote_measurement_result_invalid",rawResultId:stage.result.id,progress:input.progress,
          failure:{name:error instanceof Error?error.name:"Unknown",message:error instanceof Error?error.message:String(error)}},next:[]};
      }
      value={...this.finishCandidate(stage,input,pending.request,pending.encoded,pending.choice,pending.candidateId,measurement),elapsedMs:value.elapsedMs};
    }
    if(value.kind==="continue"&&(path.resourceUse.admittedStages>=path.intent.maximumStages||path.resourceUse.dispatchedAttempts>=path.intent.maximumAttempts||Date.parse(this.dependencies.now())>=Date.parse(path.intent.deadlineAt)))return {progress:{kind:"input_preparation",state:"gap",reason:"input_preparation_execution_budget_exhausted",rawResultId:stage.result.id,progress:value.input.progress,resources:path.resourceUse},next:[]};
    if(value.kind==="continue")return {progress:{kind:"input_preparation",state:"progressing",input:value.input,rawResultId:stage.result.id},
      next:[{id:`${path.intent.id}:stage:${path.progressRevision+2}`,pathId:path.intent.id,stageKind:value.stageKind,input:value.input,
        capabilities:value.stageKind==="measure"?["model-measurement"]:[],dependencies:[{requestId:stage.request.id,condition:"accepted" as const}]}]};
    if(value.kind==="prepared") {validatePreparedContextInput(value.prepared);return {progress:{kind:"input_preparation",state:"prepared",prepared:value.prepared,rawResultId:stage.result.id},next:[]};}
    if(value.kind==="gap")return {progress:{state:"gap",...value,rawResultId:stage.result.id},next:[]};
    throw new TypeError("input_preparation_result_invalid");
  }

  private async process(stage:ActivityStageState,input:PreparationStageInput,signal:AbortSignal):Promise<WithoutTiming<PreparationResult>> {
    const provider=this.dependencies.provider,{demand,template,policy}=input.request;
    let progress=input.progress;
    const step=nextInputCombination(demand,progress);
    if(step.kind==="gap")return {kind:"gap",reason:step.reason,progress:step.progress,gap:{reason:step.reason,demandId:demand.id,targetRevision:demand.targetRevision,
      information:step.progress.tested.flatMap(t=>t.gaps),capacity:step.progress.tested.flatMap(t=>t.assessment?[t.assessment]:[]),untested:step.untested,responsibility:"request_owner"}};
    if(step.kind!=="measure")throw new TypeError("input_preparation_duplicate_ready");
    progress=step.progress;
    let request:ProviderRequest,encoded:EncodedModelInput,measurement:ModelInputMeasurement;
    {
      const composition=composeInputChoice(demand,step.choice,{providerId:template.composition.providerId,model:template.composition.model,
        interaction:template.interaction,lineage:template.composition.lineage,composedAt:template.composition.composedAt});
      request=snapshotProviderRequest({...template,requestId:composition.id,composition,instructions:composition.instructions,messages:composition.messages,
        modelContext:{...template.modelContext,assessment:null}});
      encoded=provider.encodeInput!(request,input.request.deliveryMode);
      if(encoded.targetDigest!==demand.targetRevision)throw new TypeError("input_preparation_target_changed");
      measurement=provider.modelContext.measure(composition,this.dependencies.now());
      if(measurement.status==="unknown" && input.request.allowExternalMeasurement && provider.inputMeasurement && progress.externalMeasurements<demand.maximumExternalMeasurements) {
        progress=chargeInputCombination(demand,progress,{externalMeasurements:1,readBytes:0});
        const remote=provider.inputMeasurement.prepare(request,encoded);
        if(remote.methodRevision!==provider.inputMeasurement.revision || remote.encodedInputId!==encoded.id || remote.targetRevision!==encoded.targetDigest)throw new TypeError("input_measurement_preparation_invalid");
        return {kind:"continue",stageKind:"measure",input:{request:input.request,progress,pending:{request,encoded,choice:step.choice,candidateId:step.id,remote}}};
      }
    }
    signal.throwIfAborted();
    return this.finishCandidate(stage,{...input,progress},request,encoded,step.choice,step.id,measurement);
  }

  private finishCandidate(stage:ActivityStageState,input:PreparationStageInput,request:ProviderRequest,encoded:EncodedModelInput,choice:InputChoice,candidateId:string,measurement:ModelInputMeasurement):WithoutTiming<PreparationResult> {
    const provider=this.dependencies.provider,{demand,policy}=input.request,{limits,reservations}=targetCapacity(provider,input.request);
    let progress=input.progress;
    measurement=snapshotModelInputMeasurement(measurement,request.composition.id);
    const evidence=measurementEvidence(encoded,demand,measurement,provider);
    const allocation=allocateInputCapacity(demand,choice,input.request.localMeasurements,input.request.sharedCapacity);
    const localLimits=allocation.shares.filter(s=>s.ceiling!==null).map(s=>({id:`local:${s.contributionId}`,targetRevision:demand.targetRevision,
      dimension:s.dimension,maximum:s.ceiling!,source:`contribution:${s.contributionId}`}));
    const capacity=assessInputCapacity({encodedInputId:encoded.id,targetRevision:demand.targetRevision,purpose:demand.purpose,limits,evidence,reservations,policy});
    const unknownLocal=allocation.shares.filter(s=>s.hardLimit==="unknown"&&!policy.allowUnknown).map(s=>s.contributionId);
    if(allocation.hardViolations.length || unknownLocal.length) {
      // Local hard failures invalidate this combination even if another contribution has spare capacity.
      const decisions=[...capacity.decisions,...localLimits.filter(l=>allocation.hardViolations.includes(l.id.slice(6))||unknownLocal.includes(l.id.slice(6))).map(l=>({limitId:l.id,evidenceId:null,
        conclusion:allocation.hardViolations.includes(l.id.slice(6))?"violated" as const:"uncertain" as const,reason:"local_hard_ceiling"}))];
      const rejected={...capacity,decisions,allowed:false};
      progress=recordInputCombination(demand,progress,candidateId,{...rejected,id:modelInputValueDigest(rejected)});
      return {kind:"continue",stageKind:"organize",input:{request:input.request,progress}};
    }
    progress=recordInputCombination(demand,progress,candidateId,capacity);
    if(!capacity.allowed)return {kind:"continue",stageKind:"organize",input:{request:input.request,progress}};
    const legacyAssessment=assessModelContext({compositionId:request.composition.id,capacity:provider.modelContext.capacity,measurement,
      requestedOutput:request.modelContext.requestedOutput,headroom:request.modelContext.headroom,assessedAt:this.dependencies.now(),revision:"context-input-preparation:1"});
    request=snapshotProviderRequest({...request,modelContext:{...request.modelContext,assessment:legacyAssessment}});
    // Capacity annotations do not change model payload or its semantic request digest.
    const locations=modelInputSectionLocations(request.composition.sections);
    const deliveries=inputDeliveryLocations(demand,choice,locations);
    const prepared:PreparedContextInput={kind:"prepared_context_input",preparationStageId:stage.request.id,demand,choice,request,encoded,measurement:evidence,limits,capacity,progress,locations,deliveries,
      allocation,localMeasurements:input.request.localMeasurements,sharedCapacity:input.request.sharedCapacity};
    validatePreparedContextInput(prepared);
    return {kind:"prepared",prepared};
  }
}

export function firstContextInputPreparationStage(pathId:string,request:ContextInputPreparationRequest):ActivityStageRequest {
  return {id:`${pathId}:stage:1`,pathId,stageKind:"organize",input:{request,progress:startInputCombinationSearch(request.demand)} satisfies PreparationStageInput,capabilities:[],dependencies:[]};
}

export function validatePreparedContextInput(value:PreparedContextInput):void {
  snapshotProviderRequest(value.request);
  assertEncodedModelInputIntegrity(value.encoded,value.request);
  const composition=composeInputChoice(value.demand,value.choice,{providerId:value.request.composition.providerId,model:value.request.composition.model,
    interaction:value.request.interaction,lineage:value.request.composition.lineage,composedAt:value.request.composition.composedAt});
  const locations=modelInputSectionLocations(composition.sections);
  const allocation=allocateInputCapacity(value.demand,value.choice,value.localMeasurements,value.sharedCapacity);
  const assessment=assessInputCapacity({encodedInputId:value.encoded.id,targetRevision:value.demand.targetRevision,purpose:value.demand.purpose,
    limits:value.limits,evidence:value.measurement,reservations:value.capacity.reservations,policy:value.capacity.policy});
  if(value.kind!=="prepared_context_input" || !value.preparationStageId || inputChoiceGaps(value.demand,value.choice).length ||
      modelInputValueDigest(composition)!==modelInputValueDigest(value.request.composition) ||
      modelInputValueDigest(locations)!==modelInputValueDigest(value.locations) ||
      allocation.hardViolations.length || modelInputValueDigest(allocation)!==modelInputValueDigest(value.allocation) ||
      modelInputValueDigest(inputDeliveryLocations(value.demand,value.choice,locations))!==modelInputValueDigest(value.deliveries) ||
      modelInputValueDigest(assessment)!==modelInputValueDigest(value.capacity) || value.encoded.targetDigest!==value.demand.targetRevision ||
      value.request.purpose!==value.demand.purpose || value.capacity.encodedInputId!==value.encoded.id || value.capacity.targetRevision!==value.demand.targetRevision ||
      value.capacity.policy.purpose!==value.demand.purpose || !value.capacity.allowed || !value.progress.tested.some(t=>t.id===value.request.composition.id &&
        t.assessment?.id===value.capacity.id && modelInputValueDigest(t.choice)===modelInputValueDigest(value.choice)))throw new TypeError("prepared_context_input_invalid");
}

function inputDeliveryLocations(demand:InputOrganizationDemand,choice:InputChoice,locations:readonly ModelInputSectionLocation[]) {
  return demand.deliveryIds.map(id=>{
    const contribution=demand.contributions.find(c=>c.deliveryIds.includes(id))!;
    const option=contribution.options.find(o=>o.id===choice[contribution.id])!;
    const pointers=option.sections.flatMap(o=>locations.find(l=>l.sectionId===o.section.id)?.jsonPointers??[]);
    if(!pointers.length)throw new TypeError("input_delivery_content_missing");
    return {id,position:JSON.stringify(pointers)};
  });
}

function readInput(stage:ActivityStageState):PreparationStageInput {
  const input=stage.request.input as PreparationStageInput;
  if(input?.request?.kind!=="context_input_preparation" || !input.progress)throw new TypeError("input_preparation_stage_invalid");
  return input;
}
function measurementEvidence(encoded:EncodedModelInput,demand:InputOrganizationDemand,value:ModelInputMeasurement,provider:Provider):readonly InputMeasurementEvidence[] {
  const dimension=provider.modelContext.capacity.supported && provider.modelContext.capacity.semantics==="input_and_output"?"shared_tokens":"input_tokens";
  const quantity=value.status==="unknown"?{kind:"unknown" as const,reason:value.reason}:value.estimator.accuracy==="exact"?{kind:"exact" as const,value:value.amount}:
    value.estimator.accuracy==="upper_bound"?{kind:"bounds" as const,lower:0,upper:value.amount}:{kind:"estimate" as const,value:value.amount,limitations:[value.uncertainty.kind]};
  return [{id:`${encoded.id}:bytes`,encodedInputId:encoded.id,targetRevision:demand.targetRevision,methodRevision:"utf8:1",dimension:"request_bytes",coverage:"complete",quantity:{kind:"exact",value:encoded.bytes},basis:"complete adapter encoded bytes",uncovered:[]},
    {id:`${encoded.id}:tokens`,encodedInputId:encoded.id,targetRevision:demand.targetRevision,methodRevision:value.status==="unknown"?"unavailable":value.estimator.revision,
      dimension,coverage:value.status==="unknown"?"partial":"complete",quantity,basis:"provider-owned measurement",uncovered:value.status==="unknown"?["target tokenization"]:[]}];
}

function targetCapacity(provider:Provider,request:ContextInputPreparationRequest) {
  const targetRevision=request.demand.targetRevision,limits=[...request.limits],reservations=[...request.reservations];
  const capacity=provider.modelContext.capacity;
  if(capacity.supported) {
    const dimension=capacity.semantics==="input_and_output"?"shared_tokens" as const:"input_tokens" as const;
    limits.push({id:"target:model-window",targetRevision,dimension,maximum:capacity.maximum,source:`${capacity.source}:${capacity.revision}`});
    if(dimension==="shared_tokens"&&!reservations.some(r=>r.purpose==="generation"&&r.dimension===dimension)) {
      const output=request.template.modelContext.requestedOutput;
      reservations.push({id:"target:generation",purpose:"generation",dimension,basis:output.revision,alreadyIncluded:false,
        quantity:output.maximum===null?{kind:"unknown",reason:"generation room not planned by purpose owner"}:{kind:"exact",value:output.maximum}});
    }
  }
  const transport=provider.requestBodyTransportLimit;
  limits.push({id:"target:transport",targetRevision,dimension:"request_bytes",maximum:transport.maximumBytes,source:`${transport.source}:${transport.revision}`});
  return {limits,reservations};
}
