import {modelInputValueDigest as digest,type ModelInputPreservation} from "@agent-anything/model-interaction/input";
import {modelCallRefKey,type ModelToolResult} from "@agent-anything/model-interaction";
import {OPENAI_RESPONSES,DEEPSEEK_CHAT_COMPLETIONS,OLLAMA_CHAT,type ModelAgentCompositionBinding,type ModelPurposeEvidence} from "@agent-anything/model-interaction/protocol";
import {bindProtocolModelActivity,readProtocolContent,type ProtocolExecutionJournal,type ProtocolExecutionState,type ProtocolJournalRecord,type ProtocolPurposeAcceptance} from "@agent-anything/agent-runtime/model-access";
import {inputNotificationMessage,retainTaskDecisionSource,type TaskDecisionInputSources,type NativeTaskHistoryEntry,type NativeTaskHistorySeed,type ControllerInputDeliveryBatch} from "@agent-anything/agent-runtime/decision";
import {prepareResponses,responsesReplayItems,responsesFunctionResult,prepareDeepSeekChat,deepSeekAssistant,deepSeekToolResult,
  prepareOllamaChat,ollamaAssistant,ollamaToolResult,type ResponsesPreparation} from "@agent-anything/provider-integrations/native";
import {helarcOpeningBackground,type HelarcExecutionBackground} from "../../prompt/HelarcConversationOpening.js";
import type {HelarcControllerProtocolComposition} from "../HelarcControllerProtocolComposition.js";
import type {HelarcAgentOutput} from "../HelarcController.js";
import {HELARC_NATIVE_TASK_INTERPRETER,nativeTaskCatalog,type HelarcCommittedTaskReply,type HelarcNativeTaskProposal} from "./HelarcNativeTask.js";
import type {HelarcNativeRunTask} from "./HelarcNativeTaskExecution.js";
import type {ContextSelectionPort,ContextSelectionSnapshot} from "@agent-anything/context/selection";
import type {HelarcRetainedNativeInput} from "./HelarcNativeInputAcceptance.js";
import {validateHelarcNativeResultSelection,type HelarcNativeResultSelectionPorts} from "./HelarcNativeResultSelection.js";
import {helarcNativeTaskResultDeliveries} from "./HelarcNativeTaskResultDelivery.js";
import {HelarcNativeWorkingInput,validateHelarcNativeWorkingSources,type HelarcNativeWorkingGroupBasis,type HelarcNativeWorkingSources} from "./HelarcNativeWorkingSources.js";

export interface HelarcNativeTaskInputPorts {
  readonly journal:ProtocolExecutionJournal;
  readonly composition:ModelAgentCompositionBinding;
  readonly controller:HelarcControllerProtocolComposition;
  readonly environment?:HelarcExecutionBackground;
  readonly conditions:Parameters<typeof bindProtocolModelActivity>[0]["conditions"];
  readonly authorizeImport?:(seed:NativeTaskHistorySeed,input:TaskDecisionInputSources<HelarcAgentOutput>)=>Promise<void>;
  readonly contextSelections?:ContextSelectionPort;
}
interface RetainedTaskInput extends HelarcNativeRunTask {readonly workingItems:readonly JsonObject[];readonly workingSources:HelarcNativeWorkingSources}
type JsonObject=Record<string,unknown>;
interface HistoryRecord {readonly prepared:RetainedTaskInput;readonly response:JsonObject;readonly proposal:HelarcNativeTaskProposal;readonly evidence:ModelPurposeEvidence;readonly contextInput:ProtocolExecutionState["contextInput"]}
interface InputParticipant {
  readonly protocol:string;readonly path:"input"|"messages";
  readonly response:(value:JsonObject)=>readonly JsonObject[];
  readonly result:(response:JsonObject,result:ModelToolResult)=>JsonObject;
  readonly encode:(items:readonly JsonObject[],instructions:string,definitions:Parameters<typeof prepareResponses>[0]["tools"],purpose:ModelPurposeEvidence["scope"]["purpose"],model:string)=>Pick<ResponsesPreparation,"encoded"|"digest">;
}

