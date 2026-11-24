import type {ProtocolReconciliationHandoff,ProtocolRetentionStatus} from "@agent-anything/agent-runtime/model-access";
import {OPENAI_RESPONSES_ADAPTER} from "@agent-anything/provider-integrations/native";
import type {HelarcExecutionStore} from "../execution-storage/HelarcExecutionStore.js";
import {reportExecutionFailure, type ExecutionDiagnosticSink} from "../diagnostics/HelarcExecutionDiagnostics.js";
import type {ProviderConfigurationService} from "./ProviderConfigurationService.js";
import {HelarcResponsesPurposeObserver} from "./HelarcResponsesPurposeObserver.js";
import {HelarcChatPurposeObserver} from "./HelarcChatPurposeObserver.js";
import {ProviderConnectionRetention} from "./ProviderConnectionRetention.js";
import {helarcConnectionActivityId,helarcConnectionCustodyEvidence} from "./HelarcConnectionCustodyEvidence.js";
import {HelarcNativeReportDelivery} from "../context/HelarcNativeReportDelivery.js";
import {HelarcNativeInputRetirement} from "../context/HelarcNativeInputRetirement.js";
import {driveNativeFollowUpPages,type NativeFollowUpPage} from "./HelarcNativeFollowUpScheduling.js";
import {measureExecutionAsync} from "../diagnostics/ExecutionPerformance.js";

/** Drives accepted receiver obligations, never a Run or a new task request. */
export class HelarcNativeFollowUpService {
  private readonly abort = new AbortController();
  private readonly responses: HelarcResponsesPurposeObserver;
  private readonly chats:HelarcChatPurposeObserver;
  private readonly retention:ProviderConnectionRetention;
  private retentionCursor="";
  private deliveryCursor:string|null=null;
  private readonly reports:HelarcNativeReportDelivery;
  private readonly inputs:HelarcNativeInputRetirement;
  private inputCursor:string|null=null;
  private selectionCursor:string|null=null;
  private reconciliationCursor:string|null=null;
  private readonly completion: Promise<void>;
  private readonly failures = new Map<string, string>();

  constructor(private readonly store: HelarcExecutionStore, private readonly providers: ProviderConfigurationService,
    private readonly diagnostics?: ExecutionDiagnosticSink,private readonly retired:()=>void=()=>{},
    private readonly retireLocal:()=>Promise<NativeFollowUpPage>=async()=>({examined:0,more:false})) {
    this.responses = new HelarcResponsesPurposeObserver(store, providers);
    this.chats=new HelarcChatPurposeObserver(store,providers);
    this.retention=new ProviderConnectionRetention(providers,helarcConnectionCustodyEvidence(store));
    const settleInputUse=(state:import("@agent-anything/agent-runtime/model-access").ProtocolExecutionState)=>{
      const protocol=state.activity.composition.composition.protocol.id;
      if(protocol==="openai.responses")return this.responses.settleInputUse(state);
      if(protocol==="ollama.chat"||protocol==="deepseek.chat-completions")return this.chats.settleInputUse(state);
      throw new TypeError("native_delivery_resolution_protocol_unavailable");
    };
    this.reports=new HelarcNativeReportDelivery(store,settleInputUse);
    this.inputs=new HelarcNativeInputRetirement(store,settleInputUse);
    const lanes:[string,()=>Promise<NativeFollowUpPage>][]=[
      ["native_reconciliation",()=>this.reconcilePage()],
      ["connection_custody",()=>this.retirePage()],
      ["selection_withdrawal",()=>this.withdrawSelections()],
      ["input_use",()=>this.retireInputs()],
      ["recipient_delivery",()=>this.recoverDeliveries()],
      ["local_participants",()=>this.retireLocal()],
    ];
    this.completion=Promise.all(lanes.map(async([owner,page])=>{
      try{await driveNativeFollowUpPages({owner,page,signal:this.abort.signal,diagnostics});}
      catch(error){if(!this.abort.signal.aborted)reportExecutionFailure(diagnostics,"native_follow_up_scheduler",{responsibility:owner},error);}
    })).then(()=>{});
  }

  private async reconcilePage(): Promise<NativeFollowUpPage> {
      const page=await measureExecutionAsync(this.diagnostics,"native_follow_up.discover",{
        responsibility:"native_reconciliation",cursor:this.reconciliationCursor},()=>this.store.protocolJournal.command({kind:"reconciliation_list",
          receiver:OPENAI_RESPONSES_ADAPTER.id,after:this.reconciliationCursor,limit:16})) as readonly ProtocolReconciliationHandoff[];
      for (const handoff of page) {
        this.abort.signal.throwIfAborted();
        if (handoff.dueAt > Date.now()) continue;
        try {
          await measureExecutionAsync(this.diagnostics,"native_follow_up.reconcile",{
            activityId:handoff.activityId,handoffId:handoff.id},()=>this.responses.reconcile(handoff, this.abort.signal, async operation => {
            this.abort.signal.throwIfAborted();
            if (operation === "create") throw new TypeError("native_follow_up_cannot_generate");
            // The native owner rechecks the original handoff, current fence and
            // retained connection on every operation. No Run resurrection here.
          },1));
          this.failures.delete(handoff.id);
        } catch (error) {
          if (this.abort.signal.aborted) throw error;
          const message = error instanceof Error ? error.message : String(error);
          if (this.failures.get(handoff.id) !== message) reportExecutionFailure(this.diagnostics,
            "native_follow_up_blocked", {activityId:handoff.activityId, handoffId:handoff.id, receiver:handoff.receiver}, error);
          this.rememberFailure(handoff.id,message);
        }
      }
      this.reconciliationCursor=page.length===16?page.at(-1)!.id:null;
      return {examined:page.length,more:this.reconciliationCursor!==null};
  }

