import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {OPENAI_RESPONSES,type ModelPurposeParticipants} from "@agent-anything/model-interaction/protocol";
import {bindProtocolModelActivity,type ProtocolModelActivity} from "@agent-anything/agent-runtime/model-access";
import type {ActivityPathState,ActivityStageState} from "@agent-anything/agent-runtime/activity";
import {prepareResponsesInputTokenCount,dispatchResponsesInputTokenCount,responsesInputCapacityEvidence,responsesInputCapacityRefusal,
  resolveResponsesInputContinuity,nativeInputGroupDigest,RESPONSES_INPUT_TOKEN_COUNT_REVISION,
  type ResponsesInputTokenCountRequest,type ResponsesCountEvidence,type ResponsesMeasurementApplicability} from "@agent-anything/provider-integrations/native";
import {HelarcResponsesCountExecution,HELARC_RESPONSES_COUNT_INTERPRETER,type HelarcNativeInputMeasurementPort,type HelarcNativeInputMeasurementResult,
  type HelarcResponsesCountRequest,type HelarcNativeStructuredRequest} from "@agent-anything/helarc/controller";
import type {HelarcExecutionStore} from "../execution-storage/HelarcExecutionStore.js";
import {measureIdentifiedWork,measuredFetch,protocolWork} from "../diagnostics/IdentifiedWorkTiming.js";
import type {ProviderConfiguration} from "../../shared/ProviderConfiguration.js";
import type {ProviderConfigurationService} from "../provider/ProviderConfigurationService.js";
import {ProviderConnectionRetention} from "../provider/ProviderConnectionRetention.js";
import {reuseHelarcResponsesMeasurement,responsesMeasurementInputIdentity} from "./HelarcResponsesMeasurementReuse.js";

export const HELARC_RESPONSES_MEASUREMENT_PARTICIPANT:ModelPurposeParticipants={
  purpose:{id:"context_input_measurement",revision:"1"},
  input:{implementation:{id:"helarc.responses-input-count-input",revision:"1"},protocol:OPENAI_RESPONSES},
  interpreter:{implementation:HELARC_RESPONSES_COUNT_INTERPRETER,protocol:OPENAI_RESPONSES}};
export const HELARC_RESPONSES_MEASUREMENT_SELECTION={purpose:HELARC_RESPONSES_MEASUREMENT_PARTICIPANT.purpose,
  methodRevision:`${RESPONSES_INPUT_TOKEN_COUNT_REVISION}:evidence-handoff:2`};
export interface HelarcNativeAuxiliaryMeasurementSource {
  readonly activityId:string;readonly runId:string;readonly recipientId:string;
  readonly source:HelarcNativeStructuredRequest["source"];
  readonly measurement?:{readonly pathId:string;readonly stageId:string;readonly maximumCalls:number;readonly kind?:"auxiliary_input"|"compact_assessment_input"};
}
export interface HelarcResponsesInputMeasurements extends HelarcNativeInputMeasurementPort {
  measureStructured(request:HelarcNativeStructuredRequest,source:HelarcNativeAuxiliaryMeasurementSource,signal:AbortSignal):Promise<HelarcNativeInputMeasurementResult>;
  interruptStructured(source:Pick<HelarcNativeAuxiliaryMeasurementSource,"activityId">,signal:AbortSignal):Promise<void>;
}

export function bindResponsesRecipientMeasurements(count:ResponsesInputTokenCountRequest,result:ResponsesCountEvidence,
  current:ResponsesMeasurementApplicability,inputId:string,workBudget:boolean){
  return (["input_tokens","shared_tokens"] as const).map(dimension=>{
    const value=responsesInputCapacityEvidence(count,result,current,dimension);
    // Unknown target stability limits forecasts; it does not invalidate this complete observation.
    const observed=workBudget&&dimension==="input_tokens"&&result.status==="measured"&&value.coverage==="complete"&&
      (value.quantity.kind==="exact"||value.quantity.kind==="estimate"&&value.quantity.limitations.includes("target_validity_unknown"));
    const {id:_id,...body}=value,derived={...body,encodedInputId:inputId,basis:`${value.basis};measurement_input:${count.binding.encodedInputId}`,
      ...(observed?{observedInputCount:{tokens:result.inputTokens,receiptId:result.id}}:{})};
    return {...derived,id:digest(derived)};
  });
}