export function prepareHelarcResponsesTask(input:TaskDecisionInputSources<HelarcAgentOutput>,ports:HelarcNativeTaskInputPorts,
  options:Pick<Parameters<typeof prepareResponses>[0],"stream">&Partial<Pick<Parameters<typeof prepareResponses>[0],"transport"|"background"|"store"|"reasoning"|"max_output_tokens"|"cache">>={stream:false}) {
  return prepareTask(input,ports,{protocol:OPENAI_RESPONSES.id,path:"input",response:responsesReplayItems,
    result:(response,result)=>responsesFunctionResult(response,requiredCallId(result),resultText(result)),
    encode:(items,instructions,tools,purpose,model)=>prepareResponses({model,input:items,instructions,tools,purpose,store:false,
      include:["reasoning.encrypted_content"],...options})});
}
export function prepareHelarcDeepSeekTask(input:TaskDecisionInputSources<HelarcAgentOutput>,ports:HelarcNativeTaskInputPorts,
  options:Pick<Parameters<typeof prepareDeepSeekChat>[0],"stream"|"thinking">={stream:false}) {
  return prepareTask(input,ports,{protocol:DEEPSEEK_CHAT_COMPLETIONS.id,path:"messages",response:r=>[deepSeekAssistant(r)],
    result:(response,result)=>deepSeekToolResult(response,requiredCallId(result),resultText(result)),
    encode:(items,instructions,tools,purpose,model)=>prepareDeepSeekChat({model,messages:withSystem(items,instructions),tools,purpose,...options})});
}
export function prepareHelarcOllamaTask(input:TaskDecisionInputSources<HelarcAgentOutput>,ports:HelarcNativeTaskInputPorts,
  options:Pick<Parameters<typeof prepareOllamaChat>[0],"stream"|"think"|"options">={stream:false}) {
  return prepareTask(input,ports,{protocol:OLLAMA_CHAT.id,path:"messages",response:r=>[ollamaAssistant(r)],
    result:(response,result)=>ollamaToolResult(response,result.modelCallRef.contentBlockOrdinal,resultText(result)),
    encode:(items,instructions,tools,purpose,model)=>prepareOllamaChat({model,messages:withSystem(items,instructions),tools,purpose,...options})});
}

