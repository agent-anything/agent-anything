import {HelarcActivityBindings} from "./HelarcActivityBindings.js";
import {HelarcActivityService,type HelarcActivityServiceOptions} from "./HelarcActivityService.js";
import {HELARC_ACTIVITY_PURPOSES} from "./HelarcContextRunBinding.js";
import type {HelarcExecutionStore} from "../execution-storage/HelarcExecutionStore.js";

/** Application lifetime, independently of a window, task wait or professional path. */
export function createHelarcActivityHost(store:HelarcExecutionStore,
  options:Pick<HelarcActivityServiceOptions,"diagnostics"|"rediscoveryMs"|"report">={}) {
  const roots=new Map<string,string>();
  let restore:((runId:string)=>Promise<void>)|undefined;
  const bindings=new HelarcActivityBindings(async runId=>{
    const retained=roots.get(runId);if(retained)return retained;
    const initial=await store.readRunCommit(`${runId}:commit:0`);
    if(!initial)return null;
    if(!initial.admission||initial.state.run.id!==runId)throw new TypeError("activity_initial_run_binding_invalid");
    const root=initial.admission.lineage.root.id;
    roots.set(runId,root);
    if(roots.size>512)roots.delete(roots.keys().next().value!);
    return root;
  });
  const service=new HelarcActivityService({store,...options,purposes:bindings,purposeIds:HELARC_ACTIVITY_PURPOSES.map(p=>p.ref.id),
    scopeAvailable:async runId=>{
      if(await bindings.available(runId))return true;
      if(restore)await restore(runId);
      return bindings.available(runId);
    },reconsideration:(owner,subscription)=>bindings.reconsideration(owner,subscription)});
  return {bindings,service,setRecoveryResolver(resolver:(runId:string)=>Promise<void>){
    if(restore)throw new TypeError("activity_recovery_resolver_already_bound");restore=resolver;service.wake();
  }};
}
