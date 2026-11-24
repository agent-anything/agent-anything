import type {Provider} from "@agent-anything/model-interaction";
import type {HelarcExecutionStore} from "../execution-storage/HelarcExecutionStore.js";
import type {HelarcExecutionAdmission} from "../execution-storage/HelarcExecutionAdmission.js";
import {originalPreparationLimitation} from "../execution-storage/HelarcExecutionAdmissionValidation.js";
import {validateHelarcNativeContextRunBinding} from "../context/HelarcNativeContextRunBinding.js";
import {prepareHelarcHostRun,type PreparedHelarcHostRun,type PrepareHelarcHostRunInput} from "./HelarcHostRunComposition.js";

type RecoveryPorts=Pick<PrepareHelarcHostRunInput,"activityHost"|"commandOutputDirectory"|"inspection"|
  "contextManifestPersistence"|"runTranscriptPort"|"sessionAuthorityPort"|"persistentPolicyAmendments"|"connectionRetention"> & {
  readonly executionStore:HelarcExecutionStore;
  readonly recoverProvider:(saved:HelarcExecutionAdmission)=>Promise<Provider>;
  readonly recoverNative?:(saved:Extract<HelarcExecutionAdmission,{version:4}>)=>Promise<import("./HelarcNativeHostArrangement.js").HelarcNativeHostArrangement>;
  readonly retainCommandOutput?:(saved:HelarcExecutionAdmission)=>PrepareHelarcHostRunInput["retainCommandOutput"];
};