async function prepareTask(input:TaskDecisionInputSources<HelarcAgentOutput>,ports:HelarcNativeTaskInputPorts,participant:InputParticipant) {
  const {composition}=ports,definition=composition.composition;
  if(input.interaction.kind!=="native_evidence"||input.interaction.unsettledCalls.length||definition.protocol.id!==participant.protocol||
    definition.agent.id!==input.agent.id||definition.agent.revision!==input.agent.revision)throw new TypeError("helarc_native_input_binding_mismatch");
  const activityId=`${input.toolExposure.controllerRequestId}:native-task`,scope={runId:input.runId,activityId,recipientId:input.agent.id,
    purpose:definition.task.purpose,compositionDigest:composition.digest};
  const activity=bindProtocolModelActivity({composition,scope,conditions:ports.conditions});
  const catalog=ports.controller.createCallableCatalog(input.toolExposure,input.planLimits,input.plan!==null);
  const basis={scope,protocol:definition.protocol,adapter:definition.adapter.implementation,interpreter:HELARC_NATIVE_TASK_INTERPRETER,
    acceptance:{id:`${activityId}:accepted`,revision:"1"},requestId:`${activityId}:request`,controllerRequestId:input.toolExposure.controllerRequestId,
    operationId:participant.protocol===OPENAI_RESPONSES.id?`${activityId}:responses:operation:1`:`${activityId}:create`,record:{id:`${activityId}:response`,revision:"1"},
    catalog:catalog.definitions.map(d=>({definition:d,binding:catalog.bindings.find(b=>b.callableName===d.name)!})),
    schemaMode:participant.protocol===OPENAI_RESPONSES.id?"responses-strict" as const:"identity" as const,hasPlan:input.plan!==null,planLimits:input.planLimits};
  const binding={...basis,catalogRevision:nativeTaskCatalog(basis).revision};
  const latestIndex=lastPurposeIndex(input.interaction.entries);
  const working=new HelarcNativeWorkingInput(),items=working.items,sourceDigest=retainTaskDecisionSource(input).id;
  const resultItems:{callId:string;index:number;contentDigest:string}[]=[];
  let previous:HelarcCommittedTaskReply|null=null;
  const continueHistory=async(entries:readonly NativeTaskHistoryEntry[],index:number,currentRun:boolean)=>{
    const entry=entries[index];
    if(entry?.kind!=="purpose")throw new TypeError("helarc_native_history_boundary_missing");
    const original=await historyRecord(ports.journal,entry,composition,!currentRun);
    const inherited=await workingInput(original,ports,participant),exchangeId=entry.evidence.scope.activityId;
    working.inherit(inherited.items,inherited.sources,entry.evidence);
    const responseBasis:HelarcNativeWorkingGroupBasis={id:`${exchangeId}:response`,originRunId:entry.evidence.scope.runId,
      sources:[{source:{owner:"model-access",kind:"protocol_observation",...original.prepared.binding.record},position:""}],
      duties:["continuity"],preservation:account("native-response","Retain the actual response, its Calls and their relation to settled outcomes; do not invent local or remote effects."),
      exchangeId,protection:["active_exchange"],acceptedBy:null,representations:[]};
    working.append(participant.response(original.response),responseBasis);
    if(currentRun)previous={scope:entry.evidence.scope,acceptance:entry.evidence.acceptance,responseRecord:original.prepared.binding.record,text:original.proposal.text};
    const calls=new Set(entry.calls.map(c=>modelCallRefKey(c.modelCallRef)));
    for(const next of entries.slice(index+1)){
      if(next.kind==="purpose")throw new TypeError("helarc_native_history_boundary_changed");
      if(next.kind==="settlement"){
        if(!calls.has(modelCallRefKey(next.result.modelCallRef)))throw new TypeError("helarc_native_result_source_missing");
        if(currentRun)resultItems.push({callId:next.result.modelCallRef.id,index:items.length,contentDigest:digest(participant.result(original.response,next.result))});
        working.append([participant.result(original.response,next.result)],{...responseBasis,id:`${exchangeId}:result:${next.result.modelCallRef.id}`,
          sources:[...responseBasis.sources,...next.result.sourceRefs.map(source=>({source,position:""}))],duties:["continuity","evidence"],
          preservation:account("call-outcome","Retain the Call identity, actual outcome, failures, uncertainty and available details; do not turn prerequisite repair into completion.")});
      }else appendNotifications(working,next.batch);
    }
  };
  if(latestIndex>=0)await continueHistory(input.interaction.entries,latestIndex,true);
  else if(input.interaction.seed){
    if(!ports.authorizeImport)throw new TypeError("helarc_native_import_authorization_required");
    await ports.authorizeImport(input.interaction.seed,input);
    // Earlier imports are already in the latest accepted input; later empty histories are not.
    const segments=input.interaction.seed.segments;
    let start=segments.length-1;
    while(start>=0&&lastPurposeIndex(segments[start]!.entries)<0)start--;
    for(let index=Math.max(0,start);index<segments.length;index++){
      const segment=segments[index]!,purpose=lastPurposeIndex(segment.entries);
      if(purpose>=0)await continueHistory(segment.entries,purpose,false);
      else appendImportedContext(working,segment,segment.boundary?.opening??[]);
      appendImportedContext(working,segment,segment.boundary?.closing??[]);
    }
    appendInitialItems(working,input,sourceDigest,ports.environment);
  }else appendInitialItems(working,input,sourceDigest,ports.environment);
  appendSelectedMaterials(working,input,sourceDigest);
  if(latestIndex<0)for(const entry of input.interaction.entries){
    if(entry.kind!=="delivery")throw new TypeError("helarc_native_history_before_first_purpose_invalid");
    appendNotifications(working,entry.batch);
  }
  const instructions=[...input.agent.instructions.blocks.map(b=>b.content),...ports.controller.protocolInstructions.filter(s=>s.enabled&&s.content.trim()).map(s=>s.content)].join("\n\n");
  const pending=notifications(input.inputDelivery),offset=items.length+(participant.path==="messages"&&instructions?1:0);
  appendNotifications(working,input.inputDelivery);
  const wire=participant.encode(items,instructions,catalog.definitions,scope.purpose,definition.configuration.model);
  const prepared:RetainedTaskInput={format:"helarc.native-prepared-task.v1",binding,wire:{body:wire.encoded,digest:wire.digest},previous,
    sourceDigest,workingItems:items,workingSources:working.snapshot(),
    results:resultItems.map(r=>({callId:r.callId,position:`/${participant.path}/${r.index+(participant.path==="messages"&&instructions?1:0)}`,contentDigest:r.contentDigest})),
    delivery:(input.inputDelivery?.entries??[]).map((entry,i)=>({sequence:entry.sequence,position:`/${participant.path}/${offset+i}`,contentDigest:digest(pending[i])}))};
  validateHelarcNativeTaskDelivery(prepared,input);
  return {activity,prepared};
}

