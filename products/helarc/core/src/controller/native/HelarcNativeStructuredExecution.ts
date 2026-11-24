import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {requireModelPurpose, snapshotModelPurposeEvidence, type ModelPurposeEvidence, type ProtocolRevisionRef} from "@agent-anything/model-interaction/protocol";
import {assertProtocolModelActivityOriginal, readProtocolContent, retainProtocolContent, ProtocolObservationUnavailable,
  type ProtocolObservationLimitation, type ProtocolEvidenceRevision,
  type ProtocolModelActivity, type ProtocolExecutionJournal, type ProtocolExecutionState,
  type ProtocolJournalRecord, type ProtocolPurposeAcceptance, type ProtocolContentWork} from "@agent-anything/agent-runtime/model-access";
import {ActivityCheckpointError,type SharedAcceptancePort} from "@agent-anything/agent-runtime/activity";
import type {InvocationInterruptionContext} from "@agent-anything/agent-core/control";
import {compileNativeSchema, prepareResponses, prepareDeepSeekChat, prepareOllamaChat,
  OPENAI_RESPONSES_ADAPTER, DEEPSEEK_CHAT_ADAPTER, OLLAMA_CHAT_ADAPTER,
  type NativeSchemaCodec, type NativeSchemaSpec} from "@agent-anything/provider-integrations/native";
import {assessHelarcResponsesStructured, assessHelarcDeepSeekStructured, assessHelarcOllamaStructured,
  type HelarcNativeStructuredAssessment} from "./HelarcNativeStructuredOutput.js";
import {assertHelarcNativeStructuredInput,HelarcNativeStructuredInputUnavailable,
  type HelarcNativeStructuredInputPreparation} from "./HelarcNativeStructuredInput.js";

export const HELARC_NATIVE_STRUCTURED_INTERPRETER = {id:"helarc.native-structured-result", revision:"1"} as const;
export interface HelarcNativeStructuredRequest {
  readonly format:"helarc.native-structured-request.v1";
  readonly source:ProtocolRevisionRef;
  readonly activity:ProtocolModelActivity;
  readonly operationId:string;
  readonly observation:ProtocolRevisionRef;
  readonly schema:NativeSchemaSpec;
  readonly mappingRevision:string;
  readonly wire:{readonly body:string;readonly digest:string};
  readonly inputPreparation?:HelarcNativeStructuredInputPreparation;
  readonly methodCapacity?:{readonly fixed:import("@agent-anything/model-interaction/input").InputCapacityAssessment;
    readonly full:import("@agent-anything/model-interaction/input").InputCapacityAssessment};
}
export interface HelarcNativeStructuredResult {
  readonly format:"helarc.native-structured-result.v1";
  readonly source:ProtocolRevisionRef;
  readonly requestDigest:string;
  readonly evidence:ModelPurposeEvidence;
  readonly assessment:HelarcNativeStructuredAssessment;
  readonly interpretedAt:string;
}
interface PreparationSource {
  readonly source:ProtocolRevisionRef;
  readonly activity:ProtocolModelActivity;
}
function prepared(source:PreparationSource, value:{encoded:string;digest:string;format:NativeSchemaCodec|null}):HelarcNativeStructuredRequest {
  if (!value.format) throw new TypeError("native_structured_body_contract_required");
  const id=source.activity.scope.activityId;
  const result:HelarcNativeStructuredRequest={format:"helarc.native-structured-request.v1",...source,
    operationId:source.activity.composition.composition.protocol.id==="openai.responses"?`${id}:responses:operation:1`:`${id}:create`,observation:{id:`${id}:response`,revision:"1"},schema:value.format.spec,
    mappingRevision:digest(value.format.binding),wire:{body:value.encoded,digest:value.digest}};
  validateHelarcNativeStructuredRequest(result);
  return Object.freeze(result);
}
export function prepareHelarcResponsesStructured(source:PreparationSource, input:Omit<Parameters<typeof prepareResponses>[0],"model"|"purpose"|"tools"> & {readonly textSchema:Record<string,unknown>}):HelarcNativeStructuredRequest {
  return prepared(source,prepareResponses({...input,model:source.activity.composition.composition.configuration.model,purpose:source.activity.scope.purpose}));
}
export function prepareHelarcDeepSeekStructured(source:PreparationSource, input:Omit<Parameters<typeof prepareDeepSeekChat>[0],"model"|"purpose"|"tools"> & {readonly jsonSchema:Record<string,unknown>}):HelarcNativeStructuredRequest {
  return prepared(source,prepareDeepSeekChat({...input,model:source.activity.composition.composition.configuration.model,purpose:source.activity.scope.purpose}));
}
export function prepareHelarcOllamaStructured(source:PreparationSource, input:Omit<Parameters<typeof prepareOllamaChat>[0],"model"|"purpose"|"tools"> & {readonly format:Record<string,unknown>}):HelarcNativeStructuredRequest {
  return prepared(source,prepareOllamaChat({...input,model:source.activity.composition.composition.configuration.model,purpose:source.activity.scope.purpose}));
}

