import type {ProtocolRevisionRef} from "@agent-anything/model-interaction/protocol";
import {copy,digest,object,list,token,string,validateNativePreparedEncoding,NativeProtocolError,type JsonObject} from "../NativeJson.js";
import {dispatchNativeHttp,httpJson,type NativeHttpObservation,type NativeHttpOptions} from "../NativeHttp.js";
import {nativeHttpEndpoint} from "../NativeHttpEndpoint.js";
import {validateResponsesInputGroups} from "../input/ResponsesInputRealization.js";

export const RESPONSES_COMPACT_METHOD={id:"openai.responses.compact",revision:"1"} as const;
export const RESPONSES_IN_REQUEST_COMPACTION={id:"openai.responses.context_management.compaction",revision:"1"} as const;
export interface ResponsesCompactPreparation {
  readonly purpose:ProtocolRevisionRef;
  readonly body:JsonObject;
  readonly encoded:string;
  readonly digest:string;
}
export interface ResponsesCompactedWindow {
  readonly resourceId:string;
  readonly raw:JsonObject;
  readonly items:readonly JsonObject[];
  readonly digest:string;
  readonly removed:readonly {readonly pointer:string;readonly reason:"output_provenance"|"sdk_decoding"}[];
  readonly opaqueItems:readonly {readonly index:number;readonly id:string;readonly digest:string}[];
}

/** Compact is a separate resource, never a generation Response or a task cursor. */
export function prepareResponsesCompact(input:{readonly model:string;readonly input:readonly JsonObject[];
  readonly purpose:ProtocolRevisionRef;readonly instructions?:string;readonly previous_response_id?:string}):ResponsesCompactPreparation {
  token(input.purpose.id);token(input.purpose.revision);
  validateResponsesInputGroups(input.input);
  const body=copy({model:token(input.model),input:input.input,
    ...(input.instructions===undefined?{}:{instructions:string(input.instructions)}),
    ...(input.previous_response_id===undefined?{}:{previous_response_id:token(input.previous_response_id)})});
  return copy({purpose:input.purpose,body,encoded:JSON.stringify(body),digest:digest(body)});
}
export async function dispatchResponsesCompact(prepared:ResponsesCompactPreparation,
  connection:{readonly baseUrl:string;readonly apiKey:string;readonly organization?:string;readonly project?:string},options:NativeHttpOptions):Promise<NativeHttpObservation>{
  validateNativePreparedEncoding(prepared,"responses_compact_request_changed");
  return dispatchNativeHttp({url:nativeHttpEndpoint(connection.baseUrl,"responses/compact"),body:prepared.encoded,framing:"json",
    headers:{"content-type":"application/json",authorization:`Bearer ${connection.apiKey}`,
      ...(connection.organization?{"OpenAI-Organization":connection.organization}:{}),...(connection.project?{"OpenAI-Project":connection.project}:{})}},options);
}
export function readResponsesCompact(observation:NativeHttpObservation):ResponsesCompactedWindow {
  return restoreResponsesCompactedWindow(httpJson(observation));
}
/** Preserve the entire window and all unknown fields. Only documented output-only fields are normalized. */
export function restoreResponsesCompactedWindow(value:unknown):ResponsesCompactedWindow {
  const raw=object(value),resourceId=token(raw.id);
  if(raw.object!=="response.compaction"||raw.error!=null)throw new NativeProtocolError("responses_compact_envelope_invalid");
  const removed:ResponsesCompactedWindow["removed"][number][]=[],opaqueItems:ResponsesCompactedWindow["opaqueItems"][number][]=[],ids=new Set<string>();
  const items=list(raw.output).map((entry,index)=>{
    const item={...object(entry)},pointer=`/output/${index}`;
    if(item.id!==undefined){const id=token(item.id);if(ids.has(id))throw new NativeProtocolError("responses_compact_item_duplicate");ids.add(id);}
    if(item.status!==undefined&&item.status!=="completed")throw new NativeProtocolError("responses_compact_item_incomplete");
    if(Object.hasOwn(item,"created_by")){delete item.created_by;removed.push({pointer:`${pointer}/created_by`,reason:"output_provenance"});}
    if(item.type==="function_call"&&Object.hasOwn(item,"parsed_arguments")){delete item.parsed_arguments;removed.push({pointer:`${pointer}/parsed_arguments`,reason:"sdk_decoding"});}
    if(item.type==="message"&&Array.isArray(item.content))item.content=item.content.map((part,index)=>{
      const result={...object(part)};if(Object.hasOwn(result,"parsed")){delete result.parsed;removed.push({pointer:`${pointer}/content/${index}/parsed`,reason:"sdk_decoding"});}return result;
    });
    if(item.type==="compaction")opaqueItems.push({index,id:token(item.id),digest:digest(string(item.encrypted_content))});
    return item;
  });
  if(!items.length||!opaqueItems.length)throw new NativeProtocolError("responses_compact_window_missing");
  validateResponsesInputGroups(items);
  return copy({resourceId,raw,items,digest:digest(items),removed,opaqueItems});
}

export interface ResponsesCompactionOptions {readonly type:"compaction";readonly compact_threshold:number;}
export function validateResponsesCompactionOptions(options:readonly ResponsesCompactionOptions[]):readonly ResponsesCompactionOptions[]{
  if(!Array.isArray(options)||options.length!==1||options[0].type!=="compaction"||Object.keys(options[0]).some(k=>k!=="type"&&k!=="compact_threshold")||
    !Number.isSafeInteger(options[0].compact_threshold)||options[0].compact_threshold<1000)
    throw new NativeProtocolError("responses_compaction_options_invalid");
  return copy(options);
}
export interface ResponsesCompactionOccurrence {
  readonly responseId:string;readonly outputIndex:number;readonly itemId:string;readonly digest:string;
  readonly precedingOutput:readonly string[];
  readonly internalSourceCoverage:"unknown";
}
/** Observation is factual even when no agreement authorized the conversion. */
export function responsesCompactionOccurrences(response:JsonObject):readonly ResponsesCompactionOccurrence[]{
  if(response.object!=="response")throw new NativeProtocolError("responses_compaction_response_invalid");
  const responseId=token(response.id),precedingOutput:string[]=[],result:ResponsesCompactionOccurrence[]=[];
  for(const [outputIndex,value] of list(response.output).entries()){
    const item=object(value),itemId=token(item.id);
    if(item.type==="compaction"){
      string(item.encrypted_content);
      result.push({responseId,outputIndex,itemId,digest:digest(item),precedingOutput:[...precedingOutput],internalSourceCoverage:"unknown"});
    }
    precedingOutput.push(itemId);
  }
  return copy(result);
}
/** Native replay reduction is explicit and separate from standalone compact output. */
export function responsesInternalCompactionReplay(input:readonly JsonObject[],output:readonly JsonObject[]):{
  readonly items:readonly JsonObject[];readonly omittedPrefixDigest:string|null;readonly omittedItems:number;
}{
  const all=[...input,...output];let last=-1;
  for(let i=all.length-1;i>=0;i--)if(all[i].type==="compaction"){last=i;break;}
  const omittedItems=last<0?0:last,items=all.slice(omittedItems);
  validateResponsesInputGroups(items);
  return copy({items,omittedItems,omittedPrefixDigest:omittedItems?digest(all.slice(0,omittedItems)):null});
}
