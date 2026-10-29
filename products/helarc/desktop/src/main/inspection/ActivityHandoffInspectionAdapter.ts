import {InspectionRecorder} from "@agent-anything/inspection/recording";
import {inspectionLink} from "@agent-anything/inspection/adapters";
import type {ActivityHandoffFact, ActivityHandoffObserver,ActivityStageState} from "@agent-anything/agent-runtime/activity";

export class ActivityHandoffInspectionAdapter implements ActivityHandoffObserver {
  constructor(private readonly recorder: InspectionRecorder) {}
  observeStage(runId:string,stage:ActivityStageState):void {
    const r=this.recorder,subject=r.ref("activity","contribution",stage.request.id,runId);
    const contents:NonNullable<Parameters<InspectionRecorder["offer"]>[0]["contents"]>[number][]=
      [{name:"Submitted stage input",class:"agent",stage:"input",mediaType:"application/json",value:JSON.parse(JSON.stringify(stage.request.input))}];
    if(stage.result) {
      contents.push({name:"Durable stage result",class:"agent",stage:"result",mediaType:"application/json",value:JSON.parse(JSON.stringify(stage.result))});
      r.offer({subject:r.ref("activity","contribution",stage.result.id,runId),occurredAt:stage.result.recordedAt,
        payload:{kind:"execution",phase:"settled",executionKind:"durable_raw_result",status:stage.result.outcome,code:null,effectCertainty:null},
        links:[inspectionLink("produces",subject,r.ref("activity","contribution",stage.result.id,runId))],
        contents:[{name:"Original result and measured usage",class:"agent",stage:"raw",mediaType:"application/json",value:JSON.parse(JSON.stringify(stage.result))}]});
    }
    const raw=stage.result?.value as {kind?:string;prepared?:import("@agent-anything/agent-runtime/context-representation").PreparedContextInput}|null;
    const accepted=stage.receipt?.progress as {state?:string;prepared?:import("@agent-anything/agent-runtime/context-representation").PreparedContextInput}|null;
    const prepared=accepted?.state==="prepared"?accepted.prepared:raw?.kind==="prepared"?raw.prepared:(stage.request.input as {kind?:string})?.kind==="prepared_context_input"?
      stage.request.input as import("@agent-anything/agent-runtime/context-representation").PreparedContextInput:undefined;
    const links=[];
    const method=(stage.receipt?.progress as {method?:import("@agent-anything/agent-runtime/context-representation").RepresentationMethodProgress})?.method;
    if(method) {
      contents.push({name:"Professional method progress and coverage",class:"agent",stage:"method",mediaType:"application/json",value:JSON.parse(JSON.stringify({state:method.state,current:method.current,queue:method.queue,
        sourceBoundary:method.request.sourceBoundary,deliveriesNotConsumedByMethod:method.request.deliveryIds,readPages:method.pages,rangeUnits:method.rangeUnits,candidates:method.candidates,assessments:method.assessments,checkGroups:method.checkGroups,resultIds:method.resultIds,gap:method.gap,
        resources:{readBytes:method.readBytes,storedBytes:method.storedBytes,modelCalls:method.modelCalls},interpretationMs:stage.receipt?.interpretationMs??null,executionUsage:stage.result?.usage??null}))});
      for(const candidate of method.candidates)if(stage.request.id===`${candidate.generatedBy}:dispatch`||candidate.generatedBy.startsWith(`${stage.request.id}:`))
        links.push(inspectionLink("produces",subject,r.ref("representation","contribution",JSON.stringify([candidate.representation.id,candidate.representation.revision]),runId)));
      for(const assessment of method.assessments)if(assessment.rawResultId===stage.result?.id)
        links.push(inspectionLink("produces",subject,r.ref("representation","contribution",assessment.id,runId)));
    }
    if(prepared) {
      contents.push({name:"Encoded model input",class:"agent",stage:"encoded",mediaType:"text/plain",value:prepared.encoded.body},
        {name:"Input allocation, measurement and source positions",class:"agent",stage:"capacity",mediaType:"application/json",
          value:JSON.parse(JSON.stringify({demand:prepared.demand.id,historyBoundary:prepared.demand.historyBoundary,choice:prepared.choice,locations:prepared.locations,deliveries:prepared.deliveries,
            allocation:prepared.allocation,measurement:prepared.measurement,capacity:prepared.capacity,progress:prepared.progress}))});
      links.push(inspectionLink("produces",subject,r.ref("model-input","contribution",prepared.encoded.id,runId)),
        inspectionLink("includes",r.ref("activity","contribution",prepared.preparationStageId,runId),subject));
      r.offer({subject:r.ref("model-input","contribution",prepared.encoded.id,runId),occurredAt:stage.result?.recordedAt??null,
        payload:{kind:"execution",phase:"settled",executionKind:"prepared_model_input",status:"prepared",code:null,effectCertainty:null},
        contents:[{name:"Prepared encoded input (not proof of sending)",class:"agent",stage:"encoded",mediaType:"text/plain",value:prepared.encoded.body}]});
      if(stage.request.stageKind==="model") {
        const request=r.ref("model-interaction","request",prepared.request.requestId,runId);
        links.push(inspectionLink("includes",subject,request));
        r.offer({subject:request,occurredAt:stage.attempt?.startedAt??null,payload:{kind:"request",purpose:prepared.request.purpose,providerId:prepared.request.composition.providerId,
          model:prepared.request.composition.model,compositionId:prepared.request.composition.id,messageCount:prepared.request.messages.length,
          toolCount:prepared.request.interaction.kind==="native_tool_turn"?prepared.request.interaction.callables.length:0},
          links:[inspectionLink("materializes",r.ref("model-input","contribution",prepared.encoded.id,runId),request),...(stage.result?[inspectionLink("produces",request,r.ref("activity","contribution",stage.result.id,runId))]:[])],
          contents:[{name:"Accepted request and dispatch state",class:"agent",stage:"request",mediaType:"application/json",value:JSON.parse(JSON.stringify({request:prepared.request,state:stage.status,attempt:stage.attempt,encoded:prepared.encoded}))}]});
      }
    }
    r.offer({subject,occurredAt:stage.result?.recordedAt??null,payload:{kind:"execution",phase:stage.status==="accepted"?"settled":stage.status==="dispatched"?"started":"pending",
      executionKind:"purpose_bound_stage",status:stage.status,code:null,effectCertainty:null},links,contents});
  }
  observe(fact: ActivityHandoffFact): void {
    const r = this.recorder;
    const subject = r.ref("activity","event",`${fact.runId}:handoff:${fact.sequence}`,fact.runId);
    const path = r.ref("activity","contribution",fact.pathId,fact.runId);
    const stage = fact.requestId ? r.ref("activity","contribution",fact.requestId,fact.runId) : null;
    if(stage)r.offer({subject:stage,occurredAt:fact.occurredAt,payload:{kind:"execution",phase:fact.kind==="accepted"?"settled":fact.kind==="dispatched"?"started":"pending",
      executionKind:"purpose_bound_stage",status:fact.kind,code:null,effectCertainty:null}});
    const related=[];
    if(stage&&Array.isArray(fact.details.dependencies))for(const dependency of fact.details.dependencies){
      if(dependency&&typeof dependency==="object"&&typeof dependency.requestId==="string"&&["accepted","raw_result"].includes(String(dependency.condition)))
        related.push(inspectionLink("prerequisite",r.ref("activity","contribution",dependency.requestId,fact.runId),stage,
          {condition:dependency.condition==="accepted"?"settled":"result",operation:`activity:${dependency.condition}`}));
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
      for (const fact of facts) {
        this.observe(fact);
        if(fact.requestId && ["stage_submitted","raw_saved","accepted"].includes(fact.kind)) {
          const stage=await port.command({kind:"read_stage",requestId:fact.requestId}) as ActivityStageState|null;
          if(stage)this.observeStage(runId,stage);
        }
      }
      if (facts.length < 128) return;
      after = facts.at(-1)!.sequence;
    }
  }
}
