import {createHash} from "node:crypto";
import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import type {ProtocolRevisionRef} from "@agent-anything/model-interaction/protocol";
import {readProtocolContent,readProtocolInputRejection,type ProtocolExecutionState,type ProtocolPurposeAcceptance,type ProtocolReconciliationHandoff} from "@agent-anything/agent-runtime/model-access";
import type {SharedAcceptancePart} from "@agent-anything/agent-runtime/activity";
import {helarcNativeTaskResultDeliveries,acceptHelarcNativeInputReceipt,type HelarcNativeTaskDelivery,type HelarcNativeRunTask} from "@agent-anything/helarc/controller";
import type {ContextMaterialRef} from "@agent-anything/context/material";
import {snapshotContextMaterialRef} from "@agent-anything/context/material";
import {materialViewReference,type MaterialHold,type MaterialDeliveryState,type MaterialDeliveryGuard,type MaterialRecipient,
  type MaterialDeliveryObligation,type MaterialVersion,type MaterialDeliveryPage,type MaterialDeliveryEvidence,type MaterialDeliveryDispositionAcceptance} from "@agent-anything/context/custody";
import type {HelarcExecutionStore} from "../execution-storage/HelarcExecutionStore.js";

const OWNER="helarc.report-handoff";
const ref=(id:string):ProtocolRevisionRef=>({id,revision:"1"});
export function helarcReportDeliveryRef(reference:ContextMaterialRef,recipient:MaterialRecipient):ProtocolRevisionRef {
  return ref(`helarc-report-delivery:${digest({reference,recipient})}`);
}

