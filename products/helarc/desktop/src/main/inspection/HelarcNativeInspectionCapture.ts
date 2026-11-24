import {readProtocolContent,type ProtocolExecutionJournal,type ProtocolJournalFact,type ProtocolExecutionState,type ProtocolContentRef,type ProtocolJournalRecord,type ProtocolEvidenceRevision} from "@agent-anything/agent-runtime/model-access";
import {nativeInspectionRecords,inspectionLink,type NativeInspectionBinding} from "@agent-anything/inspection/adapters";
import type {InspectionRecorder} from "@agent-anything/inspection/recording";
import type {InspectionJson} from "@agent-anything/inspection/records";
import type {ContextSelectionPort,ContextSelectionSnapshot} from "@agent-anything/context/selection";
import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {randomUUID} from "node:crypto";

/** Source-side, bounded diagnostic import. Inspector queries never receive this port. */
export class HelarcNativeInspectionCapture {
  private journal:ProtocolExecutionJournal|null=null;
  private selections:ContextSelectionPort|null=null;
  private pending=Promise.resolve();
  private queued=0;
  private readonly bindings=new Map<string,NativeInspectionBinding>();
  constructor(private readonly recorder:Pick<InspectionRecorder,"ref"|"offer"|"offerWhenReady"|"captures"|"capturePolicyRevision">){}
  bind(journal:ProtocolExecutionJournal,selections?:ContextSelectionPort):void{
    if(this.journal&&this.journal!==journal)throw new Error("native_capture_store_binding_changed");
    this.journal=journal;
    this.selections=selections??null;
  }
  enqueue(fact:ProtocolJournalFact,origin:"live"|"import"):void{
    if(!this.journal||fact.kind.startsWith("material_delivery."))return;
    const policy=this.recorder.capturePolicyRevision;
    if(this.queued>=512){this.issue(fact,origin,"native_capture_queue_full");return;}
    this.queued++;
    const enqueued=performance.now();
    this.pending=this.pending.then(()=>this.measure(fact,origin,policy,enqueued))
      .catch(()=>this.issue(fact,origin,"native_capture_unavailable")).finally(()=>{this.queued--;});
  }
  async import(fact:ProtocolJournalFact):Promise<void>{
    if(fact.kind.startsWith("material_delivery."))return;
    if(!this.journal)throw new Error("native_capture_store_unavailable");
    await this.measure(fact,"import",this.recorder.capturePolicyRevision,performance.now());
  }
  private async measure(fact:ProtocolJournalFact,origin:"live"|"import",policy:string,enqueued:number):Promise<void>{
    const started=performance.now(),work={queuedMs:started-enqueued,elapsedMs:0,bodyPages:0,bodyBytes:0,bodyReadMs:0,selectedInputReads:0};
    try{await this.capture(fact,origin,policy,work);}
    finally{
      work.elapsedMs=performance.now()-started;
      const record:Parameters<InspectionRecorder["offer"]>[0]={id:`native-capture-work:${randomUUID()}`,subject:this.recorder.ref("protocol-execution","model-activity",fact.activityId,fact.runId),
        occurredAt:fact.occurredAt,payload:{kind:"native_fact",category:"capture",nativeType:"Capture work",nativeId:String(fact.sequence),
          operationId:null,position:null,status:null,origin,limitation:null,
          details:Object.entries(work).map(([name,value])=>({name,value:String(value)}))}};
      if(origin==="import"){if(!await this.recorder.offerWhenReady(record))throw new Error("native_capture_work_rejected");}
      else this.recorder.offer(record);
    }
  }
  async flush():Promise<void>{await this.pending;}
  private issue(fact:ProtocolJournalFact,origin:"live"|"import",code:string):void{
    this.recorder.offer({id:`native-gap:${origin}:${fact.runId}:${fact.sequence}:${code}`,subject:this.recorder.ref("protocol-execution","model-activity",fact.activityId,fact.runId),
      occurredAt:fact.occurredAt,payload:{kind:"native_fact",details:[],category:"coverage",nativeType:fact.kind,nativeId:null,operationId:null,position:null,status:null,origin,limitation:code}});
    if(origin==="import")throw new Error(code);
  }
  private async binding(fact:ProtocolJournalFact):Promise<NativeInspectionBinding>{
    const cached=this.bindings.get(fact.activityId);if(cached)return cached;
    const reservation=fact.kind==="admission_reserved"||fact.kind==="admission_closed"?
      fact.value as import("@agent-anything/agent-runtime/model-access").ProtocolAdmissionReservation:null;
    const state=reservation?null:await this.journal!.command({kind:"state",activityId:fact.activityId}) as ProtocolExecutionState|null;
    const a=reservation?.activity??state?.activity;
    if(!a||a.scope.runId!==fact.runId||a.scope.activityId!==fact.activityId)throw new Error("native_capture_activity_missing");
    const c=a.composition.composition;
    const subject=this.recorder.ref("protocol-execution","model-activity",fact.activityId,fact.runId);
    const value={subject,protocol:c.protocol,interpretation:c.adapter.implementation};
    const accepted=await this.recorder.offerWhenReady({id:`native-activity:${fact.runId}:${fact.activityId}`,subject,occurredAt:null,
      payload:{kind:"native_interaction",protocol:c.protocol.id,protocolRevision:c.protocol.revision,
        interpretation:c.adapter.implementation.id,interpretationRevision:c.adapter.implementation.revision,purpose:a.scope.purpose.id,
        recipientId:a.scope.recipientId,compositionDigest:a.scope.compositionDigest,model:c.configuration.model??null},
      links:[inspectionLink("contains",this.recorder.ref("runtime","run",fact.runId,fact.runId),subject),
        inspectionLink("binding",this.recorder.ref("model-composition","definition",a.composition.digest,fact.runId),subject)]});
    if(!accepted)throw new Error("native_capture_binding_rejected");
    if(this.bindings.size>=256)this.bindings.delete(this.bindings.keys().next().value!);
    this.bindings.set(fact.activityId,value);return value;
  }
  private async capture(fact:ProtocolJournalFact,origin:"live"|"import",policy:string,
    work:{bodyPages:number;bodyBytes:number;bodyReadMs:number;selectedInputReads:number}):Promise<void>{
    const binding=await this.binding(fact),record=fact.value as ProtocolJournalRecord;
    const source=this.recorder.ref("protocol-execution","event",`protocol-execution:${fact.sequence}`,fact.runId);
    let content:ProtocolContentRef|null=null,value:unknown=fact.value,category=fact.kind,operationId:string|null=null;
    if(fact.kind==="prepared")content=(fact.value as {input:ProtocolContentRef}).input;
    else if(fact.kind==="purpose_accepted")content=(fact.value as {result:ProtocolContentRef}).result;
    else if(["dispatch_intent","reconciliation_intent","observation","owner_checkpoint","history_disposition"].includes(fact.kind)){
      content=record.content;operationId=record.operationId;
    }else if(fact.kind==="evidence"){
      const evidence=fact.value as ProtocolEvidenceRevision;category=evidence.kind;
      // Transport heads change with every segment. Their public metadata is the observation index.
      if(evidence.kind==="transport")value=evidence.metadata;
      else content=evidence.content;
    }else if(fact.kind==="control"){
      const state=fact.value as ProtocolExecutionState;
      value={cancelled:state.cancelled,fence:state.fence,accepted:state.accepted,retentionReleased:state.retentionReleased};
    }else if(fact.kind==="native_checkpoint")return;
    const allowed=policy===this.recorder.capturePolicyRevision&&this.recorder.captures("provider");
    let unavailableReason:string|undefined;
    if(content){
      if(!allowed){unavailableReason="capture_policy_changed_or_disabled";value=null;}
      else if(content.bytes>8*1024*1024){unavailableReason="native_capture_content_bound";value=null;}
      else {
        value=JSON.parse((await readProtocolContent(this.journal!,content,fact.activityId,8*1024*1024,w=>{
          work.bodyPages+=w.pages;work.bodyBytes+=w.bytes;work.bodyReadMs+=w.elapsedMs;
        })).toString("utf8"));
        if(policy!==this.recorder.capturePolicyRevision||!this.recorder.captures("provider")){value=null;unavailableReason="capture_policy_changed_or_disabled";}
      }
    }
    // Structural detail outside the public capture contract is not copied from execution snapshots.
    if(!allowed&&!content)value=null;
    for(const input of nativeInspectionRecords(binding,{identity:`${fact.runId}:${fact.sequence}`,category,operationId,source,
      occurredAt:fact.occurredAt,origin,value:value as InspectionJson,...(unavailableReason?{unavailableReason}:{})})){
      if(policy!==this.recorder.capturePolicyRevision){this.issue(fact,origin,"capture_policy_changed");return;}
      if(!await this.recorder.offerWhenReady(input,{maxPendingRecords:100})){this.issue(fact,origin,"native_capture_rejected");return;}
    }
    if(fact.kind==="evidence"&&category==="usage"&&allowed){
      for(const input of nativeInspectionRecords(binding,{identity:`${fact.runId}:${fact.sequence}:accounting-index`,category:"accounting",operationId,source,
        occurredAt:fact.occurredAt,origin,value:{...(fact.value as ProtocolEvidenceRevision).metadata,type:"Work accounting revision"}})){
        if(policy!==this.recorder.capturePolicyRevision){this.issue(fact,origin,"capture_policy_changed");return;}
        if(!await this.recorder.offerWhenReady(input,{maxPendingRecords:100})){this.issue(fact,origin,"native_capture_rejected");return;}
      }
    }
    const selected=fact.kind==="prepared"?(fact.value as {contextInput?:{id:string;digest:string}}).contextInput:null;
    if(selected){
      let native:unknown=null,missing:string|undefined;
      if(!allowed)missing="capture_policy_changed_or_disabled";
      else if(!this.selections)missing="selected_input_capture_port_unavailable";
      else {
        work.selectedInputReads++;
        const snapshot=await this.selections.command({kind:"binding",inputId:selected.id,checkCurrentControl:false}) as ContextSelectionSnapshot|null;
        if(!snapshot||snapshot.scope.runId!==fact.runId||digest(snapshot.input.exactInput)!==selected.digest)missing="original_selected_input_unavailable";
        else if(Buffer.byteLength(JSON.stringify(snapshot.input.exactInput))>8*1024*1024)missing="native_capture_content_bound";
        else native=snapshot.input.exactInput;
      }
      for(const input of nativeInspectionRecords(binding,{identity:`${fact.runId}:${fact.sequence}:selection`,category:"selected_input",operationId,source,
        occurredAt:fact.occurredAt,origin,value:native,...(missing?{unavailableReason:missing}:{})})){
        if(policy!==this.recorder.capturePolicyRevision){this.issue(fact,origin,"capture_policy_changed");return;}
        if(!await this.recorder.offerWhenReady(input,{maxPendingRecords:100})){this.issue(fact,origin,"native_capture_rejected");return;}
      }
    }
  }
}
