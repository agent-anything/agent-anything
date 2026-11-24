import { DEEPSEEK_CHAT_COMPLETIONS, type ProtocolRevisionRef } from "@agent-anything/model-interaction/protocol";
import type { ModelCallableDefinition } from "@agent-anything/model-interaction";
import { compileNativeCatalog, type NativeCallableCatalog } from "./NativeCallableCatalog.js";
import { compileNativeSchema, type NativeSchemaCodec } from "./NativeSchema.js";
import { copy, digest, json, list, object, string, token, validateNativePreparedEncoding, NativeProtocolError, type JsonObject } from "./NativeJson.js";
import { httpJson, dispatchNativeHttp, type NativeHttpObservation, type NativeHttpOptions } from "./NativeHttp.js";
import { nativeHttpEndpoint } from "./NativeHttpEndpoint.js";

export const DEEPSEEK_CHAT_ADAPTER=Object.freeze({id:"deepseek.chat-completions.adapter",revision:"1"});
export function deepSeekInputCapacityRefused(value:unknown):boolean {
  if(!value||typeof value!=="object"||Array.isArray(value))return false;
  const error=(value as Record<string,unknown>).error;
  return Boolean(error&&typeof error==="object"&&!Array.isArray(error)&&(error as Record<string,unknown>).code==="context_length_exceeded");
}
export interface DeepSeekChatPreparation {readonly body:JsonObject;readonly encoded:string;readonly digest:string;readonly catalog:NativeCallableCatalog;readonly format:NativeSchemaCodec|null}
export async function dispatchDeepSeekChat(prepared:Pick<DeepSeekChatPreparation,"body"|"encoded"|"digest">,connection:{readonly baseUrl:string;readonly apiKey:string},options:NativeHttpOptions){
  validateNativePreparedEncoding(prepared,"deepseek_prepared_input_changed");
  return dispatchNativeHttp({url:nativeHttpEndpoint(connection.baseUrl,"chat/completions"),body:prepared.encoded,framing:prepared.body.stream?"sse":"json",
    headers:{"content-type":"application/json",authorization:`Bearer ${connection.apiKey}`}},options);
}
export function prepareDeepSeekChat(input:{readonly model:string;readonly messages:readonly JsonObject[];readonly purpose:ProtocolRevisionRef;
  readonly stream:boolean;readonly thinking?:{readonly type:"enabled"|"disabled"};readonly tools?:readonly ModelCallableDefinition[];readonly jsonSchema?:JsonObject}):DeepSeekChatPreparation {
  if(input.jsonSchema&&input.tools?.length)throw new NativeProtocolError("deepseek_combined_purpose_not_declared");
  const catalog=compileNativeCatalog({protocol:DEEPSEEK_CHAT_COMPLETIONS,purpose:input.purpose,definitions:input.tools??[],mode:"identity"});
  const format=input.jsonSchema?compileNativeSchema({protocol:DEEPSEEK_CHAT_COMPLETIONS,purpose:input.purpose,canonical:input.jsonSchema,mode:"identity",root:"object-body"}):null;
  // JSON mode requires an owner-authored JSON instruction. No hidden prompt is inserted here.
  if(format&&!input.messages.some(m=>typeof m.content==="string"&&/json/i.test(m.content)))throw new NativeProtocolError("deepseek_json_instruction_required");
  const body=copy({model:token(input.model),messages:input.messages,stream:input.stream,
    ...(input.stream?{stream_options:{include_usage:true}}:{}),...(input.thinking?{thinking:input.thinking}:{}),
    ...(format?{response_format:{type:"json_object"}}:{}),...(catalog.entries.length?{tool_choice:"auto",tools:catalog.entries.map(e=>({type:"function",function:{
      name:e.definition.name,description:e.definition.description,parameters:e.codec.wire}}))}:{})});
  return Object.freeze({body,encoded:JSON.stringify(body),digest:digest(body),catalog,format});
}
export function readDeepSeekObservation(observation:NativeHttpObservation):JsonObject {
  if(observation.status<200||observation.status>=300||!observation.frames.length)return httpJson(observation);
  let envelope:JsonObject|undefined,finish:unknown=null,done=false,usage:unknown=null;
  const content:string[]=[],reasoning:string[]=[],refusal:string[]=[];
  const calls=new Map<number,{id:string;type:string;name:string[];arguments:string[]}>();
  for(const frame of observation.frames){
    if(done)throw new NativeProtocolError("deepseek_chunk_after_done");
    if(frame.data==="[DONE]"){done=true;continue;}
    const chunk=object(json(frame.data));
    if(chunk.error!==undefined)throw new NativeProtocolError("deepseek_stream_error");
    if(chunk.object!=="chat.completion.chunk")throw new NativeProtocolError("deepseek_chunk_invalid");
    if(envelope&&envelope.id!==chunk.id)throw new NativeProtocolError("deepseek_completion_identity_changed");
    token(chunk.id);envelope=chunk;
    if(chunk.usage!=null)usage=chunk.usage;
    for(const raw of list(chunk.choices)){
      const choice=object(raw);
      if(choice.index!==0||finish!==null)throw new NativeProtocolError("deepseek_choice_ambiguous");
      const delta=object(choice.delta);
      if(Object.keys(delta).some(k=>!["role","content","reasoning_content","tool_calls","refusal"].includes(k)))throw new NativeProtocolError("deepseek_delta_unsupported");
      if(delta.role!==undefined&&delta.role!=="assistant")throw new NativeProtocolError("deepseek_role_invalid");
      if(delta.content!=null)content.push(string(delta.content));
      if(delta.reasoning_content!=null)reasoning.push(string(delta.reasoning_content));
      if(delta.refusal!=null)refusal.push(string(delta.refusal));
      for(const c of delta.tool_calls===undefined?[]:list(delta.tool_calls)){
        const call=object(c),index=Number(call.index);
        if(!Number.isSafeInteger(index)||index<0||index>=256)throw new NativeProtocolError("deepseek_call_index_invalid");
        let accumulated=calls.get(index);
        if(!accumulated){accumulated={id:"",type:"",name:[],arguments:[]};calls.set(index,accumulated);}
        if(call.id!==undefined){if(accumulated.id&&accumulated.id!==call.id)throw new NativeProtocolError("deepseek_call_identity_changed");accumulated.id=token(call.id);}
        if(call.type!==undefined){if(call.type!=="function")throw new NativeProtocolError("deepseek_call_type_unsupported");accumulated.type="function";}
        if(call.function!==undefined){const fn=object(call.function);if(fn.name!==undefined)accumulated.name.push(string(fn.name));if(fn.arguments!==undefined)accumulated.arguments.push(string(fn.arguments));}
      }
      if(choice.finish_reason!=null)finish=choice.finish_reason;
    }
  }
  if(!done||!envelope||finish===null)throw new NativeProtocolError("deepseek_stream_incomplete");
  const tool_calls=[...calls.entries()].sort(([a],[b])=>a-b).map(([index,c],ordinal)=>{
    if(index!==ordinal||!c.id||c.type!=="function")throw new NativeProtocolError("deepseek_call_incomplete");
    return {id:c.id,type:c.type,function:{name:c.name.join(""),arguments:c.arguments.join("")}};
  });
  return copy({...envelope,object:"chat.completion",usage,choices:[{index:0,finish_reason:finish,message:{role:"assistant",content:content.join(""),
    ...(reasoning.length?{reasoning_content:reasoning.join("")} :{}),...(refusal.length?{refusal:refusal.join("")} :{}),...(tool_calls.length?{tool_calls}:{})}}]});
}
export function deepSeekAssistant(response:JsonObject):JsonObject {
  token(response.id);
  if(response.object!=="chat.completion"||list(response.choices).length!==1)throw new NativeProtocolError("deepseek_completion_invalid");
  const choice=object(list(response.choices)[0]);
  if(choice.index!==0||!["stop","tool_calls"].includes(String(choice.finish_reason)))throw new NativeProtocolError("deepseek_completion_not_acceptable",{finish_reason:choice.finish_reason});
  const message=object(choice.message);
  if(Object.keys(message).some(k=>!["role","content","reasoning_content","tool_calls","refusal"].includes(k)))throw new NativeProtocolError("deepseek_message_unsupported");
  if(message.role!=="assistant")throw new NativeProtocolError("deepseek_role_invalid");
  if(message.content!=null)string(message.content);
  if(message.reasoning_content!=null)string(message.reasoning_content);
  if(message.refusal!=null)string(message.refusal);
  const ids=new Set<string>();
  for(const raw of message.tool_calls===undefined?[]:list(message.tool_calls)){
    const call=object(raw),fn=object(call.function),id=token(call.id);
    if(call.type!=="function"||ids.has(id))throw new NativeProtocolError("deepseek_call_correlation_invalid");ids.add(id);token(fn.name);string(fn.arguments);
  }
  return copy(message);
}
export function deepSeekToolResult(response:JsonObject,callId:string,content:string):JsonObject {
  const message=deepSeekAssistant(response);
  if(!list(message.tool_calls??[]).some(c=>object(c).id===callId))throw new NativeProtocolError("deepseek_result_call_unknown");
  return copy({role:"tool",tool_call_id:callId,content:string(content)});
}
export function deepSeekCallableExchange(response:JsonObject,results:readonly {readonly tool_call_id:string;readonly content:string}[]):readonly JsonObject[]{
  const message=deepSeekAssistant(response),calls=list(message.tool_calls??[]).map(object);
  const byId=new Map(results.map(result=>[result.tool_call_id,result]));
  if(byId.size!==results.length||results.length!==calls.length||calls.some(call=>!byId.has(token(call.id))))
    throw new NativeProtocolError("deepseek_result_group_mismatch");
  return copy([message,...calls.map(call=>({role:"tool",tool_call_id:call.id,content:string(byId.get(token(call.id))!.content)}))]);
}
export function readDeepSeekStructured(response:JsonObject,format:NativeSchemaCodec):unknown {
  const message=deepSeekAssistant(response);
  if(list(message.tool_calls??[]).length)throw new NativeProtocolError("deepseek_auxiliary_call_forbidden");
  if(message.refusal)throw new NativeProtocolError("deepseek_auxiliary_refused");
  return format.parse(string(message.content));
}
