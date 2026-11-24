import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {unavailablePreparationRule,validateFrozenPreparationRules,type RetainedPreparation} from "./FrozenPreparationRules.js";
import {INITIAL_CONTEXT_PREPARATION_POLICY} from "@agent-anything/agent-runtime/context-representation";
import {nativeActivityPurposes,type NativePurposeInventoryRevision} from "./HelarcNativeActivityPurposes.js";
import {contextSettingsSnapshot,matchHelarcNativeContextObservations,type HelarcContextSettings,type HelarcNativeContextObservationTarget} from "@agent-anything/helarc/configuration";
import type {ProviderConfiguration} from "../../shared/ProviderConfiguration.js";
import {validWorkInputBudget} from "../../shared/HelarcWorkInputBudget.js";

export interface HelarcNativeContextRunBinding {
  readonly id:string;
  readonly revision:NativePurposeInventoryRevision;
  readonly target:HelarcNativeContextObservationTarget;
  readonly settings:ReturnType<typeof contextSettingsSnapshot>;
  readonly observations:ReturnType<typeof matchHelarcNativeContextObservations>;
  readonly policy:typeof INITIAL_CONTEXT_PREPARATION_POLICY;
  readonly methodComparisonRevision?:"13"|"14"|"15";
  readonly maxInputTokensPerGeneration?:number;
  readonly purposes:ReturnType<typeof nativeActivityPurposes>;
}
export function helarcNativeContextTarget(configuration:ProviderConfiguration,artifact:string|null=null):HelarcNativeContextObservationTarget {
  return {kind:"native_configuration",configuration:{id:configuration.id,revision:configuration.revision},
    protocol:{id:configuration.protocol,revision:"1"},model:configuration.model,semanticRevision:configuration.semanticRevision,artifact};
}
export function bindHelarcNativeContextSettings(settings:HelarcContextSettings,configuration:ProviderConfiguration,artifact:string|null=null,maxInputTokensPerGeneration?:number):HelarcNativeContextRunBinding {
  if(maxInputTokensPerGeneration!==undefined&&(!validWorkInputBudget(maxInputTokensPerGeneration)||configuration.protocol!=="openai.responses"))
    throw new TypeError("work_input_budget_unsupported");
  const target=helarcNativeContextTarget(configuration,artifact),snapshot=contextSettingsSnapshot(settings);
  const revision="3";
  const value={revision:revision as NativePurposeInventoryRevision,target,settings:snapshot,observations:matchHelarcNativeContextObservations(snapshot.settings,target),
    ...(maxInputTokensPerGeneration===undefined?{}:{maxInputTokensPerGeneration}),
    policy:INITIAL_CONTEXT_PREPARATION_POLICY,methodComparisonRevision:"15" as const,purposes:nativeActivityPurposes(target.protocol.id,revision)};
  return structuredClone({id:`native-context-binding:${digest(value)}`,...value});
}
export type RetainedNativeContextRunBinding=RetainedPreparation<HelarcNativeContextRunBinding>;
export function validateRetainedNativeContextRunBinding(candidate:unknown):asserts candidate is RetainedNativeContextRunBinding {
  if(!candidate||typeof candidate!=="object")throw new TypeError("native_context_run_binding_missing");
  const {id,...value}=candidate as RetainedNativeContextRunBinding;
  if(value.maxInputTokensPerGeneration!==undefined&&(!validWorkInputBudget(value.maxInputTokensPerGeneration)||
    value.target.protocol.id!=="openai.responses"||value.revision!=="3"))throw new TypeError("work_input_budget_unsupported");
  if(!["1","2","3"].includes(value.revision)||id!==`native-context-binding:${digest(value)}`||value.target.kind!=="native_configuration"||value.target.protocol.revision!=="1"||
    digest(contextSettingsSnapshot(value.settings.settings))!==digest(value.settings)||
    digest(matchHelarcNativeContextObservations(value.settings.settings,value.target))!==digest(value.observations))
    throw new TypeError("native_context_run_binding_invalid");
  validateFrozenPreparationRules(value);
}
export function nativePreparationLimitation(binding:RetainedNativeContextRunBinding) {
  return unavailablePreparationRule(binding,nativeActivityPurposes(binding.target.protocol.id,binding.revision),"native_context_run");
}
export function validateHelarcNativeContextRunBinding(candidate:unknown):asserts candidate is HelarcNativeContextRunBinding {
  validateRetainedNativeContextRunBinding(candidate);
  const unavailable=nativePreparationLimitation(candidate);
  if(unavailable)throw new TypeError(unavailable.code);
}
