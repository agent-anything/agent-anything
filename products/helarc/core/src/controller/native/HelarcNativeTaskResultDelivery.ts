import {modelInputValueDigest as digest,declareModelResultContentTextSlot,readModelResultContentTextSlot,fillModelResultContentTextSlots} from "@agent-anything/model-interaction/input";
import type {ModelToolResult} from "@agent-anything/model-interaction";
import type {TaskDecisionInputSources} from "@agent-anything/agent-runtime/decision";
import type {HelarcAgentOutput} from "../HelarcController.js";
import type {HelarcNativeRunTask} from "./HelarcNativePreparedTask.js";
import {helarcResultTextDeclaration} from "../../prompt/HelarcResultTextDeclaration.js";

/** Original accepted outcomes only; this is not another copy of task decision context. */
export interface HelarcNativeTaskResultSources {
  readonly runId:string;
  readonly results:readonly ModelToolResult[];
}
type ResultInput=TaskDecisionInputSources<HelarcAgentOutput>|HelarcNativeTaskResultSources;
export function helarcNativeTaskResultSources(input:TaskDecisionInputSources<HelarcAgentOutput>):HelarcNativeTaskResultSources {
  if(input.interaction.kind!=="native_evidence")throw new TypeError("native_result_delivery_basis_missing");
  const entries=input.interaction.entries;
  let boundary=entries.length-1;while(boundary>=0&&entries[boundary]!.kind!=="purpose")boundary--;
  return {runId:input.runId,results:entries.slice(boundary+1).flatMap(e=>e.kind==="settlement"?[e.result]:[])};
}

/** Realizes declared bodies only. The returned draft still requires selection and quality acceptance. */
export function presentHelarcNativeTaskResults(prepared:HelarcNativeRunTask,input:ResultInput,
  replacements:readonly {readonly callId:string;readonly text:string;readonly representation:{readonly id:string;readonly revision:string};readonly groupId:string}[]) {
  const deliveries=helarcNativeTaskResultDeliveries(prepared,input),body=JSON.parse(prepared.wire.body);
  if(new Set(replacements.map(r=>r.callId)).size!==replacements.length||prepared.resultPresentations?.length)
    throw new TypeError("native_result_presentation_original_required");
  const resultPresentations=replacements.map(replacement=>{
    const delivery=deliveries.find(d=>d.result.modelCallRef.id===replacement.callId);
    const declaration=delivery&&helarcResultTextDeclaration(delivery.result,"original","1");
    if(!delivery||!declaration)throw new TypeError("native_result_text_declaration_missing");
    const result=fillModelResultContentTextSlots(delivery.result,[{slot:declaration.slot,text:replacement.text}]);
    const match=/^\/(input|messages)\/(\d+)$/.exec(delivery.position)!,item=body[match[1]!][Number(match[2])];
    item[item.type==="function_call_output"?"output":"content"]=JSON.stringify({settlement:result.settlement,result:result.content});
    return {groupId:replacement.groupId,position:delivery.position,slot:declaration.slot,representation:replacement.representation};
  });
  return {wire:{body:JSON.stringify(body),digest:digest(body)},resultPresentations};
}

/** Actual native positions, not text search or inference from a result's publication. */
export function helarcNativeTaskResultDeliveries(prepared:HelarcNativeRunTask,input:ResultInput):
  readonly {readonly result:ModelToolResult;readonly position:string;readonly contentDigest:string}[] {
  if(!Array.isArray(prepared.results)||input.runId!==prepared.binding.scope.runId)throw new TypeError("native_result_delivery_basis_missing");
  const body=JSON.parse(prepared.wire.body),settlements="interaction" in input?helarcNativeTaskResultSources(input).results:input.results;
  if(prepared.results.length!==settlements.length||new Set(prepared.results.map(r=>r.callId)).size!==prepared.results.length)
    throw new TypeError("native_result_delivery_incomplete");
  const presentations=prepared.resultPresentations??[];
  if(!Array.isArray(presentations)||presentations.length>128||new Set(prepared.results.map(r=>r.position)).size!==prepared.results.length||
    presentations.some(p=>!prepared.results.some(r=>r.callId===p.slot.callId&&r.position===p.position))||
    new Set(presentations.map(p=>digest({callId:p.slot.callId,path:p.slot.contentPath}))).size!==presentations.length)
    throw new TypeError("native_result_presentation_invalid");
  return prepared.results.map(mapping=>{
    const match=/^\/(input|messages)\/(\d+)$/.exec(mapping.position),item=match?body[match[1]!]?.[Number(match[2])]:null;
    const result=settlements.find(s=>s.modelCallRef.id===mapping.callId);
    if(!item||!result||digest(item)!==mapping.contentDigest)throw new TypeError("native_result_delivery_position_changed");
    const text=item.type==="function_call_output"?item.output:item.role==="tool"?item.content:null;
    if(typeof text!=="string")throw new TypeError("native_result_delivery_content_changed");
    const value=JSON.parse(text),presentations=(prepared.resultPresentations??[]).filter(p=>p.slot.callId===mapping.callId);
    if(presentations.length&&!prepared.selectedInputId)throw new TypeError("native_result_presentation_not_selected");
    const replacements=presentations.map(p=>{
      const declaration=helarcResultTextDeclaration(result,"original", "1");
      if(!declaration||p.position!==mapping.position||digest(declaration.slot)!==digest(p.slot))throw new TypeError("native_result_text_declaration_changed");
      const actual={...result,content:value.result},slot=declareModelResultContentTextSlot(actual,p.slot.contentPath);
      return {slot:p.slot,text:readModelResultContentTextSlot(actual,slot)};
    });
    const presented=fillModelResultContentTextSlots(result,replacements);
    if(digest(value)!==digest({settlement:result.settlement,result:presented.content}))
      throw new TypeError("native_result_delivery_content_changed");
    if(result.providerCallRef&&((item.type==="function_call_output"?item.call_id:item.tool_call_id)!==result.providerCallRef.id))
      throw new TypeError("native_result_delivery_call_changed");
    return {result,position:mapping.position,contentDigest:mapping.contentDigest};
  });
}
