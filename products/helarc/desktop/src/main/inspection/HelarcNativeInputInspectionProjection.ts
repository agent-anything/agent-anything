import type {ActivityPathState,ActivityStageState} from "@agent-anything/agent-runtime/activity";
import type {NativeInputPreparationValue} from "@agent-anything/agent-runtime/context-representation";
import type {HelarcNativeInputDemandPlan,HelarcRetainedNativeInput,HelarcResponsesInRequestReceptionPlan,HelarcResponsesInRequestEligibility} from "@agent-anything/helarc/controller";
import {inspectionLink} from "@agent-anything/inspection/adapters";
import type {InspectionRecordInput} from "@agent-anything/inspection/records";
import type {InspectionProjectionRefs} from "./InspectionReplay.js";
import {identifiedRecords} from "./InspectionReplay.js";
import {processEvidenceRecords,processObservationRef} from "./ProcessEvidenceProjection.js";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";

/** Product-native shapes stay at the Product observation boundary, not in shared execution. */
export function* helarcNativeInputRecords(r:InspectionProjectionRefs,path:ActivityPathState,stage:ActivityStageState):Generator<InspectionRecordInput>{
  const runId=path.intent.runId,origin=r.ref("activity","contribution",stage.request.id,runId);
  if(path.intent.purpose.contract?.ref?.id==="helarc.responses-compact"&&stage.result){
    const value=stage.result.value as {assessment?:import("@agent-anything/helarc/controller").HelarcResponsesCompactAssessment;
      assessmentDisposition?:import("@agent-anything/helarc/controller").HelarcCompactAssessmentNotStarted}|null;
    const local=value?.assessmentDisposition;
    if(local?.kind==="assessment_not_started"&&local.attemptId===stage.result.attemptId&&local.stageId===stage.request.id){
      const raw=r.ref("activity","contribution",stage.result.id,runId);
      const disposition=r.ref("assessment-disposition","event",local.attemptId,runId,"1");
      yield {id:"compact-assessment-disposition:"+modelInputValueDigest([runId,stage.result.id,local]),subject:disposition,occurredAt:stage.result.recordedAt,
        payload:{kind:"execution",phase:"settled",executionKind:"native_assessment_admission",status:"not_started",code:local.reason,effectCertainty:null},
        links:[inspectionLink("produces",origin,disposition),inspectionLink("binding",raw,disposition),
          inspectionLink("observes",disposition,r.ref("runtime","event",local.compactAcceptance.id,runId,local.compactAcceptance.revision))],
        contents:[{name:"Frozen assessment admission and checked native work",class:"execution",stage:"disposition",mediaType:"application/json",
          value:JSON.parse(JSON.stringify(local))}]};
    }
    const assessment=stage.request.stageKind==="assessment"?value?.assessment:null;
    if(assessment){
      const subject=r.ref("context-representation","contribution",assessment.id,runId,"1");
      const emittedFacts=new Set<string>();
      for(const f of assessment.findings){
        const item=r.ref("context-preservation","contribution",f.id,runId);
        yield {id:"compact-finding:"+modelInputValueDigest([runId,assessment.id,f.id]),subject:item,occurredAt:stage.result.recordedAt,
          payload:{kind:"execution",phase:"settled",executionKind:"preservation_finding",status:f.conclusion,code:f.assessmentIssue?.category??f.kind,effectCertainty:null},
          links:[inspectionLink("includes",subject,item),inspectionLink("produces",origin,item),
            ...(f.purposeReceipts??[]).map(p=>inspectionLink("observes",item,r.ref("runtime","event",p.id,runId,p.revision)))],
          contents:[{name:"Preservation duty and evidence",class:"agent",stage:"assessment",mediaType:"application/json",
            value:JSON.parse(JSON.stringify({assessment:assessment.id,source:assessment.sourceDigest,admissible:assessment.quality.allowed,
              finding:f.factAssessments?{...f,factAssessments:f.factAssessments.map(v=>v.id)}:f}))}]};
        for(const fact of f.factAssessments??[]){
          const id="compact-fact:"+modelInputValueDigest([runId,assessment.id,fact.id]);
          const node=r.ref("context-preservation","contribution",id,runId);
          const first=!emittedFacts.has(id);emittedFacts.add(id);
          yield {id:first?id:id+":"+modelInputValueDigest(f.id),subject:node,occurredAt:stage.result.recordedAt,
            payload:{kind:"execution",phase:"settled",executionKind:first?"preservation_fact":"preservation_fact_membership",
              status:fact.status,code:fact.required?"required":"detail",effectCertainty:null},
            links:[inspectionLink("includes",item,node)],contents:first?[{name:"Fact, source, question coverage and answer quality",
              class:"agent",stage:"assessment",mediaType:"application/json",value:JSON.parse(JSON.stringify({assessment:assessment.id,fact}))}]:[]};
        }
      }
    }
    const result=stage.result.value as {interruption?:readonly {activityId?:string;disposition?:{limitation?:import("@agent-anything/agent-runtime/model-access").ProtocolObservationLimitation}}[]}|null;
    for(const entry of result?.interruption??[]){
      const l=entry?.disposition?.limitation;
      if(l?.kind!=="protocol_observation_unavailable"||l.activityId!==entry.activityId)continue;
      const b=l.basis,raw=r.ref("activity","contribution",stage.result.id,runId);
      const disposition=r.ref("assessment-disposition","event",l.activityId,runId,String(b.revision));
      yield {subject:disposition,occurredAt:stage.result.recordedAt,payload:{kind:"execution",phase:"settled",executionKind:"native_assessment_observation",
        status:"unavailable",code:l.reason,effectCertainty:null},
        links:[inspectionLink("binding",raw,disposition),inspectionLink("observes",disposition,r.ref("protocol-evidence","event",`${b.scopeId}:${b.kind}:${b.key}`,runId,String(b.revision))),
          inspectionLink("binding",disposition,r.ref("protocol-execution","model-activity",l.activityId,runId))],
        contents:[{name:"Original assessment limitation (not a model answer)",class:"execution",stage:"disposition",mediaType:"application/json",value:JSON.parse(JSON.stringify(l))}]};
    }
  }
  if(path.intent.purpose.contract.ref.id==="helarc.responses-in-request-reception"&&stage.request.stageKind==="receive"){
    const plan=(stage.request.input as {plan:HelarcResponsesInRequestReceptionPlan}).plan;
    const result=stage.result?.value as {kind?:string;reason?:string;work?:unknown;eligibility?:HelarcResponsesInRequestEligibility;
      preparation?:NativeInputPreparationValue}|undefined;
    const selected=result?.preparation?.exactInput as HelarcRetainedNativeInput|undefined;
    yield {subject:origin,occurredAt:stage.result?.recordedAt??null,
      payload:{kind:"execution",phase:stage.status==="accepted"?"settled":"pending",executionKind:"in_request_input_reception",
        status:path.cancelled?"cancelled":result?.kind==="ready"?"input_checked":result?.kind==="unavailable"?"input_unavailable":stage.status,
        code:result?.reason??null,effectCertainty:null},
      links:[inspectionLink("binding",r.ref("activity","contribution",plan.inputSupply.source.stageId,runId),origin),
        inspectionLink("binding",r.ref("activity","contribution",`${plan.originalInputPathId}:stage:1`,runId),origin),
        ...(plan.binding.sourceInput?[inspectionLink("binding",r.ref("context_selection","contribution",plan.binding.sourceInput.inputId,runId),origin)]:[]),
        ...(result?.eligibility?[inspectionLink("observes",origin,r.ref("helarc-native-input","contribution",result.eligibility.id,runId,"1"))]:[]),
        ...(result?.preparation?[inspectionLink("produces",origin,r.ref("context_selection","contribution",result.preparation.inputId,runId))]:[])],
      contents:[{name:"Original method-use policy and reception (not dispatch or conversion)",class:"execution",stage:"input_preparation",mediaType:"application/json",
        value:JSON.parse(JSON.stringify({scope:plan.binding.scope,inputNeedId:plan.inputNeed.needId,sourceInput:plan.binding.sourceInput??null,
          originalUse:plan.use,eligibility:result?.eligibility??null,result:result?.kind??null,reason:result?.reason??null,
          agreement:selected?.compactionAgreement??null,work:result?.work??null,
          actualConversionObserved:false,adoptionNotImplied:true,cancelled:path.cancelled}))}]};
    if(result?.eligibility){
      const e=result.eligibility,subject=r.ref("helarc-native-input","contribution",e.id,runId,"1");
      yield {subject,occurredAt:stage.result?.recordedAt??null,
        payload:{kind:"execution",phase:"settled",executionKind:"method_use_admission",status:e.allowed?"eligible":"excluded",
          code:e.reasons[0]??null,effectCertainty:null},links:[inspectionLink("observes",origin,subject)],
        contents:[{name:"Joint use conditions and preservation coverage",class:"execution",stage:"method_admission",mediaType:"application/json",
          value:JSON.parse(JSON.stringify(e))}]};
    }
  }
  if(path.intent.purpose.contract.ref.id==="helarc.native-auxiliary-input"&&stage.request.stageKind==="prepare_input"){
    const input=stage.request.input as {kind:string;activityId:string;source:{id:string;revision:string};content:{id:string;digest:string}};
    const result=stage.result?.value as {kind?:string;content?:{id:string;digest:string}|null;countActivityId?:string|null}|undefined;
    if(input.kind!=="helarc_native_auxiliary_input")throw new TypeError("native_auxiliary_input_inspection_source_invalid");
    const recipient=r.ref("protocol-execution","model-activity",input.activityId,runId);
    yield {subject:origin,occurredAt:stage.result?.recordedAt??null,payload:{kind:"execution",phase:stage.status==="accepted"?"settled":"pending",
      executionKind:"auxiliary_input_preparation",status:stage.status,code:null,effectCertainty:null},
      links:[inspectionLink("produces",origin,recipient),
        inspectionLink("binding",r.ref("protocol-content","contribution",input.content.id,runId,input.content.digest),origin),
        inspectionLink("binding",r.ref("model-input-source","contribution",input.source.id,runId,input.source.revision),origin),
        ...(result?.countActivityId?[inspectionLink("observes",origin,r.ref("protocol-execution","model-activity",result.countActivityId,runId))]:[]),
        ...(result?.content?[inspectionLink("produces",origin,r.ref("protocol-content","contribution",result.content.id,runId,result.content.digest))]:[])],
      contents:[{name:"Original auxiliary input work and allowance (not generation)",class:"execution",stage:"input_preparation",mediaType:"application/json",
        value:JSON.parse(JSON.stringify({source:input,resourceLimits:path.intent.resourceLimits??{},result:result??null,generationAccepted:false}))}]};
    return;
  }
  if(path.intent.purpose.contract.ref.id==="helarc.native-input-demand"&&stage.request.stageKind==="source"){
    const plan=(stage.request.input as {plan:HelarcNativeInputDemandPlan}).plan,planning=plan.supplyConditions?.generationPlanning;
    if(planning){
      const subject=r.ref("native-input-planning","contribution",planning.id,runId);
      yield {subject,occurredAt:null,payload:{kind:"execution",phase:"settled",executionKind:"generation_space_planning",
        status:planning.reservation.quantity.kind==="estimate"?"estimated":"unknown",code:null,effectCertainty:null},
        links:[inspectionLink("observes",origin,subject),...planning.samples.map(sample=>inspectionLink("observes",subject,
          r.ref("protocol-evidence","event",`${sample.scopeId}:usage:${sample.key}`,runId,String(sample.revision))))],
        contents:[{name:"Frozen generation-space planning (not an output limit)",class:"execution",stage:"capacity",mediaType:"application/json",
          value:JSON.parse(JSON.stringify(planning))}]};
    }
  }
}

