import type {ModelJsonValue,ModelToolResult} from "@agent-anything/model-interaction";
import {declareModelResultContentTextSlot} from "@agent-anything/model-interaction/input";
import {snapshotContextMaterialRef,type ContextMaterialRef} from "@agent-anything/context/material";

/** Helarc owns its delegated result body. This declaration is eligibility, not permission to transform. */
export function helarcResultTextDeclaration(result:ModelToolResult,id:string,revision:string){
  const body=result.content;
  if(result.presentation.presenter.id!=="agent-runtime.observation"||result.presentation.disposition==="unavailable"||
    !object(body)||!["descendant_run","descendant_result_transfer"].includes(String(body.kind)))return null;
  if(!object(body.output)||typeof body.output.summary!=="string")return null;
  let source:{kind:"inline"}|{kind:"retained_material";reference:ContextMaterialRef}={kind:"inline"};
  const report=body.output.report;
  if(object(report)){
    if(report.status!=="retained_material")return null;
    source={kind:"retained_material",reference:snapshotContextMaterialRef(report.reference)};
  }else if(!body.output.summary.length)return null;
  return {id,source,owner:{owner:"helarc-task-input",kind:"result_text_declaration",id,revision},
    slot:declareModelResultContentTextSlot(result,["output","summary"]),requirements:[{
      id:`${id}:report-content`,revision,basis:"Helarc delegated result report contract",
      description:"Preserve the report's actionable findings, requested deliverable, conditions, unresolved work, failures, uncertainty, references and applicability. Do not substitute a list of steps taken for the result. The surrounding execution facts remain unchanged; do not contradict them or infer success from completion."}]};
}
function object(value:ModelJsonValue|undefined):value is {readonly [key:string]:ModelJsonValue}{return value!==null&&typeof value==="object"&&!Array.isArray(value);}
