import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {unavailablePreparationRule,validateFrozenPreparationRules,type RetainedPreparation} from "./FrozenPreparationRules.js";
import {CONTEXT_INPUT_PREPARATION_PURPOSE,REPRESENTATION_METHOD_PURPOSE,SOURCE_MATERIAL_PUBLICATION_PURPOSE,CONTEXT_INPUT_MATERIALIZATION_PURPOSE,INITIAL_CONTEXT_PREPARATION_POLICY} from "@agent-anything/agent-runtime/context-representation";
import {TASK_MODEL_RESPONSE_PURPOSE} from "@agent-anything/agent-runtime/decision";
import {HELARC_STOP_MODEL_PURPOSE} from "@agent-anything/helarc/task-fulfillment";
import {contextSettingsSnapshot,matchHelarcContextObservations,type HelarcContextSettings,type HelarcProviderProfile} from "@agent-anything/helarc/configuration";

export const HELARC_ACTIVITY_PURPOSES=[CONTEXT_INPUT_PREPARATION_PURPOSE,REPRESENTATION_METHOD_PURPOSE,SOURCE_MATERIAL_PUBLICATION_PURPOSE,
  CONTEXT_INPUT_MATERIALIZATION_PURPOSE,TASK_MODEL_RESPONSE_PURPOSE,HELARC_STOP_MODEL_PURPOSE] as const;

export interface HelarcContextRunBinding {
  readonly id:string;
  readonly revision:"1";
  readonly settings:ReturnType<typeof contextSettingsSnapshot>;
  readonly observations:ReturnType<typeof matchHelarcContextObservations>;
  readonly policy:typeof INITIAL_CONTEXT_PREPARATION_POLICY;
  readonly methodComparisonRevision?:"13"|"14"|"15";
  readonly purposes:readonly typeof CONTEXT_INPUT_PREPARATION_PURPOSE[];
}
export function bindHelarcContextSettings(settings:HelarcContextSettings,profile:HelarcProviderProfile):HelarcContextRunBinding {
  const bound=contextSettingsSnapshot(settings);
  const value={revision:"1" as const,settings:bound,observations:matchHelarcContextObservations(bound.settings,profile),
    policy:INITIAL_CONTEXT_PREPARATION_POLICY,methodComparisonRevision:"15" as const,purposes:HELARC_ACTIVITY_PURPOSES};
  return structuredClone({id:`context-binding:${modelInputValueDigest(value)}`,...value});
}
export type RetainedContextRunBinding=RetainedPreparation<HelarcContextRunBinding>;
export function validateRetainedContextRunBinding(candidate:unknown):asserts candidate is RetainedContextRunBinding {
  if(!candidate||typeof candidate!=="object")throw new TypeError("context_run_binding_missing");
  const {id,...value}=candidate as RetainedContextRunBinding;
  if(value.revision!=="1"||id!==`context-binding:${modelInputValueDigest(value)}`||
    modelInputValueDigest(contextSettingsSnapshot(value.settings.settings))!==modelInputValueDigest(value.settings))throw new TypeError("context_run_binding_invalid");
  validateFrozenPreparationRules(value);
}
export function legacyPreparationLimitation(binding:RetainedContextRunBinding) {
  return unavailablePreparationRule(binding,HELARC_ACTIVITY_PURPOSES,"context_run");
}
export function validateHelarcContextRunBinding(candidate:unknown):asserts candidate is HelarcContextRunBinding {
  validateRetainedContextRunBinding(candidate);
  const unavailable=legacyPreparationLimitation(candidate);
  if(unavailable)throw new TypeError(unavailable.code);
}
