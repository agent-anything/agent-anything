import type Database from "better-sqlite3";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {MaterialCustodyError,custodyToken,containsMaterialRange,type MaterialHold,type MaterialRange} from "@agent-anything/context/custody";
import type {ContextAcceptancePart,ContextDelivery,ContextInputBinding,ContextSelectionCommand,ContextSelectionProposal,
  ContextSelectionSnapshot,ContextSelectionValue,ContextUseControl,ContextUseScope} from "@agent-anything/context/selection";
import type {RepresentationRef} from "@agent-anything/context/representation";
import type {SharedAcceptanceProposal} from "@agent-anything/agent-runtime/activity";
import type {ExecutionContentRoot} from "./ExecutionContent.js";
import {SharedAcceptanceRejection,type SharedAcceptanceParticipant} from "./SharedAcceptanceDatabase.js";
import {ContextFoundationRecords,checkedJson,requireSame} from "./ContextFoundationRecords.js";
import {MaterialCustodyDatabase} from "./MaterialCustodyDatabase.js";
import {RepresentationDatabase} from "./RepresentationDatabase.js";

export const CONTEXT_SELECTION_SCHEMA=`
CREATE TABLE context_use_scopes(id TEXT PRIMARY KEY,scope_key TEXT NOT NULL UNIQUE,run_id TEXT NOT NULL,value TEXT NOT NULL,digest TEXT NOT NULL,control TEXT NOT NULL,control_digest TEXT NOT NULL,current_id TEXT);
CREATE TABLE context_selection_versions(id TEXT PRIMARY KEY,scope_id TEXT NOT NULL,acceptance_id TEXT NOT NULL,value TEXT NOT NULL,digest TEXT NOT NULL);
CREATE TABLE context_input_bindings(id TEXT PRIMARY KEY,scope_id TEXT NOT NULL,acceptance_id TEXT NOT NULL,value TEXT NOT NULL,digest TEXT NOT NULL,retired TEXT);
CREATE TABLE context_recipient_deliveries(id TEXT PRIMARY KEY,recipient_key TEXT NOT NULL,value TEXT NOT NULL,digest TEXT NOT NULL,input_id TEXT,accepted_response TEXT,disposition TEXT);
CREATE TABLE context_input_sends(input_id TEXT NOT NULL,attempt_id TEXT NOT NULL,PRIMARY KEY(input_id,attempt_id));
`;
type Selection=NonNullable<ContextSelectionProposal["selection"]>;
type DeliveryPart=Extract<ContextAcceptancePart,{owner:"context_delivery"}>;
interface StoredInput extends Omit<ContextInputBinding,"exactInput"> {readonly exactInputRoot:ExecutionContentRoot;readonly exactInputDigest:string;}
export class ContextSelectionDatabase {
  constructor(private readonly db:Database.Database,private readonly records:ContextFoundationRecords,
    private readonly materials:MaterialCustodyDatabase,private readonly representations:RepresentationDatabase,
    private readonly retain:(value:unknown)=>ExecutionContentRoot,private readonly hydrate:(root:ExecutionContentRoot)=>unknown,
    private readonly confirmResult:(runId:string,pathId:string,inputDigest:string,resultId:string)=>boolean,
    private readonly confirmAttempt:(runId:string,pathId:string,requestId:string,inputDigest:string,attemptId:string)=>boolean,
    private readonly pathSettled:(pathId:string)=>boolean) {}
  command(command:ContextSelectionCommand):ContextSelectionValue {
    switch(command.kind) {
      case "scope":return this.registerScope(command.scope);
      case "control":return this.control(command.control,command.expectedRevision);
      case "current":{const scope=this.scope(command.scopeId);return scope.currentId?this.selection(scope.currentId):null;}
      case "binding":return this.binding(command.inputId,command.checkCurrentControl);
      case "delivery":return this.delivery(command.id);
      case "sent":return this.sent(command.inputId,command.attemptId);
      case "retire_input":return this.retireInput(command.inputId,command.basis);
      case "withdraw":return this.withdraw(command);
    }
  }
  participants():readonly SharedAcceptanceParticipant[] {
    return [
      {owner:"context_selection",kinds:["selection_input"],prepare:(part,acceptance)=>{
        const proposal=part.proposal as ContextSelectionProposal;
        const scope=this.scope(proposal.scopeId).scope;
        if(acceptance.id!==proposal.id || acceptance.scope!==scope.runId || acceptance.actor!==scope.owner)reject("selection_actor_invalid");
        const {exactInput,...metadata}=proposal.input;
        const submission=acceptance.parts.find(part=>part.owner==="activity"&&part.kind==="stage_submission");
        const request=submission?.proposal as import("@agent-anything/agent-runtime/activity").ActivityStageRequest|undefined;
        if(!request || request.id!==proposal.input.stageRequestId || request.pathId!==proposal.input.activityId ||
          modelInputValueDigest(request.input)!==modelInputValueDigest(exactInput))reject("input_activity_submission_missing");
        const stored:StoredInput={...metadata,exactInputRoot:this.retain(exactInput),exactInputDigest:modelInputValueDigest(exactInput)};
        const judgment=this.representations.judgment(proposal.input.combinationJudgmentId);
        if(!judgment || judgment.kind!=="combination" || judgment.conclusion!=="supported" || judgment.purpose!==scope.purpose || judgment.target!==scope.target ||
          judgment.dependencies.inputDigest!==modelInputValueDigest(exactInput))reject("input_combination_not_supported");
        const deliveryPart=acceptance.parts.find(p=>p.owner==="context_delivery"&&p.kind==="select");
        if(!deliveryPart || modelInputValueDigest(deliveryPart.proposal)!==modelInputValueDigest({inputId:proposal.input.id,scopeId:scope.id,deliveryIds:proposal.input.deliveries.map(d=>d.id)}))reject("input_delivery_part_missing");
        return {proposal:structuredClone(proposal),stored};
      },apply:(value,acceptance)=>{
        const {proposal,stored}=value as {proposal:ContextSelectionProposal;stored:StoredInput};
        try{this.acceptSelection(proposal,stored,acceptance);}catch(error){if(error instanceof MaterialCustodyError)reject(error.code);throw error;}
      },validate:value=>{
        const {proposal}=value as {proposal:ContextSelectionProposal};
        for(const id of proposal.releaseHolds)if(this.materials.hold(id))reject("input_hold_transfer_incomplete");
      }},
      {owner:"context_delivery",kinds:["publish","select","accept","dispose"],prepare:part=>structuredClone(part),apply:(value,acceptance)=>{
        try{this.applyDelivery(value as DeliveryPart,acceptance);}catch(error){if(error instanceof MaterialCustodyError)reject(error.code);throw error;}
      }},
    ];
  }
  private registerScope(scope:ContextUseScope):ContextUseScope {
    [scope.id,scope.runId,scope.recipient,scope.purpose,scope.continuity,scope.owner,scope.target,scope.authorityBasis].forEach(custodyToken);
    return this.db.transaction(()=>{
      const old=this.records.sql("SELECT value,digest FROM context_use_scopes WHERE id=?").get(scope.id) as {value:string;digest:string}|undefined;
      if(old){requireSame(checkedJson(old),scope);return scope;}
      const control={scopeId:scope.id,revision:0,allowed:true,basis:scope.authorityBasis};
      this.records.sql("INSERT INTO context_use_scopes VALUES (?,?,?,?,?,?,?,NULL)").run(scope.id,
        JSON.stringify([scope.runId,scope.recipient,scope.purpose,scope.continuity]),scope.runId,JSON.stringify(scope),modelInputValueDigest(scope),JSON.stringify(control),modelInputValueDigest(control));
      this.records.fact(scope.runId,"context_selection",scope.id,"scope_registered",{scope});return scope;
    })();
  }
  private scope(id:string):{scope:ContextUseScope;control:ContextUseControl;currentId:string|null} {
    const row=this.records.sql("SELECT value,digest,control,control_digest,current_id FROM context_use_scopes WHERE id=?").get(id) as {value:string;digest:string;control:string;control_digest:string;current_id:string|null}|undefined;
    if(!row)reject("input_scope_missing");
    return {scope:checkedJson(row),control:checkedJson({value:row.control,digest:row.control_digest}),currentId:row.current_id};
  }
  private control(control:ContextUseControl,expectedRevision:number):ContextUseControl {
    custodyToken(control.basis);
    return this.db.transaction(()=>{
      const current=this.scope(control.scopeId);
      if(current.control.revision===control.revision){requireSame(current.control,control);return control;}
      if(current.control.revision!==expectedRevision || control.revision!==expectedRevision+1)reject("input_control_conflict");
      this.records.sql("UPDATE context_use_scopes SET control=?,control_digest=? WHERE id=?").run(JSON.stringify(control),modelInputValueDigest(control),control.scopeId);
      this.records.fact(current.scope.runId,"context_selection",control.scopeId,"control_changed",{control});return control;
    })();
  }
  private selection(id:string):Selection {
    const row=this.records.sql("SELECT value,digest FROM context_selection_versions WHERE id=?").get(id) as {value:string;digest:string}|undefined;
    if(!row)reject("selection_missing");return checkedJson<Selection>(row);
  }
  private storedInput(id:string):{input:StoredInput;acceptanceId:string;retired:string|null} {
    const row=this.records.sql("SELECT value,digest,acceptance_id,retired FROM context_input_bindings WHERE id=?").get(id) as {value:string;digest:string;acceptance_id:string;retired:string|null}|undefined;
    if(!row)reject("input_binding_missing");return {input:checkedJson(row),acceptanceId:row.acceptance_id,retired:row.retired};
  }
  private acceptSelection(proposal:ContextSelectionProposal,input:StoredInput,acceptance:SharedAcceptanceProposal):void {
    const current=this.scope(proposal.scopeId),scope=current.scope;
    if(!current.control.allowed || current.control.revision!==proposal.expectedControlRevision)reject("input_control_changed");
    if(current.currentId!==proposal.expectedSelectionId)reject("selection_conflict");
    const selection=proposal.selection??(current.currentId?this.selection(current.currentId):null);
    if(!selection || selection.id!==input.selectionId || input.scopeId!==scope.id || input.target!==scope.target || !selection.representations.length || selection.representations.length>256)reject("input_selection_invalid");
    const combination=this.representations.judgment(input.combinationJudgmentId)!;
    if(modelInputValueDigest(combination.subjects)!==modelInputValueDigest(selection.representations))reject("input_combination_subjects_changed");
    for(const judgmentId of selection.judgmentIds) {
      const judgment=this.representations.judgment(judgmentId);
      if(!judgment || judgment.conclusion!=="supported" || judgment.target!==scope.target || judgment.purpose!==scope.purpose)reject("selection_judgment_unavailable");
    }
    const ranges:MaterialRange[]=[];
    for(const ref of selection.representations) {
      const representation=this.representations.read(ref);if(!representation)reject("selection_representation_missing");
      ranges.push(representation.body,...representation.details);
    }
    for(const range of ranges) {
      const hold=selection.holds.find(h=>containsMaterialRange(h.range,range));
      if(!hold || hold.responsibility!=="selection" || hold.basis!==selection.id)reject("selection_hold_missing");
      if(modelInputValueDigest(this.materials.hold(hold.id))!==modelInputValueDigest(hold))reject("selection_hold_identity_mismatch");
      this.materials.requireProtected(hold.instanceId,range,scope,hold.id);
    }
    for(const selected of input.deliveries) {const delivery=this.delivery(selected.id);if(!delivery)reject("delivery_missing");ranges.push(delivery.material);}
    for(const range of ranges) {
      const hold=input.holds.find(h=>containsMaterialRange(h.range,range));if(!hold)reject("input_hold_missing");
      if(modelInputValueDigest(this.materials.hold(hold.id))!==modelInputValueDigest(hold))reject("input_hold_identity_mismatch");
      this.materials.requireProtected(hold.instanceId,range,scope,hold.id);
      if(hold.responsibility!=="input" || hold.basis!==input.id)reject("input_hold_responsibility_invalid");
    }
    if(proposal.selection) {
      this.records.sql("INSERT INTO context_selection_versions VALUES (?,?,?,?,?)").run(selection.id,scope.id,acceptance.id,JSON.stringify(selection),modelInputValueDigest(selection));
      this.records.sql("UPDATE context_use_scopes SET current_id=? WHERE id=?").run(selection.id,scope.id);
    }
    this.records.sql("INSERT INTO context_input_bindings VALUES (?,?,?,?,?,NULL)").run(input.id,scope.id,acceptance.id,JSON.stringify(input),modelInputValueDigest(input));
    this.records.fact(scope.runId,"context_selection",input.id,"input_bound",{acceptanceId:acceptance.id,scopeId:scope.id,selectionId:selection.id,activityId:input.activityId,
      deliveryIds:input.deliveries.map(d=>d.id),holds:input.holds.map(h=>h.id),changedSelection:proposal.selection!==null});
  }
  private binding(id:string,checkCurrentControl:boolean):ContextSelectionSnapshot {
    // Read all related metadata in one view, then hydrate the immutable body outside it.
    const metadata=this.db.transaction(()=>{
      const {input,acceptanceId,retired}=this.storedInput(id),current=this.scope(input.scopeId);
      if(checkCurrentControl&&retired!==null)reject("input_retired");
      if(checkCurrentControl&&!current.control.allowed)reject("input_control_revoked");
      if(checkCurrentControl)for(const hold of input.holds)this.materials.requireProtected(hold.instanceId,hold.range,current.scope,hold.id);
      return {input,acceptanceId,scope:current.scope,selection:this.selection(input.selectionId),deliveries:input.deliveries.map(d=>{
        const value=this.delivery(d.id);if(!value)reject("input_delivery_missing");return value;
      })};
    })();
    const {exactInputRoot,exactInputDigest,...input}=metadata.input;
    const exactInput=this.hydrate(exactInputRoot);
    if(modelInputValueDigest(exactInput)!==exactInputDigest)reject("input_content_corrupt");
    return {...metadata,input:{...input,exactInput}};
  }
  private delivery(id:string):ContextDelivery|null {
    const row=this.records.sql("SELECT value,digest FROM context_recipient_deliveries WHERE id=?").get(id) as {value:string;digest:string}|undefined;
    return row?checkedJson<ContextDelivery>(row):null;
  }
  private applyDelivery(part:DeliveryPart,acceptance:SharedAcceptanceProposal):void {
    if(part.kind==="dispose") {
      const {deliveryId,recipient,reason,basis}=part.proposal;custodyToken(basis);
      const delivery=this.delivery(deliveryId);
      if(!delivery || recipientKey(delivery.recipient)!==recipientKey(recipient) || acceptance.scope!==recipient.runId || acceptance.actor!==recipient.recipient || !["cancelled","withdrawn","unavailable"].includes(reason))reject("delivery_disposition_invalid");
      const row=this.records.sql("SELECT input_id,accepted_response,disposition FROM context_recipient_deliveries WHERE id=?").get(deliveryId) as {input_id:string|null;accepted_response:string|null;disposition:string|null};
      const disposition=JSON.stringify({reason,basis});
      if(row.disposition!==null){if(row.disposition!==disposition)reject("delivery_disposition_conflict");return;}
      if(row.accepted_response!==null || row.input_id!==null&&!this.pathSettled(this.storedInput(row.input_id).input.activityId))reject("delivery_disposition_unsettled");
      this.records.sql("UPDATE context_recipient_deliveries SET disposition=? WHERE id=?").run(disposition,deliveryId);
      this.records.fact(recipient.runId,"context_delivery",deliveryId,"disposed",{reason,basis});
    } else if(part.kind==="publish") {
      const delivery=part.proposal,hold=this.materials.hold(delivery.holdId);
      const version=this.materials.version(delivery.material.materialId,delivery.material.version);
      if(!version || version.origin.runId!==delivery.sourceRunId || !hold || hold.responsibility!=="delivery" || hold.instanceId!==delivery.instanceId || hold.basis!==delivery.id)reject("delivery_source_or_hold_invalid");
      this.materials.requireProtected(delivery.instanceId,delivery.material,delivery.recipient,delivery.holdId);
      const old=this.delivery(delivery.id);if(old){requireSame(old,delivery);return;}
      this.records.sql("INSERT INTO context_recipient_deliveries VALUES (?,?,?,?,NULL,NULL,NULL)").run(delivery.id,recipientKey(delivery.recipient),JSON.stringify(delivery),modelInputValueDigest(delivery));
      this.records.fact(delivery.recipient.runId,"context_delivery",delivery.id,"published",{sourceRunId:delivery.sourceRunId,sourceId:delivery.sourceId,material:delivery.material,holdId:delivery.holdId});
    } else if(part.kind==="select") {
      const scope=this.scope(part.proposal.scopeId).scope,{input,acceptanceId}=this.storedInput(part.proposal.inputId);
      if(acceptanceId!==acceptance.id || input.scopeId!==scope.id || modelInputValueDigest(input.deliveries.map(d=>d.id))!==modelInputValueDigest(part.proposal.deliveryIds))reject("delivery_input_mismatch");
      for(const id of part.proposal.deliveryIds) {
        const row=this.records.sql("SELECT value,digest,recipient_key,input_id,accepted_response,disposition FROM context_recipient_deliveries WHERE id=?").get(id) as {value:string;digest:string;recipient_key:string;input_id:string|null;accepted_response:string|null;disposition:string|null}|undefined;
        if(!row || row.recipient_key!==recipientKey(scope) || row.input_id!==null || row.accepted_response!==null || row.disposition!==null)reject("delivery_selection_conflict");
        checkedJson(row);
        this.records.sql("UPDATE context_recipient_deliveries SET input_id=? WHERE id=?").run(input.id,id);
      }
    } else {
      const {input}=this.storedInput(part.proposal.inputId),scope=this.scope(input.scopeId).scope;
      if(acceptance.scope!==scope.runId || acceptance.actor!==scope.owner || !this.records.sql("SELECT 1 FROM context_input_sends WHERE input_id=?").get(input.id))reject("delivery_not_sent");
      if(!this.confirmResult(scope.runId,input.activityId,input.exactInputDigest,part.proposal.responseId))reject("delivery_response_not_confirmed");
      for(const selected of input.deliveries) {
        const delivery=this.delivery(selected.id)!;
        const prior=this.records.sql("SELECT accepted_response,disposition FROM context_recipient_deliveries WHERE id=?").get(selected.id) as {accepted_response:string|null;disposition:string|null};
        if(prior.disposition!==null)reject("delivery_disposed");
        if(prior.accepted_response!==null){if(prior.accepted_response!==part.proposal.responseId)reject("delivery_response_conflict");continue;}
        if(delivery.detailHoldId) {
          const hold=this.materials.hold(delivery.detailHoldId);
          if(!part.proposal.detailHolds.includes(delivery.detailHoldId) || !hold || hold.responsibility!=="detail")reject("delivery_detail_promise_missing");
          this.materials.requireProtected(hold.instanceId,delivery.material,delivery.recipient,hold.id);
        }
        this.records.sql("UPDATE context_recipient_deliveries SET accepted_response=? WHERE id=? AND input_id=? AND accepted_response IS NULL").run(part.proposal.responseId,selected.id,input.id);
        this.records.fact(scope.runId,"context_delivery",selected.id,"accepted",{inputId:input.id,responseId:part.proposal.responseId,detailHoldId:delivery.detailHoldId});
      }
    }
  }
  private sent(inputId:string,attemptId:string):null {
    custodyToken(attemptId);
    this.db.transaction(()=>{
      const {input,retired}=this.storedInput(inputId),scope=this.scope(input.scopeId);
      if(retired!==null)reject("input_retired");
      if(!scope.control.allowed)reject("input_control_revoked");
      if(!this.confirmAttempt(scope.scope.runId,input.activityId,input.stageRequestId,input.exactInputDigest,attemptId))reject("input_attempt_not_confirmed");
      for(const hold of input.holds)this.materials.requireProtected(hold.instanceId,hold.range,scope.scope,hold.id);
      const result=this.records.sql("INSERT OR IGNORE INTO context_input_sends VALUES (?,?)").run(inputId,attemptId);
      if(result.changes)this.records.fact(scope.scope.runId,"context_selection",input.id,"sent",{attemptId});
    })();return null;
  }
  mayRelease(hold:MaterialHold):boolean {
    if(hold.responsibility==="input")return !this.records.sql("SELECT 1 FROM context_input_bindings WHERE id=? AND retired IS NULL").get(hold.basis);
    if(hold.responsibility==="selection")return !this.records.sql("SELECT 1 FROM context_use_scopes WHERE current_id=?").get(hold.basis);
    if(hold.responsibility==="delivery")return !this.records.sql("SELECT 1 FROM context_recipient_deliveries WHERE id=? AND accepted_response IS NULL AND disposition IS NULL").get(hold.basis);
    return true;
  }
  private retireInput(id:string,basis:string):null {
    custodyToken(basis);
    this.db.transaction(()=>{
      const {input,retired}=this.storedInput(id),scope=this.scope(input.scopeId).scope;
      if(retired!==null){if(retired!==basis)reject("input_retirement_conflict");return;}
      if(!this.pathSettled(input.activityId) || this.records.sql("SELECT 1 FROM context_recipient_deliveries WHERE input_id=? AND accepted_response IS NULL AND disposition IS NULL").get(id))reject("input_responsibility_unsettled");
      this.records.sql("UPDATE context_input_bindings SET retired=? WHERE id=? AND retired IS NULL").run(basis,id);
      this.records.fact(scope.runId,"context_selection",id,"input_retired",{basis});
    })();return null;
  }
  private withdraw(command:Extract<ContextSelectionCommand,{kind:"withdraw"}>):null {
    custodyToken(command.basis);
    this.db.transaction(()=>{
      const current=this.scope(command.scopeId);
      if(current.currentId!==command.expectedSelectionId || current.control.revision!==command.expectedControlRevision)reject("selection_withdraw_conflict");
      this.records.sql("UPDATE context_use_scopes SET current_id=NULL WHERE id=?").run(command.scopeId);
      this.records.fact(current.scope.runId,"context_selection",command.scopeId,"selection_withdrawn",{selectionId:command.expectedSelectionId,basis:command.basis});
    })();return null;
  }
}
function recipientKey(recipient:{runId:string;recipient:string;purpose:string}):string{return JSON.stringify([recipient.runId,recipient.recipient,recipient.purpose]);}
function reject(code:string):never{throw new SharedAcceptanceRejection("context_selection",code);}
