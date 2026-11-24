import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import type {RepresentationMethodRequest} from "./methods/RepresentationMethod.js";
import type {RepresentationMethodQuotation} from "./methods/RepresentationMethodQuotation.js";
import type {MaterialAccess} from "@agent-anything/context/custody";

/** Professional work description, not a universal model request or a native execution strategy. */
export interface ProtocolRepresentationMethodRequest {
  readonly method:"protocol";
  readonly methodRevision:string;
  readonly recipient:RepresentationMethodRequest["recipient"];
  readonly targetRevision:string;
  readonly sourceBoundary:string;
  readonly bounds:RepresentationMethodRequest["bounds"];
  readonly materialAccesses:readonly MaterialAccess[];
  readonly execution:{readonly owner:string;readonly protocol:{readonly id:string;readonly revision:string};readonly request:unknown};
}
export type ContextPreparationMethodRequest=RepresentationMethodRequest|ProtocolRepresentationMethodRequest;
/** Accepted professional progress, not a native API state or a claim of task readiness. */
export interface ContextPreparationMethodProgress<R extends ContextPreparationMethodRequest=ContextPreparationMethodRequest> {
  readonly limitationEvidence?:import("./ContextPreparationPolicy.js").ContextPolicyEvidence;
  readonly request:R;
  readonly state:"working"|"ready"|"gap";
}
export function validateProtocolMethodQuotation(request:ProtocolRepresentationMethodRequest,quotation:RepresentationMethodQuotation):RepresentationMethodQuotation {
  if(!request.execution.owner||!request.execution.protocol.id||!request.execution.protocol.revision||!request.methodRevision||
    quotation.requestDigest!==modelInputValueDigest(request)||quotation.targetRevision!==request.targetRevision||quotation.boundary!==request.sourceBoundary||
    modelInputValueDigest(quotation.limits)!==modelInputValueDigest(request.bounds)||quotation.owner!=="context-representation"||quotation.revision!=="1")
    throw new TypeError("protocol_method_quotation_binding_invalid");
  for(const value of Object.values(quotation.minimum))if(!Number.isSafeInteger(value)||value<0)throw new TypeError("protocol_method_minimum_invalid");
  for(const value of Object.values(quotation.costs))if(!Number.isFinite(value.minimum)||value.minimum<0||
    value.maximum!==null&&(!Number.isFinite(value.maximum)||value.maximum<value.minimum)||!value.basis)throw new TypeError("protocol_method_cost_invalid");
  for(const value of Object.values(request.bounds))if(!Number.isSafeInteger(value)||value<0)throw new TypeError("protocol_method_bound_invalid");
  const {id,...value}=quotation;
  if(id!==`method-quotation:${modelInputValueDigest(value)}`||!quotation.phases.length||
    !quotation.phases.some(p=>p.kind==="input")||!quotation.phases.some(p=>p.kind==="retain")||
    !quotation.handoff.includes("recipient_combination_judgment")||!quotation.handoff.includes("shared_adoption"))
    throw new TypeError("protocol_method_quotation_incomplete");
  return quotation;
}
