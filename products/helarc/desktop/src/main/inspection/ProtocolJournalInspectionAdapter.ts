import type {ProtocolJournalFact,ProtocolJournalObserver,ProtocolJournalRecord,ProtocolPurposeAcceptance,ProtocolEvidenceRevision,ProtocolEvidenceScope,ProtocolUsageMerge,ProtocolUsageRetirement,ProtocolReconciliationHandoff} from "@agent-anything/agent-runtime/model-access";
import {ProtocolEvidenceInspectionAdapter,inspectionLink} from "@agent-anything/inspection/adapters";
import type {InspectionRecorder} from "@agent-anything/inspection/recording";
import {HelarcNativeInspectionCapture} from "./HelarcNativeInspectionCapture.js";
import {releaseBasisSubject} from "./ConnectionReleaseInspection.js";

/** Metadata and exact custody references only. Native body readers are separate, permission-checked paths. */
export class ProtocolJournalInspectionAdapter implements ProtocolJournalObserver {
  private readonly evidence:ProtocolEvidenceInspectionAdapter;
  private readonly capture:HelarcNativeInspectionCapture|null;
  constructor(private readonly recorder:Pick<InspectionRecorder,"ref"|"offer">&Partial<Pick<InspectionRecorder,"offerWhenReady"|"captures"|"capturePolicyRevision">>){
    this.evidence=new ProtocolEvidenceInspectionAdapter(recorder);
    this.capture=recorder.offerWhenReady&&recorder.captures?new HelarcNativeInspectionCapture(recorder as InspectionRecorder):null;
  }
  bindContentReader(journal:import("@agent-anything/agent-runtime/model-access").ProtocolExecutionJournal,selections?:import("@agent-anything/context/selection").ContextSelectionPort):void{this.capture?.bind(journal,selections);}
  async flush():Promise<void>{await this.capture?.flush();}
  observe(fact:ProtocolJournalFact,origin:"live"|"import"="live"):void {
    this.capture?.enqueue(fact,origin);
    const owner=fact.kind.startsWith("material_delivery.")?"material-delivery":"protocol-execution";
    const subject=this.recorder.ref(owner,"event",`${owner}:${fact.sequence}`,fact.runId);
    const activity=this.recorder.ref("protocol-execution","model-activity",fact.activityId,fact.runId);
    const links=[inspectionLink("produces",activity,subject)];
    if(fact.kind==="admission_reserved"||fact.kind==="admission_closed"){
      const value=fact.value as import("@agent-anything/agent-runtime/model-access").ProtocolAdmissionReservation;
      links.push(inspectionLink("binding",subject,this.recorder.ref("protocol-admission","event",fact.activityId,fact.runId)),
        inspectionLink("binding",this.recorder.ref("model-composition","definition",value.activity.composition.digest,fact.runId),subject));
      if(value.closedBy)links.push(inspectionLink("settles",this.recorder.ref("execution","event",value.closedBy.id,fact.runId,value.closedBy.revision),subject));
    }
    if(fact.kind==="input_refused"){
      const value=fact.value as import("@agent-anything/agent-runtime/model-access").ProtocolInputRejectionEvidence;
      links.push(inspectionLink("binding",this.recorder.ref("protocol-execution","event",value.evidence.id,fact.runId,value.evidence.revision),subject),
        inspectionLink("binding",this.recorder.ref("context_selection","contribution",value.inputId,fact.runId),subject),
        inspectionLink("binding",this.recorder.ref("context_selection","contribution",value.scopeId,fact.runId),subject));
    }
    if(fact.kind==="retention_released"){
      const value=fact.value as {basis:{id:string;revision:string}};
      links.push(inspectionLink("binding",this.recorder.ref("protocol-execution","event",value.basis.id,fact.runId,value.basis.revision),subject));
    }
    if(fact.kind==="connection_released"){
      const release=fact.value as import("@agent-anything/agent-runtime/model-access").ProtocolConnectionRelease;
      const {observation}=release;
      const basis=releaseBasisSubject(this.recorder,{runId:fact.runId,activityId:fact.activityId,release});
      this.recorder.offer({id:`connection-release-basis:${basis.id}`,subject:basis,occurredAt:fact.occurredAt,
        payload:{kind:"event",name:"connection.release_basis",sequence:fact.sequence,code:null},
        links:[inspectionLink("produces",subject,basis,{operation:"authorizes_local_release"})]});
      const b=observation.limitation.basis;
      links.push(inspectionLink("binding",this.recorder.ref("activity","contribution",observation.stageId,fact.runId),subject),
        inspectionLink("binding",this.recorder.ref("shared_acceptance","contribution",observation.receiptId,fact.runId),subject),
        inspectionLink("binding",this.recorder.ref("protocol-evidence","event",`${b.scopeId}:${b.kind}:${b.key}`,fact.runId,String(b.revision)),subject));
    }
    if(fact.kind==="input_use_settled"){
      const value=fact.value as {input:{id:string;digest:string};basis:{id:string;revision:string};acceptanceId:string};
      links.push(inspectionLink("settles",subject,this.recorder.ref("context_selection","contribution",value.input.id,fact.runId)),
        inspectionLink("binding",this.recorder.ref("protocol-execution","event",value.basis.id,fact.runId,value.basis.revision),subject),
        inspectionLink("binding",this.recorder.ref("shared_acceptance","contribution",value.acceptanceId,fact.runId),subject));
    }
    if(fact.kind==="prepared"){
      const value=fact.value as {contextInput?:{id:string;digest:string}};
      if(value.contextInput)links.push(inspectionLink("binding",this.recorder.ref("context_selection","contribution",value.contextInput.id,fact.runId),subject));
    }
    if(fact.kind==="evidence_scope"){
      const {scope}=fact.value as {scope:ProtocolEvidenceScope};
      links.push(inspectionLink("binding",subject,this.recorder.ref("protocol-evidence","event",scope.id,fact.runId)));
    }
    if(fact.kind==="reconciliation_handoff"||fact.kind==="reconciliation_closed"){
      const handoff=fact.kind==="reconciliation_handoff"?(fact.value as {handoff:ProtocolReconciliationHandoff}).handoff:fact.value as ProtocolReconciliationHandoff;
      const transfer=this.recorder.ref("protocol-reconciliation","event",handoff.id,fact.runId);
      links.push(inspectionLink("binding",subject,transfer),inspectionLink("settles",this.recorder.ref("shared_acceptance","contribution",fact.identity,fact.runId),transfer));
      for(const basis of [handoff.checkpoint,...(handoff.disposition?[handoff.disposition.basis]:[])])
        links.push(inspectionLink("binding",this.recorder.ref("protocol-execution","event",basis.id,fact.runId,basis.revision),transfer));
      for(const reference of handoff.dependencies)links.push(inspectionLink("binding",this.recorder.ref("protocol-content","contribution",reference.id,fact.runId,reference.digest),transfer));
    }
    if(fact.kind==="evidence"){
      const value=fact.value as ProtocolEvidenceRevision;
      const evidence=this.recorder.ref("protocol-evidence","event",`${value.scopeId}:${value.kind}:${value.key}`,fact.runId,String(value.revision));
      links.push(inspectionLink("binding",subject,evidence));
      links.push(inspectionLink("binding",this.recorder.ref("protocol-evidence","event",value.scopeId,fact.runId),evidence));
      for(const ref of [value.content,...value.references])links.push(inspectionLink("binding",this.recorder.ref("protocol-content","contribution",ref.id,fact.runId,ref.digest),evidence));
      for(const dependency of value.dependencies)links.push(inspectionLink("binding",this.recorder.ref("protocol-execution","event",dependency.ref.id,fact.runId,dependency.ref.revision),evidence));
    }
    if(fact.kind==="usage_retired"){
      const value=fact.value as ProtocolUsageRetirement;
      const alias=this.recorder.ref("protocol-evidence","event",`${value.scopeId}:usage-retirement:${value.key}`,fact.runId);
      links.push(inspectionLink("binding",subject,alias));
      links.push(inspectionLink("binding",alias,this.recorder.ref("protocol-evidence","event",`${value.scopeId}:usage-merge:${value.mergeId}`,fact.runId)));
      links.push(inspectionLink("binding",alias,this.recorder.ref("protocol-evidence","event",`${value.scopeId}:usage:${value.survivor.key}`,fact.runId,String(value.survivor.revision)),{operation:"usage_merge"}));
    }
    if(fact.kind==="usage_merge"){
      const value=fact.value as ProtocolUsageMerge;
      const merge=this.recorder.ref("protocol-evidence","event",`${value.scopeId}:usage-merge:${value.mergeId}`,fact.runId);
      const survivor=this.recorder.ref("protocol-evidence","event",`${value.scopeId}:usage:${value.survivor.key}`,fact.runId,String(value.survivor.revision));
      links.push(inspectionLink("binding",subject,merge),inspectionLink("binding",merge,survivor));
      links.push(inspectionLink("settles",this.recorder.ref("shared_acceptance","contribution",value.acceptanceId,fact.runId),merge));
      links.push(inspectionLink("binding",this.recorder.ref("protocol-content","contribution",value.survivor.content.id,fact.runId,value.survivor.content.digest),survivor));
      for(const retired of value.retired){
        const alias=this.recorder.ref("protocol-evidence","event",`${value.scopeId}:usage-retirement:${retired.key}`,fact.runId);
        links.push(inspectionLink("produces",merge,alias),inspectionLink("binding",alias,survivor,{operation:"usage_merge"}));
        if(retired.previous){
          const previous=this.recorder.ref("protocol-evidence","event",`${value.scopeId}:usage:${retired.key}`,fact.runId,String(retired.previous.revision));
          links.push(inspectionLink("binding",previous,alias,{operation:"usage_retirement"}));
          links.push(inspectionLink("binding",this.recorder.ref("protocol-content","contribution",retired.previous.content.id,fact.runId,retired.previous.content.digest),previous));
        }
      }
    }
    if(["dispatch_intent","reconciliation_intent","owner_checkpoint","observation","history_disposition","native_checkpoint"].includes(fact.kind)){
      const value=fact.value as ProtocolJournalRecord;
      if(value.source){
        this.evidence.source(value.source);
        links.push(inspectionLink("binding",subject,this.recorder.ref(value.source.protocol.id,"event",value.ref.id,fact.runId,value.ref.revision)));
      }
      links.push(inspectionLink("binding",this.recorder.ref("protocol-content","contribution",value.content.id,fact.runId,value.content.digest),subject));
      for(const dependency of value.dependencies)links.push(inspectionLink("binding",this.recorder.ref(owner,"event",dependency.id,fact.runId,dependency.revision),subject));
      links.push(inspectionLink("binding",subject,this.recorder.ref(owner,"event",value.ref.id,fact.runId,value.ref.revision)));
    }
    if(fact.kind==="purpose_accepted"){
      const acceptance=fact.value as ProtocolPurposeAcceptance;
      for(const source of acceptance.evidence.sources)this.evidence.source(source);
      this.evidence.accepted(acceptance.evidence);
      links.push(inspectionLink("binding",this.recorder.ref("runtime","event",acceptance.evidence.acceptance.id,fact.runId,acceptance.evidence.acceptance.revision),subject));
      links.push(inspectionLink("binding",this.recorder.ref("protocol-content","contribution",acceptance.result.id,fact.runId,acceptance.result.digest),subject));
    }
    this.recorder.offer({id:`${owner}:${fact.runId}:${fact.sequence}`,subject,occurredAt:fact.occurredAt,
      payload:{kind:"event",name:`execution.${fact.kind}`,sequence:fact.sequence,code:null},links,
      contents:[{name:"Durable evidence and responsibility",stage:fact.kind,class:"execution",mediaType:"application/json",value:JSON.parse(JSON.stringify(fact.value))}]});
  }
  async replay(read:(after:number,limit:number)=>Promise<readonly ProtocolJournalFact[]>):Promise<void>{
    const records:import("@agent-anything/inspection/records").InspectionRecordInput[]=[];
    const structural=new ProtocolJournalInspectionAdapter({ref:this.recorder.ref.bind(this.recorder),offer:input=>{records.push(input);return true;}});
    let after=0;for(;;){const facts=await read(after,128);if(!facts.length)return;
      for(const fact of facts){
        if(fact.sequence<=after)throw new Error("protocol_fact_replay_order_invalid");
        structural.observe(fact,"import");
        for(const record of records){
          const accepted=this.recorder.offerWhenReady?await this.recorder.offerWhenReady(record,{maxPendingRecords:100}):this.recorder.offer(record);
          if(accepted===false)throw new Error("protocol_fact_import_rejected");
        }
        records.length=0;await this.capture?.import(fact);after=fact.sequence;
      }
    }
  }
}
