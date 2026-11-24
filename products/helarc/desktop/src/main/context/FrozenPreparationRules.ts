import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {INITIAL_CONTEXT_PREPARATION_POLICY as installed} from "@agent-anything/agent-runtime/context-representation";
import {validateActivityPurpose,type ActivityPurposeContract} from "@agent-anything/agent-runtime/activity";
import type {RecoveryBindingLimitation} from "../../shared/HelarcExecutionRecovery.js";

interface FrozenRules {
  readonly policy:{readonly id:string; readonly revision:string};
  readonly purposes:readonly ActivityPurposeContract[];
  readonly methodComparisonRevision?:string;
}

/** Historical payloads can identify their policy without implementing today's policy shape. */
export type RetainedPreparation<T> = Omit<T,"policy"|"methodComparisonRevision"> & Pick<FrozenRules,"policy"|"methodComparisonRevision">;

export function validateFrozenPreparationRules(value:FrozenRules):void {
  const token=(s:unknown)=>typeof s==="string" && s.length>0 && s.length<=2048 && s===s.trim();
  if(!token(value.policy?.id)||!token(value.policy.revision)||!Array.isArray(value.purposes)||
     (value.methodComparisonRevision!==undefined&&!token(value.methodComparisonRevision)))
    throw new TypeError("context_run_binding_invalid");
  value.purposes.forEach(validateActivityPurpose);
  if(new Set(value.purposes.map(p=>JSON.stringify([p.ref.id,p.ref.revision]))).size!==value.purposes.length)
    throw new TypeError("context_run_binding_invalid");
}

export function unavailablePreparationRule(value:FrozenRules,purposes:readonly ActivityPurposeContract[],
  prefix:"context_run"|"native_context_run"):RecoveryBindingLimitation|null {
  if(digest(value.policy)!==digest(installed))return {component:"preparation_policy",code:prefix+"_policy_unavailable",
    required:value.policy.id+"@"+value.policy.revision,available:installed.id+"@"+installed.revision,
    requiredDigest:digest(value.policy),availableDigest:digest(installed)};
  if(value.methodComparisonRevision!==undefined&&!["13","14","15"].includes(value.methodComparisonRevision))
    return {component:"method_comparison",code:prefix+"_policy_unavailable",required:value.methodComparisonRevision,available:"13, 14, 15"};
  if(digest(value.purposes)!==digest(purposes))return {component:"activity_purposes",code:prefix+"_purposes_unavailable",
    required:digest(value.purposes),available:digest(purposes)};
  return null;
}