async function workingInput(original:HistoryRecord,ports:Pick<HelarcNativeTaskInputPorts,"contextSelections">,participant:Pick<InputParticipant,"path">):Promise<{items:readonly JsonObject[];sources:HelarcNativeWorkingSources}> {
  const {prepared,contextInput}=original;
  if(!prepared.selectedInputId){
    if(!Array.isArray(prepared.workingItems))throw new TypeError("helarc_native_working_input_missing");
    const body=JSON.parse(prepared.wire.body),wireItems=body[participant.path];
    const expected=participant.path==="messages"&&wireItems?.[0]?.role==="system"?wireItems.slice(1):wireItems;
    if(digest(expected)!==digest(prepared.workingItems))throw new TypeError("helarc_native_working_input_changed");
    validateHelarcNativeWorkingSources(prepared.workingSources,prepared.workingItems);
    return {items:prepared.workingItems,sources:prepared.workingSources};
  }
  if(!ports.contextSelections)throw new TypeError("helarc_native_selection_owner_required");
  // Accepted history outlives its sending holds. A new request has separate admission checks.
  const selected=await ports.contextSelections.command({kind:"binding",inputId:prepared.selectedInputId,checkCurrentControl:false}) as ContextSelectionSnapshot;
  const native=selected.input.exactInput as HelarcRetainedNativeInput;
  if(native?.kind!=="helarc_native_input"||native.wire.digest!==prepared.wire.digest||selected.scope.runId!==prepared.binding.scope.runId||
    selected.input.id!==prepared.selectedInputId||selected.input.activityId!==prepared.binding.scope.activityId||
    digest(contextInput)!==digest({id:selected.input.id,digest:digest(native)})||
    digest(selected.input.nativeConsumer)!==digest({protocol:prepared.binding.protocol,compositionDigest:prepared.binding.scope.compositionDigest})||
    selected.scope.recipient!==prepared.binding.scope.recipientId||selected.scope.purpose!==prepared.binding.scope.purpose.id||
    native.manifest.scope.compositionDigest!==prepared.binding.scope.compositionDigest)throw new TypeError("helarc_native_selected_working_input_changed");
  const all=native.manifest.groups.flatMap(g=>g.items),items=participant.path==="messages"&&all[0]?.role==="system"?all.slice(1):all;
  if(!native.workingSources)throw new TypeError("helarc_native_selected_sources_missing");
  validateHelarcNativeWorkingSources(native.workingSources,items);
  return {items,sources:native.workingSources};
}
function lastPurposeIndex(entries:readonly NativeTaskHistoryEntry[]):number {
  for(let index=entries.length-1;index>=0;index--)if(entries[index]!.kind==="purpose")return index;
  return -1;
}

