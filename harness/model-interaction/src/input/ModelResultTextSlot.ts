import {snapshotModelMessage,type ModelMessage} from "../ModelMessage.js";
import type {ModelJsonValue} from "../ModelInteractionContractValidation.js";
import {modelInputValueDigest} from "./ModelWorkingView.js";

/** A source-declared text position inside one result body, never inside its protocol envelope. */
export interface ModelResultTextSlot {
  readonly callId:string;
  readonly contentPath:readonly (string|number)[];
  readonly resultDigest:string;
  readonly textDigest:string;
}
export type ModelToolMessage=Extract<ModelMessage,{readonly role:"tool"}>;
export interface ModelInputResultTextBinding {
  readonly sectionId:string;
  readonly slot:ModelResultTextSlot;
  readonly source:{readonly owner:string;readonly kind:string;readonly id:string;readonly revision:string|null};
  readonly representation:{readonly owner:string;readonly kind:string;readonly id:string;readonly revision:string|null};
}

export function declareModelResultTextSlot(message:ModelToolMessage,callId:string,contentPath:ModelResultTextSlot["contentPath"]):ModelResultTextSlot {
  const result=selectedResult(message,callId),text=textAt(result.content,contentPath);
  return {callId,contentPath:[...contentPath],resultDigest:modelInputValueDigest(result),textDigest:modelInputValueDigest(text)};
}

/** Checks the declared original; it does not authorize conversion or assess a replacement's meaning. */
export function readModelResultTextSlot(message:ModelToolMessage,slot:ModelResultTextSlot):string {
  const result=selectedResult(message,slot.callId),text=textAt(result.content,slot.contentPath);
  if(modelInputValueDigest(result)!==slot.resultDigest||modelInputValueDigest(text)!==slot.textDigest)
    throw new TypeError("model_result_text_source_changed");
  return text;
}

export function fillModelResultTextSlot(message:ModelToolMessage,slot:ModelResultTextSlot,text:string):ModelToolMessage {
  return fillModelResultTextSlots(message,[{slot,text}]);
}

/** All declarations bind the same original message, never an intermediate rewritten result. */
export function fillModelResultTextSlots(message:ModelToolMessage,replacements:readonly {readonly slot:ModelResultTextSlot;readonly text:string}[]):ModelToolMessage {
  const identities=new Set<string>();
  for(const {slot,text} of replacements) {
    readModelResultTextSlot(message,slot);
    const identity=modelInputValueDigest({callId:slot.callId,path:slot.contentPath});
    if(typeof text!=="string"||identities.has(identity))throw new TypeError("model_result_text_replacement_invalid");
    identities.add(identity);
  }
  const copy=structuredClone(message);
  const next=snapshotModelMessage({...copy,content:copy.content.map(block=>({...block,result:{...block.result,
    content:replacements.filter(r=>r.slot.callId===block.result.modelCallRef.id)
      .reduce((content,r)=>replaceText(content,r.slot.contentPath,r.text),block.result.content)}}))});
  if(next.role!=="tool")throw new TypeError("model_result_text_role_invalid");
  return next;
}

function selectedResult(message:ModelToolMessage,callId:string) {
  const checked=snapshotModelMessage(message);
  if(checked.role!=="tool"||!callId)throw new TypeError("model_result_text_role_invalid");
  const matches=checked.content.filter(block=>block.result.modelCallRef.id===callId);
  if(matches.length!==1)throw new TypeError("model_result_text_call_invalid");
  return matches[0]!.result;
}
function child(value:ModelJsonValue,key:string|number):ModelJsonValue {
  if(value===null||typeof value!=="object"||
    (Array.isArray(value)?!Number.isSafeInteger(key)||Number(key)<0:typeof key!=="string")||
    !Object.hasOwn(value,key))throw new TypeError("model_result_text_path_invalid");
  return (value as Record<string|number,ModelJsonValue>)[key]!;
}
function textAt(value:ModelJsonValue,path:ModelResultTextSlot["contentPath"]):string {
  if(!Array.isArray(path)||path.length>64)throw new TypeError("model_result_text_path_invalid");
  for(const key of path)value=child(value,key);
  if(typeof value!=="string")throw new TypeError("model_result_text_leaf_required");
  return value;
}
function replaceText(value:ModelJsonValue,path:ModelResultTextSlot["contentPath"],text:string):ModelJsonValue {
  if(!path.length)return text;
  const [key,...rest]=path,next=replaceText(child(value,key!),rest,text);
  if(Array.isArray(value))return value.map((item,index)=>index===key?next:item);
  return {...value as Record<string,ModelJsonValue>,[key!]:next};
}
