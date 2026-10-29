import type {CapacityDimension,MeasuredQuantity} from "./InputCapacityEvidence.js";
import type {InputChoice,InputOrganizationDemand} from "./InputContribution.js";
import {modelInputValueDigest} from "./ModelWorkingView.js";

export interface LocalInputMeasurement {
  readonly contributionId:string;
  readonly optionId:string;
  readonly optionDigest:string;
  readonly dimension:CapacityDimension;
  readonly quantity:MeasuredQuantity;
  readonly methodRevision:string;
  readonly basis:string;
}
export interface SharedInputCapacity {
  readonly dimension:CapacityDimension;
  readonly available:number;
  readonly basis:string;
}
/** Local grants coordinate demand. Only complete encoding can establish overall fit. */
export function allocateInputCapacity(demand:InputOrganizationDemand,choice:InputChoice,
  measurements:readonly LocalInputMeasurement[],shared:SharedInputCapacity|null) {
  if(shared && (!Number.isFinite(shared.available)||shared.available<0||!shared.basis))throw new TypeError("input_shared_capacity_invalid");
  const shares=demand.contributions.map(c=>{
    const option=c.options.find(o=>o.id===choice[c.id]);if(!option)throw new TypeError("input_option_unavailable");
    const candidates=measurements.filter(m=>m.contributionId===c.id && m.optionId===option.id && m.dimension===c.localBudget.dimension);
    if(candidates.length>1)throw new TypeError("input_local_measurement_ambiguous");
    const measurement=candidates[0];
    if(measurement && (measurement.optionDigest!==modelInputValueDigest(option)||!measurement.methodRevision||!measurement.basis))throw new TypeError("input_local_measurement_stale");
    const quantity=measurement?.quantity;
    const upper=quantity?.kind==="exact"?quantity.value:quantity?.kind==="bounds"?quantity.upper:null;
    const lower=quantity?.kind==="exact"?quantity.value:quantity?.kind==="bounds"?quantity.lower:0;
    const need=upper??(quantity?.kind==="estimate"?quantity.value:null);
    if([upper,lower,need].some(v=>v!==null&&(!Number.isFinite(v)||v<0))||upper!==null&&upper<lower)throw new TypeError("input_local_measurement_invalid");
    const grant=c.localBudget.grant,ceiling=c.localBudget.ceiling;
    const wanted=need===null?null:ceiling===null?need:Math.min(need,ceiling);
    return {contributionId:c.id,dimension:c.localBudget.dimension,grant,need,ceiling,
      returned:grant===null||upper===null?null:Math.max(0,grant-upper),
      allocated:grant===null||wanted===null?null:Math.min(grant,wanted),
      requested:grant===null||wanted===null?null:Math.max(0,wanted-grant),
      hardLimit:ceiling===null?"not_applicable" as const:lower>ceiling?"violated" as const:upper!==null&&upper<=ceiling?"within" as const:"unknown" as const,
      evidence:measurement??null};
  });
  let remainder:number|null=null;
  if(shared) {
    const comparable=shares.filter(s=>s.dimension===shared.dimension);
    if(comparable.every(s=>s.allocated!==null)) {
      remainder=shared.available-comparable.reduce((n,s)=>n+s.allocated!,0);
      // Caller order is explicit contribution priority; never infer semantic importance from size.
      for(const share of comparable) {
        const extra=Math.min(Math.max(0,remainder),share.requested??0);
        share.allocated!+=extra;remainder-=extra;
      }
    }
  }
  return {shares,sharedRemainder:remainder,scope:"local_contributions_not_full_encoding" as const,
    hardViolations:shares.filter(s=>s.hardLimit==="violated").map(s=>s.contributionId)};
}
