import {snapshotProviderRequest,type ProviderRequest,type ModelJsonValue} from "@agent-anything/model-interaction";
import {declareModelResultTextSlot,modelInputValueDigest,type InputDuty,type ModelInputSection,type ModelInputSourceRef} from "@agent-anything/model-interaction/input";
import {createInputDeliverySections,inputNotificationDigest,inputNotificationDeliveryId,validateTaskDecisionSource,type TaskDecisionSourceRecord} from "@agent-anything/agent-runtime/decision";
import {restoreHelarcCallableCatalog} from "../controller/HelarcModelCallableCatalog.js";
import type {OriginalInputSources,OriginalInputSourceGroup} from "@agent-anything/agent-runtime/context-representation";

export interface HelarcTaskInputSourceGroup extends OriginalInputSourceGroup {
  readonly owner:"helarc-task-input";
}
export interface HelarcTaskInputSources extends OriginalInputSources {
  readonly owner:"helarc-task-input";
  readonly groups:readonly HelarcTaskInputSourceGroup[];
}

/** Supplies original sources and known protocol relations, not a representation or capacity decision. */
export function createHelarcTaskInputSources(original:TaskDecisionSourceRecord,request:ProviderRequest):HelarcTaskInputSources {
  validateTaskDecisionSource(original);
  const retained=snapshotProviderRequest(request),source=original.source;
  if(retained.correlation?.controllerRequestId!==source.toolExposure.controllerRequestId||retained.metadata.runId!==source.runId)
    throw new TypeError("helarc_task_input_source_mismatch");
  restoreHelarcCallableCatalog(retained,source.toolExposure);
  const pending=createInputDeliverySections(source.inputDelivery),notifications=source.inputDelivery?.entries??[];
  for(const section of pending) {
    const actual=retained.composition.sections.find(value=>value.id===section.id);
    if(!actual||modelInputValueDigest(actual)!==modelInputValueDigest(section))throw new TypeError("helarc_task_source_delivery_missing");
  }
  const native=new Map(retained.composition.workingView.nativeGroups.flatMap(group=>group.sectionIds.map(id=>[id,group] as const)));
  const visited=new Set<string>(),groups:HelarcTaskInputSourceGroup[]=[];
  for(const section of retained.composition.sections) {
    if(visited.has(section.id))continue;
    const group=native.get(section.id),ids=group?.sectionIds??[section.id];
    const occurrences=ids.map(id=>{
      const position=retained.composition.sections.findIndex(value=>value.id===id);
      if(position<0||visited.has(id))throw new TypeError("helarc_task_source_group_invalid");
      visited.add(id);return {position,section:retained.composition.sections[position]!};
    });
    const sources=new Map<string,ModelInputSourceRef>();
    for(const {section:value} of occurrences)for(const ref of [value.source,...(value.provenance?.sources??[])])sources.set(modelInputValueDigest(ref),ref);
    const duties=[...new Set(occurrences.flatMap(({section:value})=>sourceDuties(value)))];
    const deliveries=occurrences.flatMap(({section:value})=>{
      const index=pending.findIndex(entry=>entry.id===value.id);
      if(index<0)return [];
      const entry=notifications[index]!,digest=inputNotificationDigest(entry);
      return [{id:inputNotificationDeliveryId(entry),sequence:entry.sequence,digest,sectionId:value.id,source:entry.source}];
    });
    const revision=modelInputValueDigest(occurrences.map(value=>value.section));
    // Helarc owns its delegated result schema. A shared method must not discover writable text fields by guessing.
    const resultTexts=occurrences.flatMap(({section:value})=>{
      if(value.content.kind!=="model_message"||value.content.message.role!=="tool")return [];
      const message=value.content.message;
      return message.content.flatMap(({result})=>{
        const body=result.content;
        if(result.presentation.presenter.id!=="agent-runtime.observation"||result.presentation.disposition==="unavailable"||
          !jsonObject(body)||!["descendant_run","descendant_result_transfer"].includes(String(body.kind)))return [];
        const output=body.output;
        if(!jsonObject(output)||typeof output.summary!=="string"||!output.summary.length)return [];
        const id=`${value.id}:${result.modelCallRef.id}:report`;
        return [{id,owner:{owner:"helarc-task-input",kind:"result_text_declaration",id,revision},sectionId:value.id,
          slot:declareModelResultTextSlot(message,result.modelCallRef.id,["output","summary"]),requirements:[{
            id:`${id}:report-content`,revision,basis:"Helarc delegated result report contract",
            description:"Preserve the report's actionable findings, requested deliverable, conditions, unresolved work, failures, uncertainty, references and applicability. Do not substitute a list of steps taken for the result. The surrounding execution facts remain unchanged; do not contradict them or infer success from completion."}]}];
      });
    });
    const groupRevision=resultTexts.length?modelInputValueDigest({occurrences,resultTexts}):revision;
    groups.push({id:`${source.runId}:input-source:${modelInputValueDigest(ids)}`,revision:groupRevision,owner:"helarc-task-input",occurrences,duties,sources:[...sources.values()],deliveries,
      ...(resultTexts.length?{resultTexts}:{})});
  }
  const boundary=modelInputValueDigest({interaction:source.interaction.id,revision:source.interaction.revision,
    delivery:source.inputDelivery?{id:source.inputDelivery.id,revision:source.inputDelivery.revision}:null});
  const basis={owner:"helarc-task-input" as const,runId:source.runId,originalSourceId:original.id,boundary,request:retained,groups};
  return {id:`task-input-sources:${modelInputValueDigest(basis)}`,...basis};
}

function sourceDuties(section:ModelInputSection):readonly InputDuty[] {
  if(section.role==="instruction")return ["behavior"];
  const purpose=section.provenance?.purpose;
  const duties:InputDuty[]=[];
  if(purpose==="assignment"||purpose==="intervention")duties.push("objective");
  if(purpose==="initial_background"||purpose==="selected_input")duties.push("working_understanding");
  if(purpose==="selected_material"||section.role==="tool")duties.push("evidence");
  if(section.kind==="input_notification")duties.push("new_information");
  // Every occurrence remains in the original conversation. Unclassified meaning is not permission to omit it.
  duties.push("continuity");
  return duties;
}
function jsonObject(value:ModelJsonValue|undefined):value is {readonly [key:string]:ModelJsonValue} {
  return value!==null&&typeof value==="object"&&!Array.isArray(value);
}