export function* nativePreparationRecords(r:InspectionProjectionRefs,runId:string,stageId:string,
  result:ActivityStageState["result"],accepted:boolean):Generator<InspectionRecordInput,void>{
  if(!result)return;
  const value=result.value as {preparation?:NativeInputPreparationValue}|null|undefined,p=value?.preparation;
  if(p?.kind!=="native_input_preparation"||p.projection.owner!=="helarc-native-input")return;
  const native=p.exactInput as HelarcRetainedNativeInput;
  if(native?.kind!=="helarc_native_input")return;
  const subject=r.ref("context_selection","contribution",p.inputId,runId),status=accepted?"preparation_accepted":"preparation_observed";
  const digest=modelInputValueDigest({runId,stageId,raw:result.id,input:p.inputId,body:p.encoded.bodyDigest,status});
  const origin={owner:"native-input-preparation",id:"native-preparation:"+digest,runId,revision:"1"};
  const observation=processObservationRef(r,origin,digest),occurredAt=accepted?null:result.recordedAt;
  yield {id:origin.id,subject,occurredAt,payload:{kind:"execution",phase:"settled",executionKind:"native_input_preparation",
    status,code:null,effectCertainty:null},links:[inspectionLink("observes",observation,subject)],
    contents:[{name:"Prepared native request (not dispatch)",class:"agent",stage:"encoded",mediaType:"text/plain",value:p.encoded.body},
      {name:"Full-input capacity, reservations and unknowns",class:"execution",stage:"capacity",mediaType:"application/json",value:JSON.parse(JSON.stringify(p.capacity))},
      {name:"Native source groups, continuity and retained dependencies",class:"agent",stage:"source",mediaType:"application/json",
        value:JSON.parse(JSON.stringify({manifest:native.manifest,prefixGroups:native.prefixGroups,predecessor:native.predecessor,
          continuity:native.continuity,resultPresentations:native.resultPresentations??[],compactionAgreement:native.compactionAgreement??null}))}]};
  const links=[inspectionLink("produces",r.ref("activity","contribution",stageId,runId),subject)];
  const representations=new Set<string>(),holds=new Set<string>();
  for(const group of native.manifest.groups){
    representations.add(JSON.stringify([group.representation.id,group.representation.revision]));
    for(const id of group.holds)holds.add(id);
  }
  for(const id of representations)links.push(inspectionLink("includes",subject,r.ref("representation","contribution",id,runId)));
  for(const id of holds)links.push(inspectionLink("binding",r.ref("material_custody","contribution",id,runId),subject));
  yield* identifiedRecords(origin.id+":evidence",processEvidenceRecords(r,{observation,occurredAt,
    evidence:{origin,digest,subject,category:"input",name:"native_input_preparation",status,purpose:null,recipient:null},links}));
}
