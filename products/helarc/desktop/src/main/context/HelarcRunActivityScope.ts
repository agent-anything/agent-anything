import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import type {ActivityPurposeHandler} from "@agent-anything/agent-runtime/activity";
import type {RunCommit} from "@agent-anything/agent-runtime/execution-coordinator";
import type {HelarcExecutionStore} from "../execution-storage/HelarcExecutionStore.js";
import type {HelarcActivityHost} from "./HelarcRunActivityComposition.js";
import type {HelarcActivityBindings} from "./HelarcActivityBindings.js";

/** Shared tree authority and activation. Professional paths retain their own purposes and progress. */
export function createHelarcRunActivityScope(input:{
  rootRunId:string;store:HelarcExecutionStore;host:HelarcActivityHost;contextId:string;
  modelPoolId:string;composition:{id:string;revision:string;modelPoolCapacity:number;localPoolCapacity:number};
}){
  const {rootRunId,store,host,modelPoolId,composition}=input;
  const scopeId=`helarc-tree:${rootRunId}`,localPoolId="helarc-local-materials";
  const permissionBasis=`helarc-activity:${digest({rootRunId,context:input.contextId,modelPoolId,composition})}`;
  const members=new Map<string,RunCommit>();
  let active=false,prepared=false,retired=false,intent:"settle"|"continue"|"cancel"="settle";
  async function original(runId:string){
    let member=members.get(runId);
    if(!member){
      member=await store.readRunCommit(`${runId}:commit:0`)??undefined;
      if(!member?.admission||member.state.run.id!==runId||member.admission.lineage.root.id!==rootRunId)
        throw new TypeError("helarc_activity_original_membership_unavailable");
      members.set(runId,member);
    }
    return member;
  }
  const hostPort={assertAvailable:()=>{host.service.assertAvailable();if(!active)throw new TypeError("helarc_activity_binding_not_activated");},
    subscribe:(listener:()=>void,interest?:import("@agent-anything/agent-runtime/activity").ActivityChangeInterest)=>store.onActivityChange(listener,interest),wake:()=>host.service.wake()};
  type Authorize=ActivityPurposeHandler["authorize"];
  const withOriginalScope=(owner:Authorize,continuesCapture=false):Authorize=>async(path,stage,signal,action)=>{
    const starts=action==="admission"||action==="execution"||continuesCapture&&!path.cancelled&&
      (action==="reconciliation"||action==="interpretation");
    signal.throwIfAborted();host.service.assertAvailable(starts?"progression":"settlement");
    if(!active)throw new TypeError("helarc_activity_binding_not_activated");
    if(path.intent.permissionBasis!==permissionBasis)throw new TypeError("helarc_activity_permission_basis_changed");
    await original(path.intent.runId);signal.throwIfAborted();
    if(intent==="settle"&&starts)return {kind:"temporary",code:"helarc_recovery_continue_required",
      message:"Original response reconciliation is available; new execution is waiting for an explicit continuation."};
    if(intent==="cancel"&&(action==="execution"||continuesCapture&&starts))return {kind:"denied",code:"helarc_recovery_cancel_requested",message:"Recovery was authorized for cancellation, not new execution.",
      decision:{owner:"helarc-host",id:rootRunId,revision:"cancel"}};
    return owner(path,stage,signal,action);
  };
  const authorize=withOriginalScope(async(path,_stage,_signal,action)=>{
    if(action==="admission"||action==="execution"){
      const current=await store.readRunControl(path.intent.runId);
      if(!current)throw new TypeError("helarc_activity_current_control_unavailable");
      if(current.terminal||current.cancelled)return {kind:"denied",code:"helarc_run_progression_closed",
        message:"The original Run no longer permits new execution.",decision:{owner:"runtime",id:current.commitId,revision:String(current.revision)}};
    }
    return {kind:"allowed"};
  });
  return {scopeId,modelPoolId,localPoolId,permissionBasis,original,host:hostPort,authorize,
    authorizeLocalHandoff:(owner:Authorize)=>withOriginalScope(owner,true),
    assertNewDeliveryAllowed(){hostPort.assertAvailable();if(intent!=="continue")throw new TypeError("helarc_recovery_continue_required");},
    async deadline(runId:string){const member=await original(runId);return new Date(Date.parse(member.state.startedAt)+member.admission!.config.limits.maxDurationMs).toISOString();},
    async prepareActivation(){
      if(retired)throw new TypeError("helarc_activity_scope_retired");
      if(prepared)return;host.service.assertAvailable();
      if((await store.readProductRun(rootRunId))?.contextBinding.id!==input.contextId)throw new TypeError("helarc_activity_original_admission_missing");
      for(const [id,capacity]of [[modelPoolId,composition.modelPoolCapacity],[localPoolId,composition.localPoolCapacity]] as const)
        await store.activityHandoffs.command({kind:"bind_resource_pool",pool:{id,capacity,revision:"1",authority:"helarc.activity-host.v1"}});
      prepared=true;
    },
    activate(registered:Parameters<HelarcActivityBindings["bind"]>[1],next:"settle"|"continue"|"cancel"="continue"){
      if(retired)throw new TypeError("helarc_activity_scope_retired");
      if(active){
        if(intent==="cancel"&&next!=="cancel")throw new TypeError("helarc_cancelled_binding_cannot_continue");
        if(next!=="settle")intent=next;host.service.wake();return;
      }
      if(!prepared)throw new TypeError("helarc_activity_activation_unprepared");
      host.service.assertAvailable();intent=next;host.bindings.bind(rootRunId,registered);active=true;host.service.wake();
    },
    async retire():Promise<boolean>{
      if(retired)return true;
      const controls=await store.readTreeControl(rootRunId);
      if(!controls.length||controls.some(value=>!value.terminal))return false;
      for(const control of controls){
        if(host.service.scopeIdle?.(control.runId)!==true)return false;
        const obligations=await store.activityHandoffs.command({kind:"scope_obligations",runId:control.runId}) as
          {runId:string;pendingHandoffs:number;openSubscriptions:number};
        if(obligations.pendingHandoffs||obligations.openSubscriptions)return false;
        let after:string|null=null;
        do{
          const page=await store.protocolJournal.command({kind:"retention_page",runId:control.runId,after,limit:32}) as
            {states:readonly import("@agent-anything/agent-runtime/model-access").ProtocolExecutionState[];next:string|null};
          if(page.states.some(state=>!state.retentionReleased))return false;
          after=page.next;
        }while(after!==null);
      }
      if(controls.some(value=>host.service.scopeIdle?.(value.runId)!==true))return false;
      for(const control of controls)host.service.forgetIdleScope?.(control.runId);
      host.bindings.unbind(rootRunId,permissionBasis);active=false;retired=true;members.clear();return true;
    },
    async authorizeNative(runId:string,mode:"local"|"dispatch",signal:AbortSignal){
      signal.throwIfAborted();host.service.assertAvailable(mode==="local"?"settlement":"progression");
      if(!active)throw new TypeError("helarc_activity_binding_not_activated");
      await original(runId);
      if(mode==="dispatch"&&intent!=="continue")throw new TypeError("helarc_native_progression_not_authorized");
      if(mode==="dispatch"){
        const current=await store.readRunControl(runId);
        if(!current||current.terminal||current.cancelled)throw new TypeError("helarc_native_run_progression_closed");
      }
    }};
}
