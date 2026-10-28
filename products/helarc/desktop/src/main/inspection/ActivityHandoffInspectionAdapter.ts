import {InspectionRecorder} from "@agent-anything/inspection/recording";
import {inspectionLink} from "@agent-anything/inspection/adapters";
import type {ActivityHandoffFact, ActivityHandoffObserver} from "@agent-anything/agent-runtime/activity";

export class ActivityHandoffInspectionAdapter implements ActivityHandoffObserver {
  constructor(private readonly recorder: InspectionRecorder) {}
  observe(fact: ActivityHandoffFact): void {
    const r = this.recorder;
    const subject = r.ref("activity","event",`${fact.runId}:handoff:${fact.sequence}`,fact.runId);
    const path = r.ref("activity","contribution",fact.pathId,fact.runId);
    const stage = fact.requestId ? r.ref("activity","contribution",fact.requestId,fact.runId) : null;
    if(stage)r.offer({subject:stage,occurredAt:fact.occurredAt,payload:{kind:"execution",phase:fact.kind==="accepted"?"settled":fact.kind==="dispatched"?"started":"pending",
      executionKind:"purpose_bound_stage",status:fact.kind,code:null,effectCertainty:null}});
    const related=[];
    if(stage&&Array.isArray(fact.details.dependencies))for(const dependency of fact.details.dependencies){
      if(dependency&&typeof dependency==="object"&&typeof dependency.requestId==="string")related.push(inspectionLink("prerequisite",r.ref("activity","contribution",dependency.requestId,fact.runId),stage));
    }
    if(stage&&typeof fact.details.resultId==="string")related.push(inspectionLink("produces",stage,r.ref("activity","contribution",fact.details.resultId,fact.runId)));
    if(stage&&typeof fact.details.receiptId==="string")related.push(inspectionLink("settles",r.ref("shared_acceptance","contribution",fact.details.receiptId,fact.runId),stage));
    r.offer({subject,occurredAt:fact.occurredAt,payload:{kind:"event",name:`activity.${fact.kind}`,sequence:fact.sequence,code:null},
      links:[inspectionLink("includes",r.ref("runtime","run",fact.runId,fact.runId),path),inspectionLink("includes",path,subject),
        ...(stage ? [inspectionLink("includes",path,stage),inspectionLink("includes",stage,subject)] : []),...related,
        ...(stage && typeof fact.details.modelRequestId === "string" ? [inspectionLink("includes",stage,r.ref("model-interaction","request",fact.details.modelRequestId,fact.runId))] : [])],
      contents:[{name:"Durable activity handoff",class:"execution",stage:fact.kind,mediaType:"application/json",value:JSON.parse(JSON.stringify(fact))}]});
  }
  async replay(runId:string,port:import("@agent-anything/agent-runtime/activity").ActivityHandoffPort): Promise<void> {
    let after = 0;
    while (true) {
      const facts = await port.command({kind:"facts",runId,after,limit:128}) as readonly ActivityHandoffFact[];
      for (const fact of facts) this.observe(fact);
      if (facts.length < 128) return;
      after = facts.at(-1)!.sequence;
    }
  }
}