async function historyRecord(journal:ProtocolExecutionJournal,entry:Extract<NativeTaskHistoryEntry,{kind:"purpose"}>,composition:ModelAgentCompositionBinding,imported=false):Promise<HistoryRecord> {
  const activityId=entry.evidence.scope.activityId,state=await journal.command({kind:"state",activityId}) as ProtocolExecutionState|null;
  const accepted=await journal.command({kind:"acceptance",activityId}) as ProtocolPurposeAcceptance|null;
  if(!state||state.activity.composition.digest!==entry.evidence.scope.compositionDigest||!accepted||digest(accepted.evidence)!==digest(entry.evidence))throw new TypeError("helarc_native_history_owner_mismatch");
  if(imported){
    const original=state.activity.composition.composition,current=composition.composition;
    if(digest(original.protocol)!==digest(current.protocol)||digest(original.adapter)!==digest(current.adapter)||
      digest(original.task)!==digest(current.task))throw new TypeError("helarc_native_import_participant_unavailable");
  }else if(state.activity.composition.digest!==composition.digest)throw new TypeError("helarc_native_history_owner_mismatch");
  const prepared=JSON.parse((await readProtocolContent(journal,state.input,activityId,32*1024*1024)).toString()) as RetainedTaskInput;
  const record=await journal.command({kind:"record",activityId,ref:prepared.binding.record}) as ProtocolJournalRecord|null;
  if(!record?.source||record.source.scope.runId!==entry.evidence.scope.runId||record.kind!=="observation")throw new TypeError("helarc_native_history_observation_missing");
  const response=JSON.parse((await readProtocolContent(journal,record.content,activityId,32*1024*1024)).toString()) as JsonObject;
  const result=JSON.parse((await readProtocolContent(journal,accepted.result,activityId,32*1024*1024)).toString());
  if(result.format!=="helarc.native-task-decision.v1"||digest(result.proposal?.evidence)!==digest(entry.evidence))throw new TypeError("helarc_native_history_result_mismatch");
  return {prepared,response,proposal:result.proposal,evidence:entry.evidence,contextInput:state.contextInput};
}
function account(id:string,basis:string,visibleMessage=false):ModelInputPreservation{return {obligations:[{id,requirement:"account",basis,
  ...(visibleMessage?{permittedEvidence:["direct","method_assurance","continuation_probe"] as const}:{})}],relationships:[]};}
