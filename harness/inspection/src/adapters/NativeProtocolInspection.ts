import {createHash} from "node:crypto";
import type {InspectionJson,InspectionRecordInput,InspectionSubjectRef} from "../records/index.js";
import {inspectionLink,inspectionContentId} from "./ProviderInspectionAdapter.js";

export interface NativeInspectionBinding {
  readonly subject:InspectionSubjectRef;
  readonly protocol:{readonly id:string;readonly revision:string};
  readonly interpretation:{readonly id:string;readonly revision:string};
}
export interface NativeInspectionCapture {
  readonly identity:string;readonly category:string;readonly operationId:string|null;
  readonly occurredAt:string|null;readonly origin:"live"|"import";
  readonly source:InspectionSubjectRef;readonly value:unknown;readonly unavailableReason?:string;
}
const object=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:{};
const bounded=(v:unknown):string|null=>typeof v==="string"?v.slice(0,512):null;
const items=(v:unknown):unknown[]=>Array.isArray(v)?v:[];
const key=(v:unknown)=>createHash("sha256").update(JSON.stringify(v)).digest("hex");
const readers:Record<string,string>={"openai.responses":"openai.responses.adapter","deepseek.chat-completions":"deepseek.chat-completions.adapter","ollama.chat":"ollama.chat.adapter"};
function details(value:Record<string,unknown>,supported:boolean){
  if(!supported)return [];
  return ["name","role","call_id","sequence_number","finish_reason","done","done_reason","operation","method","startingAfter",
    "input_tokens","output_tokens","total_tokens","prompt_tokens","completion_tokens","cached_tokens","reasoning_tokens",
    "prompt_eval_count","eval_count","total_duration","load_duration","prefixGroups","predecessor","remotePrefix","selectedInputId",
    "amount","currency","basis","known","provisional","reason","coverage","cancelled","retentionReleased",
    "workId","revision","usageRevision","purpose","usageState","finality","inputTokens","inputState","outputTokens","outputState",
    "cacheReadTokens","cacheReadState","cacheWriteTokens","cacheWriteState","exposure","localReleased","reconciliationOwner",
    "heldReservations","costRevision","costCoverage","pricedSubtotalsJson","previous_response_id","allowed","inputId","requestDigest",
    "enabled","evidenceKind","profileId","actualConversionObserved","internalSourceCoverage","semanticPreservation","purposeAccepted"]
    .flatMap(name=>{const v=value[name];return v===null||typeof v==="string"||typeof v==="number"||typeof v==="boolean"?
      [{name,value:v===null?null:String(v).slice(0,512)}]:[];});
}
export function supportsNativeInspection(binding:NativeInspectionBinding):boolean {
  return binding.protocol.revision==="1"&&readers[binding.protocol.id]===binding.interpretation.id&&binding.interpretation.revision==="1";
}

