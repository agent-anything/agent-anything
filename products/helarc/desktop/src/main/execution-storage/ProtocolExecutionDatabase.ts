import type Database from "better-sqlite3";
import {createHash} from "node:crypto";
import {assertProtocolModelActivityOriginal,assertProtocolPurposeEvidence,PROTOCOL_INPUT_REJECTION_MAXIMUM_BYTES,type ProtocolInputRejection,type ProtocolInputRejectionEvidence,type ProtocolContentRef,type ProtocolJournalPart,
  type ProtocolJournalCommand,type ProtocolJournalValue,type ProtocolExecutionState,type ProtocolExecutionFence,
  type ProtocolPurposeAcceptance,type ProtocolJournalRecord,type ProtocolPendingDelivery,type ProtocolEffectIntent,
  type ProtocolJournalFact,type ProtocolReconciliationHandoff,type ProtocolAdmissionReservation,type ProtocolEvidenceRevision,type ProtocolObservationReceipt} from "@agent-anything/agent-runtime/model-access";
import {snapshotModelCallableRequest} from "@agent-anything/model-interaction";
import {nativeModelSourceKey,snapshotNativeModelSource,sameRevisionRef,type ProtocolRevisionRef} from "@agent-anything/model-interaction/protocol";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {checkedJson} from "./ContextFoundationRecords.js";
import {SharedAcceptanceRejection,type SharedAcceptanceParticipant} from "./SharedAcceptanceDatabase.js";
import {ProtocolEvidenceDatabase} from "./ProtocolEvidenceDatabase.js";
import type {NativeContextConsumer} from "./ContextSelectionDatabase.js";

export const PROTOCOL_EXECUTION_SCHEMA=`
CREATE TABLE protocol_contents(id TEXT PRIMARY KEY,activity_id TEXT NOT NULL,value TEXT NOT NULL,digest TEXT NOT NULL,written INTEGER NOT NULL,complete INTEGER NOT NULL,state_digest TEXT NOT NULL);
CREATE TABLE protocol_content_chunks(id TEXT NOT NULL,offset INTEGER NOT NULL,bytes BLOB NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(id,offset));
CREATE TABLE protocol_activities(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,value TEXT NOT NULL,digest TEXT NOT NULL);
CREATE TABLE protocol_records(activity_id TEXT NOT NULL,id TEXT NOT NULL,revision TEXT NOT NULL,value TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(activity_id,id,revision));
CREATE TABLE protocol_acceptances(activity_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,acceptance_id TEXT NOT NULL,acceptance_revision TEXT NOT NULL,value TEXT NOT NULL,digest TEXT NOT NULL,UNIQUE(run_id,acceptance_id,acceptance_revision));
CREATE TABLE protocol_effects(id TEXT PRIMARY KEY,activity_id TEXT NOT NULL,value TEXT NOT NULL,digest TEXT NOT NULL);
CREATE TABLE protocol_deliveries(id TEXT PRIMARY KEY,activity_id TEXT NOT NULL,value TEXT NOT NULL,digest TEXT NOT NULL);
CREATE TABLE protocol_facts(sequence INTEGER PRIMARY KEY,run_id TEXT NOT NULL,activity_id TEXT NOT NULL,value TEXT NOT NULL,digest TEXT NOT NULL);
CREATE INDEX protocol_facts_run ON protocol_facts(run_id,sequence);
`;
export const PROTOCOL_EXECUTION_OBJECTS=["protocol_contents","protocol_content_chunks","protocol_activities","protocol_records","protocol_acceptances","protocol_effects","protocol_deliveries","protocol_facts","protocol_facts_run"];
export const PROTOCOL_RECONCILIATION_SCHEMA=`
CREATE TABLE protocol_reconciliations(id TEXT PRIMARY KEY,activity_id TEXT NOT NULL UNIQUE,receiver TEXT NOT NULL,closed INTEGER NOT NULL,value TEXT NOT NULL,digest TEXT NOT NULL);
CREATE INDEX protocol_reconciliations_receiver ON protocol_reconciliations(receiver,closed,id);
`;
export const PROTOCOL_RECONCILIATION_OBJECTS=["protocol_reconciliations","protocol_reconciliations_receiver"];
export const PROTOCOL_ADMISSION_SCHEMA=`
CREATE TABLE protocol_admissions(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,value TEXT NOT NULL,digest TEXT NOT NULL);
CREATE INDEX protocol_admissions_run ON protocol_admissions(run_id,id);
CREATE INDEX protocol_activities_run ON protocol_activities(run_id,id);
`;
export const PROTOCOL_ADMISSION_OBJECTS=["protocol_admissions","protocol_admissions_run","protocol_activities_run"];
type Effect={intent:ProtocolEffectIntent;dispatched:boolean;confirmationBasis:"intent_recorded"|"not_started"|"run_execution"|null;confirmation:ProtocolRevisionRef|null;result:ProtocolContentRef|null;deliveries:readonly ProtocolPendingDelivery[];
  coordination?:{runId:string;acceptedIn:ProtocolRevisionRef;settledIn:ProtocolRevisionRef|null}};
type Delivery={delivery:ProtocolPendingDelivery;receipt:ProtocolRevisionRef|null};
const PAGE=65536,CHUNK=262144,STORAGE=8*1024*1024*1024;

