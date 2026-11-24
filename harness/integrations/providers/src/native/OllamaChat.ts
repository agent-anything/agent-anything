import { OLLAMA_CHAT, type ProtocolRevisionRef } from "@agent-anything/model-interaction/protocol";
import type { ModelCallableDefinition } from "@agent-anything/model-interaction";
import { compileNativeCatalog, type NativeCallableCatalog } from "./NativeCallableCatalog.js";
import { compileNativeSchema, type NativeSchemaCodec } from "./NativeSchema.js";
import { copy, digest, json, list, object, string, token, validateNativePreparedEncoding, NativeProtocolError, type JsonObject } from "./NativeJson.js";
import { httpJson, dispatchNativeHttp, type NativeHttpObservation, type NativeHttpOptions } from "./NativeHttp.js";
import { nativeHttpEndpoint } from "./NativeHttpEndpoint.js";

export const OLLAMA_CHAT_ADAPTER=Object.freeze({id:"ollama.chat.adapter",revision:"1"});
export function ollamaInputCapacityRefused(value:unknown):boolean {
  if(!value||typeof value!=="object"||Array.isArray(value))return false;
  const body=value as Record<string,unknown>,error=body.error;
  if(error&&typeof error==="object"&&!Array.isArray(error)){
    const detail=error as Record<string,unknown>;
    return detail.code==="exceed_context_size_error"||detail.type==="exceed_context_size_error";
  }
  return typeof error==="string"&&(error.toLowerCase()==="input length exceeds the context length"||
    /^request \(\d+ tokens\) exceeds the available context size \(\d+ tokens\)[.!]?$/i.test(error));
}
export interface OllamaChatPreparation {readonly body:JsonObject;readonly encoded:string;readonly digest:string;readonly catalog:NativeCallableCatalog;readonly format:NativeSchemaCodec|null}
export async function dispatchOllamaChat(prepared:Pick<OllamaChatPreparation,"body"|"encoded"|"digest">,connection:{readonly baseUrl:string},options:NativeHttpOptions){
  validateNativePreparedEncoding(prepared,"ollama_prepared_input_changed");
  return dispatchNativeHttp({url:nativeHttpEndpoint(connection.baseUrl,"api/chat"),body:prepared.encoded,framing:prepared.body.stream?"ndjson":"json",
    headers:{"content-type":"application/json"}},options);
}
export function prepareOllamaChat(input:{readonly model:string;readonly messages:readonly JsonObject[];readonly purpose:ProtocolRevisionRef;
  readonly stream:boolean;readonly think?:boolean|string;readonly options?:JsonObject;readonly tools?:readonly ModelCallableDefinition[];readonly format?:JsonObject}):OllamaChatPreparation {
  if(input.format&&input.tools?.length)throw new NativeProtocolError("ollama_combined_purpose_not_declared");
  const catalog=compileNativeCatalog({protocol:OLLAMA_CHAT,purpose:input.purpose,definitions:input.tools??[],mode:"identity"});
  const format=input.format?compileNativeSchema({protocol:OLLAMA_CHAT,purpose:input.purpose,canonical:input.format,mode:"identity",root:"body"}):null;
  const body=copy({model:token(input.model),messages:input.messages,stream:input.stream,...(input.think!==undefined?{think:input.think}:{}),
    ...(input.options?{options:input.options}:{}),...(format?{format:format.wire}:{}),...(catalog.entries.length?{tools:catalog.entries.map(e=>({type:"function",function:{
      name:e.definition.name,description:e.definition.description,parameters:e.codec.wire}}))}:{})});
  return Object.freeze({body,encoded:JSON.stringify(body),digest:digest(body),catalog,format});
}
export function readOllamaChatObservation(observation:NativeHttpObservation):JsonObject {
  if(observation.status<200||observation.status>=300||!observation.frames.length)return httpJson(observation);
  let terminal:JsonObject|undefined,model:string|undefined;
  const content:string[]=[],thinking:string[]=[],calls:unknown[]=[];
  for(const frame of observation.frames){
    if(terminal)throw new NativeProtocolError("ollama_chunk_after_done");
    const chunk=object(json(frame.data));
    if(chunk.error!==undefined)throw new NativeProtocolError("ollama_stream_error");
    if(typeof chunk.done!=="boolean")throw new NativeProtocolError("ollama_done_missing");
    if(model&&chunk.model!==model)throw new NativeProtocolError("ollama_model_changed");model=token(chunk.model);
    if(chunk.message!==undefined){
      const message=object(chunk.message);
      if(message.role!=="assistant")throw new NativeProtocolError("ollama_role_invalid");
      if(Object.keys(message).some(k=>!["role","content","thinking","tool_calls","images"].includes(k)))throw new NativeProtocolError("ollama_message_unsupported");
      if(message.images!==undefined)throw new NativeProtocolError("ollama_output_images_unsupported");
      if(message.content!==undefined)content.push(string(message.content));
      if(message.thinking!==undefined)thinking.push(string(message.thinking));
      if(message.tool_calls!==undefined)calls.push(...list(message.tool_calls));
      if(calls.length>256)throw new NativeProtocolError("ollama_call_limit");
    }
    if(chunk.done)terminal=chunk;
  }
  if(!terminal)throw new NativeProtocolError("ollama_stream_incomplete");
  return copy({...terminal,message:{role:"assistant",content:content.join(""),...(thinking.length?{thinking:thinking.join("")} :{}),...(calls.length?{tool_calls:calls}:{})}});
}
export function ollamaAssistant(response:JsonObject):JsonObject {
  token(response.model);
  if(response.done!==true||response.done_reason!=="stop"||response.error!==undefined)throw new NativeProtocolError("ollama_chat_not_acceptable",{done_reason:response.done_reason});
  const message=object(response.message);
  if(Object.keys(message).some(k=>!["role","content","thinking","tool_calls","images"].includes(k)))throw new NativeProtocolError("ollama_message_unsupported");
  if(message.role!=="assistant")throw new NativeProtocolError("ollama_role_invalid");string(message.content);
  if(message.thinking!==undefined)string(message.thinking);
  if(message.images!==undefined)throw new NativeProtocolError("ollama_output_images_unsupported");
  for(const raw of list(message.tool_calls??[])){const fn=object(object(raw).function);token(fn.name);object(fn.arguments);}
  return copy(message);
}
export function ollamaToolResult(response:JsonObject,ordinal:number,content:string):JsonObject {
  const message=ollamaAssistant(response),calls=list(message.tool_calls??[]);
  if(!Number.isSafeInteger(ordinal)||ordinal<0||ordinal>=calls.length)throw new NativeProtocolError("ollama_result_call_unknown");
  return copy({role:"tool",tool_name:token(object(object(calls[ordinal]).function).name),content:string(content)});
}
export function ollamaCallableExchange(response:JsonObject,results:readonly {readonly ordinal:number;readonly content:string}[]):readonly JsonObject[]{
  const message=ollamaAssistant(response),calls=list(message.tool_calls??[]).map(object);
  const byOrdinal=new Map(results.map(result=>[result.ordinal,result]));
  if(byOrdinal.size!==results.length||results.length!==calls.length||calls.some((_,index)=>!byOrdinal.has(index)))
    throw new NativeProtocolError("ollama_result_group_mismatch");
  return copy([message,...calls.map((call,index)=>({role:"tool",tool_name:token(object(call.function).name),content:string(byOrdinal.get(index)!.content)}))]);
}
export function readOllamaStructured(response:JsonObject,format:NativeSchemaCodec):unknown {
  const message=ollamaAssistant(response);
  if(list(message.tool_calls??[]).length)throw new NativeProtocolError("ollama_auxiliary_call_forbidden");
  return format.parse(string(message.content));
}