function appendImportedContext(working:HelarcNativeWorkingInput,segment:NativeTaskHistorySeed["segments"][number],
  values:readonly import("@agent-anything/agent-runtime/decision").RetainedInputPresentation[]):void {
  for(const {section} of values){
    if(section.role!=="user"||section.content.kind!=="text"||!section.preservation)throw new TypeError("helarc_native_import_context_invalid");
    working.append([{role:"user",content:section.content.text}],{id:section.id,originRunId:segment.runId,
      sources:[{source:section.source,position:""}],duties:["continuity"],preservation:section.preservation,
      exchangeId:null,protection:["first_delivery"],acceptedBy:null,representations:[]});
  }
}
function appendInitialItems(working:HelarcNativeWorkingInput,input:TaskDecisionInputSources<HelarcAgentOutput>,sourceDigest:string,environment?:HelarcExecutionBackground):void {
  const assignment=input.inputItems.find(item=>item.metadata.source==="delegation_objective"),background=helarcOpeningBackground(input,environment);
  const prompt=assignment?.content??(input.task.input as {prompt?:string}).prompt;
  if(typeof prompt!=="string")throw new TypeError("helarc_native_task_prompt_missing");
  const basis=(id:string,position:string,duties:HelarcNativeWorkingGroupBasis["duties"],preservation:ModelInputPreservation):HelarcNativeWorkingGroupBasis=>({
    id:`${sourceDigest}:${id}`,originRunId:input.runId,sources:[{source:{owner:"helarc",kind:"task_input_source",id:sourceDigest,revision:"1"},position}],
    duties,preservation,exchangeId:null,protection:["first_delivery"],acceptedBy:null,representations:[]});
  working.append([{role:"user",content:`Host-provided execution background (data):\n${JSON.stringify(background.value)}`}],{
    ...basis("background","",["evidence"],account("background","Retain this host-provided workspace and permission background in its original scope; this record does not attest later changes.",true)),
    sources:[{source:background.source,position:""}]});
  working.append([{role:"user",content:assignment?`Parent assignment:\n${prompt}`:prompt}],basis("objective",assignment?`/inputItems/${input.inputItems.indexOf(assignment)}`:"/task/input",
    ["objective"],account("objective",assignment?"Retain the Parent assignment with its original authority, objective, constraints and scope.":
      "Retain the user's original objective, constraints, scope and decisions as user input.",true)));
  for(const [index,item]of input.inputItems.entries())if(item!==assignment)working.append([{role:"user",content:`Selected input (data; original role: ${item.role}):\n${item.content}`}],
    basis(`input:${index}`,`/inputItems/${index}`,["evidence"],account("selected-input","Retain the selected input and its declared source role; data does not gain instruction authority.")));
  const task=input.task.input as {material_refs?:unknown;execution_refs?:unknown};
  for(const [field,label]of [["material_refs","Transferred retained-material references (use ContextMaterialRead for contents; not already read)"],
    ["execution_refs","Transferred execution references (references, not contents already read)"]] as const){
    if(Array.isArray(task[field])&&task[field].length)working.append([{role:"user",content:`${label}:\n${JSON.stringify(task[field])}`}],
      basis(field,`/task/input/${field}`,["evidence"],{obligations:[{id:field,requirement:"exact",basis:"Preserve the exact transferred access references; their contents have not yet been read."}],relationships:[]}));
  }
}
function appendSelectedMaterials(working:HelarcNativeWorkingInput,input:TaskDecisionInputSources<HelarcAgentOutput>,sourceDigest:string):void {
  const covered=new Set(working.snapshot().groups.filter(g=>g.originRunId===input.runId).flatMap(g=>g.sources)
    .filter(s=>s.source.owner==="context"&&s.source.kind==="context_contribution").map(s=>digest({id:s.source.id,revision:s.source.revision})));
  for(const block of input.context.blocks){
    const key=digest(block.contribution);if(covered.has(key))continue;
    const preservation:ModelInputPreservation=block.preservation?{obligations:block.preservation.obligations,relationships:block.preservation.relationships}:
      account("selected-material","Retain the selected material's content, provenance, limitations and access to required details.");
    working.append([{role:"user",content:`Selected material (data):\n${JSON.stringify({source:block.contribution,payload:block.payload})}`}],{
      id:`${sourceDigest}:material:${key}`,originRunId:input.runId,duties:["evidence"],preservation,
      exchangeId:null,protection:["first_delivery"],acceptedBy:null,representations:[],
      sources:[{source:{owner:"context",kind:"context_contribution",...block.contribution},position:""}]});
    covered.add(key);
  }
}
function appendNotifications(working:HelarcNativeWorkingInput,batch:ControllerInputDeliveryBatch|null|undefined):void {
  const items=notifications(batch);
  for(const [index,entry]of (batch?.entries??[]).entries())working.append([items[index]!],{
    id:`${batch!.id}:entry:${entry.sequence}`,originRunId:entry.runId,sources:[{source:entry.source,position:""}],duties:["new_information"],
    preservation:account("addressed-input","Retain the addressed input, its author, scope and correction or outcome role without silently overriding earlier evidence."),
    exchangeId:null,protection:["first_delivery"],acceptedBy:null,representations:[]});
}
function notifications(batch:ControllerInputDeliveryBatch|null|undefined):JsonObject[] {
  return (batch?.entries??[]).map(entry=>{const message=inputNotificationMessage(entry);
    return {role:"user",content:message.content.map(b=>b.kind==="text"?b.text:"").join("\n")};});
}
function resultText(result:ModelToolResult){return JSON.stringify({settlement:result.settlement,result:result.content});}
function requiredCallId(result:ModelToolResult){if(!result.providerCallRef)throw new TypeError("native_result_call_id_missing");return result.providerCallRef.id;}