/** Runs under the caller's accepted measurement stage; never acquires the model pool twice. */
export function createHelarcResponsesInputMeasurement(p:{store:HelarcExecutionStore;providers:ProviderConfigurationService;configuration:ProviderConfiguration;
  workBudget?:boolean;
  now:()=>string;check:(activity:ProtocolModelActivity,signal:AbortSignal,dispatch?:boolean)=>Promise<void>}):HelarcResponsesInputMeasurements {
  const c=p.configuration,retention=new ProviderConnectionRetention(p.providers,{read:async pin=>
    (await p.store.sharedAcceptance.query(pin.acceptanceId))?.outcome==="accepted"?"accepted":"unknown"});
  function connection(request:HelarcResponsesCountRequest){
    const id=request.activity.scope.activityId;
    return {kind:"connection" as const,bindingId:c.connectionBindingId,pinId:`${id}:connection`,acceptanceId:`${id}:prepare`};
  }
  function original(request:HelarcResponsesCountRequest){
    const config=request.activity.composition.composition.configuration,b=request.count.binding;
    if(config.configuration.id!==c.id||config.configuration.revision!==c.revision||config.connectionBinding.id!==c.connectionBindingId||config.model!==c.model||
      b.targetDigest!==digest({model:c.model,configuration:`${c.id}:${c.revision}`,connection:c.connectionBindingId,disclosure:request.activity.conditions.authority.id}))
      throw new TypeError("responses_measurement_original_target_changed");
  }
  async function measurementStage(request:HelarcResponsesCountRequest,dispatch:boolean){
    const a=request.allowance;if(!a)return null;
    const path=await p.store.activityHandoffs.command({kind:"read_path",pathId:a.pathId}) as ActivityPathState|null;
    const stage=await p.store.activityHandoffs.command({kind:"read_stage",requestId:a.stageId}) as ActivityStageState|null;
    if(!path||!stage?.attempt||stage.request.pathId!==path.intent.id||path.intent.runId!==request.activity.scope.runId||
      path.intent.owner!=="context-representation"||path.intent.permissionBasis!==request.activity.conditions.authority.id||
      (path.intent.resourceBudgetSources?.measurementCalls??(a.kind?path.intent.id:null))!==a.sourcePathId||path.intent.resourceLimits?.measurementCalls!==a.maximumCalls)
      throw new TypeError("responses_measurement_original_allowance_changed");
    if(a.kind==="method_input"){
      const input=(stage.request.input as {nativeInput?:import("@agent-anything/agent-runtime/context-representation").RepresentationMethodModelInput})?.nativeInput;
      if(stage.request.stageKind!=="model"||!stage.request.capabilities.includes("model-access")||!input||
        `${input.job.id}:native-method:input-count`!==request.activity.scope.activityId||
        digest(input.request.nativeComposition)!==digest(request.activity.composition)||input.request.capacity.maximumMeasurements!==a.maximumCalls||
        input.request.recipient.recipient!==request.activity.scope.recipientId)throw new TypeError("responses_method_measurement_original_changed");
    }else if(a.kind==="compact_assessment_input"){
      const method=(stage.request.input as {method?:{phase:string;request:import("@agent-anything/agent-runtime/context-representation").ProtocolRepresentationMethodRequest}}).method;
      const source=method?.request.execution.request as import("@agent-anything/helarc/controller").HelarcResponsesCompactSource|undefined;
      if(stage.request.stageKind!=="assessment"||!stage.request.capabilities.includes("model-access")||method?.phase!=="assessment"||
        method.request.method!=="protocol"||!source?.assessmentInput||source.assessmentInput.maximumMeasurements!==a.maximumCalls||
        source.manifest.scope.compositionDigest!==request.activity.composition.digest||method.request.recipient.recipient!==request.activity.scope.recipientId||
        request.count.binding.scope.purpose!==source.assessmentInput.capacity.policy.purpose||
        !["oracle",...(source.assessmentModelCalls===4?["plan-ownership"]:[]),"probe","judgment"].some(s=>request.activity.scope.activityId===`${path.intent.id}:compact-assessment:${s}:input-count`))
        throw new TypeError("responses_compact_assessment_measurement_original_changed");
    }else if(a.kind==="auxiliary_input"){
      const input=stage.request.input as {kind?:string;activityId?:string;compositionDigest?:string;source?:unknown;wireDigest?:string};
      if(stage.request.stageKind!=="prepare_input"||!stage.request.capabilities.includes("model-measurement")||
        input?.kind!=="helarc_native_auxiliary_input"||`${input.activityId}:input-count`!==request.activity.scope.activityId||
        input.compositionDigest!==request.activity.composition.digest||input.wireDigest!==request.count.generation.digest||
        digest(input.source)!==request.count.binding.sourceDigest)throw new TypeError("responses_auxiliary_measurement_original_changed");
    }else if(!stage.request.capabilities.includes("model-measurement"))throw new TypeError("responses_measurement_original_allowance_changed");
    if(dispatch&&(path.cancelled||Date.parse(p.now())>=Date.parse(path.intent.deadlineAt)))throw new TypeError("responses_measurement_stage_not_active");
    return {path,stage};
  }
  const execution=new HelarcResponsesCountExecution({journal:p.store.protocolJournal,acceptance:p.store.sharedAcceptance,generation:p.store.generation,now:p.now,
    authorize:async(request,action,signal)=>{original(request);await p.check(request.activity,signal,action==="dispatch");await measurementStage(request,action==="dispatch");},
    reserve:async(request,signal)=>{
      const current=await measurementStage(request,true);signal.throwIfAborted();if(!current)return true;
      try{
        await p.store.activityHandoffs.command({kind:"reserve_resources",expectedControlRevision:current.path.controlRevision,
          reservation:{id:`${request.activity.scope.activityId}:count:allowance`,pathId:current.path.intent.id,requestId:current.stage.request.id,amounts:{measurementCalls:1}}});
        return true;
      }catch(error){
        if(error instanceof Error&&(error.message==="activity_resource_limit_exceeded"||(error as Error&{code?:string}).code==="activity_resource_limit_exceeded"))return false;
        throw error;
      }
    },
    dispatch:async(request,signal,authorize,retainChunk)=>{
      const binding=connection(request),config=await retention.recover(binding);
      if(config.id!==c.id||config.revision!==c.revision||config.protocol!=="openai.responses"||config.baseUrl!==c.baseUrl||config.model!==c.model)
        throw new TypeError("responses_measurement_original_target_changed");
      return p.providers.withConnection(binding.bindingId,async(actual,key)=>{
        if(actual.id!==c.id||actual.revision!==c.revision||actual.connectionBindingId!==binding.bindingId||actual.native.protocol!=="openai.responses")
          throw new TypeError("responses_measurement_original_connection_changed");
        await authorize();
        return dispatchResponsesInputTokenCount(request.count,{baseUrl:actual.baseUrl,apiKey:key??"",targetDigest:request.count.binding.targetDigest,
          ...actual.native.organization?{organization:actual.native.organization}:{},...actual.native.project?{project:actual.native.project}:{}},
          {signal,maximumBytes:1024*1024,retainChunk,fetch:measuredFetch(p.store,protocolWork(request.activity.scope.runId,request.activity.scope.activityId),request.activity.scope.activityId),applicability:{binding:request.count.binding,generationDigest:request.count.generation.digest,
            now:p.now(),authorized:true,dependenciesAvailable:true}});
      });
    }});
  async function measureRequest(request:HelarcResponsesCountRequest,inputId:string,legacy:boolean,signal:AbortSignal){
    const {activity,count}=request;
    original(request);await p.check(activity,signal);await measurementStage(request,false);
    const current=()=>({binding:count.binding,generationDigest:count.generation.digest,now:p.now(),authorized:true,dependenciesAvailable:true});
    const evidence=(result:ResponsesCountEvidence)=>bindResponsesRecipientMeasurements(count,result,current(),inputId,p.workBudget===true);
    const refusals=(result:Parameters<typeof responsesInputCapacityRefusal>[1])=>{
      const refusal=responsesInputCapacityRefusal(count,result,current());
      if(!refusal)return [];
      const {id:_id,...basis}=refusal,value={...basis,encodedInputId:inputId,
        source:{owner:"protocol_execution",id:activity.scope.activityId,revision:"1"}};
      return [{...value,id:`responses-capacity-refusal:${digest(value)}`}];
    };
    const retained=await p.store.protocolJournal.command({kind:"state",activityId:activity.scope.activityId});
    if(!retained&&!legacy){
      const reused=await reuseHelarcResponsesMeasurement({journal:p.store.protocolJournal,request,current:current(),signal});
      if(reused){await p.check(activity,signal);return {evidence:evidence(reused),usage:{measurementCalls:0}};}
    }
    if(!retained){
      const bound=connection(request);
      await p.store.protocolJournal.command({kind:"reserve_admission",activity});
      await p.providers.pin({id:bound.pinId,bindingId:bound.bindingId,acceptanceId:bound.acceptanceId,
        owner:activity.composition.composition.adapter.implementation.id,purpose:activity.scope.purpose.id,state:"provisional"});
    }
    const result=await measureIdentifiedWork(p.store,{work:protocolWork(activity.scope.runId,activity.scope.activityId),
      phase:"measure_input"},()=>execution.execute(request,signal));await p.check(activity,signal);
    const dispatched=await p.store.protocolJournal.command({kind:"record",activityId:activity.scope.activityId,
      ref:{id:`${activity.scope.activityId}:count:dispatch`,revision:"1"}});
    return {evidence:evidence(result),refusals:refusals(result),usage:{measurementCalls:dispatched?1:0}};
  }
  const port=(stage?:{path:ActivityPathState;stage:ActivityStageState}):HelarcNativeInputMeasurementPort=>({
    inStage:(path,current)=>port({path,stage:current}),interrupt:(inputId,signal)=>execution.interrupt(`${inputId}:native-count`,signal),measure:async(input,signal)=>{
    const legacy=input.selection.methodRevision===RESPONSES_INPUT_TOKEN_COUNT_REVISION;
    const {budget,...selection}=input.selection,{native}=input;
    if(digest(selection)!==digest(legacy?{...HELARC_RESPONSES_MEASUREMENT_SELECTION,methodRevision:RESPONSES_INPUT_TOKEN_COUNT_REVISION}:HELARC_RESPONSES_MEASUREMENT_SELECTION)||native.continuity.kind!=="responses")
      throw new TypeError("responses_measurement_participant_changed");
    if(budget&&(!stage||stage.path.intent.resourceBudgetSources?.measurementCalls!==budget.pathId||
      stage.path.intent.resourceLimits?.measurementCalls!==budget.maximumCalls))throw new TypeError("responses_measurement_original_allowance_changed");
    const m=native.manifest,continuity=resolveResponsesInputContinuity(m,native.continuity);
    const prefix=continuity.prefixGroups?continuity.next.policy==="connection_memory"?
      {kind:"connection_memory" as const,responseId:continuity.predecessor!}:
      {kind:"persistent" as const,responseId:continuity.predecessor!,coverageDigest:digest(m.groups.slice(0,continuity.prefixGroups).map(nativeInputGroupDigest))}:
      {kind:"none" as const};
    const localRendering=m.groups.every(g=>g.items.every(localItem));
    const activity=bindProtocolModelActivity({composition:input.activity.composition,
      scope:{...input.activity.scope,activityId:`${input.inputId}:native-count`,purpose:input.selection.purpose},conditions:input.activity.conditions});
    const binding={scope:{id:m.scope.id,runId:m.scope.runId,recipient:m.scope.recipientId,purpose:m.scope.purpose.id},
        selectionDigest:digest(m.groups.map(g=>({id:g.id,digest:nativeInputGroupDigest(g)}))),
        sourceDigest:digest({sources:m.groups.map(g=>g.sources),settings:m.settingSources}),targetDigest:digest(m.target),targetRevision:m.target.configuration,
        dependencyDigest:digest({prefix,continuity:continuity.next.generation,groups:m.groups.map(nativeInputGroupDigest)}),
        targetValidity:c.capacityDeclaration?.validUntil?{basis:`user_declared_target:${c.capacityDeclaration.basis}`,validUntil:c.capacityDeclaration.validUntil}:null,prefix,
        dependencies:localRendering?{kind:"immutable" as const,basis:"retained_native_text_and_call_items"}:{kind:"unknown" as const,reason:"native_external_rendering_dependencies_unestablished"}};
    const count=prepareResponsesInputTokenCount({prepared:{body:JSON.parse(native.wire.body),encoded:native.wire.body,digest:native.wire.digest},
      binding:{...binding,encodedInputId:legacy?input.inputId:responsesMeasurementInputIdentity({binding,generationDigest:native.wire.digest})}});
    const request:HelarcResponsesCountRequest={format:"helarc.responses-count-request.v1",activity,count,...(budget?{
      allowance:{pathId:stage!.path.intent.id,stageId:stage!.stage.request.id,sourcePathId:budget.pathId,maximumCalls:budget.maximumCalls}}:{})};
    return measureRequest(request,input.inputId,legacy,signal);
  }});
  return {...port(),interruptStructured:(source,signal)=>execution.interrupt(`${source.activityId}:input-count`,signal),measureStructured:async(request,source,signal)=>{
    if(!source.measurement||source.activityId!==request.activity.scope.activityId||digest(source.source)!==digest(request.source)||
      !request.activity.composition.composition.auxiliary.some(participant=>digest(participant)===digest(HELARC_RESPONSES_MEASUREMENT_PARTICIPANT)))
      throw new TypeError("responses_auxiliary_measurement_binding_missing");
    const a=source.measurement,body=JSON.parse(request.wire.body),inputId=`${source.activityId}:native-input:${request.wire.digest}`;
    if(!Array.isArray(body.input)||body.previous_response_id!==undefined||body.conversation!==undefined)
      throw new TypeError("responses_auxiliary_measurement_continuity_changed");
    const activity=bindProtocolModelActivity({composition:request.activity.composition,conditions:request.activity.conditions,
      scope:{...request.activity.scope,activityId:`${source.activityId}:input-count`,purpose:HELARC_RESPONSES_MEASUREMENT_PARTICIPANT.purpose}});
    const binding={scope:{id:`${source.runId}:auxiliary-input:${source.recipientId}:${request.activity.scope.purpose.id}`,
      runId:source.runId,recipient:source.recipientId,purpose:request.activity.scope.purpose.id},
      selectionDigest:digest({wire:request.wire.digest,schema:request.mappingRevision}),sourceDigest:digest(source.source),
      targetDigest:digest({model:c.model,configuration:`${c.id}:${c.revision}`,connection:c.connectionBindingId,disclosure:request.activity.conditions.authority.id}),
      targetRevision:`${c.id}:${c.revision}`,dependencyDigest:digest({source:source.source,wire:request.wire.digest}),
      targetValidity:c.capacityDeclaration?.validUntil?{basis:`user_declared_target:${c.capacityDeclaration.basis}`,validUntil:c.capacityDeclaration.validUntil}:null,
      prefix:{kind:"none" as const},dependencies:body.input.every(localItem)?{kind:"immutable" as const,basis:"retained_auxiliary_text_and_schema"}:
        {kind:"unknown" as const,reason:"native_external_rendering_dependencies_unestablished"}};
    const count=prepareResponsesInputTokenCount({prepared:{body,encoded:request.wire.body,digest:request.wire.digest},
      binding:{...binding,encodedInputId:responsesMeasurementInputIdentity({binding,generationDigest:request.wire.digest})}});
    return measureRequest({format:"helarc.responses-count-request.v1",activity,count,
      allowance:{kind:a.kind??"method_input",pathId:a.pathId,stageId:a.stageId,sourcePathId:a.pathId,maximumCalls:a.maximumCalls}},inputId,false,signal);
  }};
}

function localItem(item:Record<string,unknown>):boolean {
  if(item.type==="function_call")return typeof item.name==="string"&&typeof item.arguments==="string";
  if(item.type==="function_call_output")return typeof item.output==="string";
  if(item.type==="reasoning")return typeof item.encrypted_content==="string";
  if(item.type==="compaction")return typeof item.encrypted_content==="string";
  if(item.type!==undefined&&item.type!=="message")return false;
  if(typeof item.content==="string")return true;
  return Array.isArray(item.content)&&item.content.every(part=>part&&typeof part==="object"&&
    (part.type==="input_text"||part.type==="output_text")&&typeof part.text==="string");
}