/** Parent input receipt and detail access are different responsibilities over the same version. */
export class HelarcNativeReportDelivery implements HelarcNativeTaskDelivery {
  constructor(private readonly store:HelarcExecutionStore,private readonly resolution:(state:ProtocolExecutionState)=>Promise<{
    readonly basis:ProtocolRevisionRef;readonly resolved:boolean}|null>=async()=>null){}
  registration(detail:MaterialHold,version:MaterialVersion):readonly SharedAcceptancePart[] {
    const reference=materialViewReference(detail.range,version),identity=helarcReportDeliveryRef(reference,detail.consumer);
    const hold:MaterialHold={...detail,id:`identity:${identity.id}:hold`,responsibility:"delivery",releaseCondition:"Accepted Parent task input reference or lawful disposition"};
    const obligation:MaterialDeliveryObligation={ref:identity,contract:{ref:ref("helarc.child-report-reference"),owner:OWNER,
      confirmation:"Accepted Parent task input contains the disclosed immutable report reference; not full-body receipt"},recipient:hold.consumer,range:hold.range,holdId:hold.id};
    return [{owner:"material_custody",kind:"holds",proposal:{acquire:[hold],release:[],basis:detail.basis}},
      {owner:"material_delivery",kind:"register",proposal:{obligation,handoff:null}}];
  }
  async select(prepared:HelarcNativeRunTask,input:Parameters<HelarcNativeTaskDelivery["select"]>[1]):Promise<void> {
    const deliveries=this.deliveries(prepared,input);if(!deliveries.length)return;
    await this.original(prepared);
    for(const delivery of deliveries){
      const state=await this.state(delivery.ref);
      if(!state||state.discharged.length)continue;
      const basis=ref(prepared.binding.scope.activityId);
      if(state.protection.selected||state.protection.inFlight!=="none"){
        if(digest(state.protection.basis)!==digest(basis))throw new TypeError("report_delivery_competing_selection");
        continue;
      }
      await this.acceptParts(`${basis.id}:report-select:${delivery.ref.id}`,state.obligation.recipient.runId,[{owner:"material_delivery",kind:"protect",
        proposal:{obligation:state.obligation.ref,expectedRevision:state.protection.revision,selected:true,inFlight:"pending",basis}}]);
    }
  }
  async accept(prepared:HelarcNativeRunTask,input:Parameters<HelarcNativeTaskDelivery["select"]>[1],accepted:ProtocolPurposeAcceptance):Promise<void> {
    const deliveries=this.deliveries(prepared,input);if(!deliveries.length)return;
    return this.acceptKnown(prepared,deliveries,accepted);
  }
  private async acceptKnown(prepared:HelarcNativeRunTask,deliveries:readonly {ref:ProtocolRevisionRef;position:string;contentDigest:string}[],accepted:ProtocolPurposeAcceptance):Promise<void>{
    const original=await this.original(prepared),activityId=prepared.binding.scope.activityId;
    const saved=await this.store.protocolJournal.command({kind:"acceptance",activityId}) as ProtocolPurposeAcceptance|null;
    if(!saved||digest(saved)!==digest(accepted)||digest(saved.evidence.scope)!==digest(prepared.binding.scope))throw new TypeError("report_delivery_purpose_unconfirmed");
    for(const delivery of deliveries){
      let state=await this.state(delivery.ref);if(!state)continue;
      const request=ref(`${delivery.ref.id}:received:${accepted.evidence.acceptance.id}`);
      if(await this.store.materialDeliveries.query({kind:"accepted",ref:request})){
        await this.store.materialCustody.command({kind:"release",holdId:state.obligation.holdId,basis:request.id});continue;
      }
      if(state.discharged.length)continue;
      const receipt=ref(`${delivery.ref.id}:input:${digest({input:original.input,position:delivery.position,contentDigest:delivery.contentDigest,acceptance:accepted.evidence.acceptance})}`);
      const clearId=`${request.id}:confirmed`;
      if(!(await this.store.sharedAcceptance.query(clearId))){
        if(state.protection.basis.id!==activityId)throw new TypeError("report_delivery_selected_activity_changed");
        await this.acceptParts(clearId,state.obligation.recipient.runId,[
          {owner:"material_delivery",kind:"evidence",proposal:{ref:receipt,obligation:state.obligation.ref,kind:"receipt",basis:accepted.evidence.acceptance}},
          {owner:"material_delivery",kind:"protect",proposal:{obligation:state.obligation.ref,expectedRevision:state.protection.revision,
            selected:false,inFlight:"none",basis:accepted.evidence.acceptance}}]);
      }
      state=(await this.state(delivery.ref))!;
      const guard=await this.store.materialDeliveries.query({kind:"guard",ref:state.obligation.ref}) as MaterialDeliveryGuard;
      await this.acceptParts(request.id,state.obligation.recipient.runId,[{owner:"material_delivery",kind:"disposition",proposal:{ref:request,
        expectedObligation:state.obligation,expectedSelectionRevision:guard.revision,disposition:{kind:"fulfilled",obligation:state.obligation.ref,
          contract:state.obligation.contract.ref,receipt}}}]);
      await this.store.materialCustody.command({kind:"release",holdId:state.obligation.holdId,basis:request.id});
    }
  }
  async refused(prepared:HelarcNativeRunTask,input:Parameters<HelarcNativeTaskDelivery["select"]>[1],
    evidence:import("@agent-anything/agent-runtime/model-access").ProtocolInputRejectionEvidence):Promise<void>{
    const original=await this.original(prepared),activityId=prepared.binding.scope.activityId;
    if(original.accepted||digest(original.inputRefusal)!==digest(evidence))throw new TypeError("report_delivery_refusal_unconfirmed");
    for(const delivery of this.deliveries(prepared,input)){
      const state=await this.state(delivery.ref);if(!state||state.discharged.length)continue;
      await this.clearInFlight(delivery.ref,original,evidence.evidence,`${activityId}:report-refused:${delivery.ref.id}`);
    }
  }
  /** Only a confirmed, unselected publication can be withdrawn by this path. Unknown input keeps its hold. */
  async withdraw(reference:ContextMaterialRef,recipient:MaterialRecipient,basis:ProtocolRevisionRef):Promise<void>{
    return this.withdrawObligation(helarcReportDeliveryRef(reference,recipient),recipient,basis);
  }
  private async withdrawObligation(identity:ProtocolRevisionRef,recipient:MaterialRecipient,basis:ProtocolRevisionRef):Promise<void>{
    const state=await this.state(identity);if(!state)return;
    if(state.obligation.contract.owner!==OWNER||digest(state.obligation.recipient)!==digest(recipient))throw new TypeError("report_delivery_owner_changed");
    const authorization=ref(`${identity.id}:withdrawal:${basis.id}`),resolution=ref(`${authorization.id}:no-inflight`),request=ref(`${authorization.id}:dispose`);
    if(await this.store.materialDeliveries.query({kind:"accepted",ref:request})){
      await this.store.materialCustody.command({kind:"release",holdId:state.obligation.holdId,basis:request.id});return;
    }
    if(state.discharged.length)return;
    const guard=await this.store.materialDeliveries.query({kind:"guard",ref:identity}) as MaterialDeliveryGuard;
    if(guard.active)throw new TypeError("report_delivery_withdrawal_requires_reconciliation");
    await this.acceptParts(request.id,recipient.runId,[
      {owner:"material_delivery",kind:"evidence",proposal:{ref:authorization,obligation:identity,kind:"authorization",basis}},
      {owner:"material_delivery",kind:"evidence",proposal:{ref:resolution,obligation:identity,kind:"in_flight_resolution",basis:state.protection.basis}},
      {owner:"material_delivery",kind:"disposition",proposal:{ref:request,expectedObligation:state.obligation,expectedSelectionRevision:guard.revision,
        disposition:{kind:"non_delivery",obligation:identity,contract:state.obligation.contract.ref,authorization,inFlightResolution:resolution}}}]);
    await this.store.materialCustody.command({kind:"release",holdId:state.obligation.holdId,basis:request.id});
  }
  pending(after:string|null,limit:number):Promise<MaterialDeliveryPage<MaterialDeliveryState>>{
    return this.store.materialDeliveries.query({kind:"pending_page",owner:OWNER,after,limit}) as Promise<MaterialDeliveryPage<MaterialDeliveryState>>;
  }
  /** Completes only original delivery obligations; it never resumes the recipient Run. */
  async recoverDisposition(identity:ProtocolRevisionRef):Promise<"disposed"|"pending"|"unresolved">{
    let state=await this.state(identity);if(!state)throw new TypeError("report_delivery_obligation_missing");
    const obligation=state.obligation,recipient=obligation.recipient;
    if(obligation.contract.owner!==OWNER||obligation.contract.ref.id!=="helarc.child-report-reference"||obligation.contract.ref.revision!=="1")
      throw new TypeError("report_delivery_owner_changed");
    if(state.discharged.length){
      const page=await this.store.materialDeliveries.query({kind:"disposition_page",obligation:identity,after:null,limit:2}) as MaterialDeliveryPage<MaterialDeliveryDispositionAcceptance>;
      if(page.next||page.entries.length!==1||page.entries[0]!.disposition.kind==="transferred")return "unresolved";
      const accepted=page.entries[0]!;
      if(accepted.discharged.length!==1||accepted.discharged[0]!.holdId!==obligation.holdId||digest(accepted.discharged[0]!.range)!==digest(obligation.range))
        throw new TypeError("report_delivery_discharge_scope_changed");
      await this.store.materialCustody.command({kind:"release",holdId:obligation.holdId,basis:accepted.request.id});return "disposed";
    }
    const receipts=await this.store.materialDeliveries.query({kind:"receipt_page",obligation:identity,after:null,limit:2}) as MaterialDeliveryPage<MaterialDeliveryEvidence>;
    if(receipts.next||receipts.entries.length>1)throw new TypeError("report_delivery_receipt_ambiguous");
    if(receipts.entries.length){
      const evidence=receipts.entries[0]!,request=ref(`${identity.id}:received:${evidence.basis.id}`);
      if(state.protection.selected||state.protection.inFlight!=="none")throw new TypeError("report_delivery_receipt_protection_changed");
      const guard=await this.store.materialDeliveries.query({kind:"guard",ref:identity}) as MaterialDeliveryGuard;
      await this.acceptParts(request.id,recipient.runId,[{owner:"material_delivery",kind:"disposition",proposal:{ref:request,
        expectedObligation:obligation,expectedSelectionRevision:guard.revision,disposition:{kind:"fulfilled",obligation:identity,
          contract:obligation.contract.ref,receipt:evidence.ref}}}]);
      await this.store.materialCustody.command({kind:"release",holdId:obligation.holdId,basis:request.id});return "disposed";
    }
    if(state.protection.selected||state.protection.inFlight!=="none"){
      const activityId=state.protection.basis.id;
      const execution=await this.store.protocolJournal.command({kind:"state",activityId}) as ProtocolExecutionState|null;
      if(!execution||execution.activity.scope.runId!==recipient.runId||execution.activity.scope.recipientId!==recipient.recipient||
        execution.activity.scope.purpose.id!==recipient.purpose)throw new TypeError("report_delivery_original_activity_changed");
      if(!execution.accepted){
        if(execution.inputRefusal){
          const refusal=await readProtocolInputRejection(this.store.protocolJournal,execution);
          if(!refusal)throw new TypeError("report_delivery_original_refusal_missing");
          await this.clearInFlight(identity,execution,execution.inputRefusal.evidence,`${activityId}:report-refused:${identity.id}`);return "pending";
        }
        if(!execution.cancelled)return "pending";
        const handoff=await this.store.protocolJournal.command({kind:"activity_reconciliation",activityId}) as ProtocolReconciliationHandoff|null;
        if(handoff?.disposition?.outcome!=="unresolved"&&handoff?.disposition)return this.reconcileCancellation(identity,activityId,handoff.id);
        const resolution=await this.resolution(execution);
        if(!resolution?.resolved)return "unresolved";
        await this.clearInFlight(identity,execution,resolution.basis);
        return this.recoverDisposition(identity);
      }
      const acceptance=await this.store.protocolJournal.command({kind:"acceptance",activityId}) as ProtocolPurposeAcceptance|null;
      if(!acceptance||digest(acceptance.evidence.acceptance)!==digest(execution.accepted))throw new TypeError("report_delivery_original_receipt_missing");
      const prepared=JSON.parse((await readProtocolContent(this.store.protocolJournal,execution.input,activityId,32*1024*1024)).toString()) as HelarcNativeRunTask;
      if(prepared.format!=="helarc.native-prepared-task.v1")throw new TypeError("report_delivery_task_input_required");
      const body=JSON.parse(prepared.wire.body),matching=prepared.results.filter(mapping=>{
        const match=/^\/(input|messages)\/(\d+)$/.exec(mapping.position),item=match?body[match[1]!]?.[Number(match[2])]:null;
        if(!item||digest(item)!==mapping.contentDigest)throw new TypeError("report_delivery_original_position_changed");
        const text=item.type==="function_call_output"?item.output:item.role==="tool"?item.content:null;
        if(typeof text!=="string")throw new TypeError("report_delivery_original_result_changed");
        const value=JSON.parse(text)?.result;
        if(value?.kind!=="descendant_run"||value.output?.report?.status!=="retained_material")return false;
        const reference=snapshotContextMaterialRef(value.output.report.reference);
        return digest(helarcReportDeliveryRef(reference,recipient))===digest(identity);
      });
      if(matching.length!==1)throw new TypeError("report_delivery_original_reference_missing");
      await acceptHelarcNativeInputReceipt(prepared,acceptance,{journal:this.store.protocolJournal,acceptance:this.store.sharedAcceptance,selections:this.store.contextSelections});
      await this.acceptKnown(prepared,[{ref:identity,position:matching[0]!.position,contentDigest:matching[0]!.contentDigest}],acceptance);
      return "disposed";
    }
    const control=await this.store.readRunControl(recipient.runId);
    if(!control?.terminal)return "pending";
    const guard=await this.store.materialDeliveries.query({kind:"guard",ref:identity}) as MaterialDeliveryGuard;
    if(guard.active)return "unresolved";
    await this.withdrawObligation(identity,recipient,{id:control.commitId,revision:String(control.revision)});return "disposed";
  }
  private async clearInFlight(identity:ProtocolRevisionRef,execution:ProtocolExecutionState,basis:ProtocolRevisionRef,
    id=`${execution.activity.scope.activityId}:report-resolution:${identity.id}:${digest(basis)}`):Promise<void>{
    const prior=await this.store.sharedAcceptance.query(id);
    if(prior){if(prior.outcome!=="accepted")throw new TypeError("report_delivery_resolution_rejected");return;}
    const state=await this.state(identity);if(!state)throw new TypeError("report_delivery_obligation_missing");
    const scope=execution.activity.scope,recipient=state.obligation.recipient;
    if(execution.accepted||scope.runId!==recipient.runId||scope.recipientId!==recipient.recipient||scope.purpose.id!==recipient.purpose||
      state.protection.basis.id!==scope.activityId)throw new TypeError("report_delivery_resolution_scope_changed");
    await this.acceptParts(id,recipient.runId,[
      {owner:"material_delivery",kind:"evidence",proposal:{ref:ref(`${id}:resolved`),obligation:identity,kind:"in_flight_resolution",basis}},
      {owner:"material_delivery",kind:"protect",proposal:{obligation:identity,expectedRevision:state.protection.revision,
        selected:false,inFlight:"none",basis}}]);
  }
  /** The Host supplies the original addressed obligation, not a new inferred receipt. */
  async reconcileCancellation(identity:ProtocolRevisionRef,activityId:string,handoffId:string):Promise<"unresolved"|"disposed"> {
    let state=await this.state(identity);if(!state)throw new TypeError("report_delivery_obligation_missing");
    const execution=await this.store.protocolJournal.command({kind:"state",activityId}) as ProtocolExecutionState|null;
    const handoff=await this.store.protocolJournal.command({kind:"reconciliation",activityId,id:handoffId}) as ProtocolReconciliationHandoff|null;
    const scope=execution?.activity.scope,recipient=state.obligation.recipient;
    if(!execution?.cancelled||!handoff?.disposition||handoff.receiver!==execution.activity.composition.composition.adapter.implementation.id||
      scope?.runId!==recipient.runId||scope.recipientId!==recipient.recipient||scope.purpose.id!==recipient.purpose)
      throw new TypeError("report_delivery_reconciliation_unconfirmed");
    if(execution.accepted)throw new TypeError("report_delivery_original_receipt_required");
    const request=ref(`${identity.id}:cancelled:${handoffId}`),cleared=`${request.id}:resolved`;
    if(await this.store.materialDeliveries.query({kind:"accepted",ref:request})){
      await this.store.materialCustody.command({kind:"release",holdId:state.obligation.holdId,basis:request.id});return "disposed";
    }
    if(state.discharged.length||state.protection.basis.id!==activityId&&!(await this.store.sharedAcceptance.query(cleared)))
      throw new TypeError("report_delivery_selected_activity_changed");
    if(handoff.disposition.outcome==="unresolved")return "unresolved";
    const authorization=ref(`${request.id}:authorization`),resolution=ref(`${request.id}:in-flight`);
    if(!(await this.store.sharedAcceptance.query(cleared))){
      await this.acceptParts(cleared,recipient.runId,[
        {owner:"material_delivery",kind:"evidence",proposal:{ref:authorization,obligation:identity,kind:"authorization",
          basis:{id:activityId,revision:String(execution.fence.controlRevision)}}},
        {owner:"material_delivery",kind:"evidence",proposal:{ref:resolution,obligation:identity,kind:"in_flight_resolution",basis:handoff.disposition.basis}},
        {owner:"material_delivery",kind:"protect",proposal:{obligation:identity,expectedRevision:state.protection.revision,
          selected:false,inFlight:"none",basis:handoff.disposition.basis}}]);
    }
    state=(await this.state(identity))!;
    const guard=await this.store.materialDeliveries.query({kind:"guard",ref:identity}) as MaterialDeliveryGuard;
    if(guard.active)return "unresolved";
    await this.acceptParts(request.id,recipient.runId,[{owner:"material_delivery",kind:"disposition",proposal:{ref:request,
      expectedObligation:state.obligation,expectedSelectionRevision:guard.revision,disposition:{kind:"non_delivery",obligation:identity,
        contract:state.obligation.contract.ref,authorization,inFlightResolution:resolution}}}]);
    await this.store.materialCustody.command({kind:"release",holdId:state.obligation.holdId,basis:request.id});return "disposed";
  }
  private deliveries(prepared:HelarcNativeRunTask,input:Parameters<HelarcNativeTaskDelivery["select"]>[1]){
    const recipient={runId:prepared.binding.scope.runId,recipient:prepared.binding.scope.recipientId,purpose:prepared.binding.scope.purpose.id};
    return helarcNativeTaskResultDeliveries(prepared,input).flatMap(({result,position,contentDigest})=>{
      const content=result.content as {kind?:unknown;output?:{report?:{status?:unknown;reference?:unknown}}}|null;
      if(content?.kind!=="descendant_run"||content.output?.report?.status!=="retained_material")return [];
      const reference=snapshotContextMaterialRef(content.output.report.reference);
      return [{ref:helarcReportDeliveryRef(reference,recipient),position,contentDigest}];
    });
  }
  private state(identity:ProtocolRevisionRef){return this.store.materialDeliveries.query({kind:"obligation",ref:identity}) as Promise<MaterialDeliveryState|null>;}
  private async original(prepared:HelarcNativeRunTask):Promise<ProtocolExecutionState>{
    const state=await this.store.protocolJournal.command({kind:"state",activityId:prepared.binding.scope.activityId}) as ProtocolExecutionState|null;
    const bytes=Buffer.from(JSON.stringify(prepared));
    if(!state||digest(state.activity.scope)!==digest(prepared.binding.scope)||state.input.bytes!==bytes.length||
      state.input.digest!==`sha256:${createHash("sha256").update(bytes).digest("hex")}`)throw new TypeError("report_delivery_original_input_changed");
    return state;
  }
  private async acceptParts(id:string,scope:string,parts:readonly SharedAcceptancePart[]){
    const result=await this.store.sharedAcceptance.accept({id,scope,actor:OWNER,parts});
    if(result.outcome!=="accepted")throw new TypeError(`report_delivery_acceptance_rejected:${result.rejection?.code}`);
  }
}