/** Validate the frozen body contract against the actual native request, not today's Settings. */
export function validateHelarcNativeStructuredRequest(request:HelarcNativeStructuredRequest):NativeSchemaCodec {
  const {activity}=request,composition=activity.composition.composition;
  assertProtocolModelActivityOriginal(activity,activity);
  const purpose=requireModelPurpose(activity.composition,activity.scope.purpose),codec=compileNativeSchema(request.schema);
  const body=JSON.parse(request.wire.body);
  if(request.format!=="helarc.native-structured-request.v1"||!request.source.id||!request.source.revision||
    request.operationId!==(composition.protocol.id==="openai.responses"?`${activity.scope.activityId}:responses:operation:1`:`${activity.scope.activityId}:create`)||request.observation.id!==`${activity.scope.activityId}:response`||request.observation.revision!=="1"||
    digest(purpose.interpreter.implementation)!==digest(HELARC_NATIVE_STRUCTURED_INTERPRETER)||
    digest(composition.task.purpose)===digest(activity.scope.purpose)||
    digest(codec.binding.protocol)!==digest(composition.protocol)||digest(codec.binding.purpose)!==digest(activity.scope.purpose)||
    digest(codec.binding)!==request.mappingRevision||body.model!==composition.configuration.model||
    digest(body)!==request.wire.digest||body.tools!==undefined)throw new TypeError("native_structured_original_binding_invalid");
  switch(composition.protocol.id){
    case "openai.responses":
      if(digest(composition.adapter.implementation)!==digest(OPENAI_RESPONSES_ADAPTER)||request.schema.mode!=="responses-strict"||request.schema.root!=="body"||
        body.text?.format?.type!=="json_schema"||body.text.format.strict!==true||digest(body.text.format.schema)!==digest(codec.wire))
        throw new TypeError("native_structured_responses_mapping_changed");
      break;
    case "deepseek.chat-completions":
      if(digest(composition.adapter.implementation)!==digest(DEEPSEEK_CHAT_ADAPTER)||request.schema.mode!=="identity"||request.schema.root!=="object-body"||
        body.response_format?.type!=="json_object"||!Array.isArray(body.messages)||!body.messages.some((m:{content?:unknown})=>typeof m.content==="string"&&/json/i.test(m.content)))
        throw new TypeError("native_structured_deepseek_mapping_changed");
      break;
    case "ollama.chat":
      if(digest(composition.adapter.implementation)!==digest(OLLAMA_CHAT_ADAPTER)||request.schema.mode!=="identity"||request.schema.root!=="body"||digest(body.format)!==digest(codec.wire))
        throw new TypeError("native_structured_ollama_mapping_changed");
      break;
    default:throw new TypeError("native_structured_protocol_unavailable");
  }
  if(request.inputPreparation)assertHelarcNativeStructuredInput(request);
  return codec;
}

