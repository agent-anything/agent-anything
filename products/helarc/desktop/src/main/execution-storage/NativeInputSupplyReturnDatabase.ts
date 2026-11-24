import {confirmNativeInputSupplyReturn,type NativeInputSupplyReturn,type NativeInputSupplySelection} from "@agent-anything/agent-runtime/context-representation";
import type {SharedAcceptanceProposal} from "@agent-anything/agent-runtime/activity";
import {contextProcessObject as object,contextProcessRelationship as relation} from "@agent-anything/context/evidence";
import type {InputSupplyPaths} from "./InputSupplyExitDatabase.js";
import type {ContextFoundationRecords} from "./ContextFoundationRecords.js";
import {SharedAcceptanceRejection} from "./SharedAcceptanceDatabase.js";

/** Confirms the atomic handoff. The original need, selection and Stage remain the authorities. */
export class NativeInputSupplyReturnDatabase {
  constructor(private readonly records:ContextFoundationRecords,private readonly paths:InputSupplyPaths,
    private readonly selection:(id:string)=>NativeInputSupplySelection|null) {}
  validate(value:NativeInputSupplyReturn,acceptance:SharedAcceptanceProposal):NativeInputSupplySelection {
    const need=this.paths.need(value.needId),source=this.paths.stage(value.origin.requestId);
    const ready=this.paths.stage(value.readyStageId),path=need?this.paths.path(need.stage.pathId):null;
    const selected=this.selection(value.inputId);
    if(!need||!source||!ready||!path||!selected||selected.acceptanceId!==acceptance.id||
      selected.scope.runId!==acceptance.scope||selected.scope.owner!==acceptance.actor)
      throw new SharedAcceptanceRejection("context_input_supply","native_input_return_unconfirmed");
    try {confirmNativeInputSupplyReturn(value,{need,source,path,scope:selected.scope,input:selected.input,ready:ready.request});}
    catch {throw new SharedAcceptanceRejection("context_input_supply","native_input_return_changed");}
    if(!acceptance.parts.some(p=>p.owner==="activity"&&p.kind==="stage_submission"&&
      (p.proposal as {id?:string})?.id===ready.request.id)||
      !acceptance.parts.some(p=>p.owner==="context_selection"&&p.kind==="selection_input"&&
      (p.proposal as {input?:{id?:string}})?.input?.id===selected.input.id))
      throw new SharedAcceptanceRejection("context_input_supply","native_input_return_not_joint");
    return selected;
  }
  record(value:NativeInputSupplyReturn,acceptance:SharedAcceptanceProposal):void {
    const subject=object("context_input_supply",value.needId,acceptance.scope);
    this.records.fact(acceptance.scope,"context_input_supply",value.needId,"native_input_returned",{...value,acceptanceId:acceptance.id},
      {revision:"1",category:"responsibility",subject,state:{phase:"settled",status:"native_input_returned"},related:[],relationships:[
        ...[value.origin.requestId,value.origin.receiptId,value.readyStageId].map(id=>relation("observes",subject,object("activity",id,acceptance.scope))),
        relation("delivers",subject,object("context_selection",value.inputId,acceptance.scope),"input_ready"),
        relation("settles",object("shared_acceptance",acceptance.id,acceptance.scope),subject),
      ]});
  }
}