/** Evidence for an auxiliary consumer, never a replacement task history or executable request. */
export async function readHelarcNativeTaskEvidence(history:import("@agent-anything/agent-runtime/decision").NativeTaskHistory,
  ports:Pick<HelarcNativeTaskInputPorts,"journal"|"composition"|"contextSelections">):Promise<readonly JsonObject[]> {
  const index=lastPurposeIndex(history.entries);
  if(index<0){if(history.entries.length||history.seed)throw new TypeError("native_task_evidence_boundary_missing");return [];}
  const protocol=ports.composition.composition.protocol.id;
  const participant=protocol===OPENAI_RESPONSES.id?{path:"input" as const,response:responsesReplayItems,
    result:(r:JsonObject,t:ModelToolResult)=>responsesFunctionResult(r,requiredCallId(t),resultText(t))}:
    protocol===DEEPSEEK_CHAT_COMPLETIONS.id?{path:"messages" as const,response:(r:JsonObject)=>[deepSeekAssistant(r)],
      result:(r:JsonObject,t:ModelToolResult)=>deepSeekToolResult(r,requiredCallId(t),resultText(t))}:
    protocol===OLLAMA_CHAT.id?{path:"messages" as const,response:(r:JsonObject)=>[ollamaAssistant(r)],
      result:(r:JsonObject,t:ModelToolResult)=>ollamaToolResult(r,t.modelCallRef.contentBlockOrdinal,resultText(t))}:null;
  if(!participant)throw new TypeError("native_task_evidence_protocol_unavailable");
  const entry=history.entries[index]!;if(entry.kind!=="purpose")throw new TypeError("native_task_evidence_boundary_missing");
  const original=await historyRecord(ports.journal,entry,ports.composition);
  const items=[...(await workingInput(original,ports,participant)).items,...participant.response(original.response)];
  const calls=new Set(entry.calls.map(c=>modelCallRefKey(c.modelCallRef)));
  for(const next of history.entries.slice(index+1)){
    if(next.kind==="purpose")throw new TypeError("native_task_evidence_boundary_changed");
    if(next.kind==="settlement"){
      if(!calls.has(modelCallRefKey(next.result.modelCallRef)))throw new TypeError("native_task_evidence_call_missing");
      items.push(participant.result(original.response,next.result));
    }else items.push(...notifications(next.batch));
  }
  return items;
}
function withSystem(items:readonly JsonObject[],instructions:string):readonly JsonObject[]{return instructions?[{role:"system",content:instructions},...items]:items;}
export function validateHelarcNativeTaskDelivery(prepared:HelarcNativeRunTask,input:TaskDecisionInputSources<HelarcAgentOutput>):void {
  const pending=notifications(input.inputDelivery),body=JSON.parse(prepared.wire.body);
  if(prepared.delivery.length!==pending.length)throw new TypeError("native_task_delivery_incomplete");
  for(const [i,mapping] of prepared.delivery.entries()) {
    const match=/^\/(input|messages)\/(\d+)$/.exec(mapping.position),items=match?body[match[1]!]:null,index=match?Number(match[2]):-1;
    if(!Array.isArray(items)||index!==items.length-pending.length+i||mapping.sequence!==input.inputDelivery!.entries[i]!.sequence||
      digest(items[index])!==digest(pending[i])||mapping.contentDigest!==digest(pending[i]))throw new TypeError("native_task_delivery_content_mismatch");
  }
}