export interface HelarcNativeStructuredExecutionPorts {
  readonly journal:ProtocolExecutionJournal;
  readonly acceptance:SharedAcceptancePort;
  readonly generation:number;
  readonly now:()=>string;
  /** Revalidate original configuration, current authority, purpose scope and material access. */
  readonly authorize:(request:HelarcNativeStructuredRequest,context:InvocationInterruptionContext)=>Promise<void>;
  /** Native transport owns dispatch, cancellation and uncertain outcomes. It must not blindly re-create. */
  readonly observe:(state:ProtocolExecutionState,request:HelarcNativeStructuredRequest,context:InvocationInterruptionContext)=>Promise<ProtocolJournalRecord>;
  /** Inspect the original owner's existing disposition without dispatching or creating a session. */
  readonly unavailable?:(state:ProtocolExecutionState,request:HelarcNativeStructuredRequest)=>Promise<ProtocolObservationLimitation|null>;
  readonly interrupt:(state:ProtocolExecutionState,request:HelarcNativeStructuredRequest,context:InvocationInterruptionContext)=>Promise<unknown>;
  readonly contentWork?:(work:ProtocolContentWork)=>void;
}
/** Durable body-contract interpretation, not task policy or a universal model lifecycle. */
export class HelarcNativeStructuredExecution {
  constructor(private readonly ports:HelarcNativeStructuredExecutionPorts){}
  async execute(request:HelarcNativeStructuredRequest,context:InvocationInterruptionContext):Promise<HelarcNativeStructuredResult> {
    try{return await this.executeOriginal(request,context);}
    catch(error){
      if(context.signal.aborted&&context.interruption!==null){
        try{await this.interrupt(request.activity.scope.activityId,request.source,{...context,signal:new AbortController().signal});}
        catch(cause){throw new ActivityCheckpointError(`${request.activity.scope.activityId}:native-interruption`,{cause});}
      }
      throw error;
    }
  }
  private async executeOriginal(request:HelarcNativeStructuredRequest,context:InvocationInterruptionContext,known?:ProtocolObservationLimitation):Promise<HelarcNativeStructuredResult> {
    const p=this.ports,activityId=request.activity.scope.activityId,runId=request.activity.scope.runId;
    const codec=validateHelarcNativeStructuredRequest(request),requestDigest=digest(request);
    if(["2","3","4"].includes(requireModelPurpose(request.activity.composition,request.activity.scope.purpose).input.implementation.revision))
      assertHelarcNativeStructuredInput(request);
    let state=await p.journal.command({kind:"state",activityId}) as ProtocolExecutionState|null;
    await p.authorize(request,context);
    if(!state){
      context.signal.throwIfAborted();
      const input=await retainProtocolContent(p.journal,`${activityId}:prepared:${requestDigest}`,activityId,Buffer.from(JSON.stringify(request)),p.contentWork);
      const accepted=await p.acceptance.accept({id:`${activityId}:prepare`,scope:runId,actor:"execution-coordinator",
        parts:[{owner:"protocol_execution",kind:"prepare",proposal:{activity:request.activity,input}}]});
      if(accepted.outcome!=="accepted")throw new TypeError(`native_structured_prepare_rejected:${accepted.rejection?.code}`);
      state=await p.journal.command({kind:"state",activityId}) as ProtocolExecutionState;
    }
    assertProtocolModelActivityOriginal(state.activity,request.activity);
    const original=JSON.parse((await readProtocolContent(p.journal,state.input,activityId,32*1024*1024,p.contentWork)).toString()) as HelarcNativeStructuredRequest;
    if(digest(original)!==requestDigest)throw new TypeError("native_structured_original_request_changed");
    const saved=await p.journal.command({kind:"acceptance",activityId}) as ProtocolPurposeAcceptance|null;
    if(saved){
      const result=JSON.parse((await readProtocolContent(p.journal,saved.result,activityId,32*1024*1024,p.contentWork)).toString()) as HelarcNativeStructuredResult;
      if(result.format!=="helarc.native-structured-result.v1"||result.requestDigest!==requestDigest||
        digest(result.source)!==digest(original.source)||digest(result.evidence)!==digest(saved.evidence)||
        digest(result.assessment.mapping)!==digest(codec.binding)||!Number.isFinite(Date.parse(result.interpretedAt))||saved.effects.length||saved.deliveries.length)
        throw new TypeError("native_structured_accepted_result_changed");
      if(result.assessment.outcome==="unavailable"){
        const verified=await this.unavailableAssessment(state,original,codec,result.assessment.limitation);
        if(digest(verified)!==digest(result.assessment))throw new TypeError("native_structured_accepted_limitation_changed");
      }
      return result;
    }
    if(original.inputPreparation&&!original.inputPreparation.assessment.allowed){
      if(!state.cancelled){
        const closed=await p.acceptance.accept({id:`${activityId}:input-denied:${original.inputPreparation.id}`,scope:runId,actor:"execution-coordinator",
          parts:[{owner:"protocol_execution",kind:"control",proposal:{activityId,expectedRevision:state.fence.controlRevision,cancelled:true}}]});
        if(closed.outcome!=="accepted")throw new TypeError(`native_structured_input_disposition_rejected:${closed.rejection?.code}`);
      }
      throw new HelarcNativeStructuredInputUnavailable(original.inputPreparation,original.methodCapacity?.fixed.decisions.some(d=>d.conclusion==="violated")?"fixed_background":"complete_input");
    }
    if(state.cancelled)throw new TypeError("native_structured_original_cancelled");
    context.signal.throwIfAborted();
    if(state.fence.generation!==p.generation||state.fence.epoch===0){
      const accepted=await p.acceptance.accept({id:`${activityId}:claim:${p.generation}:${state.fence.epoch}`,scope:runId,
        actor:state.activity.composition.composition.adapter.implementation.id,parts:[{owner:"protocol_execution",kind:"claim",proposal:{activityId,expectedEpoch:state.fence.epoch}}]});
      if(accepted.outcome!=="accepted")throw new TypeError(`native_structured_claim_rejected:${accepted.rejection?.code}`);
      state=await p.journal.command({kind:"state",activityId}) as ProtocolExecutionState;
    }
    let assessment:HelarcNativeStructuredAssessment;
    try{
      if(known)throw new ProtocolObservationUnavailable(known);
      const record=await p.observe(state,original,context);
      assessment=await this.assessRecord(state,original,record,codec);
    }catch(error){
      if(!(error instanceof ProtocolObservationUnavailable))throw error;
      assessment=await this.unavailableAssessment(state,original,codec,error.limitation);
    }
    return this.acceptAssessment(state,original,assessment,requestDigest);
  }
  private async unavailableAssessment(state:ProtocolExecutionState,original:HelarcNativeStructuredRequest,codec:NativeSchemaCodec,limitation?:ProtocolObservationLimitation):Promise<HelarcNativeStructuredAssessment>{
    const activityId=state.activity.scope.activityId,b=limitation?.basis,p=this.ports;
    if(!b||!limitation.reason||limitation.activityId!==activityId)throw new TypeError("native_structured_limitation_scope_changed");
    const saved=await p.journal.command({kind:"evidence",activityId,scopeId:b.scopeId,evidenceKind:b.kind,key:b.key,revision:b.revision}) as ProtocolEvidenceRevision|null;
    if(!saved||saved.activityId!==activityId||saved.owner!==state.activity.composition.composition.adapter.implementation.id||
      saved.content.digest!==b.digest||!saved.references.some(r=>digest(r)===digest(state.input)))
      throw new TypeError("native_structured_limitation_basis_missing");
    const ref=saved.dependencies.find(d=>d.activityId===activityId)?.ref??{id:original.operationId+":intent",revision:"1"};
    const record=await p.journal.command({kind:"record",activityId,ref}) as ProtocolJournalRecord|null;
    if(!record?.source||digest(record.source.scope)!==digest(state.activity.scope)||digest(record.source.protocol)!==digest(codec.binding.protocol)||
      digest(record.source.interpretation)!==digest(state.activity.composition.composition.adapter.implementation))
      throw new TypeError("native_structured_limitation_anchor_missing");
    return {outcome:"unavailable",source:record.source,mapping:codec.binding,value:null,limitation,failure:{code:limitation.kind,details:{reason:limitation.reason}}};
  }
  private async assessRecord(state:ProtocolExecutionState,original:HelarcNativeStructuredRequest,record:ProtocolJournalRecord,codec:NativeSchemaCodec){
    const p=this.ports,activityId=state.activity.scope.activityId;
    const retained=await p.journal.command({kind:"record",activityId,ref:original.observation}) as ProtocolJournalRecord|null;
    if(!retained?.source||digest(retained)!==digest(record)||record.kind!=="observation"||record.operationId!==original.operationId||
      digest(record.source!.scope)!==digest(state.activity.scope)||digest(record.source!.protocol)!==digest(codec.binding.protocol)||
      digest(record.source!.interpretation)!==digest(state.activity.composition.composition.adapter.implementation))
      throw new TypeError("native_structured_observation_not_retained");
    const response=JSON.parse((await readProtocolContent(p.journal,record.content,activityId,32*1024*1024,p.contentWork)).toString());
    const assess=codec.binding.protocol.id==="openai.responses"?assessHelarcResponsesStructured:
      codec.binding.protocol.id==="deepseek.chat-completions"?assessHelarcDeepSeekStructured:assessHelarcOllamaStructured;
    return assess(response,codec,retained.source);
  }
  private async acceptAssessment(state:ProtocolExecutionState,original:HelarcNativeStructuredRequest,assessment:HelarcNativeStructuredAssessment,requestDigest:string){
    const p=this.ports,{activityId,runId}=state.activity.scope;
    const evidence=snapshotModelPurposeEvidence({scope:state.activity.scope,interpreter:HELARC_NATIVE_STRUCTURED_INTERPRETER,
      sources:[assessment.source],acceptance:{id:`${activityId}:accepted`,revision:"1"}});
    const interpretedAt=p.now();
    if(!Number.isFinite(Date.parse(interpretedAt)))throw new TypeError("native_structured_interpretation_time_invalid");
    const result:HelarcNativeStructuredResult={format:"helarc.native-structured-result.v1",source:original.source,requestDigest,evidence,assessment,interpretedAt};
    const content=await retainProtocolContent(p.journal,`${activityId}:result:${digest(result)}`,activityId,Buffer.from(JSON.stringify(result)),p.contentWork);
    const receipt=await p.acceptance.accept({id:`${activityId}:purpose:${state.fence.generation}:${state.fence.epoch}`,scope:runId,actor:evidence.interpreter.id,
      parts:[{owner:"protocol_execution",kind:"purpose",proposal:{fence:state.fence,acceptance:{evidence,result:content,effects:[],deliveries:[]}}}]});
    if(receipt.outcome!=="accepted")throw new TypeError(`native_structured_purpose_rejected:${receipt.rejection?.code}`);
    return Object.freeze(result);
  }
  async interrupt(activityId:string,source:ProtocolRevisionRef,context:InvocationInterruptionContext):Promise<unknown>{
    const p=this.ports;
    let state=await p.journal.command({kind:"state",activityId}) as ProtocolExecutionState|null;
    if(!state)return {kind:"not_prepared",activityId,source};
    const request=JSON.parse((await readProtocolContent(p.journal,state.input,activityId,32*1024*1024,p.contentWork)).toString()) as HelarcNativeStructuredRequest;
    const codec=validateHelarcNativeStructuredRequest(request);
    assertProtocolModelActivityOriginal(state.activity,request.activity);
    if(digest(request.source)!==digest(source))throw new TypeError("native_structured_interruption_source_changed");
    await p.authorize(request,context);
    if(state.accepted){
      const result=await this.executeOriginal(request,context);
      return {kind:"already_accepted",acceptance:result.evidence.acceptance,limitation:result.assessment.limitation??null};
    }
    const limitation=await p.unavailable?.(state,request);
    if(limitation){
      // Local interruption cannot turn an irretrievable observation into a remote cancellation.
      if(state.cancelled){
        await this.unavailableAssessment(state,request,codec,limitation);
        return {kind:"original_observation_unavailable",limitation};
      }
      const result=await this.executeOriginal(request,context,limitation);
      return {kind:"original_observation_unavailable",acceptance:result.evidence.acceptance,limitation};
    }
    const runId=state.activity.scope.runId;
    if(state.fence.generation!==p.generation||state.fence.epoch===0){
      const receipt=await p.acceptance.accept({id:`${activityId}:claim:${p.generation}:${state.fence.epoch}`,scope:runId,
        actor:state.activity.composition.composition.adapter.implementation.id,
        parts:[{owner:"protocol_execution",kind:"claim",proposal:{activityId,expectedEpoch:state.fence.epoch}}]});
      if(receipt.outcome!=="accepted")throw new TypeError(`native_structured_claim_rejected:${receipt.rejection?.code}`);
      state=await p.journal.command({kind:"state",activityId}) as ProtocolExecutionState;
    }
    if(!state.cancelled){
      const receipt=await p.acceptance.accept({id:`${activityId}:cancel:${state.fence.controlRevision}`,scope:runId,actor:"execution-coordinator",
        parts:[{owner:"protocol_execution",kind:"control",proposal:{activityId,expectedRevision:state.fence.controlRevision,cancelled:true}}]});
      if(receipt.outcome!=="accepted")throw new TypeError(`native_structured_cancel_rejected:${receipt.rejection?.code}`);
      state=await p.journal.command({kind:"state",activityId}) as ProtocolExecutionState;
    }
    return {kind:"native_interruption",activityId,source,followUp:await p.interrupt(state,request,context)};
  }
  /** Source owners recover the exact original preparation, not a newly assembled equivalent. */
  async recover(activityId:string,context:InvocationInterruptionContext):Promise<HelarcNativeStructuredResult|null> {
    const state=await this.ports.journal.command({kind:"state",activityId}) as ProtocolExecutionState|null;
    if(!state)return null;
    const request=JSON.parse((await readProtocolContent(this.ports.journal,state.input,activityId,32*1024*1024,this.ports.contentWork)).toString()) as HelarcNativeStructuredRequest;
    return this.execute(request,context);
  }
}