/** Read-only protocol vocabulary; never a runtime Adapter or a task interpreter. */
export function *nativeInspectionRecords(binding:NativeInspectionBinding,capture:NativeInspectionCapture):Iterable<InspectionRecordInput>{
  const supported=supportsNativeInspection(binding),v=object(capture.value);
  const ref=(owner:string,kind:InspectionSubjectRef["kind"],id:string,revision:string|null=null):InspectionSubjectRef=>
    ({...binding.subject,owner,kind,id,revision});
  const make=(suffix:string,category:string,nativeType:string,value:unknown,position:string|null=null):InspectionRecordInput=>{
    const item=object(value),unavailable=capture.unavailableReason;
    const id=`native-view:${key([binding.subject,capture.origin,capture.identity,suffix])}`;
    return {id,subject:binding.subject,occurredAt:capture.occurredAt,
      payload:{kind:"native_fact",details:details(item,supported),category,nativeType:nativeType.slice(0,512),nativeId:bounded(item.id??item.call_id),
        operationId:capture.operationId,position,status:bounded(item.status??item.finish_reason),origin:capture.origin,
        limitation:unavailable??(!supported?"native_reader_unavailable":null)},
      links:[inspectionLink("observes",capture.source,binding.subject,{targetLocation:{contentId:inspectionContentId(id),partId:null,jsonPointer:"",stage:category}})],
      contents:[{name:nativeType,class:"provider",stage:category,mediaType:"application/json",value:(value??null) as InspectionJson,
        ...(unavailable?{unavailableReason:unavailable}:{})}]};
  };
  if(capture.unavailableReason){yield make("raw",capture.category,"Original evidence",null);return;}
  if(capture.category==="admission_reserved"||capture.category==="admission_closed"){
    const activity=object(v.activity);
    yield make("admission","admission","Native admission reservation",{status:v.status??null,closedBy:v.closedBy??null,
      scope:activity.scope??null,conditions:activity.conditions??null,executionAccepted:false});return;
  }
  if(v.kind==="protocol_input_rejection"){
    yield make("refusal","input","Confirmed native input refusal",v);
    yield make("delivery","continuity","Unfulfilled input delivery",{inputId:v.inputId??null,boundary:v.boundary??null,
      reason:v.reason??null,taskResponseAccepted:false});return;
  }
  if(capture.category==="input_use_settled"){
    yield make("input-use","retirement","Input use settled without receipt",v);return;
  }
  if(capture.category==="prepared"){
    // Export the declared purpose/input, never private connection/session custody.
    if(v.format==="helarc.responses-count-request.v1"&&binding.protocol.id==="openai.responses"){
      const count=object(v.count),basis=object(count.binding);
      yield make("binding","binding","Original input counting purpose",{scope:object(v.activity).scope??null,
        inputId:basis.encodedInputId??null,targetRevision:basis.targetRevision??null,requestId:count.id??null});
      yield make("prepared","input","Native input_tokens request",count.body??null,"/count/body");
      yield make("coverage","measurement","Counting coverage and dependencies",{
        mappings:count.mappings??null,coverage:count.coverage??null,uncovered:count.uncovered??null,dispatchBlock:count.dispatchBlock??null,
        targetValidity:basis.targetValidity??null,prefix:basis.prefix??null,dependencies:basis.dependencies??null},"/count");
      const allowance=object(v.allowance),record=make("allowance","measurement","Original measurement allowance",{
        ...allowance,inputId:basis.encodedInputId??null,generationDigest:object(count.generation).digest??null,sourceDigest:basis.sourceDigest??null},"/allowance");
      const related=[...record.links??[]];
      if(typeof allowance.stageId==="string")related.push(inspectionLink("binding",ref("activity","contribution",allowance.stageId),binding.subject));
      if(typeof allowance.sourcePathId==="string")related.push(inspectionLink("binding",ref("activity-resource","contribution",JSON.stringify([allowance.sourcePathId,"measurementCalls"])),binding.subject));
      yield {...record,links:related};
      return;
    }
    if(v.format==="helarc.responses-compact-request.v1"&&binding.protocol.id==="openai.responses"){
      const compact=object(v.binding),source=object(v.source),prepared=object(compact.prepared);
      let body:unknown=null;
      try{if(typeof prepared.encoded==="string")body=JSON.parse(prepared.encoded);}catch{/* Original input remains explicitly unavailable. */}
      yield make("binding","binding","Original compact purpose binding",{scope:object(v.activity).scope??null,
        sourceDigest:source.sourceDigest??null,operationId:compact.id??null});
      yield make("prepared","input","Prepared compact input",body,"/binding/prepared/encoded");
      yield make("source","transformation","Compact source requirements",{groups:source.groups??null,dependencies:source.dependencies??null,
        duties:source.duties??null,dutyBasis:source.dutyBasis??null,ancestry:source.ancestry??null},"/source");
      return;
    }
    const wire=object(v.wire);let body:unknown=null;
    try{if(typeof wire.body==="string")body=JSON.parse(wire.body);}catch{/* Missing/invalid body stays explicit. */}
    yield make("binding","binding","Original purpose binding",v.binding??{source:v.source??null,schema:v.schema??null,mappingRevision:v.mappingRevision??null});
    if(body!==null)yield make("prepared","input","Prepared native input",body,"/wire/body");
    if(v.inputPreparation){
      const preparation=object(v.inputPreparation),assessment=object(preparation.assessment);
      const record=make("input-preparation","measurement","Auxiliary complete-input admission",{
        ...preparation,allowed:assessment.allowed??null,status:assessment.allowed===true?"submission_permitted":"submission_blocked",
        dispatched:false,purposeAccepted:false},"/inputPreparation");
      const source=object(preparation.source),related=[...record.links??[]];
      if(typeof source.id==="string"&&typeof source.revision==="string")related.push(inspectionLink("binding",
        ref("model-input-source","contribution",source.id,source.revision),binding.subject));
      for(const item of items(assessment.refusals)){
        const refusal=object(item),origin=object(refusal.source);
        if(origin.owner==="protocol_execution"&&typeof origin.id==="string"&&typeof origin.revision==="string")
          related.push(inspectionLink("observes",binding.subject,ref("protocol-execution","model-activity",origin.id,origin.revision)));
      }
      yield {...record,links:related};
    }
    if(v.delivery)yield make("delivery","input","Input source mapping",v.delivery,"/delivery");
    if(v.resultPresentations)yield make("results","input","Selected result representations",v.resultPresentations,"/resultPresentations");
    if(body!==null){const b=object(body);yield make("continuity","continuity","Input continuity boundary",{
      selectedInputId:v.selectedInputId??null,predecessor:b.previous_response_id??null,
      remotePrefix:b.previous_response_id?"not established by the outgoing suffix":"explicit input"});}
    return;
  }
  if(capture.category==="selected_input"){
    yield make("selected","input","Complete selected input",v.manifest??null,"/manifest");
    yield make("continuity","continuity","Selected continuity evidence",{prefixGroups:v.prefixGroups??null,predecessor:v.predecessor??null,continuity:v.continuity??null});
    if(v.compactionAgreement){
      const agreement=object(v.compactionAgreement),evidence=object(agreement.useEvidence),use=object(evidence.use),policy=object(use.policy);
      yield make("compaction","transformation","Compaction agreement",v.compactionAgreement);
      if(agreement.useEvidence){
        const record=make("compaction-admission","transformation","In-request compaction use admission",{
          ...evidence,enabled:use.enabled??null,evidenceKind:policy.origin??null,profileId:evidence.profileId??null,
          status:"agreement_accepted",actualConversionObserved:false,quality:agreement.quality??null});
        yield {...record,links:[...record.links??[],...typeof evidence.id==="string"?
          [inspectionLink("observes",binding.subject,ref("helarc-native-input","contribution",evidence.id,"1"))]:[]]};
      }
    }
    return;
  }
  if(capture.category==="measurement"){
    yield make("measurement","measurement","Native input measurement",v);
    if(v.observation)yield make("http","observation","Counting HTTP observation",v.observation,"/observation");
    if(v.raw)yield make("response","output","input_tokens response",v.raw,"/raw");
    return;
  }
  if(!supported){yield make("raw",capture.category,"Original evidence",capture.value);return;}
  let native=v;
  if(v.kind==="body"||v.kind==="websocket"){
    try{native=object(JSON.parse(String(v.data)));}catch{yield make("segment","observation",String(v.kind),v);return;}
  }else if(v.kind==="http"){
    yield make("segment","observation",bounded(object(v.part).kind)??"http",v);
    for(const [i,frame]of items(object(v.part).frames).entries()){
      try{const parsed=JSON.parse(String(object(frame).data));
        yield* nativeInspectionRecords(binding,{...capture,identity:`${capture.identity}:frame:${i}`,category:"event",value:parsed});
      }catch{/* Framing evidence remains available when a frame is not JSON. */}
    }
    return;
  }else if(v.kind==="dispatch"){
    let body:unknown=v.body;try{if(typeof body==="string")body=JSON.parse(body);}catch{/* Non-JSON remains captured text. */}
    let endpoint:string|null=null;try{const url=new URL(String(v.url));url.username="";url.password="";url.search="";url.hash="";endpoint=url.toString();}catch{/* Route is not inferred. */}
    yield make("dispatch","sent",bounded(v.operation)??"dispatch",{operation:v.operation??null,method:v.method??null,endpoint,body:body??null,startingAfter:v.startingAfter??null});return;
  }
  yield make("source",capture.category,bounded(native.type??native.object??native.kind)??capture.category,native);
  if(binding.protocol.id==="openai.responses"){
    const response=object(native.response??native);
    for(const [i,item] of items(response.output).entries()){
      const entry=object(item),position=`${native.response?"/response":""}/output/${i}`;
      yield make(`output:${i}`,"output",bounded(entry.type)??"unknown",item,position);
      if(response.object==="response"&&entry.type==="compaction")yield make(`conversion:${i}`,"transformation","Observed in-request compaction item",{
        id:entry.id??null,responseId:response.id??null,actualConversionObserved:true,internalSourceCoverage:"unknown",
        semanticPreservation:"not_established_by_observation",purposeAccepted:"not_implied"},position);
    }
    if(response.usage){yield make("usage","accounting","Response usage observation",response.usage,`${native.response?"/response":""}/usage`);
      for(const field of ["input_tokens_details","output_tokens_details"])if(object(response.usage)[field])yield make(field,"accounting",field,object(response.usage)[field]);}
    if(response.previous_response_id)yield make("predecessor","continuity","previous_response_id",{previous_response_id:response.previous_response_id},"/previous_response_id");
  }else if(binding.protocol.id==="deepseek.chat-completions"){
    for(const [i,choice] of items(native.choices).entries())yield make(`choice:${i}`,"output","choice",choice,`/choices/${i}`);
    if(native.usage)yield make("usage","accounting","Completion usage observation",native.usage,"/usage");
  }else if(binding.protocol.id==="ollama.chat"){
    if(native.message)yield make("message","output","message",native.message,"/message");
    if(native.done!==undefined)yield make("metrics","accounting","Chat completion metrics",Object.fromEntries(
      ["done","done_reason","total_duration","load_duration","prompt_eval_count","prompt_eval_duration","eval_count","eval_duration"].filter(k=>native[k]!==undefined).map(k=>[k,native[k]])));
  }
}