/** Application-owned original compositions, not task continuation or a second activity driver. */
export class HelarcHostRunRecovery {
  private readonly originals=new Map<string,Promise<PreparedHelarcHostRun>>();
  private readonly nativeOriginals=new Map<string,Promise<import("./HelarcNativeHostArrangement.js").HelarcNativeHostArrangement>>();
  private readonly scopes=new Map<string,Promise<void>>();
  private readonly readyCompositions=new Map<string,PreparedHelarcHostRun>();
  constructor(private readonly ports:RecoveryPorts) {}
  forgetRetired(rootRunId:string):void {
    this.originals.delete(rootRunId);this.nativeOriginals.delete(rootRunId);
    this.scopes.delete(rootRunId);this.readyCompositions.delete(rootRunId);
  }
  retain(prepared:PreparedHelarcHostRun):void {
    if(this.originals.has(prepared.rootRunId))throw new TypeError("host_original_composition_already_retained");
    this.originals.set(prepared.rootRunId,Promise.resolve(prepared));
    this.readyCompositions.set(prepared.rootRunId,prepared);
  }
  async restoreScope(runId:string):Promise<void> {
    const initial=await this.ports.executionStore.readRunCommit(`${runId}:commit:0`);
    if(!initial?.admission||initial.state.run.id!==runId)throw new TypeError("host_original_run_admission_unavailable");
    const rootRunId=initial.admission.lineage.root.id;
    let pending=this.scopes.get(rootRunId);
    if(!pending){
      pending=this.restoreOriginalScope(rootRunId);
      this.scopes.set(rootRunId,pending);
      void pending.catch(()=>{if(this.scopes.get(rootRunId)===pending)this.scopes.delete(rootRunId);});
    }
    await pending;
  }
  private async restoreOriginalScope(rootRunId:string):Promise<void>{
    const ready=this.readyCompositions.get(rootRunId);
    if(ready){ready.restoreActivityResponsibilities();return;}
    const saved=await this.ports.executionStore.readProductRun(rootRunId);
    if(!saved)throw new TypeError("host_original_product_admission_unavailable");
    if(saved.version===4){
      await this.requireOriginalPreparation(saved,"restore_activity_scope");
      const context=saved.contextBinding;
      validateHelarcNativeContextRunBinding(context);
      const native=await this.native(saved);
      const activities=native.compose({rootRunId,store:this.ports.executionStore,host:this.ports.activityHost,
        context,deliveryMode:saved.responseDelivery,now:()=>new Date().toISOString()});
      activities.restoreCompositions(saved.model);
      await activities.prepareActivation();
      activities.activate("settle");
      return;
    }
    (await this.prepare(rootRunId)).restoreActivityResponsibilities();
  }
  private async requireOriginalPreparation(saved:HelarcExecutionAdmission,action:"restore_activity_scope"|"restore_task_composition") {
    const limitation=originalPreparationLimitation(saved);
    if(!limitation)return;
    const head=await this.ports.executionStore.readRunControl(saved.rootRunId);
    this.ports.inspection?.recordRecoveryBindingCheck({runId:saved.rootRunId,outcome:"rejected",code:limitation.code,
      component:limitation.component,changedVariableNames:[],action,bindingId:saved.contextBinding.id,limitation,
      ...(head?{checkpoint:{id:head.commitId,revision:head.revision}}:{})});
    throw Object.assign(new Error(`The original ${limitation.component.replaceAll("_"," ")} is unavailable (required ${limitation.required}; installed ${limitation.available}). Retained work was not replayed.`),
      {code:limitation.code,action,limitation});
  }
  private native(saved:Extract<HelarcExecutionAdmission,{version:4}>){
    let value=this.nativeOriginals.get(saved.rootRunId);
    if(!value){
      if(!this.ports.recoverNative)throw new TypeError("host_original_native_composition_unavailable");
      value=this.ports.recoverNative(saved);this.nativeOriginals.set(saved.rootRunId,value);
      const original=value;
      void value.catch(()=>{if(this.nativeOriginals.get(saved.rootRunId)===original)this.nativeOriginals.delete(saved.rootRunId);});
    }
    return value;
  }
  prepare(rootRunId:string):Promise<PreparedHelarcHostRun> {
    const retained=this.originals.get(rootRunId);if(retained)return retained;
    const pending=this.compose(rootRunId).then(prepared=>{this.readyCompositions.set(rootRunId,prepared);return prepared;});
    this.originals.set(rootRunId,pending);
    void pending.catch(()=>{if(this.originals.get(rootRunId)===pending)this.originals.delete(rootRunId);});
    return pending;
  }
  private async compose(rootRunId:string):Promise<PreparedHelarcHostRun> {
    const saved=await this.ports.executionStore.readProductRun(rootRunId);
    if(!saved||saved.rootRunId!==rootRunId)throw new TypeError("host_original_product_admission_unavailable");
    await this.requireOriginalPreparation(saved,"restore_task_composition");
    const common={...this.ports,
      retainCommandOutput:this.ports.retainCommandOutput?.(saved),responseDelivery:saved.responseDelivery,
      instructionSettings:saved.instructionSettings,task:saved.task,inputItems:saved.inputItems,
      sessionId:saved.sessionId,productRunId:saved.productRunId,
      workspaceResolver:{async resolve(){return saved.workspace;}},
      workspaceSelection:{kind:"references" as const,primaryRef:saved.workspace.primary.id,additionalRefs:saved.workspace.additional.map(root=>root.id)},
      identityResolver:{async resolve(){return saved.identity;}},
      identitySelection:saved.identity.kind==="anonymous"?{kind:"anonymous" as const}:{kind:"reference" as const,identityRef:saved.identity.id},
      permissionPreset:saved.permissionPreset,enforcement:saved.enforcement,
      runLimits:saved.runLimits,runTreeLimits:saved.runTreeLimits,commandLimits:saved.commandLimits??undefined};
    if(saved.version===4){
      if(!this.ports.recoverNative)throw new TypeError("host_original_native_composition_unavailable");
      return prepareHelarcHostRun({...common,recoveryAdmission:saved,native:await this.native(saved)});
    }
    return prepareHelarcHostRun({...common,recoveryAdmission:saved,provider:await this.ports.recoverProvider(saved),providerProfile:saved.providerProfile});
  }
}
