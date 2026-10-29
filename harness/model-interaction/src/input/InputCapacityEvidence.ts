import {modelInputValueDigest} from "./ModelWorkingView.js";

export type CapacityDimension = "input_tokens" | "shared_tokens" | "request_bytes" | "media_items" | "tool_items";
export type MeasuredQuantity =
  | {readonly kind:"exact"; readonly value:number}
  | {readonly kind:"bounds"; readonly lower:number; readonly upper:number|null}
  | {readonly kind:"estimate"; readonly value:number; readonly limitations:readonly string[]}
  | {readonly kind:"unknown"; readonly reason:string};
export interface InputMeasurementEvidence {
  readonly id:string;
  readonly encodedInputId:string;
  readonly targetRevision:string;
  readonly methodRevision:string;
  readonly dimension:CapacityDimension;
  readonly coverage:"complete"|"partial";
  readonly quantity:MeasuredQuantity;
  readonly basis:string;
  readonly uncovered:readonly string[];
}
export interface InputCapacityLimit {
  readonly id:string;
  readonly targetRevision:string;
  readonly dimension:CapacityDimension;
  readonly maximum:number;
  readonly source:string;
}
export interface InputCapacityPolicy {
  readonly id:string;
  readonly revision:string;
  readonly purpose:string;
  readonly basis:string;
  readonly allowEstimatedFit:boolean;
  readonly allowUnknown:boolean;
}
export interface CapacityReservation {
  readonly id:string;
  readonly purpose:"generation"|"measurement_error"|"future_growth";
  readonly dimension:CapacityDimension;
  readonly quantity:MeasuredQuantity;
  readonly basis:string;
  readonly alreadyIncluded:boolean;
}
export interface InputCapacityAssessment {
  readonly id:string;
  readonly encodedInputId:string;
  readonly targetRevision:string;
  readonly policy:InputCapacityPolicy;
  readonly decisions:readonly {readonly limitId:string;readonly evidenceId:string|null;readonly conclusion:"violated"|"within"|"estimated_fit"|"uncertain";readonly reason:string}[];
  readonly reservations:readonly CapacityReservation[];
  readonly allowed:boolean;
}

export function assessInputCapacity(input:{
  encodedInputId:string; targetRevision:string; purpose:string; limits:readonly InputCapacityLimit[];
  evidence:readonly InputMeasurementEvidence[]; reservations:readonly CapacityReservation[]; policy:InputCapacityPolicy;
}): InputCapacityAssessment {
  if (input.policy.purpose !== input.purpose || !input.policy.id || !input.policy.revision || !input.policy.basis) throw new TypeError("input_capacity_policy_scope_invalid");
  for (const evidence of input.evidence) {
    bounds(evidence.quantity);
    if (evidence.encodedInputId !== input.encodedInputId || evidence.targetRevision !== input.targetRevision || !evidence.basis || !evidence.methodRevision) throw new TypeError("input_measurement_scope_invalid");
    if (evidence.coverage === "complete" && evidence.uncovered.length) throw new TypeError("input_measurement_coverage_invalid");
  }
  for (const reservation of input.reservations) {bounds(reservation.quantity); if (!reservation.id || !reservation.basis) throw new TypeError("input_reservation_basis_missing");}
  if (new Set(input.reservations.map(r=>r.id)).size !== input.reservations.length) throw new TypeError("input_reservation_duplicate");
  const decisions:InputCapacityAssessment["decisions"][number][] = [];
  for (const limit of input.limits) {
    if (limit.targetRevision !== input.targetRevision || !Number.isFinite(limit.maximum) || limit.maximum < 0 || !limit.source) throw new TypeError("input_capacity_limit_invalid");
    const evidence = input.evidence.filter(e=>e.dimension === limit.dimension);
    if (!evidence.length) {decisions.push({limitId:limit.id,evidenceId:null,conclusion:"uncertain",reason:"measurement_unavailable"});continue;}
    // Different findings are retained separately; an estimate cannot overrule a proven violation.
    for (const item of evidence) {
      let [lower,upper,estimate] = bounds(item.quantity);
      if (item.coverage !== "complete") {upper = null; estimate = null;}
      for (const reservation of input.reservations.filter(r=>r.dimension === limit.dimension && r.purpose !== "future_growth" && !r.alreadyIncluded)) {
        const [lo,hi,es] = bounds(reservation.quantity);
        lower += lo; upper = upper === null || hi === null ? null : upper+hi;
        estimate = estimate === null || es === null ? null : estimate+es;
      }
      const conclusion = lower > limit.maximum ? "violated" : upper !== null && upper <= limit.maximum ? "within" :
        estimate !== null && estimate <= limit.maximum ? "estimated_fit" : "uncertain";
      decisions.push({limitId:limit.id,evidenceId:item.id,conclusion,reason:conclusion === "violated"?"proven_lower_bound_exceeds_limit":
        conclusion === "within"?"complete_upper_bound_within_limit":conclusion === "estimated_fit"?"estimate_not_guarantee":"insufficient_or_crossing_evidence"});
    }
  }
  if (!input.limits.length) decisions.push({limitId:"unknown",evidenceId:null,conclusion:"uncertain",reason:"target_limits_unknown"});
  const allowed = decisions.every(d=>d.conclusion === "within" || d.conclusion === "estimated_fit" && input.policy.allowEstimatedFit || d.conclusion === "uncertain" && input.policy.allowUnknown);
  const value = {encodedInputId:input.encodedInputId,targetRevision:input.targetRevision,policy:input.policy,decisions,reservations:input.reservations,allowed};
  return {...value,id:modelInputValueDigest(value)};
}

function bounds(quantity:MeasuredQuantity):[number,number|null,number|null] {
  const finite=(value:number)=>Number.isFinite(value)&&value>=0;
  switch(quantity.kind) {
    case "exact": if(!finite(quantity.value))throw new TypeError("measurement_invalid"); return [quantity.value,quantity.value,quantity.value];
    case "bounds": if(!finite(quantity.lower)||quantity.upper!==null&&(!finite(quantity.upper)||quantity.upper<quantity.lower))throw new TypeError("measurement_invalid");return [quantity.lower,quantity.upper,null];
    case "estimate":if(!finite(quantity.value))throw new TypeError("measurement_invalid");return [0,null,quantity.value];
    case "unknown":return [0,null,null];
  }
}
