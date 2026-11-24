import type {ActivityPublishedFact} from "@agent-anything/agent-runtime/activity";
import type {MaterialAccess,MaterialGrant,MaterialRecipient} from "@agent-anything/context/custody";
import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import type {RunExecutionControl} from "./RunExecutionControl.js";
import {SharedAcceptanceRejection,type SharedAcceptanceParticipant} from "./SharedAcceptanceDatabase.js";

/** The receipt for an old grant remains a fact; only a new grant needs an open recipient. */
export function reportRecipientAdmission(control:(runId:string)=>RunExecutionControl|null,
  fact:(id:string)=>ActivityPublishedFact|null,withdraw:(id:string,instance:string,recipient:MaterialRecipient,basis:string)=>void):SharedAcceptanceParticipant {
  type Condition={pathId:string;accessId:string;recipient:MaterialRecipient};
  const reject=(code:string):never=>{throw new SharedAcceptanceRejection("report_recipient",code);};
  return {owner:"report_recipient",kinds:["require_open","withdraw_access"],prepare:(part,shared)=>{
    const p=part.proposal as Condition;
    if(part.kind==="withdraw_access"){
      if(!p?.recipient||shared.actor!=="material-source"||!shared.parts.some(other=>other.owner==="activity"&&other.kind==="fact_publication"&&
        (other.proposal as ActivityPublishedFact).id===p.pathId+":stop"&&(other.proposal as ActivityPublishedFact).ref.id===p.pathId))
        reject("report_withdrawal_scope_invalid");
      return {p,source:null};
    }
    const admission=shared.parts.find(other=>other.owner==="material_custody"&&other.kind==="admit_access")?.proposal as
      {source:MaterialAccess;grant:MaterialGrant}|undefined;
    if(!p?.recipient||shared.actor!=="helarc.report-handoff"||shared.scope!==p.recipient.runId||p.accessId!==shared.id||
      !admission||digest(admission.grant.recipient)!==digest(p.recipient)||admission.grant.id!==p.accessId+":grant"||
      p.accessId!==admission.source.range.materialId+":parent:"+digest(p.recipient)||
      p.pathId!==admission.source.range.materialId+":publication:"+digest(admission.source.recipient))
      reject("report_access_admission_scope_invalid");
    control(p.recipient.runId); // Warm the validated immutable control before taking the writer transaction.
    return {p,source:admission!.source};
  },apply:(value,shared)=>{
    const {p,source}=value as {p:Condition;source:MaterialAccess|null};
    const original=fact(p.pathId+":capture-authority") as (ActivityPublishedFact&{handoff?:{parent:MaterialRecipient;child:MaterialRecipient;version:{materialId:string;version:string};pathId:string}})|null;
    if(!source&&!original)return; // Cancellation before the report owner accepted the capture.
    if(original?.ref.owner!=="helarc.report-handoff"||original.ref.kind!=="accepted_report_capture"||original.ref.id!==p.accessId||
      original.sourceId!==p.pathId+":report-owner"||original.handoff?.pathId!==p.pathId||digest(original.handoff.parent)!==digest(p.recipient))reject("report_capture_basis_unconfirmed");
    const handoff=original!.handoff!;
    if(!source){
      if(handoff.child.runId!==shared.scope)reject("report_withdrawal_scope_invalid");
      withdraw(p.accessId+":grant",p.pathId+":custody:instance",p.recipient,p.pathId+":stop");return;
    }
    if(digest(source.recipient)!==digest(handoff.child)||source.range.materialId!==handoff.version.materialId||source.range.version!==handoff.version.version)
      reject("report_access_admission_scope_invalid");
    if(fact(p.pathId+":stop"))reject("report_publication_withdrawn");
    const current=control(p.recipient.runId);
    if(!current)throw new Error("report_recipient_control_unavailable");
    if(current.terminal||current.cancelled)reject("report_recipient_closed");
  }};
}
