import type {HelarcNativeTaskBinding} from "../../controller/native/HelarcNativeTaskContracts.js";
import type {NativeModelSourceRef} from "@agent-anything/model-interaction/protocol";
import type {HelarcResponsePreviewPart} from "./HelarcResponsePreviewContracts.js";
import {boundedPresentationText} from "./HelarcRunPresentation.js";
import {helarcNativeResponseGroupId} from "./HelarcNativePresentation.js";
import {HelarcFinalResponsePreview} from "./HelarcFinalResponsePreview.js";
import {nativeReadableReasoning} from "./HelarcNativeReasoning.js";

export interface HelarcNativePreviewObservation {
  readonly binding:HelarcNativeTaskBinding;
  readonly sequence:number;
  readonly value:Readonly<Record<string,unknown>>;
  readonly disposition?:"received"|"interrupted"|"cancelled"|"failed";
  readonly code?:string;
}
export type HelarcNativePreviewObserver=(value:HelarcNativePreviewObservation)=>void;
export type HelarcNativePreviewCalls=Map<string,{name:string;identity:NativeModelSourceRef["nativeIdentity"];parser:HelarcFinalResponsePreview}>;
const object=(v:unknown):Record<string,unknown>=>v&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:{};
/** Product preview only; no displayed fragment confers task or execution authority. */
export function nativePreviewParts(event:HelarcNativePreviewObservation,previous:readonly HelarcResponsePreviewPart[],calls:HelarcNativePreviewCalls):readonly HelarcResponsePreviewPart[]{
  const b=event.binding,v=event.value,parts=[...previous];
  const put=(position:string,text:string,identity:NativeModelSourceRef["nativeIdentity"],delta:boolean,kind:"text"|"reasoning"|"final_response"="text",name:string|null=null)=>{
    const id=`native-preview:${b.scope.activityId}:${position}`;
    const source:NativeModelSourceRef={scope:b.scope,protocol:b.protocol,interpretation:b.adapter,operationId:b.operationId,record:b.record,
      position:{format:"json-pointer",value:position},nativeIdentity:identity};
    const index=parts.findIndex(p=>p.id===id),old=index<0?null:parts[index]!;
    if(index<0&&parts.length>=256)return;
    const full=delta?(old?.text??"")+text:text,bounded=boundedPresentationText(full);
    const part:HelarcResponsePreviewPart={id,kind,...bounded,receivedLength:delta?(old?.receivedLength??0)+text.length:text.length,
      omittedBytes:bounded.omittedBytes+(delta?(old?.omittedBytes??0):0),name,modelItemId:null,turnId:null,
      groupId:helarcNativeResponseGroupId(source),nativeSource:source,committedRecordId:null};
    if(index<0)parts.push(part);else parts[index]=part;
  };
  const final=(position:string,name:unknown,identity:NativeModelSourceRef["nativeIdentity"],argumentsValue:unknown,delta:boolean)=>{
    let entry=calls.get(position);
    if(!entry&&typeof name==="string"&&calls.size<256&&b.catalog?.some(c=>c.definition.name===name&&c.binding.kind==="control"&&c.binding.control==="final_result")){
      entry={name,identity,parser:new HelarcFinalResponsePreview()};calls.set(position,entry);
    }
    if(!entry)return;
    if(delta){if(typeof argumentsValue==="string")put(position,entry.parser.write(argumentsValue).text,entry.identity,false,"final_response",entry.name);}
    else{try{const args=typeof argumentsValue==="string"?JSON.parse(argumentsValue):object(argumentsValue);
      if(typeof args?.response==="string")put(position,args.response,entry.identity,false,"final_response",entry.name);
    }catch{/* Partial arguments are display-only until complete acceptance. */}}
  };
  if(b.protocol.id==="openai.responses"){
    if((v.type==="response.reasoning_summary_text.delta"||v.type==="response.reasoning_text.delta")&&Number.isInteger(v.output_index)&&typeof v.item_id==="string"&&typeof v.delta==="string"){
      const summary=v.type==="response.reasoning_summary_text.delta",index=summary?v.summary_index:v.content_index;
      if(Number.isInteger(index))put(`/output/${v.output_index}/${summary?"summary":"content"}/${index}`,v.delta,{kind:"reasoning",id:v.item_id},true,"reasoning");
    }
    if(v.type==="response.output_item.added"&&Number.isInteger(v.output_index)){
      const item=object(v.item);if(item.type==="function_call"&&typeof item.id==="string")final(`/output/${v.output_index}`,item.name,{kind:"function_call",id:item.id},item.arguments,false);
    }
    if(v.type==="response.function_call_arguments.delta"&&Number.isInteger(v.output_index))final(`/output/${v.output_index}`,null,null,v.delta,true);
    if(v.type==="response.output_text.delta"&&Number.isInteger(v.output_index)&&Number.isInteger(v.content_index)&&typeof v.item_id==="string"&&typeof v.delta==="string")
      put(`/output/${v.output_index}/content/${v.content_index}`,v.delta,{kind:"message",id:v.item_id},true);
    const response=object(v.response??v);
    const source:NativeModelSourceRef={scope:b.scope,protocol:b.protocol,interpretation:b.adapter,operationId:b.operationId,record:b.record,position:{format:"json-pointer",value:""},nativeIdentity:null};
    for(const r of nativeReadableReasoning(response,source))put(r.source.position.value,r.text,r.source.nativeIdentity,false,"reasoning");
    if(Array.isArray(response.output))for(const [i,item] of response.output.entries()){
      const m=object(item);
      if(m.type==="function_call"&&typeof m.id==="string")final(`/output/${i}`,m.name,{kind:"function_call",id:m.id},m.arguments,false);
      if(m.type!=="message"||!Array.isArray(m.content)||typeof m.id!=="string")continue;
      for(const [j,part]of m.content.entries()){const p=object(part);if(p.type==="output_text"&&typeof p.text==="string")put(`/output/${i}/content/${j}`,p.text,{kind:"message",id:m.id},false);}
    }
  }else if(b.protocol.id==="deepseek.chat-completions"&&Array.isArray(v.choices)){
    for(const choice of v.choices){const c=object(choice);if(c.index!==0||typeof v.id!=="string")continue;
      const m=object(c.delta??c.message);if(typeof m.content==="string")put("/choices/0/message/content",m.content,{kind:"chat.completion",id:v.id},c.delta!==undefined);
      if(typeof m.reasoning_content==="string")put("/choices/0/message/reasoning_content",m.reasoning_content,{kind:"chat.completion",id:v.id},c.delta!==undefined,"reasoning");
      if(Array.isArray(m.tool_calls))for(const [i,tool]of m.tool_calls.entries()){const call=object(tool),fn=object(call.function),index=Number.isInteger(call.index)?call.index:i;
        final(`/choices/0/message/tool_calls/${index}`,fn.name,typeof call.id==="string"?{kind:"tool_call",id:call.id}:null,fn.arguments,c.delta!==undefined);}
    }
  }else if(b.protocol.id==="ollama.chat"){
    const message=object(v.message);if(typeof message.content==="string")put("/message/content",message.content,null,true);
    if(typeof message.thinking==="string")put("/message/thinking",message.thinking,null,true,"reasoning");
    if(Array.isArray(message.tool_calls))for(const [i,tool]of message.tool_calls.entries()){const fn=object(object(tool).function);final(`/message/tool_calls/${i}`,fn.name,null,fn.arguments,false);}
  }
  return parts;
}
