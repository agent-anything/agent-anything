import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {INITIAL_CONTEXT_PREPARATION_POLICY,type ContextPolicyEvidence} from "./ContextPreparationPolicy.js";

export interface ContextComparableObservation {
  readonly evidence:ContextPolicyEvidence;
  readonly sequence:number;
  readonly targetRevision:string;
  readonly settingsRevision:string;
  readonly purpose:string;
  readonly measurementRevision:string;
  readonly representationContinuity:string;
  readonly dimension:"input_size"|"output_size"|"queue_ms"|"read_ms"|"encode_ms"|"model_ms"|"check_ms"|"accept_ms"|"path_ms";
  readonly unit:string;
  readonly completeness:"complete"|"partial"|"unknown";
  readonly outcome:"returned"|"failed"|"cancelled"|"truncated";
  readonly value:number|null;
}
export interface ContextEmpiricalRange {
  readonly kind:"empirical_range"|"insufficient";
  readonly comparableKey:string;
  readonly minimum:number|null;
  readonly maximum:number|null;
  readonly evidence:readonly ContextPolicyEvidence[];
  readonly excluded:readonly {readonly evidence:ContextPolicyEvidence;readonly reason:string}[];
  readonly limitations:readonly string[];
}

export function contextObservationKey(value:ContextComparableObservation):string {
  return modelInputValueDigest({target:value.targetRevision,settings:value.settingsRevision,purpose:value.purpose,
    measurement:value.measurementRevision,continuity:value.representationContinuity,dimension:value.dimension,unit:value.unit});
}
/** Evidence aggregation only. Observed ranges are neither confidence intervals nor safety bounds. */
export function contextEmpiricalRange(observations:readonly ContextComparableObservation[],reference:ContextComparableObservation,growth=false):ContextEmpiricalRange {
  const key=contextObservationKey(reference),excluded:ContextEmpiricalRange["excluded"][number][]=[];
  if(growth&&reference.dimension!=="input_size")throw new TypeError("context_growth_dimension_invalid");
  const matched=observations.filter(item=>contextObservationKey(item)===key).sort((a,b)=>a.sequence-b.sequence);
  if(new Set(matched.map(item=>item.sequence)).size!==matched.length)throw new TypeError("context_observation_sequence_duplicate");
  for(const item of matched)if(!Number.isSafeInteger(item.sequence)||item.sequence<0||item.value!==null&&(!Number.isFinite(item.value)||item.value<0))throw new TypeError("context_observation_value_invalid");
  const samples=matched.slice(-INITIAL_CONTEXT_PREPARATION_POLICY.observations),values:number[]=[],evidence:ContextPolicyEvidence[]=[];
  const usable=(item:ContextComparableObservation)=>item.completeness==="complete"&&item.value!==null&&
    (item.dimension==="input_size"||item.outcome==="returned");
  for(let i=0;i<samples.length;i++) {
    const item=samples[i]!;
    if(!usable(item)){excluded.push({evidence:item.evidence,reason:"incomplete_or_unsuccessful_observation"});continue;}
    if(growth) {
      const previous=samples[i-1];
      if(!previous||!usable(previous)){excluded.push({evidence:item.evidence,reason:"comparable_adjacent_input_missing"});continue;}
      values.push(item.value!-previous.value!);if(!evidence.includes(previous.evidence))evidence.push(previous.evidence);
    } else values.push(item.value!);
    evidence.push(item.evidence);
  }
  const sufficient=values.length>=INITIAL_CONTEXT_PREPARATION_POLICY.minimumObservations;
  return {kind:sufficient?"empirical_range":"insufficient",comparableKey:key,minimum:sufficient?Math.min(...values):null,maximum:sufficient?Math.max(...values):null,
    evidence,excluded,limitations:["observed_range_not_probability_or_safety_bound",...(growth?["growth_includes_negative_changes"]:[])]};
}
