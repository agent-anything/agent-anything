import {InspectionRecorder} from "@agent-anything/inspection/recording";
import {inspectionLink} from "@agent-anything/inspection/adapters";
import {recordInspectionRelationships} from "./InspectionRelationships.js";
import {replayInspectionProjection, type InspectionProjectionSink} from "./InspectionReplay.js";
import type {ContextFoundationFact,ContextFoundationObserver} from "../execution-storage/ContextFoundationRecords.js";

/** Links only recorded relationships; an access is not a delivery or semantic support. */
export class ContextFoundationInspectionAdapter implements ContextFoundationObserver {
  constructor(private readonly recorder:InspectionRecorder) {}
  observe(fact:ContextFoundationFact,r:InspectionProjectionSink=this.recorder):void {
    const subject=r.ref(fact.owner,"event",`${fact.runId}:context-fact:${fact.sequence}`,fact.runId);
    const policy=fact.owner==="context_preparation_policy"&&fact.kind==="decision_accepted";
    const inputUsage=fact.owner==="model-input-measurement"&&fact.kind==="input_usage_accepted";
    const object=r.ref(policy?"context-representation":fact.owner,"contribution",fact.subject,fact.runId);
    r.offer({subject:object,occurredAt:fact.occurredAt,payload:{kind:"execution",phase:["accepted","disposed","input_retired","content_deleted","decision_accepted","responsibility_registered","supply_registered","membership_changed","exit_completed","dependency_withdrawn","owned_settled","reception_transferred","input_usage_accepted"].includes(fact.kind)?"settled":"pending",
      executionKind:fact.owner,status:fact.kind,code:null,effectCertainty:null},
      ...(["decision_accepted","judgment_recorded","input_usage_accepted"].includes(fact.kind)?{contents:[{name:inputUsage?"Accepted input usage and original exchange":fact.kind==="decision_accepted"?"Context policy decision and evidence":"Representation judgment",class:"agent" as const,stage:fact.kind,mediaType:"application/json",value:JSON.parse(JSON.stringify(fact.details))}]}:{})});
    const links=[inspectionLink("includes",r.ref("runtime","run",fact.runId,fact.runId),object),inspectionLink("includes",object,subject)];
    if(inputUsage) {
      const usage=fact.details.usage as import("@agent-anything/model-interaction/input").AcceptedInputUsage;
      links.push(inspectionLink("observes",object,r.ref("model-input","contribution",usage.encodedInputId,fact.runId)),
        inspectionLink("observes",object,r.ref("activity","contribution",usage.stageId,fact.runId)),
        inspectionLink("observes",object,r.ref("activity","contribution",usage.rawResultId,fact.runId)),
        inspectionLink("observes",object,r.ref("shared_acceptance","contribution",usage.acceptanceId,fact.runId)));
    }
    if(fact.owner==="context_input_supply") {
      const exit=fact.details.exit as import("@agent-anything/agent-runtime/context-representation").InputSupplyExit|undefined;
      const binding=(exit?.origin??fact.details.binding) as {needId?:string;consumerPathId?:string;source?:{stageId?:string}}|undefined;
      const needId=binding?.needId??fact.details.needId;
      const consumer=binding?.consumerPathId??fact.details.consumerPathId;
      const source=binding?.source?.stageId??fact.details.sourceStageId;
      for(const id of [needId,consumer,source])if(typeof id==="string")links.push(inspectionLink("observes",object,r.ref("activity","contribution",id,fact.runId)));
      const target=fact.details.target as {pathId?:string;workId?:string|null}|undefined;
      for(const id of [target?.pathId,target?.workId])if(typeof id==="string")links.push(inspectionLink("observes",object,r.ref("activity","contribution",id,fact.runId)));
      if(Array.isArray(fact.details.coveredPathIds))for(const id of fact.details.coveredPathIds)
        if(typeof id==="string"&&id!==target?.pathId)links.push(inspectionLink("observes",object,r.ref("activity","contribution",id,fact.runId)));
      if(exit) {
        if(exit.basis.kind==="returned")links.push(inspectionLink("observes",object,r.ref("activity","contribution",exit.basis.stageId,fact.runId)));
        if(exit.scheduling)links.push(inspectionLink("observes",object,r.ref("activity","contribution",exit.scheduling.workId,fact.runId)));
        links.push(inspectionLink("observes",object,r.ref("activity","contribution",exit.subscriptionId,fact.runId)));
      }
      if(typeof fact.details.subscriptionId==="string")links.push(inspectionLink("delivers",object,r.ref("activity","contribution",fact.details.subscriptionId,fact.runId)));
      if(typeof fact.details.closureAcceptanceId==="string")links.push(inspectionLink("observes",object,r.ref("shared_acceptance","contribution",fact.details.closureAcceptanceId,fact.runId)));
      if(typeof fact.details.acceptanceId==="string")links.push(inspectionLink("observes",object,r.ref("shared_acceptance","contribution",fact.details.acceptanceId,fact.runId)));
    }
    if(fact.owner==="material_custody"&&fact.details.origin&&fact.details.version) {
      const origin=fact.details.origin as unknown as import("@agent-anything/context/custody").MaterialOrigin;
      const version=fact.details.version as unknown as import("@agent-anything/context/custody").MaterialVersionRef;
      links.push(inspectionLink("observes",object,r.ref(origin.owner,"contribution",origin.recordId,origin.runId,origin.revision)),
        inspectionLink("includes",r.ref("material_custody","contribution",version.materialId,null,version.version),object));
    }
    if(fact.owner==="material_custody"&&fact.kind==="access_admitted") {
      const {source,grant,hold}=fact.details as unknown as import("@agent-anything/context/custody").MaterialAccessAdmission;
      links.push(inspectionLink("observes",object,r.ref("material_custody","contribution",source.holdId,source.recipient.runId)),
        inspectionLink("produces",object,r.ref("material_custody","contribution",hold.id,hold.consumer.runId)),
        inspectionLink("includes",r.ref("material_custody","contribution",grant.range.materialId,null,grant.range.version),object));
      const reference=fact.details.reference as {id:string;revision:string}|undefined;
      if(reference)links.push(inspectionLink("includes",r.ref("context-material","contribution",reference.id,null,reference.revision),object));
    }
    if(fact.kind==="decision_accepted"&&fact.details.investment&&typeof fact.details.investment==="object") {
      const investment=fact.details.investment as {workId?:unknown;pathId?:unknown;previousPathId?:unknown};
      if(typeof investment.workId==="string")links.push(inspectionLink("produces",object,r.ref("activity-scheduling","contribution",investment.workId,fact.runId)));
      if(typeof investment.pathId==="string")links.push(inspectionLink("produces",object,r.ref("activity","contribution",investment.pathId,fact.runId)));
      if(typeof investment.previousPathId==="string")links.push(inspectionLink("observes",object,r.ref("activity","contribution",investment.previousPathId,fact.runId)));
    }
    if(policy) {
      const decision=fact.details.decision as import("@agent-anything/agent-runtime/context-representation").ContextPreparationDecision;
      const current=fact.details.currentInputEvidence as import("@agent-anything/agent-runtime/context-representation").ContextPolicyEvidence|undefined;
      if(current?.owner==="activity"&&current.kind==="fact")
        links.push(inspectionLink("observes",object,r.ref("activity","contribution",current.id,fact.runId)));
      for(const rejected of (fact.details.rejectedInputs??[]) as NonNullable<import("@agent-anything/agent-runtime/context-representation").ContextPreparationPolicyInput["rejectedInputs"]>)
        links.push(inspectionLink("observes",object,r.ref("activity","contribution",rejected.evidence.id,fact.runId)),
          inspectionLink("observes",object,r.ref("activity","contribution",rejected.stageId,fact.runId)),
          inspectionLink("observes",object,r.ref("shared_acceptance","contribution",rejected.evidence.revision,fact.runId)));
      for(const receiver of (fact.details.inputReceptions??[]) as NonNullable<import("@agent-anything/agent-runtime/context-representation").ContextPreparationPolicyInput["inputReceptions"]>) {
        links.push(inspectionLink("observes",object,r.ref("activity","contribution",receiver.pathId,fact.runId)));
        if(receiver.inputGap)links.push(inspectionLink("observes",object,r.ref("activity","contribution",receiver.inputGap.evidence.id,fact.runId)),
          inspectionLink("observes",r.ref("context-reception-option","contribution",receiver.optionId,fact.runId),r.ref("activity","contribution",receiver.inputGap.evidence.id,fact.runId)));
      }
      const report=fact.details.observationReport as import("@agent-anything/agent-runtime/context-representation").ContextPreparationEvidenceReport|null|undefined;
      if(report) {
        for(const input of report.window.inputs) {
          links.push(inspectionLink("observes",object,r.ref("model-input","contribution",input.inputId,fact.runId)));
          if(input.evidence.owner==="activity")links.push(inspectionLink("observes",object,r.ref("activity","contribution",input.evidence.id,fact.runId)));
        }
        for(const cost of report.costs)links.push(inspectionLink("observes",object,r.ref("activity","contribution",cost.pathId,fact.runId)));
      }
      const supply=fact.details.methodSupplyReport as import("@agent-anything/agent-runtime/context-representation").ContextMethodSupplyReport|null|undefined;
      for(const offer of supply?.offers??[])for(const source of offer.sources)
        links.push(inspectionLink("observes",object,r.ref("material_custody","contribution",source.materialId,null,source.version)));
      for(const original of supply?.originalWork??[]) {
        links.push(inspectionLink("observes",object,r.ref("activity","contribution",original.pathId,fact.runId)),
          inspectionLink("observes",object,r.ref("activity-scheduling","contribution",original.workId,fact.runId)));
      }
      for(const option of (fact.details.receptionOptions??[]) as readonly import("@agent-anything/agent-runtime/context-representation").ContextInputReceptionOption[]) {
        const proposal=r.ref("context-reception-option","contribution",option.id,fact.runId);
        links.push(inspectionLink("observes",object,proposal));
        r.offer({subject:proposal,occurredAt:fact.occurredAt,payload:{kind:"event",name:"context.input_reception_option",sequence:fact.sequence,code:null},
          contents:[{name:"Complete recipient input proposal (not adoption)",class:"agent",stage:"proposed",mediaType:"application/json",value:JSON.parse(JSON.stringify(option))}]});
        links.push(...option.members.flatMap(member=>[inspectionLink("observes",proposal,r.ref("activity","contribution",member.pathId,fact.runId)),
          inspectionLink("observes",proposal,r.ref("activity-scheduling","contribution",member.workId,fact.runId))]));
        if(decision.investment.kind==="prepare_input"&&decision.investment.optionId===option.id)
          links.push(inspectionLink("observes",object,r.ref("activity","contribution",option.id,fact.runId)));
      }
      for(const receipt of (fact.details.admissionRejections??[]) as readonly import("@agent-anything/agent-runtime/activity").SharedAcceptanceReceipt[]) {
        const rejection=r.ref("shared_acceptance","contribution",receipt.id,fact.runId);
        links.push(inspectionLink("observes",object,rejection));
        r.offer({subject:rejection,occurredAt:null,payload:{kind:"execution",phase:"settled",executionKind:"shared_acceptance",status:receipt.outcome,code:receipt.rejection?.code??null,effectCertainty:null},
          contents:[{name:"Original preparation admission rejection",class:"execution",stage:"rejected",mediaType:"application/json",value:JSON.parse(JSON.stringify(receipt))}]});
      }
      if(decision.foreground.kind==="continue")links.push(inspectionLink("observes",object,r.ref("model-input","contribution",decision.foreground.preparedInputId,fact.runId)));
      if(["reuse","reuse_input","prepare_input"].includes(decision.investment.kind)&&"pathId" in decision.investment)
        links.push(inspectionLink("observes",object,r.ref("activity","contribution",decision.investment.pathId,fact.runId)));
      if(decision.foreground.kind==="needs_result")links.push(inspectionLink("prerequisite",r.ref("activity","contribution",decision.foreground.pathId,fact.runId),object,
        {condition:"result",operation:"required_context_result"}));
    }
    for(const [field,owner] of [["instanceId","material_custody"],["selectionId","context_selection"],["inputId","context_selection"],
      ["acceptanceId","shared_acceptance"],["activityId","activity"],["responseId","activity"],["holdId","material_custody"],["detailHoldId","material_custody"]] as const) {
      const id=fact.details[field],runId=field==="acceptanceId"&&typeof fact.details.acceptanceScope==="string"?fact.details.acceptanceScope:fact.runId;
      if(typeof id==="string")links.push(inspectionLink("includes",r.ref(owner,"contribution",id,runId),subject));
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
    if(fact.owner==="representation"&&fact.kind==="judgment_recorded"&&fact.details.dependencies&&typeof fact.details.dependencies==="object") {
      const dependencies=fact.details.dependencies as Record<string,unknown>;
      for(const field of ["stage","rawResult"]){const id=dependencies[field];if(typeof id==="string")links.push(inspectionLink("observes",object,r.ref("activity","contribution",id,fact.runId)));}
      if(typeof dependencies.reusedJudgment==="string")links.push(inspectionLink("includes",r.ref("representation","contribution",dependencies.reusedJudgment,fact.runId),object));
      for(const [key,id] of Object.entries(dependencies))if(typeof id==="string") {
        if(/^(inheritedJudgment:\d+(?::\d+)?|relationshipSupport:\d+)$/.test(key))links.push(inspectionLink("observes",object,r.ref("representation","contribution",id,fact.runId)));
        if(/^(inheritedProducer|combinationProducer):\d+$/.test(key))links.push(inspectionLink("observes",object,r.ref("activity","contribution",id,fact.runId)));
      }
      if(typeof dependencies.encodedInput==="string")links.push(inspectionLink("observes",object,r.ref("model-input","contribution",dependencies.encodedInput,fact.runId)));
      for(const ref of (fact.details.subjects??[]) as readonly {id:string;revision:string}[])
        links.push(inspectionLink("observes",object,r.ref("representation","contribution",JSON.stringify([ref.id,ref.revision]),fact.runId)));
      for(const range of (fact.details.coverage??[]) as readonly {materialId:string;version:string}[])
        links.push(inspectionLink("observes",object,r.ref("material_custody","contribution",range.materialId,null,range.version)));
    }
    if(fact.owner==="context_selection"&&fact.kind==="input_bound"&&typeof fact.details.combinationJudgmentId==="string")
      links.push(inspectionLink("observes",object,r.ref("representation","contribution",fact.details.combinationJudgmentId,fact.runId)));
    if(fact.owner==="context_delivery"&&fact.kind==="accepted"&&typeof fact.details.inputId==="string")links.push(inspectionLink("delivers",object,r.ref("context_selection","contribution",fact.details.inputId,fact.runId)));
    if(fact.kind==="read"||fact.kind==="search"||fact.kind==="structure_read")links.push(inspectionLink("observes",subject,r.ref("material_custody","contribution",String(fact.details.instanceId),fact.runId)));
    r.offer({subject,occurredAt:fact.occurredAt,payload:{kind:"event",name:`${fact.owner}.${fact.kind}`,sequence:fact.sequence,code:null},
      contents:[{name:"Context ownership and accepted relationships",class:"agent",stage:fact.kind,mediaType:"application/json",value:JSON.parse(JSON.stringify(fact))}]});
    // Relationship fan-out is not the size of the source fact or a new policy decision.
    recordInspectionRelationships(r,subject,fact.occurredAt,links);
  }
  async replay(runId:string,read:(runId:string,after:number,limit:number)=>Promise<readonly ContextFoundationFact[]>):Promise<void> {
    let after=0;
    while(true){const facts=await read(runId,after,128);
      for(const fact of facts)await replayInspectionProjection(this.recorder,sink=>this.observe(fact,sink));
      if(facts.length<128)return;after=facts.at(-1)!.sequence;}
  }
}
