import {snapshotNativeModelSource,type NativeModelSourceRef,type ModelSchemaMappingBinding} from "@agent-anything/model-interaction/protocol";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {readResponsesStructured,readDeepSeekStructured,readOllamaStructured,responsesInputCapacityRefused,deepSeekInputCapacityRefused,
  ollamaInputCapacityRefused,NativeProtocolError,type NativeSchemaCodec} from "@agent-anything/provider-integrations/native";

export interface HelarcNativeStructuredAssessment {
  readonly source:NativeModelSourceRef;
  readonly mapping:ModelSchemaMappingBinding;
  readonly outcome:"valid"|"invalid"|"refused"|"unavailable";
  readonly limitation?:import("@agent-anything/agent-runtime/model-access").ProtocolObservationLimitation;
  readonly value:unknown;
  readonly failure:null|{readonly code:string;readonly details:Readonly<Record<string,unknown>>};
}
function assess(source:NativeModelSourceRef,codec:NativeSchemaCodec,read:()=>unknown):HelarcNativeStructuredAssessment{
  const original=snapshotNativeModelSource(source);
  if(modelInputValueDigest(original.protocol)!==modelInputValueDigest(codec.binding.protocol)||
    modelInputValueDigest(original.scope.purpose)!==modelInputValueDigest(codec.binding.purpose))throw new NativeProtocolError("helarc_structured_purpose_mismatch");
  try{return Object.freeze({source:original,mapping:codec.binding,outcome:"valid",value:read(),failure:null});}
  catch(error){
    if(!(error instanceof NativeProtocolError)||error.code.includes("configuration")||error.code.includes("structure_unsupported"))throw error;
    return Object.freeze({source:original,mapping:codec.binding,outcome:error.code.endsWith("_refused")?"refused":"invalid",value:null,failure:{code:error.code,details:error.details}});
  }
}
export function assessHelarcResponsesStructured(response:Record<string,unknown>,codec:NativeSchemaCodec,source:NativeModelSourceRef){
  if(source.protocol.id!=="openai.responses")throw new NativeProtocolError("helarc_structured_protocol_mismatch");
  return assess(source,codec,()=>{
    if(responsesInputCapacityRefused(response))throw new NativeProtocolError("native_input_capacity_refused",{protocol:source.protocol.id});
    return readResponsesStructured(response,codec);
  });
}
export function assessHelarcDeepSeekStructured(response:Record<string,unknown>,codec:NativeSchemaCodec,source:NativeModelSourceRef){
  if(source.protocol.id!=="deepseek.chat-completions")throw new NativeProtocolError("helarc_structured_protocol_mismatch");
  return assess(source,codec,()=>{
    if(deepSeekInputCapacityRefused(response))throw new NativeProtocolError("native_input_capacity_refused",{protocol:source.protocol.id});
    return readDeepSeekStructured(response,codec);
  });
}
export function assessHelarcOllamaStructured(response:Record<string,unknown>,codec:NativeSchemaCodec,source:NativeModelSourceRef){
  if(source.protocol.id!=="ollama.chat")throw new NativeProtocolError("helarc_structured_protocol_mismatch");
  return assess(source,codec,()=>{
    if(ollamaInputCapacityRefused(response))throw new NativeProtocolError("native_input_capacity_refused",{protocol:source.protocol.id});
    return readOllamaStructured(response,codec);
  });
}
export interface HelarcStructuredCorrectionLedger {
  readonly runId:string;
  readonly recipientId:string;
  readonly purpose:NativeModelSourceRef["scope"]["purpose"];
  readonly maximumCorrections:number;
  readonly observations:readonly {readonly source:string;readonly assessment:string;readonly correction:boolean}[];
}
export function isHelarcStructuredContractCorrection(assessment:HelarcNativeStructuredAssessment):boolean {
  return assessment.outcome==="invalid"&&assessment.failure!==null&&
    ["native_arguments_invalid","native_arguments_variant_ambiguous","native_json_invalid","native_json_limit"].includes(assessment.failure.code);
}
/** The auxiliary owner supplies and persists this finite budget. Adapters never decide to call a model again. */
export function planHelarcStructuredCorrection(ledger:HelarcStructuredCorrectionLedger,assessment:HelarcNativeStructuredAssessment){
  const scope=assessment.source.scope;
  if(ledger.runId!==scope.runId||ledger.recipientId!==scope.recipientId||modelInputValueDigest(ledger.purpose)!==modelInputValueDigest(scope.purpose)||
    !Number.isSafeInteger(ledger.maximumCorrections)||ledger.maximumCorrections<0||ledger.observations.length>ledger.maximumCorrections+1)
    throw new NativeProtocolError("helarc_structured_correction_scope_invalid");
  const source=modelInputValueDigest({scope:assessment.source.scope,origin:assessment.source.nativeIdentity??{operationId:assessment.source.operationId}});
  const digest=modelInputValueDigest({mapping:assessment.mapping,outcome:assessment.outcome,value:assessment.value,failure:assessment.failure});
  const old=ledger.observations.find(o=>o.source===source);
  if(old&&old.assessment!==digest)throw new NativeProtocolError("helarc_structured_correction_conflict");
  const correctable=isHelarcStructuredContractCorrection(assessment);
  const correction=old?.correction??(correctable&&ledger.observations.filter(o=>o.correction).length<ledger.maximumCorrections);
  const next=old?ledger:Object.freeze({...ledger,observations:Object.freeze([...ledger.observations,{source,assessment:digest,correction}])});
  return Object.freeze({ledger:next,correction,
    feedback:correction?`Host structured-result validation for ${assessment.source.record.id}: ${assessment.failure!.code}. Correct the result using the already supplied wire schema. ${JSON.stringify(assessment.failure!.details).slice(0,3072)}`:null});
}
