import {InspectionRecorder} from "@agent-anything/inspection/recording";
import {inspectionLink} from "@agent-anything/inspection/adapters";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {recordInspectionRelationships} from "./InspectionRelationships.js";
import {replayInspectionProjection, type InspectionProjectionSink} from "./InspectionReplay.js";
import type {ActivityHandoffFact, ActivityHandoffObserver,ActivityStageState,ActivitySchedulingAcceptance,ActivitySchedulingDispatch,
  ActivityPublishedFact,ActivityReconsiderationReceipt,ActivityReconsiderationSubscription} from "@agent-anything/agent-runtime/activity";

export class ActivityHandoffInspectionAdapter implements ActivityHandoffObserver {
  constructor(private readonly recorder: InspectionRecorder) {}
  observeStage(runId:string,stage:ActivityStageState,r:InspectionProjectionSink=this.recorder):void {
    const subject=r.ref("activity","contribution",stage.request.id,runId);
    const contents:NonNullable<Parameters<InspectionRecorder["offer"]>[0]["contents"]>[number][]=
      [{name:"Submitted stage input",class:"agent",stage:"input",mediaType:"application/json",value:JSON.parse(JSON.stringify(stage.request.input))},
        {name:"Stage execution evidence",class:"execution",stage:"evidence",mediaType:"application/json",value:{
          requestId:stage.request.id,status:stage.status,attemptId:stage.attempt?.id??null,resultId:stage.result?.id??null,
          rawEvidenceRevision:stage.rawEvidenceRevision??null,processingId:stage.processing?.id??null,receiptId:stage.receipt?.id??null,
          stopId:stage.stop?.id??null,settlementId:stage.settlement?.id??null,attemptCount:stage.attemptCount??null,retry:JSON.parse(JSON.stringify(stage.retry??null))}}];
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
    const taskSource=stage.request.input as import("@agent-anything/agent-runtime/decision").TaskModelSource|null;
    if(taskSource?.kind==="task_model_source") {
      const source=r.ref("model-input","contribution",taskSource.request.requestId,runId);
      links.push(inspectionLink("binding",source,subject));
      r.offer({subject:source,occurredAt:null,payload:{kind:"execution",phase:"settled",executionKind:"task_input_source",status:"retained",code:null,effectCertainty:null},
        contents:[{name:"Original task request source (not accepted input)",class:"agent",stage:"source",mediaType:"application/json",value:JSON.parse(JSON.stringify(taskSource.request))}]});
    }
    const sourcePublication=stage.request.input as import("@agent-anything/agent-runtime/context-representation").SourceMaterialPublicationRequest|null;
    if(sourcePublication?.kind==="source_material_publication"&&sourcePublication.lifecycle) {
      const plan=sourcePublication.lifecycle;
      links.push(inspectionLink("binding",subject,r.ref("activity-scheduling","contribution",plan.scheduling.workId,runId)),
        inspectionLink("binding",r.ref("activity-reconsideration","contribution",`${stage.request.pathId}:source-lifecycle`,runId),subject));
      contents.push({name:"Original independent publication lifecycle",class:"execution",stage:"source_lifecycle",mediaType:"application/json",
        value:JSON.parse(JSON.stringify(plan))});
    }
    if(Object.keys(stage.authorizationRestrictions??{}).length)contents.push({name:"Current action-specific authorization restrictions",class:"execution",stage:"authorization",
      mediaType:"application/json",value:JSON.parse(JSON.stringify(stage.authorizationRestrictions))});
    if(stage.stop) {
      const stop=r.ref("shared_acceptance","contribution",stage.stop.id,runId);
      contents.push({name:"Professional stop and original execution evidence (not settlement)",class:"execution",stage:"professional_stop",
        mediaType:"application/json",value:JSON.parse(JSON.stringify(stage.stop))});
      links.push(inspectionLink("binding",stop,subject));
      r.offer({subject:stop,occurredAt:null,payload:{kind:"execution",phase:"settled",executionKind:"professional_stop_acceptance",status:"accepted",code:null,effectCertainty:null},
        contents:[{name:"Stop scope and remaining execution responsibility",class:"execution",stage:"professional_stop",mediaType:"application/json",
          value:{requestId:stage.request.id,unexecuted:stage.attempt===null,settlementId:stage.settlement?.id??null,resultId:stage.result?.id??null}}]});
    }
    const limitation=stage.request.input as import("@agent-anything/agent-runtime/context-representation").ContextInputUnavailability|undefined;
    if(limitation?.kind==="context_input_unavailable") {
      links.push(inspectionLink("binding",r.ref("activity-input","contribution",limitation.needId,runId),subject),
        ...limitation.evidence.map(e=>inspectionLink("observes",subject,r.ref(e.owner,"contribution",e.id,runId))));
      if(stage.receipt) {
        links.push(inspectionLink("settles",r.ref("shared_acceptance","contribution",stage.receipt.id,runId),subject));
        r.offer({subject:r.ref("activity-input","contribution",limitation.needId,runId),occurredAt:stage.result?.recordedAt??null,payload:{kind:"execution",phase:"settled",executionKind:"input_handoff_need",status:"unavailable_accepted",code:null,effectCertainty:null}});
      }
      contents.push({name:"Input supply limitation (not a model response)",class:"execution",stage:"input_unavailable",mediaType:"application/json",value:JSON.parse(JSON.stringify(limitation))});
    }
    const materialization=(stage.request.input as {request?:import("@agent-anything/agent-runtime/context-representation").ContextInputMaterializationRequest})?.request;
    if(materialization?.kind==="context_input_materialization") {
      const declarations=materialization.demand.contributions.flatMap(contribution=>contribution.options.flatMap(option=>option.sections.flatMap(occurrence=>{
        const content=occurrence.section.content;
        const positions=content.kind==="retained_text"?[{access:content.access,slot:null}]:content.kind==="retained_result_text"?content.replacements:[];
        return positions.map(part=>({contribution:contribution.id,option:option.id,section:occurrence.section.id,position:occurrence.position,role:occurrence.section.role,access:part.access,
          resultTextSlot:part.slot,bindings:[...(option.resultTextBindings??[]).filter(b=>b.sectionId===occurrence.section.id&&part.slot&&modelInputValueDigest(b.slot)===modelInputValueDigest(part.slot)),
            ...(part.slot?[]:(option.dataTextBindings??[]).filter(b=>b.sectionId===occurrence.section.id))]}));
      })));
      contents.push({name:"Declared material text positions (not adoption)",class:"agent",stage:"materialization",mediaType:"application/json",value:JSON.parse(JSON.stringify({
        demandId:materialization.demand.id,recipient:materialization.demand.recipient,purpose:materialization.demand.purpose,historyBoundary:materialization.demand.historyBoundary,
        declarations,maximumReadBytes:materialization.demand.maximumReadBytes,pageBytes:materialization.pageBytes,progress:stage.receipt?.progress??null}))});
      for(const declaration of declarations){
        links.push(inspectionLink("binding",subject,this.recorder.ref("material_custody","contribution",declaration.access.range.materialId,null,declaration.access.range.version)));
        if(declaration.resultTextSlot)links.push(inspectionLink("observes",subject,r.ref("runtime","call",declaration.resultTextSlot.callId,runId)));
        for(const binding of declaration.bindings)links.push(inspectionLink("observes",subject,r.ref("representation","contribution",JSON.stringify([binding.representation.id,binding.representation.revision]),runId)));
      }
      const read=stage.result?.value as {kind?:string;page?:import("@agent-anything/context/custody").MaterialReadPage}|undefined;
      if(read?.kind==="page"&&read.page) {
        const material=r.ref("material_custody","contribution",read.page.version.ref.materialId,null,read.page.version.ref.version);
        links.push(inspectionLink("observes",subject,material));
        r.offer({subject:material,occurredAt:stage.result!.recordedAt,payload:{kind:"execution",phase:"settled",executionKind:"material_version",status:"read",code:null,effectCertainty:null},
          contents:[{name:"Material version from the original read",class:"agent",stage:"read",mediaType:"application/json",value:JSON.parse(JSON.stringify(read.page.version))}]});
      }
      const progress=stage.receipt?.progress as {state?:string;preparationPathId?:string;pages?:readonly {stageId:string;rawResultId:string}[]}|undefined;
      for(const page of progress?.pages??[])links.push(inspectionLink("observes",subject,r.ref("activity","contribution",page.rawResultId,runId)));
      if(progress?.state==="organized"&&progress.preparationPathId)links.push(inspectionLink("produces",subject,r.ref("activity","contribution",`${progress.preparationPathId}:stage:1`,runId)));
    }
    if(stage.receipt) {
      contents.push({name:"Original purpose acceptance and professional progress",class:"agent",stage:"acceptance",mediaType:"application/json",value:JSON.parse(JSON.stringify(stage.receipt))});
    }
    {
      const settlement=stage.settlement?.disposition as import("@agent-anything/agent-runtime/decision").TaskModelResponseSettlement|undefined;
      const task=(stage.receipt?.progress??(settlement?.kind==="retained_task_result"?settlement.response:null)) as import("@agent-anything/agent-runtime/decision").TaskModelResponseProgress|null;
      const delivery=task?.kind==="task_model_response"?(task.proposal?.inputDeliveryReceipt??task.exchange?.inputDeliveryReceipt):null;
      if(delivery?.via.kind==="provider"&&delivery.via.selection) {
        const basis=delivery.via.selection,receipt=r.ref("task-input-delivery","contribution",basis.digest,runId);
        const relations=[inspectionLink("binding",r.ref("shared_acceptance","contribution",basis.inputAcceptanceId,runId),receipt),
          inspectionLink("settles",r.ref("shared_acceptance","contribution",basis.responseAcceptanceId,runId),receipt),
          inspectionLink("observes",receipt,r.ref("activity","contribution",basis.rawResultId,runId)),
          inspectionLink("delivers",receipt,r.ref("model-interaction","request",delivery.via.requestId,runId)),
          ...basis.mapping.map(value=>inspectionLink("includes",receipt,r.ref("context_delivery","contribution",value.deliveryId,runId)))];
        r.offer({subject:receipt,occurredAt:stage.result?.recordedAt??null,payload:{kind:"execution",phase:"settled",executionKind:"task_input_delivery",status:"accepted",code:null,effectCertainty:null},
          links:relations,contents:[{name:"Actual presentations and addressed-source mapping",class:"agent",stage:"delivery",mediaType:"application/json",value:JSON.parse(JSON.stringify(delivery))}]});
        links.push(inspectionLink("produces",subject,receipt));
      }
      const presentation=task?.kind==="task_model_response"?task.exchange?.resultPresentationReceipt:null;
      if(presentation) {
        const receipt=r.ref("task-result-presentation","contribution",presentation.digest,runId);
        r.offer({subject:receipt,occurredAt:stage.result?.recordedAt??null,
          payload:{kind:"execution",phase:"settled",executionKind:"native_result_presentation",status:"response_accepted",code:null,effectCertainty:null},
          contents:[{name:"Accepted native result text and original correlation (not a new Tool settlement)",class:"agent",stage:"presentation",mediaType:"application/json",value:JSON.parse(JSON.stringify(presentation))}],
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
      r.offer({subject:receipt,occurredAt:null,payload:{kind:"execution",phase:"settled",executionKind:"activity_result_settlement",status:"accepted",code:null,effectCertainty:null},
        links:[inspectionLink("observes",receipt,r.ref("activity","contribution",stage.settlement.resultId,runId))],
        contents:[{name:"Original purpose settlement receipt",class:"agent",stage:"settlement",mediaType:"application/json",value:JSON.parse(JSON.stringify(stage.settlement))}]});
    }
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
            allocation:prepared.allocation,measurement:prepared.measurement,measurementDerivation:prepared.measurementDerivation??null,accounting:prepared.accounting??null,capacity:prepared.capacity,progress:prepared.progress}))});
      if(prepared.measurementDerivation?.observation)links.push(inspectionLink("observes",subject,
        r.ref("model-input-measurement","contribution",prepared.measurementDerivation.observation.id,runId)));
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
    r.offer({subject,occurredAt:stage.result?.recordedAt??null,payload:{kind:"execution",phase:stage.status==="accepted"||stage.status==="settled"||stage.status==="stopped"?"settled":stage.status==="dispatched"?"started":"pending",
      executionKind:"purpose_bound_stage",status:stage.status,code:null,effectCertainty:null},contents});
    recordInspectionRelationships(r,subject,stage.result?.recordedAt??null,links);
  }
  observe(fact: ActivityHandoffFact,r:InspectionProjectionSink=this.recorder): void {
    const subject = r.ref("activity","event",`${fact.runId}:handoff:${fact.sequence}`,fact.runId);
    const subjectOwner=fact.kind.startsWith("scheduling_")?"activity-scheduling":fact.kind.startsWith("reconsideration_")?"activity-reconsideration":fact.kind==="fact_published"?"activity-source":"activity";
    const path = r.ref(subjectOwner,"contribution",fact.pathId,fact.runId);
    const stage = fact.requestId ? r.ref("activity","contribution",fact.requestId,fact.runId) : null;
    if(stage)r.offer({subject:stage,occurredAt:fact.occurredAt,payload:{kind:"execution",phase:fact.kind==="accepted"||fact.kind==="settled"?"settled":fact.kind==="dispatched"?"started":"pending",
      executionKind:"purpose_bound_stage",status:fact.kind,code:null,effectCertainty:null}});
    const related=[];
    if(stage&&fact.kind==="professional_stopped") {
      const stop=r.ref("shared_acceptance","contribution",String(fact.details.receiptId),fact.runId);
      related.push(inspectionLink("observes",subject,stop),inspectionLink("binding",path,stop));
      r.offer({subject:stage,occurredAt:fact.occurredAt,payload:{kind:"execution",phase:fact.details.unexecuted===true?"settled":"pending",
        executionKind:"purpose_bound_stage",status:fact.details.unexecuted===true?"stopped_without_execution":"stopped_pending_settlement",code:null,effectCertainty:null},
        contents:[{name:"Original stop basis and retained execution",class:"execution",stage:"professional_stop",mediaType:"application/json",value:JSON.parse(JSON.stringify(fact.details))}]});
    }
    if(fact.kind==="input_needed") {
      const need=fact.details.need as import("@agent-anything/agent-runtime/activity").ActivityInputNeed;
      const ref=r.ref("activity-input","contribution",need.id,fact.runId);
      related.push(inspectionLink("produces",path,ref),inspectionLink("observes",subject,ref));
      if(need.origin)related.push(inspectionLink("produces",r.ref("activity","contribution",need.origin.requestId,fact.runId),ref),
        inspectionLink("trigger",r.ref("shared_acceptance","contribution",need.origin.receiptId,fact.runId),ref));
      r.offer({subject:ref,occurredAt:fact.occurredAt,payload:{kind:"execution",phase:"pending",executionKind:"input_handoff_need",status:"requested",code:null,effectCertainty:null},
        contents:[{name:"Original consumer input need and stage constraints",class:"execution",stage:"input_need",mediaType:"application/json",value:JSON.parse(JSON.stringify(need))}]});
    }
    if(stage&&fact.kind==="stage_submitted"&&typeof fact.details.inputNeedId==="string") {
      related.push(inspectionLink("binding",r.ref("activity-input","contribution",fact.details.inputNeedId,fact.runId),stage));
      r.offer({subject:r.ref("activity-input","contribution",fact.details.inputNeedId,fact.runId),occurredAt:fact.occurredAt,
        payload:{kind:"execution",phase:"pending",executionKind:"input_handoff_need",status:fact.details.inputOutcome==="unavailable"?"unavailable_submitted":"supplied_submitted",code:null,effectCertainty:null}});
    }
    if(fact.kind==="scheduling_accepted") {
      const acceptance=fact.details.acceptance as ActivitySchedulingAcceptance;
      const work=r.ref("activity-scheduling","contribution",acceptance.intent.workId,fact.runId);
      const decision=r.ref(acceptance.intent.owner,"contribution",acceptance.intent.decisionId,fact.runId);
      const accepted=r.ref("activity-scheduling","contribution",acceptance.intent.id,fact.runId);
      related.push(inspectionLink("trigger",decision,accepted),inspectionLink("binding",accepted,work),inspectionLink("observes",subject,accepted));
      r.offer({subject:accepted,occurredAt:fact.occurredAt,payload:{kind:"execution",phase:"settled",executionKind:"scheduling_acceptance",status:"accepted",code:null,effectCertainty:null},
        contents:[{name:"Original scheduling acceptance",class:"execution",stage:"accepted",mediaType:"application/json",value:JSON.parse(JSON.stringify(acceptance))}]});
      for(const pathId of acceptance.intent.allowedPathIds??[]) {
        const delegation=r.ref("activity-scheduling","contribution",modelInputValueDigest({acceptance:acceptance.intent.id,pathId}),fact.runId);
        r.offer({subject:delegation,occurredAt:fact.occurredAt,
          payload:{kind:"execution",phase:"settled",executionKind:"scheduling_path_delegation",status:"delegated",code:null,effectCertainty:null},
          links:[inspectionLink("binding",accepted,delegation),inspectionLink("binding",delegation,work),inspectionLink("binding",delegation,r.ref("activity","contribution",pathId,fact.runId))]});
      }
      for(const pool of (fact.details.pools??[]) as readonly import("@agent-anything/agent-runtime/activity").ActivityResourcePool[])
        r.offer({subject:r.ref("activity-resource","contribution",pool.id,null),occurredAt:fact.occurredAt,
          payload:{kind:"execution",phase:"settled",executionKind:"resource_binding",status:"bound",code:null,effectCertainty:null},
          contents:[{name:"Trusted resource pool binding",class:"execution",stage:"binding",mediaType:"application/json",value:JSON.parse(JSON.stringify(pool))}]});
      for(const claim of acceptance.intent.resources)related.push(inspectionLink("binding",work,r.ref("activity-resource","contribution",claim.poolId,null)));
      r.offer({subject:work,occurredAt:fact.occurredAt,payload:{kind:"execution",phase:"pending",executionKind:"scheduled_work",status:acceptance.service,code:null,effectCertainty:null},
        contents:[{name:"Accepted service, timing and resource basis",class:"execution",stage:"scheduling",mediaType:"application/json",value:JSON.parse(JSON.stringify(acceptance))}]});
    }
    if(fact.kind==="scheduling_paths_sealed"||fact.kind==="scheduling_closed") {
      const work=r.ref("activity-scheduling","contribution",fact.pathId,fact.runId);
      const settled=fact.kind==="scheduling_closed"&&fact.details.settlementChecked===true;
      r.offer({subject:work,occurredAt:fact.occurredAt,
        payload:{kind:"execution",phase:settled?"settled":"pending",executionKind:"scheduled_work",
          status:settled?"closed":fact.kind==="scheduling_closed"||fact.details.closed===true?"service_closed":"paths_sealed",code:null,effectCertainty:null},
        links:[inspectionLink("observes",subject,work)],
        contents:[{name:fact.kind==="scheduling_closed"?"Work closure and settlement condition":"Path admission seal (existing work may continue)",
          class:"execution",stage:fact.kind,mediaType:"application/json",value:JSON.parse(JSON.stringify(fact.details))}]});
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
      r.offer({subject:acceptance,occurredAt:retry.decidedAt,payload:{kind:"execution",phase:"settled",executionKind:"technical_attempt_retry",status:"accepted",code:retry.reason.code,effectCertainty:null},
        contents:[{name:"Original failure, policy and earliest retry (not task progression)",class:"execution",stage:"retry",mediaType:"application/json",value:JSON.parse(JSON.stringify(retry))}]});
    }
    if(stage&&fact.kind==="dispatched"&&fact.details.scheduling) {
      const dispatch=fact.details.scheduling as ActivitySchedulingDispatch;
      const work=r.ref("activity-scheduling","contribution",dispatch.workId,fact.runId);
      related.push(inspectionLink("includes",work,stage),inspectionLink("binding",r.ref("activity-scheduling","contribution",dispatch.acceptanceId,fact.runId),stage));
      for(const claim of dispatch.claims)related.push(inspectionLink("binding",stage,r.ref("activity-resource","contribution",claim.poolId,null)));
    }
    if(fact.kind==="fact_published") {
      const published=fact.details.fact as ActivityPublishedFact;
      const original=r.ref(published.ref.owner,"contribution",published.ref.id,fact.runId,published.ref.owner==="context_delivery"?undefined:published.ref.revision);
      const publication=r.ref("activity-publication","contribution",published.id,fact.runId);
      related.push(inspectionLink("produces",original,publication),inspectionLink("includes",r.ref("activity-source","contribution",published.sourceId,fact.runId),publication),inspectionLink("observes",subject,publication));
      if(published.ref.owner==="context-representation"&&["method_input_checked","method_input_unavailable","method_input_closed"].includes(published.ref.kind))
        related.push(inspectionLink("produces",r.ref("activity","contribution",published.ref.id,fact.runId),original));
      if(published.ref.kind==="result_settled")related.push(
        inspectionLink("observes",publication,r.ref("activity","contribution",published.ref.id,fact.runId)),
        inspectionLink("produces",r.ref("shared_acceptance","contribution",published.ref.revision,fact.runId),publication));
      r.offer({subject:publication,occurredAt:fact.occurredAt,payload:{kind:"execution",phase:"settled",executionKind:"fact_publication",status:"published",code:null,effectCertainty:null},
        contents:[{name:"Published fact reference",class:"execution",stage:"published",mediaType:"application/json",value:JSON.parse(JSON.stringify(published))}]});
    }
    if(fact.kind==="reconsideration_registered") {
      const subscription=fact.details.subscription as ActivityReconsiderationSubscription;
      for(const source of subscription.sources)related.push(inspectionLink("observes",r.ref("activity-reconsideration","contribution",subscription.id,fact.runId),r.ref("activity-source","contribution",source,fact.runId)));
      if(subscription.binding?.kind==="activity_path")related.push(inspectionLink("binding",r.ref("activity-reconsideration","contribution",subscription.id,fact.runId),r.ref("activity","contribution",subscription.binding.id,fact.runId)));
    }
    if(fact.kind==="reconsideration_accepted") {
      const receipt=fact.details.receipt as ActivityReconsiderationReceipt;
      const decision=r.ref(receipt.decision.owner,"contribution",receipt.decision.id,fact.runId,
        receipt.decision.kind==="context_preparation_decision"?null:receipt.decision.revision);
      for(const id of receipt.factIds)related.push(inspectionLink("trigger",r.ref("activity-publication","contribution",id,fact.runId),decision));
      for(const sourceId of receipt.observeSources??[])related.push(inspectionLink("observes",decision,r.ref("activity-source","contribution",sourceId,fact.runId)));
      related.push(inspectionLink("settles",r.ref("shared_acceptance","contribution",receipt.id,fact.runId),decision),
        inspectionLink("includes",r.ref("activity-reconsideration","contribution",receipt.subscriptionId,fact.runId),decision));
      if(receipt.decision.owner==="material-source"&&receipt.decision.kind==="source_publication_closed"&&receipt.close) {
        related.push(inspectionLink("observes",decision,r.ref("activity","contribution",receipt.decision.id,fact.runId)));
        r.offer({subject:decision,occurredAt:fact.occurredAt,payload:{kind:"execution",phase:"settled",executionKind:"source_publication_lifecycle",
          status:"closed",code:null,effectCertainty:null},contents:[{name:"Source service closure (not material release or recipient delivery)",class:"execution",
            stage:"source_closed",mediaType:"application/json",value:JSON.parse(JSON.stringify(receipt))}]});
      }
    }
    if(stage&&Array.isArray(fact.details.dependencies))for(const dependency of fact.details.dependencies){
      if(dependency&&typeof dependency==="object"&&typeof dependency.requestId==="string"&&["accepted","raw_result"].includes(String(dependency.condition)))
        related.push(inspectionLink("prerequisite",r.ref("activity","contribution",dependency.requestId,fact.runId),stage,
          {condition:dependency.condition==="accepted"?"settled":"result",operation:`activity:${dependency.condition}`}));
    }
    if(stage&&typeof fact.details.resultId==="string")related.push(inspectionLink("produces",stage,r.ref("activity","contribution",fact.details.resultId,fact.runId)));
    if(stage&&typeof fact.details.receiptId==="string")related.push(inspectionLink("settles",r.ref("shared_acceptance","contribution",fact.details.receiptId,fact.runId),stage));
    r.offer({subject,occurredAt:fact.occurredAt,payload:{kind:"event",name:`activity.${fact.kind}`,sequence:fact.sequence,code:null},
      links:[inspectionLink("includes",r.ref("runtime","run",fact.runId,fact.runId),path),inspectionLink("includes",path,subject),
        ...(stage ? [inspectionLink("includes",path,stage),inspectionLink("includes",stage,subject)] : []),
        ...(stage && typeof fact.details.modelRequestId === "string" ? [inspectionLink("includes",stage,r.ref("model-interaction","request",fact.details.modelRequestId,fact.runId))] : [])],
      contents:[{name:"Durable activity handoff",class:"execution",stage:fact.kind,mediaType:"application/json",value:JSON.parse(JSON.stringify(fact))}]});
    recordInspectionRelationships(r,subject,fact.occurredAt,related);
  }
  async replay(runId:string,port:import("@agent-anything/agent-runtime/activity").ActivityHandoffPort): Promise<void> {
    let after = 0;
    while (true) {
      const facts = await port.command({kind:"facts",runId,after,limit:128}) as readonly ActivityHandoffFact[];
      for (const fact of facts) {
        await replayInspectionProjection(this.recorder,sink=>this.observe(fact,sink));
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
          const stage=await port.command({kind:"read_stage",requestId:fact.requestId}) as ActivityStageState|null;
          if(stage)await replayInspectionProjection(this.recorder,sink=>this.observeStage(runId,stage,sink));
        }
      }
      if (facts.length < 128) return;
      after = facts.at(-1)!.sequence;
    }
  }
}
