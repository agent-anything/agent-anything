/** A supplier's bounded result for the original input need, not a model response or Run outcome. */
export interface ContextInputUnavailability {
  readonly kind:"context_input_unavailable";
  readonly needId:string;
  readonly supplier:string;
  readonly boundary:string;
  readonly reason:string;
  readonly evidence:readonly {readonly owner:string;readonly kind:string;readonly id:string;readonly revision:string}[];
}

export function validateContextInputUnavailability(value:ContextInputUnavailability):void {
  if(value?.kind!=="context_input_unavailable"||![value.needId,value.supplier,value.boundary,value.reason].every(v=>typeof v==="string"&&v.trim().length>0)||
    !Array.isArray(value.evidence)||!value.evidence.length||value.evidence.some(e=>!e||![e.owner,e.kind,e.id,e.revision].every(v=>typeof v==="string"&&v.trim().length>0)))
    throw new TypeError("context_input_unavailability_invalid");
}
