import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {readProtocolContent,type ProtocolExecutionState,type ProtocolPurposeAcceptance} from "@agent-anything/agent-runtime/model-access";
import type {SharedAcceptancePart} from "@agent-anything/agent-runtime/activity";
import type {ContextInputUse,ContextInputUsePage,ContextSelectionHeadPage,ContextUseHead} from "@agent-anything/context/selection";
import {acceptHelarcNativeInputReceipt,type HelarcNativeRunTask} from "@agent-anything/helarc/controller";
import type {HelarcExecutionStore} from "../execution-storage/HelarcExecutionStore.js";
import type {HelarcNativeDeliveryResolution} from "../provider/HelarcNativeRetention.js";

const OWNER="context-representation";

/** Completes native task input uses without reviving task execution or removing detail promises. */
export class HelarcNativeInputRetirement {
  constructor(private readonly store:HelarcExecutionStore,
    private readonly resolve:(state:ProtocolExecutionState)=>Promise<HelarcNativeDeliveryResolution|null>=async()=>null){}
  inputs(after:string|null,limit:number):Promise<ContextInputUsePage>{
    return this.store.contextSelections.command({kind:"native_input_uses",owner:OWNER,after,limit}) as Promise<ContextInputUsePage>;
  }
  heads(after:string|null,limit:number):Promise<ContextSelectionHeadPage>{
    return this.store.contextSelections.command({kind:"native_selection_heads",owner:OWNER,after,limit}) as Promise<ContextSelectionHeadPage>;
  }
  async withdraw(head:ContextUseHead):Promise<void>{
    if(head.scope.owner!==OWNER)throw new TypeError("native_selection_retirement_owner_changed");
    if(!head.selection)return;
    const terminal=await this.store.readRunControl(head.scope.runId);
    if(!terminal?.terminal)return;
    const basis=`${head.scope.id}:terminal:${terminal.commitId}`;
    await this.accept(head.scope.runId,[
      {owner:"context_selection",kind:"input_retirement",proposal:{inputIds:[],basis,
        withdrawals:[{scopeId:head.scope.id,expectedSelectionId:head.selection.id,expectedControlRevision:head.control.revision}]}},
      {owner:"material_custody",kind:"holds",proposal:{acquire:[],release:head.selection.holds.map(h=>h.id),basis}}]);
  }
  async retire(discovered:ContextInputUse):Promise<"retired"|"pending">{
    const use=await this.store.contextSelections.command({kind:"input_use",inputId:discovered.input.id}) as ContextInputUse;
    const {input,scope}=use,basis=use.retired??`${input.id}:use-complete`;
    const consumer=input.nativeConsumer;
    if(scope.owner!==OWNER||!consumer)throw new TypeError("native_input_retirement_owner_changed");
    const parts:SharedAcceptancePart[]=[];
    if(use.retired===null){
      const state=await this.store.protocolJournal.command({kind:"state",activityId:input.activityId}) as ProtocolExecutionState|null;
      if(state){
        if(state.activity.scope.runId!==scope.runId||state.contextInput?.id!==input.id||state.contextInput.digest!==input.exactInputDigest||
          state.activity.scope.compositionDigest!==consumer.compositionDigest)throw new TypeError("native_input_retirement_original_changed");
        // Auxiliary method inputs are retired by their method owner, not the task-input owner.
        if(digest(state.activity.scope.purpose)!==digest(state.activity.composition.composition.task.purpose))return "pending";
        if(!use.settled){
          if(!state.cancelled||!state.retentionReleased)return "pending";
          const disposition=await this.resolve(state);
          if(!disposition?.resolved)return "pending";
          const refreshed=await this.store.contextSelections.command({kind:"input_use",inputId:input.id}) as ContextInputUse;
          if(!refreshed.settled)return "pending";
        }
        if(state.accepted){
          const receipt=await this.store.sharedAcceptance.query(`${input.id}:purpose-received`);
          if(receipt?.outcome==="rejected")throw new TypeError("native_input_receipt_previously_rejected");
          if(!receipt){
            const accepted=await this.store.protocolJournal.command({kind:"acceptance",activityId:input.activityId}) as ProtocolPurposeAcceptance|null;
            if(!accepted||digest(accepted.evidence.acceptance)!==digest(state.accepted))throw new TypeError("native_input_original_receipt_missing");
            const prepared=JSON.parse((await readProtocolContent(this.store.protocolJournal,state.input,input.activityId,32*1024*1024)).toString()) as HelarcNativeRunTask;
            if(prepared.format!=="helarc.native-prepared-task.v1"||prepared.selectedInputId!==input.id)throw new TypeError("native_input_original_task_missing");
            await acceptHelarcNativeInputReceipt(prepared,accepted,{journal:this.store.protocolJournal,acceptance:this.store.sharedAcceptance,selections:this.store.contextSelections});
          }
        }else{
          if(!state.inputRefusal&&!state.retentionReleased)return "pending";
          if(state.inputRefusal){
            const released=await this.store.sharedAcceptance.query(`${input.activityId}:refused-input-selection`);
            if(released?.outcome!=="accepted")return "pending";
          }else if(input.deliveries.length)parts.push({owner:"context_delivery",kind:"release_selection",proposal:{inputId:input.id,basis}});
        }
      }else{
        if(!use.settled)return "pending";
        if(use.claimed!==false||use.currentSelectionId===input.selectionId)return "pending";
        if(input.deliveries.length)parts.push({owner:"context_delivery",kind:"release_selection",proposal:{inputId:input.id,basis}});
      }
      parts.push({owner:"context_selection",kind:"input_retirement",proposal:{inputIds:[input.id],withdrawals:[],basis}});
    }
    if(input.holds.some(h=>h.responsibility!=="input"||h.basis!==input.id))throw new TypeError("native_input_retirement_hold_changed");
    if(new Set(use.liveHoldIds).size!==use.liveHoldIds.length||use.liveHoldIds.some(id=>!input.holds.some(hold=>hold.id===id)))
      throw new TypeError("native_input_retirement_live_hold_changed");
    if(use.liveHoldIds.length)parts.push({owner:"material_custody",kind:"holds",proposal:{acquire:[],release:use.liveHoldIds,basis}});
    if(!parts.length)return "retired";
    await this.accept(scope.runId,parts);return "retired";
  }
  private async accept(scope:string,parts:readonly SharedAcceptancePart[]):Promise<void>{
    const proposal={scope,actor:OWNER,parts},receipt=await this.store.sharedAcceptance.accept({id:`native-input-retirement:${digest(proposal)}`,...proposal});
    if(receipt.outcome!=="accepted")throw new TypeError(`native_input_retirement_rejected:${receipt.rejection?.code}`);
  }
}