/** Durable original facts and legal local acceptance, never a native state machine. */
export class ProtocolExecutionDatabase {
  private readonly statements=new Map<string,Database.Statement>();
  private cursor:number|null=null;
  private readonly evidence:ProtocolEvidenceDatabase;
  constructor(private readonly db:Database.Database,private readonly generation:()=>number,
    private readonly claimContextInput?:(activity:ProtocolExecutionState["activity"],input:{readonly id:string;readonly digest:string},existing:boolean)=>void,
    private readonly admissionControl?:(runId:string)=>{terminal:boolean;cancelled:boolean;commitId:string;revision:number}|null,
    private readonly observationReceipt?:(state:ProtocolExecutionState)=>ProtocolObservationReceipt|null) {
    this.evidence=new ProtocolEvidenceDatabase(db,{state:id=>this.state(id),content:ref=>this.content(ref),
      record:(id,ref)=>this.record(id,ref),fence:(state,fence,reconciliation)=>this.fence(state,fence,reconciliation),
      fact:(state,kind,id,value)=>this.fact(state,kind,id,value)});
  }
  contextConsumer():NativeContextConsumer {
    const stateFor: (input:Parameters<NativeContextConsumer["describe"]>[0],scope:Parameters<NativeContextConsumer["describe"]>[1])=>ProtocolExecutionState|null=(input,scope)=>{
      const state=this.state(input.activityId),a=state?.activity.scope;
      if(!state)return null;
      if(a!.runId!==scope.runId||a!.recipientId!==scope.recipient||a!.purpose.id!==scope.purpose||
        state.contextInput?.id!==input.id||state.contextInput.digest!==input.exactInputDigest||
        a!.compositionDigest!==input.nativeConsumer?.compositionDigest||
        modelInputValueDigest(state.activity.composition.composition.protocol)!==modelInputValueDigest(input.nativeConsumer.protocol))fail("native_context_consumer_changed");
      return state;
    };
    return {describe:(input,scope)=>{
      const state=stateFor(input,scope);if(!state)return {acceptanceOwner:scope.owner,recoveryOwner:scope.owner,settled:false,claimed:false};
      const composition=state.activity.composition.composition,purpose=[composition.task,...composition.auxiliary].find(p=>sameRevisionRef(p.purpose,state.activity.scope.purpose))!;
      return {acceptanceOwner:purpose.interpreter.implementation.id,recoveryOwner:composition.adapter.implementation.id,
        settled:state.accepted!==null||Boolean(state.inputRefusal)||Boolean(state.inputUseSettlement),claimed:true};
    },attempt:(input,scope,id)=>{
      const state=stateFor(input,scope);if(!state)return false;
      const rows=this.sql("SELECT value,digest FROM protocol_records WHERE activity_id=? AND (id=? OR json_extract(value,'$.operationId')=?)").all(input.activityId,id,id) as {value:string;digest:string}[];
      return rows.map(row=>checkedJson<ProtocolJournalRecord>(row)).some(record=>record.kind==="dispatch_intent");
    },result:(input,scope,id)=>{
      if(!stateFor(input,scope))return false;
      return this.acceptance(input.activityId)?.evidence.acceptance.id===id;
    }};
  }
  private sql(text:string) {let s=this.statements.get(text);if(!s){s=this.db.prepare(text);this.statements.set(text,s);}return s;}
  private admission(id:string):ProtocolAdmissionReservation|null {
    return this.read<ProtocolAdmissionReservation>("protocol_admissions","id=?",[id]);
  }
  private requireAdmissionControl(runId:string):void {
    if(!this.admissionControl)return;
    const control=this.admissionControl(runId);
    if(!control||control.terminal||control.cancelled)fail("native_run_admission_closed");
  }
  private unavailableObservation(state:ProtocolExecutionState):ProtocolObservationReceipt|null {
    if(state.accepted||state.cancelled||state.inputRefusal||state.connectionRelease||state.retentionReleased||!this.observationReceipt||
      !sameRevisionRef(state.activity.scope.purpose,state.activity.composition.composition.task.purpose))return null;
    const control=this.admissionControl?.(state.activity.scope.runId);
    if(!control?.terminal||control.cancelled)return null;
    return this.observationReceipt(state);
  }
  confirmInputRejection(value:ProtocolInputRejectionEvidence,scope:ProtocolInputRejection["scope"]):boolean {
    const state=this.state(value.activityId),record=this.record(value.activityId,value.evidence);
    if(!state||!record||record.kind!=="owner_checkpoint"||record.content.bytes>PROTOCOL_INPUT_REJECTION_MAXIMUM_BYTES||
      state.activity.scope.runId!==scope.runId||state.activity.scope.recipientId!==scope.recipient||state.activity.scope.purpose.id!==scope.purpose||
      state.contextInput?.id!==value.inputId||state.contextInput.digest!==value.exactInputDigest||
      value.scopeId!==scope.id||value.targetRevision!==scope.target||value.evidence.owner!==state.activity.composition.composition.adapter.implementation.id)return false;
    const target=state.activity.composition.composition.configuration.configuration;
    if(`${target.id}:${target.revision}`!==scope.target)return false;
    this.content(record.content,value.activityId);
    const proof=JSON.parse(this.bytes(record.content,0,record.content.bytes).toString("utf8")) as ProtocolInputRejection;
    if(proof.kind!=="protocol_input_rejection"||proof.revision!=="1"||proof.reason!=="input_capacity_exceeded"||
      modelInputValueDigest(proof.scope)!==modelInputValueDigest(scope)||proof.boundary!==value.boundary||proof.inputId!==value.inputId||
      proof.exactInputDigest!==value.exactInputDigest||proof.bodyDigest!==value.bodyDigest||
      modelInputValueDigest(proof.originalInput)!==modelInputValueDigest(state.input)||
      !record.dependencies.some(ref=>sameRevisionRef(ref,proof.observation)))return false;
    const observed=this.record(value.activityId,proof.observation);
    if(!observed||observed.kind!=="observation"||!observed.source||observed.operationId!==record.operationId)return false;
    // Follow immutable anchors only; native error interpretation stays with the recorded owner.
    return observed.dependencies.some(ref=>{
      const basis=this.record(value.activityId,ref);
      return basis?.kind==="dispatch_intent"&&basis.operationId===observed.operationId;
    });
  }
  confirmProfessionalResult(runId:string,publisher:string,target:string,activityId:string,resultType:{protocol:string;nativeKind:string},raw:ProtocolRevisionRef,accepted:ProtocolRevisionRef):boolean {
    const state=this.state(activityId),acceptance=this.acceptance(activityId),record=this.record(activityId,raw);
    if(!state||!state.accepted||!acceptance||record?.kind!=="observation"||record.source?.nativeIdentity?.kind!==resultType.nativeKind||
      record.source.protocol.id!==resultType.protocol)return false;
    const {scope,composition}=state.activity,config=composition.composition.configuration.configuration;
    const producer=composition.composition.auxiliary.find(p=>sameRevisionRef(p.purpose,scope.purpose));
    // Immutable purpose acceptance proves interpretation. Original recipient scope proves publication authority.
    return scope.runId===runId&&scope.recipientId===publisher&&target===`${config.id}:${config.revision}`&&!!producer&&
      sameRevisionRef(acceptance.evidence.interpreter,producer.interpreter.implementation)&&
      sameRevisionRef(state.accepted,accepted)&&sameRevisionRef(acceptance.evidence.acceptance,accepted)&&
      modelInputValueDigest(acceptance.evidence.scope)===modelInputValueDigest(scope)&&
      acceptance.evidence.sources.some(s=>sameRevisionRef(s.record,raw)&&modelInputValueDigest(s)===modelInputValueDigest(record.source));
  }
  private read<T>(table:string,key:string,values:readonly (string|number)[]):T|null {
    const row=this.sql(`SELECT value,digest FROM ${table} WHERE ${key}`).get(...values) as {value:string;digest:string}|undefined;
    return row?checkedJson<T>(row):null;
  }
  private put(table:string,columns:readonly string[],keys:readonly (string|number)[],value:unknown,update=false):void {
    const text=JSON.stringify(value),digest=modelInputValueDigest(value);
    this.sql(`INSERT INTO ${table}(${[...columns,"value","digest"].join(",")}) VALUES (${[...columns,"value","digest"].map(()=>"?").join(",")})${update?` ON CONFLICT DO UPDATE SET value=excluded.value,digest=excluded.digest`:""}`).run(...keys,text,digest);
  }
  command(command:ProtocolJournalCommand):ProtocolJournalValue {
    switch(command.kind) {
      case "reserve_admission":return this.db.transaction(()=>{
        const activity=command.activity;assertProtocolModelActivityOriginal(activity,activity);
        const id=activity.scope.activityId,old=this.admission(id),accepted=this.state(id);
        if(accepted){requireSame(accepted.activity,activity);return old;}
        if(old){requireSame(old.activity,activity);if(old.status==="closed")fail("native_admission_closed");}
        this.requireAdmissionControl(activity.scope.runId);
        if(old)return old;
        const value:ProtocolAdmissionReservation={activity,status:"reserved",closedBy:null};
        this.put("protocol_admissions",["id","run_id"],[id,activity.scope.runId],value);
        this.fact({activity},"admission_reserved",`${id}:reservation`,value);return value;
      })();
      case "admission_reservation":return this.db.transaction(()=>{
        const original=this.admission(command.activityId);
        if(!original||original.status==="closed"||!command.closeIfInactive||this.state(command.activityId))return original;
        const control=this.admissionControl?.(original.activity.scope.runId);
        if(!control||(!control.terminal&&!control.cancelled))return original;
        const next:ProtocolAdmissionReservation={...original,status:"closed",closedBy:{id:control.commitId,revision:String(control.revision)}};
        this.put("protocol_admissions",["id","run_id"],[command.activityId,original.activity.scope.runId],next,true);
        this.fact({activity:original.activity},"admission_closed",`${command.activityId}:reservation-closed`,next);return next;
      })();
      case "evidence_scope":case "evidence":case "evidence_list":case "usage_retirement":case "usage_merge":return this.evidence.command(command);
      case "measurement_candidates":return this.db.transaction(()=>this.evidence.measurementCandidates(command))();
      case "usage_samples":return this.db.transaction(()=>this.evidence.usageSamples(command))();
      case "usage_snapshot":return this.db.transaction(()=>{
        token(command.runId);count(command.limit,4096);if(!command.limit)fail("usage_snapshot_limit_invalid");
        const boundaryRow=this.sql("SELECT sequence,value,digest FROM protocol_facts WHERE run_id=? ORDER BY sequence DESC LIMIT 1").get(command.runId) as {sequence:number;value:string;digest:string}|undefined;
        const fact=boundaryRow?checkedJson<Omit<ProtocolJournalFact,"sequence">>(boundaryRow):null,boundary=boundaryRow?.sequence??0;
        count(boundary);
        if(fact&&fact.runId!==command.runId)fail("usage_boundary_scope_invalid");
        if(command.expectedBoundary!==undefined){count(command.expectedBoundary);if(command.expectedBoundary!==boundary)return {changedBoundary:boundary};}
        if(command.after){
          if(command.expectedBoundary===undefined||command.ifBoundary!==undefined||
            typeof command.after.entriesComplete!=="boolean"||typeof command.after.dispatchesComplete!=="boolean")fail("usage_cursor_invalid");
          if(command.after.entries){token(command.after.entries.scopeId);token(command.after.entries.key);}
          if(command.after.dispatches){token(command.after.dispatches.activityId);token(command.after.dispatches.id);token(command.after.dispatches.revision);}
        }
        if(command.ifBoundary!==undefined){count(command.ifBoundary);if(command.ifBoundary===boundary)return {unchangedBoundary:boundary};}
        const usage=command.after?.entriesComplete?{entries:[],complete:true,next:null}:
          this.evidence.usageForRun(command.runId,command.limit,command.after?.entries??null);
        const cursor=command.after?.dispatches;
        const rows=command.after?.dispatchesComplete?[]:this.sql("SELECT r.activity_id,r.id,r.revision,r.value,r.digest FROM protocol_activities a JOIN protocol_records r ON r.activity_id=a.id WHERE a.run_id=? AND json_extract(r.value,'$.kind') IN ('dispatch_intent','reconciliation_intent') AND (r.activity_id,r.id,r.revision)>(?,?,?) ORDER BY r.activity_id,r.id,r.revision LIMIT ?")
          .all(command.runId,cursor?.activityId??"",cursor?.id??"",cursor?.revision??"",command.limit+1) as {activity_id:string;id:string;revision:string;value:string;digest:string}[];
        const dispatches=rows.slice(0,command.limit).map(row=>{
          const record=checkedJson<ProtocolJournalRecord>(row),state=this.state(record.activityId);
          if(!state||state.activity.scope.runId!==command.runId||!["dispatch_intent","reconciliation_intent"].includes(record.kind))fail("usage_dispatch_scope_invalid");
          return record;
        });
        const complete=usage.complete&&rows.length<=command.limit,lastDispatch=rows[Math.min(rows.length,command.limit)-1];
        return {runId:command.runId,boundary,complete,entries:usage.entries,dispatches,next:complete?null:{
          entries:usage.next,entriesComplete:usage.complete,dispatchesComplete:rows.length<=command.limit,
          dispatches:rows.length>command.limit?{activityId:lastDispatch!.activity_id,id:lastDispatch!.id,revision:lastDispatch!.revision}:null}};
      })();
      case "content_begin":return this.begin(command.content);
      case "content_append":return this.append(command.content,command.offset,command.bytesBase64);
      case "content_complete":return this.complete(command.content);
      case "content_read": {
        if(command.activityId!==command.content.activityId)fail("content_scope_denied");
        this.content(command.content);count(command.offset,command.content.bytes);count(command.length,PAGE);
        if(!command.length)fail("content_page_invalid");
        const end=Math.min(command.content.bytes,command.offset+command.length);
        return {bytesBase64:this.bytes(command.content,command.offset,end).toString("base64"),next:end<command.content.bytes?end:null};
      }
      case "state":return this.state(command.activityId);
      case "retention_status":{
        const state=this.state(command.activityId);if(!state)return null;
        const countRows=(sql:string)=>(this.sql(sql).get(command.activityId) as {count:number}).count;
        const observation=this.unavailableObservation(state);
        return {state,...(observation?{unavailableObservation:observation}:{}),
          pendingEffects:countRows("SELECT COUNT(*) AS count FROM protocol_effects WHERE activity_id=? AND json_extract(value,'$.confirmation') IS NULL"),
          pendingDeliveries:countRows("SELECT COUNT(*) AS count FROM protocol_deliveries WHERE activity_id=? AND json_extract(value,'$.receipt') IS NULL"),
          pendingHandoffs:countRows("SELECT COUNT(*) AS count FROM protocol_reconciliations WHERE activity_id=? AND closed=0")};
      }
      case "retention_page":{
        token(command.runId);count(command.limit,128);if(!command.limit)fail("retention_page_invalid");
        const rows=this.sql("SELECT id,value,digest FROM protocol_activities WHERE run_id=? AND id>? ORDER BY id LIMIT ?")
          .all(command.runId,command.after??"",command.limit+1) as {id:string;value:string;digest:string}[];
        const states=rows.slice(0,command.limit).map(row=>{
          const value=checkedJson<ProtocolExecutionState>(row);
          if(value.activity.scope.runId!==command.runId||value.activity.scope.activityId!==row.id)fail("activity_identity_corrupt");
          return value;
        });
        return {states,next:rows.length>command.limit?states.at(-1)!.activity.scope.activityId:null};
      }
      case "reconciliation":return this.read<ProtocolReconciliationHandoff>("protocol_reconciliations","activity_id=? AND id=?",[command.activityId,command.id]);
      case "activity_reconciliation":return this.read<ProtocolReconciliationHandoff>("protocol_reconciliations","activity_id=?",[command.activityId]);
      case "reconciliation_list":{
        token(command.receiver);count(command.limit,128);if(!command.limit)fail("handoff_page_invalid");
        return this.sql("SELECT value,digest FROM protocol_reconciliations WHERE receiver=? AND closed=0 AND id>? ORDER BY id LIMIT ?")
          .all(command.receiver,command.after??"",command.limit).map(row=>checkedJson<ProtocolReconciliationHandoff>(row as {value:string;digest:string}));
      }
      case "record":return this.record(command.activityId,command.ref);
      case "acceptance":return this.acceptance(command.activityId);
      case "effect":return this.readEffect(command.activityId,command.callId);
      case "delivery":return this.delivery(command.activityId,command.id);
      case "facts":count(command.after);count(command.limit,128);if(!command.limit)fail("fact_page_invalid");return this.facts(command.runId,command.after,command.limit);
    }
  }
  participant():SharedAcceptanceParticipant {
    return {owner:"protocol_execution",kinds:["prepare","claim","control","require_active","require_accepted_result","record","input_refusal","purpose","effect_dispatch","effect_confirmation","received","release_retention","release_connection","settle_input_use","evidence_scope","evidence","usage_merge","reconciliation_handoff","reconciliation_close"],
      prepare:part=>{modelInputValueDigest(part);return structuredClone(part);},apply:(prepared,shared)=>{
        const part=prepared as ProtocolJournalPart;
        if(part.kind==="evidence_scope"||part.kind==="evidence"||part.kind==="usage_merge"){this.evidence.apply(part,shared);return;}
        if(part.kind==="prepare") {
          const {activity,input,contextInput}=part.proposal;assertProtocolModelActivityOriginal(activity,activity);
          if(shared.actor!=="execution-coordinator"||shared.scope!==activity.scope.runId)fail("prepare_owner_invalid");
          this.content(input,activity.scope.activityId);
          const old=this.state(activity.scope.activityId);
          const reservation=this.admission(activity.scope.activityId);
          if(reservation){requireSame(reservation.activity,activity);if(reservation.status==="closed")fail("native_admission_closed");}
          if(old){requireSame(old.activity,activity);requireSame(old.input,input);requireSame(old.contextInput??null,contextInput??null);return;}
          this.requireAdmissionControl(activity.scope.runId);
          if(contextInput){if(!this.claimContextInput)fail("native_input_claim_unavailable");this.claimContextInput(activity,contextInput,false);}
          const state:ProtocolExecutionState={activity,input,...(contextInput?{contextInput}:{}),fence:{activityId:activity.scope.activityId,generation:this.generation(),epoch:0,controlRevision:0},cancelled:false,accepted:null,retentionReleased:false};
          this.put("protocol_activities",["id","run_id"],[activity.scope.activityId,shared.scope],state);
          this.fact(state,"prepared",shared.id,{input,activity,...(contextInput?{contextInput}:{})});return;
        }
        const p=part.proposal;
        const activityId="activityId" in p?p.activityId:"record" in p?p.record.activityId:p.fence.activityId;
        const state=this.state(activityId);if(!state||state.activity.scope.runId!==shared.scope)fail("activity_scope_invalid");
        const adapter=state.activity.composition.composition.adapter.implementation.id;
        const adapterOwner=()=>{if(shared.actor!==adapter)fail("adapter_owner_invalid");};
        switch(part.kind) {
          case "require_accepted_result": {
            const g=part.proposal,accepted=this.acceptance(activityId),record=this.record(activityId,g.record);
            if(state.cancelled||state.inputRefusal||state.fence.controlRevision!==g.controlRevision||!state.accepted||
              !sameRevisionRef(state.accepted,g.acceptance)||!accepted||!sameRevisionRef(accepted.evidence.acceptance,g.acceptance)||
              record?.kind!=="observation"||!record.source||!accepted.evidence.sources.some(s=>modelInputValueDigest(s)===modelInputValueDigest(record.source)))
              fail("original_result_not_applicable");
            break;
          }
          case "require_active": {
            // Read-only cross-owner precondition, ordered with the consuming acceptance.
            if(state.cancelled||state.inputRefusal||state.retentionReleased||state.connectionRelease||state.fence.controlRevision!==part.proposal.controlRevision||
              !this.record(activityId,part.proposal.record))fail("original_activity_not_applicable");
            break;
          }
          case "claim": {
            adapterOwner();count(part.proposal.expectedEpoch);
            if(state.fence.epoch!==part.proposal.expectedEpoch)fail("owner_epoch_conflict");
            const next={...state,fence:{...state.fence,generation:this.generation(),epoch:state.fence.epoch+1}};
            this.save(next);this.fact(next,"claimed",shared.id,next.fence);break;
          }
          case "control": {
            if(shared.actor!=="execution-coordinator"||state.fence.controlRevision!==part.proposal.expectedRevision||typeof part.proposal.cancelled!=="boolean")fail("control_conflict");
            if(state.cancelled&&!part.proposal.cancelled)fail("cancel_fence_cannot_reopen");
            const next={...state,cancelled:part.proposal.cancelled,fence:{...state.fence,controlRevision:state.fence.controlRevision+1}};
            this.save(next);this.fact(next,"control",shared.id,next);break;
          }
          case "input_refusal": {
            const {fence,proof,evidence}=part.proposal,state=this.state(fence.activityId)!;
            if(!state||shared.scope!==state.activity.scope.runId||shared.actor!==state.activity.composition.composition.adapter.implementation.id||
              state.accepted||!this.confirmInputRejection(evidence,proof.scope))fail("input_refusal_unconfirmed");
            if(state.inputRefusal){requireSame(state.inputRefusal,evidence);break;}
            this.fence(state,fence,false);
            this.save({...state,inputRefusal:evidence});this.fact(state,"input_refused",shared.id,evidence);break;
          }
          case "record": {
            adapterOwner();const value=part.proposal.record;
            token(value.ref.id);token(value.ref.revision);token(value.operationId);
            if(!["dispatch_intent","reconciliation_intent","owner_checkpoint","observation","history_disposition","native_checkpoint"].includes(value.kind))fail("record_kind_invalid");
            this.content(value.content,activityId);
            if(value.kind==="dispatch_intent"||value.kind==="history_disposition")this.fence(state,part.proposal.fence);
            if(value.kind==="reconciliation_intent"&&state.connectionRelease)fail("original_connection_released");
            if(value.kind==="reconciliation_intent"||value.kind==="owner_checkpoint"||value.kind==="native_checkpoint"){
              if(state.retentionReleased)fail("retained_dependencies_released");this.fence(state,part.proposal.fence,true);
            }
            if(!Array.isArray(value.dependencies)||value.dependencies.length>128)fail("record_dependencies_invalid");
            const dependencies=value.dependencies.map(ref=>this.record(activityId,ref));
            if(dependencies.some(record=>!record))fail("record_dependency_missing");
            if(!["dispatch_intent","reconciliation_intent","owner_checkpoint","native_checkpoint"].includes(value.kind)&&!dependencies.some(record=>
              (record?.kind==="dispatch_intent"||record?.kind==="reconciliation_intent")&&record.operationId===value.operationId))fail("dispatch_basis_missing");
            if(value.kind==="dispatch_intent"||value.kind==="reconciliation_intent"){
              const original=this.read<ProtocolJournalRecord>("protocol_records","activity_id=? AND json_extract(value,'$.kind') IN ('dispatch_intent','reconciliation_intent') AND json_extract(value,'$.operationId')=?",[activityId,value.operationId]);
              if(original)requireSame(original,value);
            }
            if(value.source) {
              const source=snapshotNativeModelSource(value.source);
              requireSame(source.scope,state.activity.scope);requireSame(source.protocol,state.activity.composition.composition.protocol);
              requireSame(source.interpretation,state.activity.composition.composition.adapter.implementation);
              if(!sameRevisionRef(source.record,value.ref)||source.operationId!==value.operationId)fail("source_record_mismatch");
            }
            const previous=this.record(activityId,value.ref);if(previous){requireSame(previous,value);break;}
            this.put("protocol_records",["activity_id","id","revision"],[activityId,value.ref.id,value.ref.revision],value);
            this.fact(state,value.kind,value.ref.id,value);break;
          }
          case "purpose": {
            this.fence(state,part.proposal.fence);const value=part.proposal.acceptance;
            const evidence=assertProtocolPurposeEvidence(state.activity,value.evidence);
            if(shared.actor!==evidence.interpreter.id)fail("purpose_owner_invalid");
            this.content(value.result,activityId);
            for(const source of evidence.sources) {
              const original=this.record(activityId,source.record);
              if(!original?.source)fail("purpose_source_unavailable");
              // The native interpreter owns contained positions. Custody verifies their immutable anchor.
              const anchor=original.source;
              if(modelInputValueDigest(anchor.scope)!==modelInputValueDigest(source.scope)||
                modelInputValueDigest(anchor.protocol)!==modelInputValueDigest(source.protocol)||
                !sameRevisionRef(anchor.interpretation,source.interpretation)||!sameRevisionRef(anchor.record,source.record)||
                anchor.operationId!==source.operationId)fail("purpose_source_unavailable");
              this.content(original.content,activityId);
            }
            const old=this.acceptance(activityId);
            if(old){requireSame(old,value);break;}
            if(this.sql("SELECT 1 FROM protocol_acceptances WHERE run_id=? AND acceptance_id=? AND acceptance_revision=?").get(shared.scope,evidence.acceptance.id,evidence.acceptance.revision))fail("purpose_identity_conflict");
            if(!Array.isArray(value.effects)||value.effects.length>128)fail("effect_intents_invalid");
            const ids=new Set<string>();
            for(const effect of value.effects) {
              const call=snapshotModelCallableRequest(effect.call);token(effect.owner);
              if(call.modelCallRef.turnId!==null||!sameRevisionRef(call.modelCallRef.purposeAcceptance,evidence.acceptance)||
                !evidence.sources.some(source=>nativeModelSourceKey(source)===nativeModelSourceKey(call.modelCallRef.nativeSource!))||ids.has(call.modelCallRef.id))fail("effect_source_invalid");
              ids.add(call.modelCallRef.id);
              if(this.sql("SELECT 1 FROM protocol_effects WHERE id=?").get(call.modelCallRef.id))fail("effect_identity_conflict");
              this.put("protocol_effects",["id","activity_id"],[call.modelCallRef.id,activityId],{intent:effect,dispatched:false,confirmationBasis:null,confirmation:null,result:null,deliveries:[]} satisfies Effect);
            }
            this.deliveries(state,value.deliveries);
            this.put("protocol_acceptances",["activity_id","run_id","acceptance_id","acceptance_revision"],[activityId,shared.scope,evidence.acceptance.id,evidence.acceptance.revision],value);
            this.save({...state,accepted:evidence.acceptance});this.fact(state,"purpose_accepted",shared.id,value);break;
          }
          case "effect_dispatch": {
            this.fence(state,part.proposal.fence);
            const effect=this.effect(activityId,part.proposal.callId);
            if(effect.intent.owner!==shared.actor||effect.dispatched||effect.confirmation||effect.coordination)fail("effect_dispatch_not_eligible");
            this.put("protocol_effects",["id","activity_id"],[part.proposal.callId,activityId],{...effect,dispatched:true},true);
            this.fact(state,"effect_dispatch_intent",shared.id,{callId:part.proposal.callId});break;
          }
          case "effect_confirmation": {
            const value=part.proposal,effect=this.effect(activityId,value.callId);
            if(effect.intent.owner!==shared.actor||effect.coordination)fail("effect_confirmation_owner_invalid");
            if(value.dispatchBasis!==(effect.dispatched?"intent_recorded":"not_started"))fail("effect_confirmation_basis_invalid");
            token(value.confirmation.id);token(value.confirmation.revision);this.content(value.result,activityId);
            if(effect.confirmation){requireSame(effect.confirmationBasis,value.dispatchBasis);requireSame(effect.confirmation,value.confirmation);requireSame(effect.result,value.result);requireSame(effect.deliveries,value.deliveries);break;}
            this.deliveries(state,value.deliveries);
            this.put("protocol_effects",["id","activity_id"],[value.callId,activityId],{...effect,confirmationBasis:value.dispatchBasis,confirmation:value.confirmation,result:value.result,deliveries:value.deliveries},true);
            this.fact(state,"effect_confirmed",shared.id,value);break;
          }
          case "received": {
            const value=part.proposal,delivery=this.delivery(activityId,part.proposal.deliveryId);
            if(!delivery||shared.actor!==delivery.delivery.recipient.id)fail("delivery_recipient_invalid");
            requireSame(value.recipient,delivery.delivery.recipient);token(value.receipt.id);token(value.receipt.revision);
            if(delivery.receipt){requireSame(delivery.receipt,value.receipt);break;}
            this.put("protocol_deliveries",["id","activity_id"],[value.deliveryId,activityId],{...delivery,receipt:value.receipt},true);
            this.fact(state,"delivery_received",shared.id,value);break;
          }
          case "reconciliation_handoff": {
            adapterOwner();this.fence(state,part.proposal.fence,true);
            const value=part.proposal.handoff;token(value.id);token(value.receiver);
            if(!state.cancelled||state.retentionReleased||state.connectionRelease||value.activityId!==activityId||value.receiver!==shared.actor||value.disposition!==null)fail("handoff_receiver_invalid");
            count(value.dueAt);count(value.expiresAt);if(value.dueAt>=value.expiresAt)fail("handoff_lifetime_invalid");
            const basis=this.record(activityId,value.checkpoint);
            if(basis?.kind!=="owner_checkpoint"&&basis?.kind!=="native_checkpoint")fail("handoff_checkpoint_missing");
            if(!Array.isArray(value.dependencies)||value.dependencies.length<1||value.dependencies.length>128)fail("handoff_dependencies_invalid");
            for(const reference of value.dependencies)this.content(reference,activityId);
            if(!value.dependencies.some(reference=>modelInputValueDigest(reference)===modelInputValueDigest(state.input)))fail("handoff_original_input_missing");
            const old=this.read<ProtocolReconciliationHandoff>("protocol_reconciliations","activity_id=?",[activityId]);
            if(old){requireSame(old,value);break;}
            this.put("protocol_reconciliations",["id","activity_id","receiver","closed"],[value.id,activityId,value.receiver,0],value);
            const next={...state,fence:{...state.fence,epoch:state.fence.epoch+1}};this.save(next);
            this.fact(next,"reconciliation_handoff",shared.id,{handoff:value,fence:next.fence});break;
          }
          case "reconciliation_close": {
            adapterOwner();this.fence(state,part.proposal.fence,true);const value=part.proposal;
            const old=this.read<ProtocolReconciliationHandoff>("protocol_reconciliations","activity_id=? AND id=?",[activityId,value.id]);
            if(!old||old.receiver!==shared.actor||!["resolved","unresolved"].includes(value.disposition.outcome))fail("handoff_close_invalid");
            if(old.disposition){requireSame(old.disposition,value.disposition);break;}
            const basis=this.record(activityId,value.disposition.basis);
            if(basis?.kind!=="owner_checkpoint"&&basis?.kind!=="native_checkpoint")fail("handoff_checkpoint_missing");
            const next={...old,disposition:value.disposition};
            this.put("protocol_reconciliations",["id","activity_id","receiver","closed"],[old.id,activityId,old.receiver,1],next,true);
            this.sql("UPDATE protocol_reconciliations SET closed=1 WHERE id=?").run(old.id);
            this.fact(state,"reconciliation_closed",shared.id,next);break;
          }
          case "settle_input_use": {
            adapterOwner();
            if(!state.contextInput||!state.cancelled||!state.retentionReleased||!state.retentionBasis)fail("input_use_disposition_not_ready");
            requireSame(state.contextInput,part.proposal.input);requireSame(state.retentionBasis,part.proposal.nativeBasis);
            const basis=this.record(activityId,part.proposal.nativeBasis);
            if(basis?.kind!=="native_checkpoint")fail("native_input_use_basis_missing");
            if(this.sql("SELECT 1 FROM protocol_reconciliations WHERE activity_id=? AND closed=0").get(activityId))fail("reconciliation_responsibility_pending");
            if(state.inputUseSettlement){requireSame(state.inputUseSettlement.basis,part.proposal.nativeBasis);break;}
            const settlement={basis:part.proposal.nativeBasis,acceptanceId:shared.id};
            this.save({...state,inputUseSettlement:settlement});this.fact(state,"input_use_settled",shared.id,{input:state.contextInput,...settlement,received:false});break;
          }
          case "release_connection": {
            adapterOwner();
            const {release,fence}=part.proposal;
            this.fence(state,fence,true);
            if(state.connectionRelease){requireSame(state.connectionRelease,release);break;}
            requireSame(release.bindingId,state.activity.composition.composition.configuration.connectionBinding.id);
            const receipt=this.unavailableObservation(state);
            if(!receipt)fail("connection_observation_receipt_missing");
            requireSame(release.observation,receipt);
            const b=receipt.limitation.basis;
            const head=this.evidence.command({kind:"evidence",activityId,scopeId:b.scopeId,evidenceKind:b.kind,key:b.key}) as ProtocolEvidenceRevision|null;
            if(!head||head.activityId!==activityId||head.owner!==shared.actor||head.revision!==b.revision||head.content.digest!==b.digest||
              !head.references.some(r=>modelInputValueDigest(r)===modelInputValueDigest(state.input)))fail("connection_observation_basis_changed");
            this.requireNoOutstandingResponsibilities(activityId);
            this.save({...state,connectionRelease:release});
            this.fact(state,"connection_released",shared.id,release);break;
          }
          case "release_retention": {
            adapterOwner();
            if(state.retentionReleased)break;
            if(state.fence.generation!==this.generation()||state.fence.epoch===0)fail("acceptance_fenced");
            requireSame(part.proposal.fence,state.fence);
            const basis=this.record(activityId,part.proposal.nativeBasis);
            if(basis?.kind!=="native_checkpoint")fail("native_release_basis_missing");
            if(!state.accepted&&!state.cancelled)fail("purpose_responsibility_pending");
            this.requireNoOutstandingResponsibilities(activityId);
            this.save({...state,retentionReleased:true,retentionBasis:part.proposal.nativeBasis});this.fact(state,"retention_released",shared.id,{basis:part.proposal.nativeBasis});break;
          }
        }
      }};
  }
  private requireNoOutstandingResponsibilities(activityId:string):void {
    if(this.sql("SELECT 1 FROM protocol_reconciliations WHERE activity_id=? AND closed=0").get(activityId))fail("reconciliation_responsibility_pending");
    for(const row of this.sql("SELECT id FROM protocol_effects WHERE activity_id=?").iterate(activityId) as Iterable<{id:string}>)
      if(!this.effect(activityId,row.id).confirmation)fail("local_responsibility_pending");
    for(const row of this.sql("SELECT id FROM protocol_deliveries WHERE activity_id=?").iterate(activityId) as Iterable<{id:string}>)
      if(!this.delivery(activityId,row.id)?.receipt)fail("local_responsibility_pending");
  }
  private fence(state:ProtocolExecutionState,fence:ProtocolExecutionFence|null,reconciliation=false):void {
    if(!fence||(!reconciliation&&(state.cancelled||state.inputRefusal||state.retentionReleased||state.connectionRelease))||state.fence.epoch===0||state.fence.generation!==this.generation()||modelInputValueDigest(state.fence)!==modelInputValueDigest(fence))fail("acceptance_fenced");
  }
  private state(id:string):ProtocolExecutionState|null {token(id);const state=this.read<ProtocolExecutionState>("protocol_activities","id=?",[id]);if(state&&state.activity.scope.activityId!==id)fail("activity_identity_corrupt");return state;}
  private save(state:ProtocolExecutionState):void {this.put("protocol_activities",["id","run_id"],[state.activity.scope.activityId,state.activity.scope.runId],state,true);}
  private record(activityId:string,ref:ProtocolRevisionRef):ProtocolJournalRecord|null {token(ref.id);token(ref.revision);const record=this.read<ProtocolJournalRecord>("protocol_records","activity_id=? AND id=? AND revision=?",[activityId,ref.id,ref.revision]);if(record&&(record.activityId!==activityId||!sameRevisionRef(record.ref,ref)))fail("record_identity_corrupt");return record;}
  private acceptance(activityId:string):ProtocolPurposeAcceptance|null {
    const value=this.read<ProtocolPurposeAcceptance>("protocol_acceptances","activity_id=?",[activityId]);
    if(value&&(value.evidence.scope.activityId!==activityId||value.result.activityId!==activityId))fail("acceptance_identity_corrupt");return value;
  }
  private readEffect(activityId:string,id:string):Effect|null {
    const value=this.read<Effect>("protocol_effects","id=? AND activity_id=?",[id,activityId]);
    if(value&&(value.intent.call.modelCallRef.id!==id||value.intent.call.modelCallRef.nativeSource?.scope.activityId!==activityId))fail("effect_identity_corrupt");return value;
  }
  private effect(activityId:string,id:string):Effect {const effect=this.readEffect(activityId,id);if(!effect)fail("effect_unavailable");return effect;}
  private delivery(activityId:string,id:string):Delivery|null {
    const value=this.read<Delivery>("protocol_deliveries","id=? AND activity_id=?",[id,activityId]);
    if(value&&(value.delivery.id!==id||value.delivery.content.activityId!==activityId))fail("delivery_identity_corrupt");return value;
  }
  private deliveries(state:ProtocolExecutionState,deliveries:readonly ProtocolPendingDelivery[]):void {
    if(!Array.isArray(deliveries)||deliveries.length>128)fail("deliveries_invalid");
    for(const delivery of deliveries) {
      [delivery.id,delivery.recipient.runId,delivery.recipient.id,delivery.recipient.purpose].forEach(token);
      this.content(delivery.content,state.activity.scope.activityId);
      const collision=this.sql("SELECT activity_id FROM protocol_deliveries WHERE id=?").get(delivery.id) as {activity_id:string}|undefined;
      if(collision&&collision.activity_id!==state.activity.scope.activityId)fail("delivery_scope_conflict");
      const old=this.read<Delivery>("protocol_deliveries","id=?",[delivery.id]);
      if(old){requireSame(old.delivery,delivery);continue;}
      this.put("protocol_deliveries",["id","activity_id"],[delivery.id,state.activity.scope.activityId],{delivery,receipt:null});
    }
  }
  private begin(ref:ProtocolContentRef):ProtocolContentRef {
    token(ref.id);token(ref.activityId);count(ref.bytes,STORAGE);
    if(!/^sha256:[a-f0-9]{64}$/.test(ref.digest))fail("content_digest_invalid");
    return this.db.transaction(()=>{
      const old=this.read<ProtocolContentRef>("protocol_contents","id=?",[ref.id]);if(old){requireSame(old,ref);return old;}
      const reserved=this.sql("SELECT COALESCE(SUM(json_extract(value,'$.bytes')),0) AS n FROM protocol_contents").get() as {n:number};
      if(reserved.n+ref.bytes>STORAGE)fail("content_storage_budget");
      this.sql("INSERT INTO protocol_contents VALUES (?,?,?,?,0,0,?)").run(ref.id,ref.activityId,JSON.stringify(ref),modelInputValueDigest(ref),contentStateDigest(ref,0,0));return ref;
    })();
  }
  private append(ref:ProtocolContentRef,offset:number,base64:string):ProtocolContentRef {
    count(offset,ref.bytes);if(typeof base64!=="string"||base64.length>Math.ceil(CHUNK/3)*4)fail("content_chunk_bound");
    const bytes=Buffer.from(base64,"base64");if(!bytes.length||bytes.toString("base64")!==base64||bytes.length>CHUNK)fail("content_chunk_invalid");
    return this.db.transaction(()=>{
      const row=this.contentRow(ref);const digest=hash(bytes);
      const old=this.sql("SELECT digest FROM protocol_content_chunks WHERE id=? AND offset=?").get(ref.id,offset) as {digest:string}|undefined;
      if(old){if(old.digest!==digest)fail("content_chunk_conflict");return ref;}
      if(row.complete||row.written!==offset||offset+bytes.length>ref.bytes)fail("content_write_bound");
      this.sql("INSERT INTO protocol_content_chunks VALUES (?,?,?,?)").run(ref.id,offset,bytes,digest);
      this.sql("UPDATE protocol_contents SET written=?,state_digest=? WHERE id=?").run(offset+bytes.length,contentStateDigest(ref,offset+bytes.length,0),ref.id);return ref;
    })();
  }
  private complete(ref:ProtocolContentRef):ProtocolContentRef {
    return this.db.transaction(()=>{
      const row=this.contentRow(ref);if(row.complete)return ref;if(row.written!==ref.bytes)fail("content_incomplete");
      const digest=createHash("sha256");let offset=0;
      for(const row of this.sql("SELECT offset,bytes,digest FROM protocol_content_chunks WHERE id=? ORDER BY offset").iterate(ref.id) as Iterable<{offset:number;bytes:Buffer;digest:string}>) {
        if(row.offset!==offset||hash(row.bytes)!==row.digest)fail("content_corrupt");digest.update(row.bytes);offset+=row.bytes.length;
      }
      if(offset!==ref.bytes||`sha256:${digest.digest("hex")}`!==ref.digest)fail("content_corrupt");
      this.sql("UPDATE protocol_contents SET complete=1,state_digest=? WHERE id=?").run(contentStateDigest(ref,ref.bytes,1),ref.id);return ref;
    })();
  }
  private contentRow(ref:ProtocolContentRef) {
    const row=this.sql("SELECT value,digest,written,complete,state_digest FROM protocol_contents WHERE id=?").get(ref.id) as {value:string;digest:string;written:number;complete:number;state_digest:string}|undefined;
    if(!row)fail("content_unavailable");requireSame(checkedJson(row),ref);
    if(contentStateDigest(ref,row.written,row.complete)!==row.state_digest)fail("content_state_corrupt");return row;
  }
  private content(ref:ProtocolContentRef,activityId=ref.activityId):void {
    if(ref.activityId!==activityId)fail("content_scope_denied");if(!this.contentRow(ref).complete)fail("content_incomplete");
  }
  private bytes(ref:ProtocolContentRef,start:number,end:number):Buffer {
    const pieces:Buffer[]=[];let position=start;
    for(const row of this.sql("SELECT offset,bytes,digest FROM protocol_content_chunks WHERE id=? AND offset<? AND offset+length(bytes)>? ORDER BY offset").iterate(ref.id,end,start) as Iterable<{offset:number;bytes:Buffer;digest:string}>) {
      if(row.offset>position||hash(row.bytes)!==row.digest)fail("content_corrupt");
      const piece=row.bytes.subarray(Math.max(0,position-row.offset),Math.min(row.bytes.length,end-row.offset));pieces.push(piece);position+=piece.length;
    }
    if(position!==end)fail("content_corrupt");return Buffer.concat(pieces,end-start);
  }
  private fact(state:Pick<ProtocolExecutionState,"activity">,kind:string,identity:string,value:unknown):void {
    this.cursor??=(this.sql("SELECT COALESCE(MAX(sequence),0) AS n FROM protocol_facts").get() as {n:number}).n;
    const fact={runId:state.activity.scope.runId,activityId:state.activity.scope.activityId,kind,identity,occurredAt:new Date().toISOString(),value};
    this.put("protocol_facts",["run_id","activity_id"],[fact.runId,fact.activityId],fact);
  }
  private facts(runId:string,after:number,limit:number):ProtocolJournalFact[] {
    return (this.sql("SELECT sequence,value,digest FROM protocol_facts WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT ?").all(runId,after,limit) as {sequence:number;value:string;digest:string}[])
      .map(row=>({...checkedJson<Omit<ProtocolJournalFact,"sequence">>(row),sequence:row.sequence}));
  }
  takeObservations():ProtocolJournalFact[] {
    if(this.cursor===null)return [];
    const rows=this.sql("SELECT sequence,value,digest FROM protocol_facts WHERE sequence>? ORDER BY sequence LIMIT 128").all(this.cursor) as {sequence:number;value:string;digest:string}[];
    const facts=rows.map(row=>({...checkedJson<Omit<ProtocolJournalFact,"sequence">>(row),sequence:row.sequence}));
    if(facts.length)this.cursor=facts.at(-1)!.sequence;return facts;
  }
  retainedRuns():string[] {
    const runs=new Set<string>();
    for(const row of this.sql("SELECT run_id,value,digest FROM protocol_activities").iterate() as Iterable<{run_id:string;value:string;digest:string}>){
      const state=checkedJson<ProtocolExecutionState>(row);if(state.activity.scope.runId!==row.run_id)fail("activity_identity_corrupt");
      if(!state.retentionReleased)runs.add(row.run_id);
    }
    return [...runs];
  }
  assertRunItems(runId:string,items:readonly import("@agent-anything/agent-runtime/run").RunItem[]):void {
    const seen=new Set<string>();
    for(const item of items){
      if(item.payload.kind!=="controller_turn")continue;
      for(const modelItem of item.payload.modelItems){
        if(modelItem.kind==="native_purpose_evidence"){
          const evidence=modelItem.evidence;
          const accepted=this.acceptance(evidence.scope.activityId);
          if(!accepted||evidence.scope.runId!==runId||seen.has(evidence.scope.activityId))fail("run_purpose_acceptance_missing_or_duplicate");
          requireSame(accepted.evidence,evidence);seen.add(evidence.scope.activityId);
        }
        if(modelItem.kind==="model_tool_call"&&modelItem.call.modelCallRef.turnId===null){
          const source=modelItem.call.modelCallRef.nativeSource;
          if(source.scope.runId!==runId)fail("run_call_scope_invalid");
          requireSame(this.effect(source.scope.activityId,modelItem.call.modelCallRef.id).intent.call,modelItem.call);
        }
      }
    }
  }
  /** Called only inside the owning Run commit transaction, after append-only validation. */
  acceptRunItems(runId:string,items:readonly import("@agent-anything/agent-runtime/run").RunItem[]):void {
    for(const item of items){
      const p=item.payload,basis={id:item.ref.id,revision:String(item.committedInRevision)};
      if(p.kind==="controller_turn")for(const m of p.modelItems){
        if(m.kind!=="model_tool_call"||m.call.modelCallRef.turnId!==null)continue;
        const call=m.call.modelCallRef,activityId=call.nativeSource.scope.activityId,state=this.state(activityId),effect=this.effect(activityId,call.id);
        if(!state||state.activity.scope.runId!==runId||effect.intent.owner!=="execution-coordinator"||effect.dispatched||effect.confirmation)
          fail("run_call_owner_invalid");
        requireSame(effect.intent.call,m.call);
        const coordination={runId,acceptedIn:basis,settledIn:null};
        if(effect.coordination){requireSame(effect.coordination,coordination);continue;}
        this.put("protocol_effects",["id","activity_id"],[call.id,activityId],{...effect,coordination},true);
        this.fact(state,"local_coordination_accepted",item.ref.id,{callId:call.id,coordination});
      }
      if(p.kind!=="model_call_settlement"||p.result.modelCallRef.turnId!==null)continue;
      const call=p.result.modelCallRef,activityId=call.nativeSource.scope.activityId,state=this.state(activityId),effect=this.readEffect(activityId,call.id);
      // Invalid raw Calls have correlation and a rejection, but no executable intent.
      if(!effect)continue;
      if(!state||state.activity.scope.runId!==runId||effect.intent.owner!=="execution-coordinator"||effect.coordination?.runId!==runId)
        fail("run_settlement_owner_invalid");
      requireSame(effect.intent.call.modelCallRef,call);requireSame(effect.intent.call.providerCallRef,p.result.providerCallRef);
      if(effect.intent.call.name!==p.result.name)fail("run_settlement_call_mismatch");
      if(effect.confirmation){requireSame(effect.confirmation,basis);continue;}
      const coordination={...effect.coordination,settledIn:basis};
      this.put("protocol_effects",["id","activity_id"],[call.id,activityId],{...effect,coordination,confirmationBasis:"run_execution",confirmation:basis},true);
      this.fact(state,"local_coordination_settled",item.ref.id,{callId:call.id,coordination,settlement:p.result.settlement});
    }
  }
}
function token(value:unknown):asserts value is string {if(typeof value!=="string"||!value.trim()||value.length>2048)fail("identity_invalid");}
function count(value:number,maximum=Number.MAX_SAFE_INTEGER):void {if(!Number.isSafeInteger(value)||value<0||value>maximum)fail("bound_invalid");}
function hash(bytes:Buffer):string {return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;}
function contentStateDigest(ref:ProtocolContentRef,written:number,complete:number):string{return modelInputValueDigest({ref,written,complete});}
function fail(code:string):never {throw new SharedAcceptanceRejection("protocol_execution",`protocol_${code}`);}
function requireSame(a:unknown,b:unknown):void {if(modelInputValueDigest(a)!==modelInputValueDigest(b))fail("identity_conflict");}
