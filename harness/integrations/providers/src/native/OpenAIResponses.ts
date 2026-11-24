import { OPENAI_RESPONSES, type ProtocolRevisionRef } from "@agent-anything/model-interaction/protocol";
import { type ModelCallableDefinition } from "@agent-anything/model-interaction";
import { compileNativeCatalog, type NativeCallableCatalog } from "./NativeCallableCatalog.js";
import { compileNativeSchema, type NativeSchemaCodec } from "./NativeSchema.js";
import { copy, digest, json, list, object, string, token, validateNativePreparedEncoding, NativeProtocolError, type JsonObject } from "./NativeJson.js";
import { httpJson, dispatchNativeHttp, type NativeHttpObservation, type NativeHttpOptions } from "./NativeHttp.js";
import { nativeHttpEndpoint } from "./NativeHttpEndpoint.js";
import { validateResponsesCacheSettings } from "./accounting/NativeCache.js";
import {validateResponsesCompactionOptions,type ResponsesCompactionOptions} from "./compaction/ResponsesCompaction.js";

export const OPENAI_RESPONSES_ADAPTER = Object.freeze({id:"openai.responses.adapter",revision:"1"});
/** A native error code, never a guess from model text or transport failure. */
export function responsesInputCapacityRefused(value:unknown):boolean {
  if(!value||typeof value!=="object"||Array.isArray(value))return false;
  const response=value as Record<string,unknown>,error=response.error;
  return (!response.object||response.object==="response"&&response.status==="failed")&&
    Boolean(error&&typeof error==="object"&&!Array.isArray(error)&&(error as Record<string,unknown>).code==="context_length_exceeded");
}
export interface ResponsesPreparation {
  readonly body: JsonObject;
  readonly encoded: string;
  readonly digest: string;
  readonly catalog: NativeCallableCatalog;
  readonly format: NativeSchemaCodec | null;
}
export async function dispatchResponses(prepared:ResponsesPreparation,connection:{readonly baseUrl:string;readonly apiKey:string;readonly organization?:string;readonly project?:string},options:NativeHttpOptions){
  validateNativePreparedEncoding(prepared,"responses_prepared_input_changed");
  return dispatchNativeHttp({url:nativeHttpEndpoint(connection.baseUrl,"responses"),body:prepared.encoded,framing:prepared.body.stream?"sse":"json",
    headers:{"content-type":"application/json",authorization:`Bearer ${connection.apiKey}`,...(connection.organization?{"OpenAI-Organization":connection.organization}:{}),...(connection.project?{"OpenAI-Project":connection.project}:{})}},options);
}
export function prepareResponses(input:{readonly model:string;readonly input:readonly JsonObject[];readonly purpose:ProtocolRevisionRef;
  readonly instructions?:string;readonly stream:boolean;readonly store:boolean;readonly previous_response_id?:string;
  readonly transport?:"http"|"websocket";readonly background?:boolean;
  readonly context_management?:readonly ResponsesCompactionOptions[];
  readonly max_output_tokens?:number;
  readonly tools?:readonly ModelCallableDefinition[];readonly functionMode?:"responses-strict"|"identity";
  readonly textSchema?:JsonObject;readonly reasoning?:JsonObject;readonly include?:readonly string[];
  readonly cache?:Parameters<typeof validateResponsesCacheSettings>[0]}):ResponsesPreparation {
  if(input.textSchema && input.tools?.length)throw new NativeProtocolError("responses_combined_purpose_not_declared");
  if(input.max_output_tokens!==undefined&&(!Number.isSafeInteger(input.max_output_tokens)||input.max_output_tokens<1))throw new NativeProtocolError("responses_output_bound_invalid");
  const catalog=compileNativeCatalog({protocol:OPENAI_RESPONSES,purpose:input.purpose,definitions:input.tools??[],mode:input.functionMode??"responses-strict"});
  const format=input.textSchema?compileNativeSchema({protocol:OPENAI_RESPONSES,purpose:input.purpose,canonical:input.textSchema,mode:"responses-strict",root:"body"}):null;
  if(input.transport==="websocket"&&(!input.stream||input.background!==undefined))throw new NativeProtocolError("responses_websocket_http_fields");
  const body=copy({model:token(input.model),input:input.input,...(input.transport==="websocket"?{}:{stream:input.stream,...(input.background===undefined?{}:{background:input.background})}),store:input.store,
    ...(input.cache ? validateResponsesCacheSettings(input.cache) : {}),
    ...(input.instructions !== undefined && input.instructions !== "" ? {instructions:input.instructions}:{}),
    ...(input.previous_response_id ? {previous_response_id:token(input.previous_response_id)}:{}),
    ...(input.reasoning ? {reasoning:input.reasoning}:{}),...(input.include ? {include:input.include}:{}),
    ...(input.context_management?{context_management:validateResponsesCompactionOptions(input.context_management)}:{}),
    ...(input.max_output_tokens===undefined?{}:{max_output_tokens:input.max_output_tokens}),
    ...(catalog.entries.length ? {tools:catalog.entries.map(e=>({type:"function",name:e.definition.name,description:e.definition.description,
      parameters:e.codec.wire,strict:e.codec.spec.mode==="responses-strict"})),tool_choice:"auto",parallel_tool_calls:true}:{}),
    ...(format?{text:{format:{type:"json_schema",name:"purpose_result",strict:true,schema:format.wire}}}:{})});
  return Object.freeze({body,encoded:JSON.stringify(body),digest:digest(body),catalog,format});
}
/** The complete native Response is authoritative. Deltas remain separately retained observations. */
export function readResponsesObservation(observation:NativeHttpObservation):JsonObject {
  if(observation.status<200||observation.status>=300)return httpJson(observation);
  if(!observation.frames.length)return httpJson(observation);
  let terminal:JsonObject|undefined, responseId:string|undefined, sequence=-1;
  for(const frame of observation.frames){
    const event=object(json(frame.data)),type=string(event.type);
    if(frame.event!=="message"&&frame.event!==type)throw new NativeProtocolError("responses_event_type_mismatch");
    if(event.sequence_number!==undefined){
      if(!Number.isSafeInteger(event.sequence_number)||Number(event.sequence_number)<=sequence)throw new NativeProtocolError("responses_event_sequence_invalid");
      sequence=Number(event.sequence_number);
    }
    if(terminal)throw new NativeProtocolError("responses_event_after_terminal");
    if(event.response!==undefined){
      const response=object(event.response),id=token(response.id);
      if(responseId&&responseId!==id)throw new NativeProtocolError("responses_identity_changed"); responseId=id;
      if(["response.completed","response.incomplete","response.failed"].includes(type)){
        if(response.status!==type.slice("response.".length))throw new NativeProtocolError("responses_terminal_status_mismatch");
        terminal=response;
      }
    }
    if(type==="error")throw new NativeProtocolError("responses_stream_error");
  }
  if(!terminal)throw new NativeProtocolError("responses_stream_incomplete");
  return copy(terminal);
}
export function assertResponsesTaskResponse(response:JsonObject):void {
  token(response.id);
  if(response.object!=="response")throw new NativeProtocolError("responses_envelope_invalid");
  if(response.status!=="completed")throw new NativeProtocolError("responses_not_completed",{status:response.status});
  if(response.error!=null||response.incomplete_details!=null)throw new NativeProtocolError("responses_terminal_conflict");
  const ids=new Set<string>(),calls=new Set<string>();
  for(const raw of list(response.output)){
    const item=object(raw),id=token(item.id);if(ids.has(id))throw new NativeProtocolError("responses_item_duplicate");ids.add(id);
    if(item.status!==undefined&&item.status!=="completed")throw new NativeProtocolError("responses_item_incomplete");
    if(item.type==="function_call"){
      const callId=token(item.call_id);if(calls.has(callId))throw new NativeProtocolError("responses_call_id_duplicate");calls.add(callId);
      token(item.name);string(item.arguments);
    }else if(item.type==="message"){
      if(item.role!=="assistant")throw new NativeProtocolError("responses_message_role_invalid");
      for(const content of list(item.content)){
        const part=object(content);
        if(part.type==="output_text")string(part.text);
        else if(part.type==="refusal")string(part.refusal);
        else throw new NativeProtocolError("responses_content_unsupported",{type:part.type});
      }
    }else if(item.type==="compaction"){
      if(!string(item.encrypted_content))throw new NativeProtocolError("responses_compaction_content_missing");
    }else if(item.type==="reasoning"){
      // Raw reasoning/encrypted content stays in custody and legal replay, never local execution.
      list(item.summary);
    }else throw new NativeProtocolError("responses_item_unsupported",{type:item.type});
  }
}
export function responsesReplayItems(response:JsonObject):readonly JsonObject[] {
  return mapResponsesReplay(response).items;
}
export function mapResponsesReplay(response:JsonObject):{readonly items:readonly JsonObject[];readonly removed:readonly {readonly pointer:string;readonly reason:"output_provenance"|"sdk_decoding"}[]}{
  assertResponsesTaskResponse(response);
  const removed:{pointer:string;reason:"output_provenance"|"sdk_decoding"}[]=[];
  const items=list(response.output).map((raw,index)=>{
    const item={...object(raw)},pointer=`/output/${index}`;
    if(Object.hasOwn(item,"created_by")){delete item.created_by;removed.push({pointer:`${pointer}/created_by`,reason:"output_provenance"});}
    if(item.type==="function_call"&&Object.hasOwn(item,"parsed_arguments")){delete item.parsed_arguments;removed.push({pointer:`${pointer}/parsed_arguments`,reason:"sdk_decoding"});}
    if(item.type==="message")item.content=list(item.content).map((rawPart,i)=>{
      const part={...object(rawPart)};
      if(Object.hasOwn(part,"parsed")){delete part.parsed;removed.push({pointer:`${pointer}/content/${i}/parsed`,reason:"sdk_decoding"});}return part;
    });
    return item;
  });
  return copy({items,removed});
}
export function responsesFunctionResult(response:JsonObject,callId:string,output:string):JsonObject {
  assertResponsesTaskResponse(response);
  if(!list(response.output).some(v=>object(v).type==="function_call"&&object(v).call_id===callId))throw new NativeProtocolError("responses_result_call_unknown");
  return copy({type:"function_call_output",call_id:callId,output:string(output)});
}
/** A local-function exchange, not a history selection or a dispatch decision. */
export function responsesCallableExchange(response:JsonObject,results:readonly {readonly call_id:string;readonly output:string}[]):readonly JsonObject[]{
  const replay=mapResponsesReplay(response),calls=replay.items.filter(item=>item.type==="function_call");
  const byId=new Map(results.map(result=>[result.call_id,result]));
  if(byId.size!==results.length||results.length!==calls.length||calls.some(call=>!byId.has(token(call.call_id))))
    throw new NativeProtocolError("responses_result_group_mismatch");
  return copy([...replay.items,...calls.map(call=>({type:"function_call_output",call_id:call.call_id,output:string(byId.get(token(call.call_id))!.output)}))]);
}
export function readResponsesStructured(response:JsonObject,format:NativeSchemaCodec):unknown {
  assertResponsesTaskResponse(response);
  if(list(response.output).some(v=>object(v).type==="function_call"))throw new NativeProtocolError("responses_auxiliary_call_forbidden");
  const messages=list(response.output).map(object).filter(v=>v.type==="message");
  if(messages.length!==1)throw new NativeProtocolError("responses_auxiliary_body_ambiguous");
  const content=list(messages[0].content).map(object);
  if(content.some(v=>v.type==="refusal"))throw new NativeProtocolError("responses_auxiliary_refused");
  return format.parse(content.map(v=>string(v.text)).join(""));
}
