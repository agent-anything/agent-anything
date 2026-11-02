import {validateContextProcessEvidence,type ContextProcessObjectRef} from "@agent-anything/context/evidence";
import {inspectionLink} from "@agent-anything/inspection/adapters";
import type {ContextFoundationFact} from "../execution-storage/ContextFoundationRecords.js";
import type {InspectionProjectionSink,InspectionProjectionRefs} from "./InspectionReplay.js";
import type {InspectionRecordInput,InspectionJudgmentContent} from "@agent-anything/inspection/records";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {processEvidenceRecords} from "./ProcessEvidenceProjection.js";

/** Presentation consumes declared relationships; private detail content supplies no graph semantics. */
export function recordContextProcessEvidence(fact:ContextFoundationFact,r:InspectionProjectionSink):void {
  for(const record of contextProcessInspectionRecords(fact,r))r.offer(record);
}
export function* contextProcessInspectionRecords(fact:ContextFoundationFact,r:InspectionProjectionRefs):Generator<InspectionRecordInput> {
  const evidence=fact.evidence;
  if(!evidence)throw new Error("context_process_evidence_missing");
  validateContextProcessEvidence(evidence);
  if(evidence.subject.id!==fact.subject||evidence.subject.runId!==fact.runId)throw new Error("context_process_evidence_scope_invalid");
  const ref=(value:ContextProcessObjectRef)=>r.ref(value.owner,"contribution",value.id,value.runId,value.revision);
  const event=r.ref(fact.owner,"event",`${fact.runId}:context-fact:${fact.sequence}`,fact.runId);
  const subject=ref(evidence.subject);
  if(evidence.reuse)for(const [field,metric] of [["eligibility","reuse_eligibility"],["content","reuse_content"],["checks","reuse_check"],["input","reuse_input"]] as const){
    const value=evidence.reuse[field];if(value===undefined)continue;
    yield {subject,occurredAt:fact.occurredAt,payload:{kind:"work_measurement",version:"1",
      origin:{owner:`context:${fact.owner}`,id:`${fact.sequence}:${metric}`,runId:fact.runId,revision:"1"},purpose:evidence.scope?.purpose??null,target:null,
      data:{kind:"quantity",metric,unit:"count",evidence:"actual",value,upper:null,method:evidence.reuse.basis,complete:true}}};
  }
  const judgment:InspectionJudgmentContent|undefined=evidence.judgment?{version:"1",...evidence.judgment}:undefined;
  if(evidence.state)yield {subject,occurredAt:fact.occurredAt,
    payload:{kind:"execution",executionKind:fact.owner,phase:evidence.state.phase,status:evidence.state.status,code:null,effectCertainty:null},
    contents:[{name:"Owner-declared context evidence",class:"agent",stage:fact.kind,mediaType:"application/json",value:JSON.parse(JSON.stringify(fact.details))}]};
  const relatedLinks=[];
  for(const [index,related] of evidence.related.entries()){
    const observation=r.ref(fact.owner,"event",`${event.id}:related:${index}`,fact.runId);
    yield {subject:observation,occurredAt:related.occurredAt,payload:{kind:"event",name:related.name,sequence:fact.sequence,code:null},
      contents:[{name:related.name,class:"agent",stage:"observed",mediaType:"application/json",value:JSON.parse(JSON.stringify(related.value))}]};
    relatedLinks.push(inspectionLink("includes",event,observation),inspectionLink("observes",observation,ref(related.subject)));
  }
  yield* processEvidenceRecords(r,{observation:event,occurredAt:fact.occurredAt,evidence:{origin:{owner:`context:${fact.owner}`,id:String(fact.sequence),runId:fact.runId,revision:"1"},digest:modelInputValueDigest(fact),
    subject,category:evidence.category,name:`${fact.owner}.${fact.kind}`,status:evidence.state?.status??null,purpose:evidence.scope?.purpose??null,recipient:evidence.scope?.recipient??null,
    ...(judgment?{judgment:{foreground:judgment.foreground,investment:judgment.investment,adoption:judgment.adoption,detailsContentOrdinal:1}}:{})},
    contents:[{name:"Context ownership and accepted relationships",class:"agent",stage:fact.kind,mediaType:"application/json",value:JSON.parse(JSON.stringify(fact))},
      ...(judgment?[{name:"Owner-declared context judgment",class:"agent" as const,stage:"context_judgment",mediaType:"application/json" as const,value:judgment}]:[])],links:[
    inspectionLink("includes",r.ref("runtime","run",fact.runId,fact.runId),subject),inspectionLink("includes",subject,event),
    ...relatedLinks,
    ...evidence.relationships.map(edge=>inspectionLink(edge.kind,ref(edge.from),ref(edge.to),{condition:edge.condition,operation:edge.operation})),
  ]});
}