  private async withdrawSelections():Promise<NativeFollowUpPage>{
    const heads=await measureExecutionAsync(this.diagnostics,"native_follow_up.discover",{
      responsibility:"selection_withdrawal",cursor:this.selectionCursor},()=>this.inputs.heads(this.selectionCursor,16));
    for(const head of heads.entries)await this.inputRetirementStep(`selection:${head.scope.id}`,head.scope.runId,()=>this.inputs.withdraw(head));
    this.selectionCursor=heads.next;
    return {examined:heads.entries.length,more:heads.next!==null};
  }
  private async retireInputs():Promise<NativeFollowUpPage>{
    const page=await measureExecutionAsync(this.diagnostics,"native_follow_up.discover",{
      responsibility:"input_use",cursor:this.inputCursor},()=>this.inputs.inputs(this.inputCursor,16));
    for(const input of page.entries)await this.inputRetirementStep(`input:${input.input.id}`,input.scope.runId,()=>this.inputs.retire(input));
    this.inputCursor=page.next;
    return {examined:page.entries.length,more:page.next!==null};
  }
  private async inputRetirementStep(id:string,runId:string,work:()=>Promise<unknown>):Promise<void>{
    this.abort.signal.throwIfAborted();
    try{await measureExecutionAsync(this.diagnostics,"native_follow_up.input_disposition",{runId,responsibilityId:id},work);this.failures.delete(id);}
    catch(error){
      if(this.abort.signal.aborted)throw error;
      const message=error instanceof Error?error.message:String(error);
      if(this.failures.get(id)!==message)reportExecutionFailure(this.diagnostics,"native_input_retirement_blocked",{runId,responsibilityId:id},error);
      this.rememberFailure(id,message);
    }
  }

  private async recoverDeliveries():Promise<NativeFollowUpPage>{
    const page=await measureExecutionAsync(this.diagnostics,"native_follow_up.discover",{
      responsibility:"recipient_delivery",cursor:this.deliveryCursor},()=>this.reports.pending(this.deliveryCursor,16));
    for(const state of page.entries){
      this.abort.signal.throwIfAborted();
      const identity=state.obligation.ref,key=`delivery:${identity.id}`;
      try{
        const outcome=await measureExecutionAsync(this.diagnostics,"native_follow_up.delivery_disposition",{
          runId:state.obligation.recipient.runId,obligationId:identity.id},()=>this.reports.recoverDisposition(identity));
        if(outcome==="unresolved"){
          const basis=JSON.stringify({protection:state.protection,discharged:state.discharged});
          if(this.failures.get(key)!==basis)reportExecutionFailure(this.diagnostics,"native_report_delivery_unresolved",
            {runId:state.obligation.recipient.runId,obligationId:identity.id,holdId:state.obligation.holdId},new Error("Original delivery still requires reconciliation; protection retained"));
          this.rememberFailure(key,basis);
        }else this.failures.delete(key);
      }catch(error){
        if(this.abort.signal.aborted)throw error;
        const message=error instanceof Error?error.message:String(error);
        if(this.failures.get(key)!==message)reportExecutionFailure(this.diagnostics,"native_report_delivery_recovery",
          {runId:state.obligation.recipient.runId,obligationId:identity.id},error);
        this.rememberFailure(key,message);
      }
    }
    this.deliveryCursor=page.next;
    return {examined:page.entries.length,more:page.next!==null};
  }

  private async retirePage():Promise<NativeFollowUpPage>{
    const pins=await measureExecutionAsync(this.diagnostics,"native_follow_up.discover",{
      responsibility:"connection_custody",cursor:this.retentionCursor},()=>this.providers.pins(this.retentionCursor,16));
    for(const pin of pins){
      this.abort.signal.throwIfAborted();
      if(pin.state==="released")continue;
      try{
        const id=helarcConnectionActivityId(pin);
        if(id){
          const status=await this.store.protocolJournal.command({kind:"retention_status",activityId:id}) as ProtocolRetentionStatus|null;
          if(status&&!status.state.retentionReleased&&!status.pendingEffects&&!status.pendingDeliveries&&!status.pendingHandoffs&&
            (status.state.accepted||status.state.cancelled||status.unavailableObservation)){
            const protocol=status.state.activity.composition.composition.protocol.id;
            if(protocol==="openai.responses")await this.responses.retire(status.state,status.unavailableObservation);
            else if(protocol==="ollama.chat"||protocol==="deepseek.chat-completions")await this.chats.retire(status.state);
          }
        }
        await measureExecutionAsync(this.diagnostics,"native_follow_up.connection_disposition",{pinId:pin.id},()=>this.retention.reconcile(pin));
        if((await this.providers.readPin(pin.id))?.state==="released")this.retired();
        this.failures.delete(`retirement:${pin.id}`);
      }catch(error){
        if(this.abort.signal.aborted)throw error;
        const key=`retirement:${pin.id}`,message=error instanceof Error?error.message:String(error);
        if(this.failures.get(key)!==message)reportExecutionFailure(this.diagnostics,"native_retirement_blocked",{pinId:pin.id},error);
        this.rememberFailure(key,message);
      }
    }
    this.retentionCursor=pins.length===16?pins.at(-1)!.id:"";
    return {examined:pins.length,more:pins.length===16};
  }

  private rememberFailure(id:string,message:string):void{
    this.failures.set(id,message);
    if(this.failures.size>256)this.failures.delete(this.failures.keys().next().value!);
  }

  async close(): Promise<void> {
    this.abort.abort(new Error("native_follow_up_host_shutdown"));
    await this.completion;
    try{await this.responses.close();}finally{await this.chats.close();}
  }
}