/** CRM accepts a selection; the native input participant binds it to this exact task request. */
export async function adoptHelarcNativeTaskInput(prepared:HelarcNativeRunTask,input:TaskDecisionInputSources<HelarcAgentOutput>,
  inputId:string,selections:ContextSelectionPort,resultSelection?:HelarcNativeResultSelectionPorts):Promise<HelarcNativeRunTask> {
  const selected=await selections.command({kind:"binding",inputId,checkCurrentControl:true}) as ContextSelectionSnapshot;
  const native=selected.input.exactInput as HelarcRetainedNativeInput,b=prepared.binding;
  if(native?.kind!=="helarc_native_input"||selected.input.activityId!==b.scope.activityId||
    selected.scope.runId!==b.scope.runId||selected.scope.recipient!==b.scope.recipientId||selected.scope.purpose!==b.scope.purpose.id||
    native.manifest.scope.compositionDigest!==b.scope.compositionDigest||digest(native.manifest.protocol)!==digest(b.protocol)||
    digest(JSON.parse(native.wire.body))!==native.wire.digest)throw new TypeError("helarc_native_selected_input_binding_mismatch");
  const original=JSON.parse(prepared.wire.body),body=JSON.parse(native.wire.body);
  if(digest(original.tools??[])!==digest(body.tools??[])||digest(original.instructions??null)!==digest(body.instructions??null)||body.model!==original.model)
    throw new TypeError("helarc_native_selected_task_contract_changed");
  const instructionMessages=(items:unknown)=>Array.isArray(items)?items.filter(item=>item?.role==="system"||item?.role==="developer"):[];
  if(digest(instructionMessages(original.messages))!==digest(instructionMessages(native.manifest.groups.flatMap(g=>g.items))))
    throw new TypeError("helarc_native_selected_instructions_changed");
  const settings=(value:JsonObject)=>{const {input:_,messages:__,previous_response_id:___,conversation:____,store:_____,context_management:______,...rest}=value;return rest;};
  if(digest(settings(original))!==digest(settings(body)))throw new TypeError("helarc_native_selected_request_settings_changed");
  const path=b.protocol.id==="openai.responses"?"input":"messages",items=body[path],pending=notifications(input.inputDelivery);
  if(!Array.isArray(items))throw new TypeError("helarc_native_selected_items_missing");
  const allItems=native.manifest.groups.flatMap(g=>g.items),workingItems=path==="messages"&&allItems[0]?.role==="system"?allItems.slice(1):allItems;
  if(!native.workingSources)throw new TypeError("helarc_native_selected_sources_missing");
  validateHelarcNativeWorkingSources(native.workingSources,workingItems);
  const adopted={...prepared,selectedInputId:inputId,wire:native.wire,
    workingItems,workingSources:native.workingSources,
    resultPresentations:native.resultPresentations??[],
    results:prepared.results.map(result=>{
      const presentations=(native.resultPresentations??[]).filter(p=>p.slot.callId===result.callId);
      if(presentations.length){
        const positions=new Set(presentations.map(p=>p.position)),position=presentations[0]!.position,match=new RegExp(`^/${path}/(\\d+)$`).exec(position);
        const item=match?items[Number(match[1])]:null;
        if(positions.size!==1||!item)throw new TypeError("helarc_native_selected_result_position_invalid");
        const originalIndex=Number(result.position.split("/").at(-1)),originalItem=original[path][originalIndex];
        const envelope=(value:JsonObject)=>{const {output:_,content:__,...rest}=value;return rest;};
        if(digest(envelope(item))!==digest(envelope(originalItem)))throw new TypeError("helarc_native_selected_result_envelope_changed");
        return {...result,position,contentDigest:digest(item)};
      }
      const indices=items.flatMap((item,index)=>digest(item)===result.contentDigest?[index]:[]);
      if(indices.length!==1)throw new TypeError("helarc_native_selected_result_mapping_required");
      return {...result,position:`/${path}/${indices[0]}`};
    }),
    delivery:(input.inputDelivery?.entries??[]).map((entry,i)=>({sequence:entry.sequence,position:`/${path}/${items.length-pending.length+i}`,contentDigest:digest(pending[i])}))};
  validateHelarcNativeTaskDelivery(adopted,input);
  helarcNativeTaskResultDeliveries(adopted,input);
  if(adopted.resultPresentations.length){
    if(!resultSelection)throw new TypeError("helarc_native_result_selection_validation_required");
    await validateHelarcNativeResultSelection(adopted,input,selected,resultSelection);
  }
  return adopted;
}
