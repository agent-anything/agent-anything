import type {ProviderConfiguration} from "../../shared/ProviderConfiguration.js";
import type {InputCapacityLimit,CapacityReservation} from "@agent-anything/model-interaction/input";
import type {HelarcNativeContextRunBinding} from "./HelarcNativeContextRunBinding.js";

export function helarcWorkCapacityEvidence(configuration:ProviderConfiguration,now:string,context:HelarcNativeContextRunBinding){
  const target=helarcNativeCapacityEvidence(configuration,now);
  const maximum=context.maxInputTokensPerGeneration;
  if(maximum===undefined)return target;
  const budget:InputCapacityLimit={id:`${context.id}:work-input-budget`,targetRevision:`${configuration.id}:${configuration.revision}`,
    dimension:"input_tokens",maximum,source:"accepted_work_input_budget",requires:"observed_input_count"};
  return {...target,limits:[...target.limits,budget],basis:target.basis+"; separate work ceiling requires a matching complete input count"};
}

/** Original target evidence, never an output request budget or a guessed model capability. */
export function helarcNativeCapacityEvidence(configuration:ProviderConfiguration,now:string):{
  limits:readonly InputCapacityLimit[];reservations:readonly CapacityReservation[];basis:string;
}{
  const targetRevision=`${configuration.id}:${configuration.revision}`,native=configuration.native;
  const reservations:readonly CapacityReservation[]=[{id:`${targetRevision}:generation-space`,purpose:"generation",dimension:"shared_tokens",
    quantity:{kind:"unknown",reason:"generation_requirement_not_established"},alreadyIncluded:false,
    basis:"Generated text, reasoning and callable arguments may consume shared capacity; no output cap or safety bound is configured"}];
  if(native.protocol==="ollama.chat")return {reservations,limits:[{id:`${targetRevision}:configured-window`,targetRevision,dimension:"shared_tokens",
    maximum:native.contextWindowTokens,source:"original_ollama_num_ctx"}],basis:"Original Ollama num_ctx configuration"};
  const declared=configuration.capacityDeclaration;
  if(!declared)return {reservations,limits:[],basis:"Target window capacity is unknown; no capacity declaration is retained"};
  if(declared.validUntil!==null&&Date.parse(now)>=Date.parse(declared.validUntil))
    return {reservations,limits:[],basis:`Expired target capacity declaration: ${declared.basis}`};
  return {reservations,limits:[{id:`${targetRevision}:declared-window`,targetRevision,dimension:"shared_tokens",maximum:declared.sharedTokens,
    source:`user_declared_capacity:${declared.basis}`}],basis:`User-declared target capacity: ${declared.basis}`};
}
