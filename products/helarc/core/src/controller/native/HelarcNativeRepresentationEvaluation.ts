import {modelInputValueDigest as digest,assessInputCapacity} from "@agent-anything/model-interaction/input";
import {createRepresentationMethodContent,parseRepresentationMethodValue,RepresentationMethodResultError,
  type RepresentationMethodContentScope,type MethodEvidence,type MethodJob,type GeneratedRepresentation,type AssessedRepresentation} from "@agent-anything/agent-runtime/context-representation";
import type {ProtocolModelActivity} from "@agent-anything/agent-runtime/model-access";
import type {ModelPurposeEvidence} from "@agent-anything/model-interaction/protocol";
import type {InvocationInterruptionContext} from "@agent-anything/agent-core/control";
import {HelarcNativeStructuredExecution,prepareHelarcResponsesStructured,prepareHelarcDeepSeekStructured,prepareHelarcOllamaStructured,
  type HelarcNativeStructuredRequest} from "./HelarcNativeStructuredExecution.js";
import {isHelarcStructuredContractCorrection} from "./HelarcNativeStructuredOutput.js";
import {HelarcNativeStructuredInputUnavailable} from "./HelarcNativeStructuredInput.js";

export interface HelarcNativeRepresentationSource {
  readonly source:{readonly id:string;readonly revision:string};
  readonly activityId:string;
  readonly runId:string;
  readonly recipientId:string;
  readonly scope:RepresentationMethodContentScope;
  readonly job:MethodJob;
  readonly evidence:readonly MethodEvidence[];
  readonly inputCapacity?:{readonly targetRevision:string;readonly capacity:import("@agent-anything/agent-runtime/context-representation").RepresentationMethodRequest["capacity"]};
  readonly measurement?:{readonly pathId:string;readonly stageId:string;readonly maximumCalls:number};
}
export function createHelarcNativeRepresentationSource(input:Omit<HelarcNativeRepresentationSource,"source"|"activityId">):HelarcNativeRepresentationSource {
  if(!input.runId||!input.recipientId||!input.job.id||!input.scope.sourceBoundary)throw new TypeError("native_representation_source_invalid");
  const aliases=new Set(input.evidence.map(e=>e.alias));
  if(aliases.size!==input.evidence.length||[...input.job.sources,...input.job.candidates].some(alias=>!aliases.has(alias)))
    throw new TypeError("native_representation_evidence_missing");
  for(const item of input.evidence){
    if(!input.scope.sources.some(s=>s.alias===item.alias)&&!input.job.candidates.includes(item.alias))throw new TypeError("native_representation_evidence_outside_scope");
  }
  const basis={runId:input.runId,recipientId:input.recipientId,scope:input.scope,job:input.job,evidence:input.evidence,
    ...(input.inputCapacity?{inputCapacity:input.inputCapacity}:{}),...(input.measurement?{measurement:input.measurement}:{})};
  return structuredClone({...basis,activityId:`${input.job.id}:native-method`,source:{id:`${input.job.id}:method-source`,revision:digest(basis)}});
}
function content(source:HelarcNativeRepresentationSource,activity:ProtocolModelActivity){
  const original=createHelarcNativeRepresentationSource(source);
  // Source revision covers the supplied scope and bytes, not a previous request's derived state.
  if(digest(source)!==digest(original)||original.activityId!==activity.scope.activityId||source.runId!==activity.scope.runId||source.recipientId!==activity.scope.recipientId)
    throw new TypeError("native_representation_source_binding_changed");
  const result=createRepresentationMethodContent(source.scope,source.job,source.evidence);
  const text=(section:typeof result.sections[number])=>{if(section.content.kind!=="text")throw new TypeError("native_representation_text_required");return section.content.text;};
  return {instructions:result.sections.filter(s=>s.role==="instruction").map(text).join("\n"),
    data:result.sections.filter(s=>s.role!=="instruction").map(s=>({role:"user" as const,content:text(s)})),
    fixedData:result.sections.filter(s=>s.role!=="instruction"&&!s.id.includes(":evidence:")).map(s=>({role:"user" as const,content:text(s)})),schema:result.format.schema};
}
export function prepareHelarcResponsesRepresentation(source:HelarcNativeRepresentationSource,activity:ProtocolModelActivity,
  options:Pick<Parameters<typeof prepareHelarcResponsesStructured>[1],"stream"|"store"|"reasoning">){
  const c=content(source,activity);
  return prepareHelarcResponsesStructured({source:source.source,activity},{...options,instructions:c.instructions,input:c.data,textSchema:c.schema});
}
export function prepareHelarcDeepSeekRepresentation(source:HelarcNativeRepresentationSource,activity:ProtocolModelActivity,
  options:Pick<Parameters<typeof prepareHelarcDeepSeekStructured>[1],"stream"|"thinking">){
  const c=content(source,activity);
  return prepareHelarcDeepSeekStructured({source:source.source,activity},{...options,messages:[{role:"system",content:`${c.instructions}\nReturn JSON matching the supplied output contract.`},...c.data],jsonSchema:c.schema});
}
export function prepareHelarcOllamaRepresentation(source:HelarcNativeRepresentationSource,activity:ProtocolModelActivity,
  options:Pick<Parameters<typeof prepareHelarcOllamaStructured>[1],"stream"|"think"|"options">){
  const c=content(source,activity);
  return prepareHelarcOllamaStructured({source:source.source,activity},{...options,messages:[{role:"system",content:c.instructions},...c.data],format:c.schema});
}
export type HelarcNativeRepresentationResult=({readonly evidence:ModelPurposeEvidence}&(
  |{readonly kind:"contract_result";readonly value:GeneratedRepresentation|AssessedRepresentation;readonly contractValue:unknown}
  |{readonly kind:"unavailable";readonly code:string;readonly details:unknown}
))|{readonly kind:"input_unavailable";readonly source:HelarcNativeRepresentationSource["source"];readonly code:string;readonly details:unknown};
/** The professional owner schedules/checks/repairs. This consumer only evaluates one original method job. */
export class HelarcNativeRepresentationEvaluation {
  constructor(private readonly ports:{readonly execution:HelarcNativeStructuredExecution;
    readonly interruptInput?:(source:HelarcNativeRepresentationSource,context:InvocationInterruptionContext)=>Promise<void>;
    readonly prepare:(source:HelarcNativeRepresentationSource,context:InvocationInterruptionContext)=>Promise<HelarcNativeStructuredRequest>}){}
  async evaluate(source:HelarcNativeRepresentationSource,context:InvocationInterruptionContext):Promise<HelarcNativeRepresentationResult>{
    return (await this.resolve(source,context,false))!;
  }
  recover(source:HelarcNativeRepresentationSource,context:InvocationInterruptionContext):Promise<HelarcNativeRepresentationResult|null>{
    return this.resolve(source,context,true);
  }
  async interrupt(source:HelarcNativeRepresentationSource,context:InvocationInterruptionContext){
    if(digest(createHelarcNativeRepresentationSource(source))!==digest(source))throw new TypeError("native_representation_source_changed");
    await this.ports.interruptInput?.(source,context);
    return this.ports.execution.interrupt(source.activityId,source.source,context);
  }
  private async resolve(source:HelarcNativeRepresentationSource,context:InvocationInterruptionContext,recoveryOnly:boolean):Promise<HelarcNativeRepresentationResult|null>{
    try{return await this.resolveOriginal(source,context,recoveryOnly);}
    catch(error){
      if(!(error instanceof HelarcNativeStructuredInputUnavailable))throw error;
      if(digest(error.preparation.source)!==digest(source.source)||error.preparation.scope.activityId!==source.activityId)
        throw new TypeError("native_representation_input_preparation_changed");
      return {kind:"input_unavailable",source:source.source,code:error.reason==="fixed_background"?"representation_fixed_background_unavailable":"representation_input_unavailable",
        details:{preparation:error.preparation}};
    }
  }
  private async resolveOriginal(source:HelarcNativeRepresentationSource,context:InvocationInterruptionContext,recoveryOnly:boolean):Promise<HelarcNativeRepresentationResult|null>{
    const {source:identity,activityId,...basis}=source;
    if(digest(basis)!==identity.revision||identity.id!==`${source.job.id}:method-source`||activityId!==`${source.job.id}:native-method`)throw new TypeError("native_representation_source_changed");
    let result=await this.ports.execution.recover(activityId,context);
    if(!result&&recoveryOnly)return null;
    if(!result){
      const request=await this.ports.prepare(source,context),expected=content(source,request.activity);
      if(request.activity.scope.activityId!==activityId||request.activity.scope.runId!==source.runId||request.activity.scope.recipientId!==source.recipientId||
        digest(request.source)!==digest(identity)||digest(request.schema.canonical)!==digest(expected.schema))throw new TypeError("native_representation_request_changed");
      const body=JSON.parse(request.wire.body),protocol=request.activity.composition.composition.protocol.id;
      const instructions=protocol==="deepseek.chat-completions"?`${expected.instructions}\nReturn JSON matching the supplied output contract.`:expected.instructions;
      if(protocol==="openai.responses"?body.instructions!==instructions||digest(body.input)!==digest(expected.data):
        digest(body.messages)!==digest([{role:"system",content:instructions},...expected.data]))throw new TypeError("native_representation_evidence_changed");
      const assessment=(wire:Record<string,unknown>)=>{
        const c=source.inputCapacity!,id=digest(wire);
        return assessInputCapacity({encodedInputId:id,targetRevision:c.targetRevision,purpose:request.activity.scope.purpose.id,...c.capacity,
          evidence:[{id:`${id}:bytes`,encodedInputId:id,targetRevision:c.targetRevision,methodRevision:"native-body-bytes:1",dimension:"request_bytes",
            coverage:"complete",quantity:{kind:"exact",value:Buffer.byteLength(JSON.stringify(wire))},basis:"Complete native encoded body",uncovered:[]}]});
      };
      if(source.inputCapacity){
        const fixed=assessment(protocol==="openai.responses"?{...body,input:expected.fixedData}:{...body,messages:[{role:"system",content:instructions},...expected.fixedData]}),full=assessment(body);
        if((!fixed.allowed||!full.allowed)&&!request.inputPreparation)return {kind:"input_unavailable",source:identity,code:fixed.allowed?"representation_input_unavailable":"representation_fixed_background_unavailable",details:{fixed,full}};
        result=await this.ports.execution.execute({...request,methodCapacity:{fixed,full}},context);
      }else result=await this.ports.execution.execute(request,context);
    }
    if(digest(result.source)!==digest(identity)||result.evidence.scope.activityId!==activityId||result.evidence.scope.runId!==source.runId||
      result.evidence.scope.recipientId!==source.recipientId)throw new TypeError("native_representation_result_changed");
    if(result.assessment.failure?.code==="native_input_capacity_refused")return {kind:"input_unavailable",source:identity,
      code:"provider_context_window_exceeded",details:{kind:"native_method_input_rejection",source:identity,jobId:source.job.id,
        requestDigest:result.requestDigest,evidence:result.evidence,assessment:result.assessment}};
    if(result.assessment.outcome!=="valid")return {kind:"unavailable",evidence:result.evidence,
      code:isHelarcStructuredContractCorrection(result.assessment)?"representation_output_contract_invalid":result.assessment.failure?.code??result.assessment.outcome,
      details:{nativeFailure:result.assessment.failure,outcome:result.assessment.outcome}};
    try{return {kind:"contract_result",evidence:result.evidence,contractValue:result.assessment.value,value:parseRepresentationMethodValue(result.assessment.value,source.scope,source.job)};}
    catch(error){if(!(error instanceof RepresentationMethodResultError))throw error;return {kind:"unavailable",evidence:result.evidence,code:error.code,details:error.details};}
  }
}
