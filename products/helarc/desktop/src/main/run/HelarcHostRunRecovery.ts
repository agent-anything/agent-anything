import type {Provider} from "@agent-anything/model-interaction";
import type {HelarcExecutionStore} from "../execution-storage/HelarcExecutionStore.js";
import type {HelarcExecutionAdmission} from "../execution-storage/HelarcExecutionAdmission.js";
import {prepareHelarcHostRun,type PreparedHelarcHostRun,type PrepareHelarcHostRunInput} from "./HelarcHostRunComposition.js";

type RecoveryPorts=Pick<PrepareHelarcHostRunInput,"activityHost"|"commandOutputDirectory"|"inspection"|
  "contextManifestPersistence"|"runTranscriptPort"|"sessionAuthorityPort"|"persistentPolicyAmendments"> & {
  readonly executionStore:HelarcExecutionStore;
  readonly recoverProvider:(saved:HelarcExecutionAdmission)=>Promise<Provider>;
  readonly retainCommandOutput?:(saved:HelarcExecutionAdmission)=>PrepareHelarcHostRunInput["retainCommandOutput"];
};

/** Application-owned original compositions, not task continuation or a second activity driver. */
export class HelarcHostRunRecovery {
  private readonly originals=new Map<string,Promise<PreparedHelarcHostRun>>();
  constructor(private readonly ports:RecoveryPorts) {}
  retain(prepared:PreparedHelarcHostRun):void {
    if(this.originals.has(prepared.rootRunId))throw new TypeError("host_original_composition_already_retained");
    this.originals.set(prepared.rootRunId,Promise.resolve(prepared));
  }
  async restoreScope(runId:string):Promise<void> {
    const initial=await this.ports.executionStore.readRunCommit(`${runId}:commit:0`);
    if(!initial?.admission||initial.state.run.id!==runId)throw new TypeError("host_original_run_admission_unavailable");
    const prepared=await this.prepare(initial.admission.lineage.root.id);
    prepared.restoreActivityResponsibilities();
  }
  prepare(rootRunId:string):Promise<PreparedHelarcHostRun> {
    const retained=this.originals.get(rootRunId);if(retained)return retained;
    const pending=this.compose(rootRunId);
    this.originals.set(rootRunId,pending);
    void pending.catch(()=>{if(this.originals.get(rootRunId)===pending)this.originals.delete(rootRunId);});
    return pending;
  }
  private async compose(rootRunId:string):Promise<PreparedHelarcHostRun> {
    const saved=await this.ports.executionStore.readProductRun(rootRunId);
    if(!saved||saved.rootRunId!==rootRunId)throw new TypeError("host_original_product_admission_unavailable");
    const provider=await this.ports.recoverProvider(saved);
    return prepareHelarcHostRun({...this.ports,recoveryAdmission:saved,provider,
      retainCommandOutput:this.ports.retainCommandOutput?.(saved),responseDelivery:saved.responseDelivery,
      instructionSettings:saved.instructionSettings,task:saved.task,inputItems:saved.inputItems,
      sessionId:saved.sessionId,productRunId:saved.productRunId,
      workspaceResolver:{async resolve(){return saved.workspace;}},
      workspaceSelection:{kind:"references",primaryRef:saved.workspace.primary.id,additionalRefs:saved.workspace.additional.map(root=>root.id)},
      identityResolver:{async resolve(){return saved.identity;}},
      identitySelection:saved.identity.kind==="anonymous"?{kind:"anonymous"}:{kind:"reference",identityRef:saved.identity.id},
      providerProfile:saved.providerProfile,permissionPreset:saved.permissionPreset,enforcement:saved.enforcement,
      runLimits:saved.runLimits,runTreeLimits:saved.runTreeLimits,commandLimits:saved.commandLimits??undefined});
  }
}
