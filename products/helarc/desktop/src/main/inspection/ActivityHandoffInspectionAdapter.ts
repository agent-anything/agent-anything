import {randomUUID} from "node:crypto";
import {contextStageObservation,contextActivityFactObservation} from "@agent-anything/agent-runtime/context-representation";
import {taskModelStageObservation} from "@agent-anything/agent-runtime/decision";
import {InspectionRecorder} from "@agent-anything/inspection/recording";
import {inspectionLink,inspectionContentId} from "@agent-anything/inspection/adapters";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {processEvidenceRecords,processObservationRef} from "./ProcessEvidenceProjection.js";
import {stageMeasurements,responsibilityMeasurement} from "./ActivityMeasurementProjection.js";
import type {InspectionRecordInput} from "@agent-anything/inspection/records";
import {replayInspectionRecords, type InspectionProjectionSink,type InspectionProjectionRefs} from "./InspectionReplay.js";
import type {ActivityHandoffFact, ActivityHandoffObserver,ActivityPathState,ActivityStageState,ActivitySchedulingAcceptance,ActivitySchedulingDispatch,
  ActivityPublishedFact,ActivityReconsiderationReceipt,ActivityReconsiderationSubscription} from "@agent-anything/agent-runtime/activity";

export class ActivityHandoffInspectionAdapter implements ActivityHandoffObserver {
  constructor(private readonly recorder: InspectionRecorder) {}
  observeTiming(event:import("@agent-anything/agent-runtime/activity").ActivityTimingObservation):void {
    const r=this.recorder,subject=r.ref("activity-timing","event",event.id,event.scope.runId);
    r.offer({subject,occurredAt:event.occurredAt,payload:{kind:"work_timing",version:"1",intervalId:event.id,...event.scope,
      phase:event.phase,boundary:event.kind,clock:event.clock,durationMs:event.durationMs,outcome:event.outcome},
      links:[inspectionLink("observes",subject,r.ref("activity","contribution",event.scope.stageId,event.scope.runId)),
        ...(event.scope.attemptId?[inspectionLink("observes",subject,r.ref("activity","attempt",event.scope.attemptId,event.scope.runId))]:[])],
      contents:[{name:"Original work timing and clock scope",class:"execution",stage:"timing",mediaType:"application/json",value:JSON.parse(JSON.stringify(event))}]});
  }
  observeStage(path:ActivityPathState,stage:ActivityStageState,r:InspectionProjectionSink=this.recorder):void {
    for(const record of this.stageRecords(path,stage,r))r.offer(record);
  }
  private *stageRecords(path:ActivityPathState,stage:ActivityStageState,r:InspectionProjectionRefs):Generator<InspectionRecordInput> {
    const runId=path.intent.runId;
    const context=contextStageObservation(path,stage),task=taskModelStageObservation(path,stage);
    yield* stageMeasurements(r,path,stage,context);
    const subject=r.ref("activity","contribution",stage.request.id,runId);
    const contents:NonNullable<Parameters<InspectionRecorder["offer"]>[0]["contents"]>[number][]=
      [{name:"Submitted stage input",class:"agent",stage:"input",mediaType:"application/json",value:JSON.parse(JSON.stringify(stage.request.input))},
        {name:"Stage execution evidence",class:"execution",stage:"evidence",mediaType:"application/json",value:{
          requestId:stage.request.id,status:stage.status,attemptId:stage.attempt?.id??null,resultId:stage.result?.id??null,
          rawEvidenceRevision:stage.rawEvidenceRevision??null,processingId:stage.processing?.id??null,receiptId:stage.receipt?.id??null,
          stopId:stage.stop?.id??null,settlementId:stage.settlement?.id??null,attemptCount:stage.attemptCount??null,retry:JSON.parse(JSON.stringify(stage.retry??null))}}];
    if(stage.result) {
      contents.push({name:"Durable stage result",class:"agent",stage:"result",mediaType:"application/json",value:JSON.parse(JSON.stringify(stage.result))});
      yield {subject:r.ref("activity","contribution",stage.result.id,runId),occurredAt:stage.result.recordedAt,
        payload:{kind:"execution",phase:"settled",executionKind:"durable_raw_result",status:stage.result.outcome,code:null,effectCertainty:null},
        links:[inspectionLink("produces",subject,r.ref("activity","contribution",stage.result.id,runId))],
        contents:[{name:"Original result and measured usage",class:"agent",stage:"raw",mediaType:"application/json",value:JSON.parse(JSON.stringify(stage.result))}]};
    }
    const {prepared,publication,limitation,materialization,method}=context;
    contents.push({name:"Owner evidence scope",class:"execution",stage:"observation",mediaType:"application/json",value:JSON.parse(JSON.stringify({scope:context.scope,contextCoverage:context.coverage,taskCoverage:task.coverage}))});
    const links=[];
    if(task.source) {
      const source=r.ref("model-input","contribution",task.source.requestId,runId);
      links.push(inspectionLink("binding",source,subject));
      yield {subject:source,occurredAt:null,payload:{kind:"execution",phase:"settled",executionKind:"task_input_source",status:"retained",code:null,effectCertainty:null},
        contents:[{name:"Original task request source (not accepted input)",class:"agent",stage:"source",mediaType:"application/json",value:JSON.parse(JSON.stringify(task.source))}]};
    }
    if(publication) {
      links.push(inspectionLink("binding",subject,r.ref("activity-scheduling","contribution",publication.lifecycle.scheduling.workId,runId)),
        inspectionLink("binding",r.ref("activity-reconsideration","contribution",publication.subscriptionId,runId),subject));
      contents.push({name:"Original independent publication lifecycle",class:"execution",stage:"source_lifecycle",mediaType:"application/json",
        value:JSON.parse(JSON.stringify(publication.lifecycle))});
    }
    if(Object.keys(stage.authorizationRestrictions??{}).length)contents.push({name:"Current action-specific authorization restrictions",class:"execution",stage:"authorization",
      mediaType:"application/json",value:JSON.parse(JSON.stringify(stage.authorizationRestrictions))});
    if(stage.stop) {
      const stop=r.ref("shared_acceptance","contribution",stage.stop.id,runId);
      contents.push({name:"Professional stop and original execution evidence (not settlement)",class:"execution",stage:"professional_stop",
        mediaType:"application/json",value:JSON.parse(JSON.stringify(stage.stop))});
      links.push(inspectionLink("binding",stop,subject));
      yield {subject:stop,occurredAt:null,payload:{kind:"execution",phase:"settled",executionKind:"professional_stop_acceptance",status:"accepted",code:null,effectCertainty:null},
        contents:[{name:"Stop scope and remaining execution responsibility",class:"execution",stage:"professional_stop",mediaType:"application/json",
          value:{requestId:stage.request.id,unexecuted:stage.attempt===null,settlementId:stage.settlement?.id??null,resultId:stage.result?.id??null}}]};
    }
    if(limitation) {
      links.push(inspectionLink("binding",r.ref("activity-input","contribution",limitation.needId,runId),subject),
        ...limitation.evidence.map(e=>inspectionLink("observes",subject,r.ref(e.owner,"contribution",e.id,runId))));
      if(stage.receipt) {
        links.push(inspectionLink("settles",r.ref("shared_acceptance","contribution",stage.receipt.id,runId),subject));
        yield {subject:r.ref("activity-input","contribution",limitation.needId,runId),occurredAt:null,payload:{kind:"execution",phase:"settled",executionKind:"input_handoff_need",status:"unavailable_accepted",code:null,effectCertainty:null}};
      }
      contents.push({name:"Input supply limitation (not a model response)",class:"execution",stage:"input_unavailable",mediaType:"application/json",value:JSON.parse(JSON.stringify(limitation))});
    }
    if(materialization) {
      const {declarations}=materialization;
      contents.push({name:"Declared material text positions (not adoption)",class:"agent",stage:"materialization",mediaType:"application/json",value:JSON.parse(JSON.stringify(materialization))});
      for(const declaration of declarations){
        links.push(inspectionLink("binding",subject,r.ref("material_custody","contribution",declaration.access.range.materialId,null,declaration.access.range.version)));
        if(declaration.resultTextSlot)links.push(inspectionLink("observes",subject,r.ref("runtime","call",declaration.resultTextSlot.callId,runId)));
        for(const binding of declaration.bindings)links.push(inspectionLink("observes",subject,r.ref("representation","contribution",JSON.stringify([binding.representation.id,binding.representation.revision]),runId)));
      }
      if(materialization.read) {
        const read=materialization.read,material=r.ref("material_custody","contribution",read.version.ref.materialId,null,read.version.ref.version);
        links.push(inspectionLink("observes",subject,material));
        const observation=r.ref("material-access","contribution",stage.result!.id,runId);
        yield {subject:observation,occurredAt:null,payload:{kind:"execution",phase:"settled",executionKind:"material_access",status:"read",code:null,effectCertainty:null},
          links:[inspectionLink("observes",observation,material)],
          contents:[{name:"Material version from the original read",class:"agent",stage:"read",mediaType:"application/json",value:JSON.parse(JSON.stringify(read))}]};
      }
      for(const page of materialization.pageResults)links.push(inspectionLink("observes",subject,r.ref("activity","contribution",page.rawResultId,runId)));
      if(materialization.preparationStageId)links.push(inspectionLink("produces",subject,r.ref("activity","contribution",materialization.preparationStageId,runId)));
    }
    if(stage.receipt) {
      contents.push({name:"Original purpose acceptance and professional progress",class:"agent",stage:"acceptance",mediaType:"application/json",value:JSON.parse(JSON.stringify(stage.receipt))});
    }
    {
      const delivery=task.delivery;
      if(delivery?.via.kind==="provider"&&delivery.via.selection) {
        const basis=delivery.via.selection,receipt=r.ref("task-input-delivery","contribution",basis.digest,runId);
        const relations=[inspectionLink("binding",r.ref("shared_acceptance","contribution",basis.inputAcceptanceId,runId),receipt),
          inspectionLink("settles",r.ref("shared_acceptance","contribution",basis.responseAcceptanceId,runId),receipt),
          inspectionLink("observes",receipt,r.ref("activity","contribution",basis.rawResultId,runId)),
          inspectionLink("delivers",receipt,r.ref("model-interaction","request",delivery.via.requestId,runId)),
          ...basis.mapping.map(value=>inspectionLink("includes",receipt,r.ref("context_delivery","contribution",value.deliveryId,runId)))];
        yield {subject:receipt,occurredAt:null,payload:{kind:"execution",phase:"settled",executionKind:"task_input_delivery",status:"accepted",code:null,effectCertainty:null},
          contents:[{name:"Actual presentations and addressed-source mapping",class:"agent",stage:"delivery",mediaType:"application/json",value:JSON.parse(JSON.stringify(delivery))}]};
        const origin={owner:"task-input-delivery",id:basis.digest,runId,revision:"1"},digest=modelInputValueDigest(delivery);
        yield* processEvidenceRecords(r,{observation:processObservationRef(r,origin,digest),occurredAt:null,evidence:{origin,digest,subject:receipt,category:"delivery",name:"task_input_delivery",status:"accepted",purpose:null,recipient:null},links:relations});
        links.push(inspectionLink("produces",subject,receipt));
      }
      const presentation=task.presentation;
      if(presentation) {
        const receipt=r.ref("task-result-presentation","contribution",presentation.digest,runId);
        yield {subject:receipt,occurredAt:null,
          payload:{kind:"execution",phase:"settled",executionKind:"native_result_presentation",status:"response_accepted",code:null,effectCertainty:null},
          contents:[{name:"Accepted native result text and original correlation (not a new Tool settlement)",class:"agent",stage:"presentation",mediaType:"application/json",value:JSON.parse(JSON.stringify(presentation))}]};
        const origin={owner:"task-result-presentation",id:presentation.digest,runId,revision:"1"},digest=modelInputValueDigest(presentation);
        yield* processEvidenceRecords(r,{observation:processObservationRef(r,origin,digest),occurredAt:null,evidence:{origin,digest,subject:receipt,category:"delivery",name:"native_result_presentation",status:"response_accepted",purpose:null,recipient:null},
          links:[inspectionLink("binding",r.ref("shared_acceptance","contribution",presentation.inputAcceptanceId,runId),receipt),
            inspectionLink("settles",r.ref("shared_acceptance","contribution",presentation.responseAcceptanceId,runId),receipt),
            inspectionLink("delivers",receipt,r.ref("model-interaction","request",presentation.requestId,runId)),
            inspectionLink("observes",receipt,r.ref("activity","contribution",presentation.rawResultId,runId)),
            inspectionLink("observes",receipt,r.ref("context_selection","contribution",presentation.inputId,runId)),
            ...presentation.presentations.flatMap(item=>item.bindings.flatMap(binding=>[
              inspectionLink("observes",receipt,r.ref("runtime","call",binding.slot.callId,runId)),
              inspectionLink("observes",receipt,r.ref("representation","contribution",JSON.stringify([binding.representation.id,binding.representation.revision]),runId))]))]});
        links.push(inspectionLink("produces",subject,receipt));
      }
    }
    if(stage.settlement) {
      const receipt=r.ref("shared_acceptance","contribution",stage.settlement.id,runId);
      contents.push({name:"Cancelled consumer result settlement (not task advancement)",class:"agent",stage:"settlement",mediaType:"application/json",value:JSON.parse(JSON.stringify(stage.settlement))});
      links.push(inspectionLink("settles",receipt,subject));
      yield {subject:receipt,occurredAt:null,payload:{kind:"execution",phase:"settled",executionKind:"activity_result_settlement",status:"accepted",code:null,effectCertainty:null},
        links:[inspectionLink("observes",receipt,r.ref("activity","contribution",stage.settlement.resultId,runId))],
        contents:[{name:"Original purpose settlement receipt",class:"agent",stage:"settlement",mediaType:"application/json",value:JSON.parse(JSON.stringify(stage.settlement))}]};
    }
    if(method) {
      contents.push({name:"Professional method progress and coverage",class:"agent",stage:"method",mediaType:"application/json",value:JSON.parse(JSON.stringify(method.progress))});
      for(const ref of method.generated)links.push(inspectionLink("produces",subject,r.ref("representation","contribution",JSON.stringify([ref.id,ref.revision]),runId)));
      for(const id of method.judgments)links.push(inspectionLink("produces",subject,r.ref("representation","contribution",id,runId)));
    }
    if(prepared) {
      contents.push({name:"Encoded model input",class:"agent",stage:"encoded",mediaType:"text/plain",value:prepared.encoded.body},
        {name:"Input allocation, measurement and source positions",class:"agent",stage:"capacity",mediaType:"application/json",
          value:JSON.parse(JSON.stringify({demand:prepared.demand.id,historyBoundary:prepared.demand.historyBoundary,choice:prepared.choice,locations:prepared.locations,deliveries:prepared.deliveries,
            allocation:prepared.allocation,measurement:prepared.measurement,measurementDerivation:prepared.measurementDerivation??null,accounting:prepared.accounting??null,capacity:prepared.capacity,progress:prepared.progress}))});
      if(prepared.measurementDerivation?.observation)links.push(inspectionLink("observes",subject,
        r.ref("model-input-measurement","contribution",prepared.measurementDerivation.observation.id,runId)));
      links.push(inspectionLink("produces",subject,r.ref("model-input","contribution",prepared.encoded.id,runId)),
        inspectionLink("includes",r.ref("activity","contribution",prepared.preparationStageId,runId),subject));
      const preparedRecordId=randomUUID(),preparedSubject=r.ref("model-input","contribution",prepared.encoded.id,runId);
      yield {id:preparedRecordId,subject:preparedSubject,occurredAt:null,
        payload:{kind:"execution",phase:"settled",executionKind:"prepared_model_input",status:"prepared",code:null,effectCertainty:null},
        contents:[{name:"Prepared encoded input (not proof of sending)",class:"agent",stage:"encoded",mediaType:"text/plain",value:prepared.encoded.body},
          {name:"Prepared semantic request (not wire positions)",class:"agent",stage:"semantic",mediaType:"application/json",value:JSON.parse(JSON.stringify(prepared.request))}]};
      for(const location of prepared.locations)for(const jsonPointer of location.jsonPointers)links.push(inspectionLink("includes",subject,preparedSubject,
        {operation:"canonical_section_position",targetLocation:{contentId:inspectionContentId(preparedRecordId,1),partId:location.sectionId,jsonPointer,stage:"semantic"}}));
      if(stage.request.stageKind==="model") {
        const request=r.ref("model-interaction","request",prepared.request.requestId,runId);
        links.push(inspectionLink("includes",subject,request));
        yield {subject:request,occurredAt:stage.attempt?.startedAt??null,payload:{kind:"request",purpose:prepared.request.purpose,providerId:prepared.request.composition.providerId,
          model:prepared.request.composition.model,compositionId:prepared.request.composition.id,messageCount:prepared.request.messages.length,
          toolCount:prepared.request.interaction.kind==="native_tool_turn"?prepared.request.interaction.callables.length:0},
          links:[inspectionLink("materializes",r.ref("model-input","contribution",prepared.encoded.id,runId),request),...(stage.result?[inspectionLink("produces",request,r.ref("activity","contribution",stage.result.id,runId))]:[])],
          contents:[{name:"Accepted request and dispatch state",class:"agent",stage:"request",mediaType:"application/json",value:JSON.parse(JSON.stringify({request:prepared.request,state:stage.status,attempt:stage.attempt,encoded:prepared.encoded}))}]};
      }
    }
    yield {subject,occurredAt:null,payload:{kind:"execution",phase:stage.status==="accepted"||stage.status==="settled"||stage.status==="stopped"?"settled":stage.status==="dispatched"?"started":"pending",
      executionKind:"purpose_bound_stage",status:stage.status,code:null,effectCertainty:null},contents};
    const origin={owner:"activity.stage",id:stage.request.id,runId,revision:context.scope.revision};
    yield* processEvidenceRecords(r,{observation:processObservationRef(r,origin,context.scope.revision),occurredAt:null,
      evidence:{origin,digest:context.scope.revision,subject,executionPath:r.ref("activity","contribution",stage.request.pathId,runId),category:context.coverage.method?"method":prepared?"input":"coordination",name:"purpose_bound_stage",status:stage.status,
        purpose:prepared?.demand.purpose??materialization?.purpose??null,recipient:prepared?{runId:prepared.demand.runId,recipient:prepared.demand.recipient,purpose:prepared.demand.purpose}:null},links});
  }
  observe(fact:ActivityHandoffFact,r:InspectionProjectionSink=this.recorder):void {
    for(const record of this.factRecords(fact,r))r.offer(record);
  }
  private *factRecords(fact:ActivityHandoffFact,r:InspectionProjectionRefs):Generator<InspectionRecordInput> {
    const measurement=responsibilityMeasurement(r,fact);if(measurement)yield measurement;
    const subject = r.ref("activity","event",`${fact.runId}:handoff:${fact.sequence}`,fact.runId);
    const subjectOwner=fact.kind.startsWith("scheduling_")?"activity-scheduling":fact.kind.startsWith("reconsideration_")?"activity-reconsideration":fact.kind==="fact_published"?"activity-source":"activity";
    const path = r.ref(subjectOwner,"contribution",fact.pathId,fact.runId);
    const stage = fact.requestId ? r.ref("activity","contribution",fact.requestId,fact.runId) : null;
    if(stage)yield {subject:stage,occurredAt:fact.occurredAt,payload:{kind:"execution",phase:fact.kind==="accepted"||fact.kind==="settled"?"settled":fact.kind==="dispatched"?"started":"pending",
      executionKind:"purpose_bound_stage",status:fact.kind,code:null,effectCertainty:null}};
    const professional=contextActivityFactObservation(fact);
    const ref=(value:import("@agent-anything/context/evidence").ContextProcessObjectRef)=>r.ref(value.owner,"contribution",value.id,value.runId,value.revision);
    const related=professional.links.map(link=>inspectionLink(link.kind,ref(link.from),ref(link.to)));
    if(professional.closure) {
      const closure=professional.closure;
      yield {subject:ref(closure.subject),occurredAt:fact.occurredAt,payload:{kind:"execution",phase:"settled",executionKind:closure.kind,status:closure.status,code:null,effectCertainty:null},
        contents:[{name:"Owner-declared lifecycle observation",class:"execution",stage:"closure",mediaType:"application/json",value:JSON.parse(JSON.stringify(fact.details))}]};
    }
    if(stage&&fact.kind==="professional_stopped") {
      const stop=r.ref("shared_acceptance","contribution",String(fact.details.receiptId),fact.runId);
      related.push(inspectionLink("observes",subject,stop),inspectionLink("binding",path,stop));
      yield {subject:stage,occurredAt:fact.occurredAt,payload:{kind:"execution",phase:fact.details.unexecuted===true?"settled":"pending",
        executionKind:"purpose_bound_stage",status:fact.details.unexecuted===true?"stopped_without_execution":"stopped_pending_settlement",code:null,effectCertainty:null},
        contents:[{name:"Original stop basis and retained execution",class:"execution",stage:"professional_stop",mediaType:"application/json",value:JSON.parse(JSON.stringify(fact.details))}]};
    }
    if(fact.kind==="input_needed") {
      const need=fact.details.need as import("@agent-anything/agent-runtime/activity").ActivityInputNeed;
      const ref=r.ref("activity-input","contribution",need.id,fact.runId);
      related.push(inspectionLink("produces",path,ref),inspectionLink("observes",subject,ref));
      if(need.origin)related.push(inspectionLink("produces",r.ref("activity","contribution",need.origin.requestId,fact.runId),ref),
        inspectionLink("trigger",r.ref("shared_acceptance","contribution",need.origin.receiptId,fact.runId),ref));
      yield {subject:ref,occurredAt:fact.occurredAt,payload:{kind:"execution",phase:"pending",executionKind:"input_handoff_need",status:"requested",code:null,effectCertainty:null},
        contents:[{name:"Original consumer input need and stage constraints",class:"execution",stage:"input_need",mediaType:"application/json",value:JSON.parse(JSON.stringify(need))}]};
    }
    if(stage&&fact.kind==="stage_submitted"&&typeof fact.details.inputNeedId==="string") {
      related.push(inspectionLink("binding",r.ref("activity-input","contribution",fact.details.inputNeedId,fact.runId),stage));
      yield {subject:r.ref("activity-input","contribution",fact.details.inputNeedId,fact.runId),occurredAt:fact.occurredAt,
        payload:{kind:"execution",phase:"pending",executionKind:"input_handoff_need",status:fact.details.inputOutcome==="unavailable"?"unavailable_submitted":"supplied_submitted",code:null,effectCertainty:null}};
    }
    if(fact.kind==="scheduling_accepted") {
      const acceptance=fact.details.acceptance as ActivitySchedulingAcceptance;
      const work=r.ref("activity-scheduling","contribution",acceptance.intent.workId,fact.runId);
      const decision=r.ref(acceptance.intent.owner,"contribution",acceptance.intent.decisionId,fact.runId);
      const accepted=r.ref("activity-scheduling","contribution",acceptance.intent.id,fact.runId);
      related.push(inspectionLink("trigger",decision,accepted),inspectionLink("binding",accepted,work),inspectionLink("observes",subject,accepted));
      yield {subject:accepted,occurredAt:fact.occurredAt,payload:{kind:"execution",phase:"settled",executionKind:"scheduling_acceptance",status:"accepted",code:null,effectCertainty:null},
        contents:[{name:"Original scheduling acceptance",class:"execution",stage:"accepted",mediaType:"application/json",value:JSON.parse(JSON.stringify(acceptance))}]};
      for(const pathId of acceptance.intent.allowedPathIds??[]) {
        const delegation=r.ref("activity-scheduling","contribution",modelInputValueDigest({acceptance:acceptance.intent.id,pathId}),fact.runId);
        yield {subject:delegation,occurredAt:fact.occurredAt,
          payload:{kind:"execution",phase:"settled",executionKind:"scheduling_path_delegation",status:"delegated",code:null,effectCertainty:null},
          links:[inspectionLink("binding",accepted,delegation),inspectionLink("binding",delegation,work),inspectionLink("binding",delegation,r.ref("activity","contribution",pathId,fact.runId))]};
      }
      for(const pool of (fact.details.pools??[]) as readonly import("@agent-anything/agent-runtime/activity").ActivityResourcePool[])
        yield {subject:r.ref("activity-resource","contribution",pool.id,null),occurredAt:fact.occurredAt,
          payload:{kind:"execution",phase:"settled",executionKind:"resource_binding",status:"bound",code:null,effectCertainty:null},
          contents:[{name:"Trusted resource pool binding",class:"execution",stage:"binding",mediaType:"application/json",value:JSON.parse(JSON.stringify(pool))}]};
      for(const claim of acceptance.intent.resources)related.push(inspectionLink("binding",work,r.ref("activity-resource","contribution",claim.poolId,null)));
      yield {subject:work,occurredAt:fact.occurredAt,payload:{kind:"execution",phase:"pending",executionKind:"scheduled_work",status:acceptance.service,code:null,effectCertainty:null},
        contents:[{name:"Accepted service, timing and resource basis",class:"execution",stage:"scheduling",mediaType:"application/json",value:JSON.parse(JSON.stringify(acceptance))}]};
    }
    if(fact.kind==="scheduling_paths_sealed"||fact.kind==="scheduling_closed") {
      const work=r.ref("activity-scheduling","contribution",fact.pathId,fact.runId);
      const settled=fact.kind==="scheduling_closed"&&fact.details.settlementChecked===true;
      yield {subject:work,occurredAt:fact.occurredAt,
        payload:{kind:"execution",phase:settled?"settled":"pending",executionKind:"scheduled_work",
          status:settled?"closed":fact.kind==="scheduling_closed"||fact.details.closed===true?"service_closed":"paths_sealed",code:null,effectCertainty:null},
        links:[inspectionLink("observes",subject,work)],
        contents:[{name:fact.kind==="scheduling_closed"?"Work closure and settlement condition":"Path admission seal (existing work may continue)",
          class:"execution",stage:fact.kind,mediaType:"application/json",value:JSON.parse(JSON.stringify(fact.details))}]};
    }
    if(fact.kind==="scheduling_wait") {
      const work=r.ref("activity-scheduling","contribution",fact.pathId,fact.runId);
      const waiting=r.ref("activity","contribution",String(fact.details.requestId),fact.runId);
      related.push(inspectionLink("observes",subject,work),inspectionLink("observes",subject,waiting));
    }
    if(fact.kind==="attempt_retry_accepted") {
      const retry=fact.details.receipt as import("@agent-anything/agent-runtime/activity").ActivityAttemptRetryReceipt;
      const acceptance=r.ref("activity-retry","contribution",retry.id,fact.runId);
      related.push(inspectionLink("observes",subject,acceptance),
        inspectionLink("observes",acceptance,r.ref("activity","contribution",retry.resultId,fact.runId)),
        inspectionLink("binding",acceptance,r.ref("activity","contribution",retry.requestId,fact.runId)));
      yield {subject:acceptance,occurredAt:retry.decidedAt,payload:{kind:"execution",phase:"settled",executionKind:"technical_attempt_retry",status:"accepted",code:retry.reason.code,effectCertainty:null},
        contents:[{name:"Original failure, policy and earliest retry (not task progression)",class:"execution",stage:"retry",mediaType:"application/json",value:JSON.parse(JSON.stringify(retry))}]};
    }
    if(stage&&fact.kind==="dispatched"&&fact.details.scheduling) {
      const dispatch=fact.details.scheduling as ActivitySchedulingDispatch;
      const work=r.ref("activity-scheduling","contribution",dispatch.workId,fact.runId);
      related.push(inspectionLink("includes",work,stage),inspectionLink("binding",r.ref("activity-scheduling","contribution",dispatch.acceptanceId,fact.runId),stage));
      for(const claim of dispatch.claims)related.push(inspectionLink("binding",stage,r.ref("activity-resource","contribution",claim.poolId,null)));
    }
    if(fact.kind==="fact_published") {
      const published=fact.details.fact as ActivityPublishedFact;
      const original=r.ref(published.ref.owner,"contribution",published.ref.id,fact.runId,professional.referenceRevision===undefined?published.ref.revision:professional.referenceRevision);
      const publication=r.ref("activity-publication","contribution",published.id,fact.runId);
      related.push(inspectionLink("produces",original,publication),inspectionLink("includes",r.ref("activity-source","contribution",published.sourceId,fact.runId),publication),inspectionLink("observes",subject,publication));
      if(published.origin)related.push(
        inspectionLink("observes",publication,r.ref("activity","contribution",published.origin.stageId,fact.runId)),
        inspectionLink("produces",r.ref("shared_acceptance","contribution",published.origin.acceptanceId,fact.runId),publication));
      yield {subject:publication,occurredAt:fact.occurredAt,payload:{kind:"execution",phase:"settled",executionKind:"fact_publication",status:"published",code:null,effectCertainty:null},
        contents:[{name:"Published fact reference",class:"execution",stage:"published",mediaType:"application/json",value:JSON.parse(JSON.stringify(published))}]};
    }
    if(fact.kind==="reconsideration_registered") {
      const subscription=fact.details.subscription as ActivityReconsiderationSubscription;
      for(const source of subscription.sources)related.push(inspectionLink("observes",r.ref("activity-reconsideration","contribution",subscription.id,fact.runId),r.ref("activity-source","contribution",source,fact.runId)));
      if(subscription.binding?.kind==="activity_path")related.push(inspectionLink("binding",r.ref("activity-reconsideration","contribution",subscription.id,fact.runId),r.ref("activity","contribution",subscription.binding.id,fact.runId)));
    }
    if(fact.kind==="reconsideration_accepted") {
      const receipt=fact.details.receipt as ActivityReconsiderationReceipt;
      const decision=r.ref(receipt.decision.owner,"contribution",receipt.decision.id,fact.runId,
        professional.referenceRevision===undefined?receipt.decision.revision:professional.referenceRevision);
      for(const id of receipt.factIds)related.push(inspectionLink("trigger",r.ref("activity-publication","contribution",id,fact.runId),decision));
      for(const sourceId of receipt.observeSources??[])related.push(inspectionLink("observes",decision,r.ref("activity-source","contribution",sourceId,fact.runId)));
      related.push(inspectionLink("settles",r.ref("shared_acceptance","contribution",receipt.id,fact.runId),decision),
        inspectionLink("includes",r.ref("activity-reconsideration","contribution",receipt.subscriptionId,fact.runId),decision));

    }
    if(stage&&Array.isArray(fact.details.dependencies))for(const dependency of fact.details.dependencies){
      if(dependency&&typeof dependency==="object"&&typeof dependency.requestId==="string"&&["accepted","raw_result"].includes(String(dependency.condition)))
        related.push(inspectionLink("prerequisite",r.ref("activity","contribution",dependency.requestId,fact.runId),stage,
          {condition:dependency.condition==="accepted"?"settled":"result",operation:`activity:${dependency.condition}`}));
    }
    if(stage&&typeof fact.details.resultId==="string")related.push(inspectionLink("produces",stage,r.ref("activity","contribution",fact.details.resultId,fact.runId)));
    if(stage&&typeof fact.details.receiptId==="string")related.push(inspectionLink("settles",r.ref("shared_acceptance","contribution",fact.details.receiptId,fact.runId),stage));
    yield* processEvidenceRecords(r,{observation:subject,occurredAt:fact.occurredAt,evidence:{origin:{owner:"activity.fact",id:String(fact.sequence),runId:fact.runId,revision:"1"},digest:modelInputValueDigest(fact),
      subject:stage??path,executionPath:path,category:fact.kind==="attempt_retry_accepted"?"recovery":fact.kind==="input_needed"?"demand":"coordination",name:`activity.${fact.kind}`,status:fact.kind,purpose:null,recipient:null},
      links:[...related,inspectionLink("includes",r.ref("runtime","run",fact.runId,fact.runId),path),inspectionLink("includes",path,subject),
        ...(stage ? [inspectionLink("includes",path,stage),inspectionLink("includes",stage,subject)] : []),
        ...(stage && typeof fact.details.modelRequestId === "string" ? [inspectionLink("includes",stage,r.ref("model-interaction","request",fact.details.modelRequestId,fact.runId))] : [])],
      contents:[{name:"Durable activity handoff",class:"execution",stage:fact.kind,mediaType:"application/json",value:JSON.parse(JSON.stringify(fact))}]});
  }
  async replay(runId:string,port:import("@agent-anything/agent-runtime/activity").ActivityHandoffPort): Promise<void> {
    let after = 0;
    while (true) {
      const facts = await port.command({kind:"facts",runId,after,limit:128}) as readonly ActivityHandoffFact[];
      const stages = new Set<string>();
      for (const fact of facts) {
        await replayInspectionRecords(this.recorder,this.factRecords(fact,this.recorder));
        if(fact.kind==="raw_saved"&&fact.requestId&&typeof fact.details.resultId==="string") {
          const raw=await port.command({kind:"read_raw_result",resultId:fact.details.resultId}) as import("@agent-anything/agent-runtime/activity").ActivityRawResult|null;
          if(raw) {
            const r=this.recorder,subject=r.ref("activity","contribution",raw.id,runId);
            if(!await r.offerWhenReady({subject,occurredAt:raw.recordedAt,payload:{kind:"execution",phase:"settled",executionKind:"durable_raw_result",status:raw.outcome,code:null,effectCertainty:null},
              links:[inspectionLink("produces",r.ref("activity","contribution",fact.requestId,runId),subject)],
              contents:[{name:"Original result and measured usage",class:"agent",stage:"raw",mediaType:"application/json",value:JSON.parse(JSON.stringify(raw))}]}))throw new Error("inspection_replay_record_rejected");
          }
        }
        if(fact.requestId && ["stage_submitted","raw_saved","accepted","settled"].includes(fact.kind)) {
          stages.add(fact.requestId);
        }
      }
      // These are current snapshots, not historical state at each fact. Keep every
      // original fact/result, but project a current stage only once per bounded page.
      for (const requestId of stages) {
          const stage=await port.command({kind:"read_stage",requestId}) as ActivityStageState|null;
          const path=stage?await port.command({kind:"read_path",pathId:stage.request.pathId}) as ActivityPathState|null:null;
          if(stage&&path)await replayInspectionRecords(this.recorder,this.stageRecords(path,stage,this.recorder));
      }
      if (facts.length < 128) return;
      after = facts.at(-1)!.sequence;
    }
  }
}
