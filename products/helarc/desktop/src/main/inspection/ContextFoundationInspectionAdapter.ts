import {InspectionRecorder} from "@agent-anything/inspection/recording";
import {inspectionLink} from "@agent-anything/inspection/adapters";
import type {ContextFoundationFact,ContextFoundationObserver} from "../execution-storage/ContextFoundationRecords.js";

/** Links only recorded relationships; an access is not a delivery or semantic support. */
export class ContextFoundationInspectionAdapter implements ContextFoundationObserver {
  constructor(private readonly recorder:InspectionRecorder) {}
  observe(fact:ContextFoundationFact):void {
    const r=this.recorder,subject=r.ref(fact.owner,"event",`${fact.runId}:context-fact:${fact.sequence}`,fact.runId);
    const object=r.ref(fact.owner,"contribution",fact.subject,fact.runId);
    r.offer({subject:object,occurredAt:fact.occurredAt,payload:{kind:"execution",phase:["accepted","disposed","input_retired","content_deleted"].includes(fact.kind)?"settled":"pending",
      executionKind:fact.owner,status:fact.kind,code:null,effectCertainty:null}});
    const links=[inspectionLink("includes",r.ref("runtime","run",fact.runId,fact.runId),object),inspectionLink("includes",object,subject)];
    for(const [field,owner] of [["instanceId","material_custody"],["selectionId","context_selection"],["inputId","context_selection"],
      ["acceptanceId","shared_acceptance"],["activityId","activity"],["responseId","activity"],["holdId","material_custody"],["detailHoldId","material_custody"]] as const) {
      const id=fact.details[field];if(typeof id==="string")links.push(inspectionLink("includes",r.ref(owner,"contribution",id,fact.runId),subject));
    }
    if(typeof fact.details.sourceRunId==="string"&&typeof fact.details.sourceId==="string")links.push(inspectionLink("produces",r.ref("context","contribution",fact.details.sourceId,fact.details.sourceRunId),subject));
    if(fact.owner==="representation"&&Array.isArray(fact.details.inputs))for(const input of fact.details.inputs){
      if(input&&typeof input==="object"){
        const value=input as {role?:unknown;material?:{materialId?:unknown;version?:unknown};representation?:{id?:unknown;revision?:unknown}};
        if(typeof value.representation?.id==="string"&&typeof value.representation.revision==="string")links.push(inspectionLink(value.role==="source"?"transforms":"includes",
          r.ref("representation","contribution",JSON.stringify([value.representation.id,value.representation.revision]),fact.runId),object));
        if(typeof value.material?.materialId==="string"&&typeof value.material.version==="string")links.push(inspectionLink("includes",
          r.ref("material_custody","contribution",value.material.materialId,null,value.material.version),object));
      }
    }
    if(fact.owner==="representation"&&fact.details.method&&typeof fact.details.method==="object") {
      const method=fact.details.method as {activityId?:unknown;rawResultId?:unknown;acceptanceId?:unknown};
      for(const [id,owner,relation] of [[method.activityId,"activity","produces"],[method.rawResultId,"activity","transforms"],[method.acceptanceId,"shared_acceptance","settles"]] as const)
        if(typeof id==="string")links.push(inspectionLink(relation,r.ref(owner,"contribution",id,fact.runId),object));
    }
    if(fact.owner==="context_delivery"&&fact.kind==="accepted"&&typeof fact.details.inputId==="string")links.push(inspectionLink("delivers",object,r.ref("context_selection","contribution",fact.details.inputId,fact.runId)));
    if(fact.kind==="read"||fact.kind==="search"||fact.kind==="structure_read")links.push(inspectionLink("observes",subject,r.ref("material_custody","contribution",String(fact.details.instanceId),fact.runId)));
    r.offer({subject,occurredAt:fact.occurredAt,payload:{kind:"event",name:`${fact.owner}.${fact.kind}`,sequence:fact.sequence,code:null},links,
      contents:[{name:"Context ownership and accepted relationships",class:"agent",stage:fact.kind,mediaType:"application/json",value:JSON.parse(JSON.stringify(fact))}]});
  }
  async replay(runId:string,read:(runId:string,after:number,limit:number)=>Promise<readonly ContextFoundationFact[]>):Promise<void> {
    let after=0;
    while(true){const facts=await read(runId,after,128);for(const fact of facts)this.observe(fact);if(facts.length<128)return;after=facts.at(-1)!.sequence;}
  }
}
