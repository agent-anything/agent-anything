import { assessInputCapacity, type InputMeasurementEvidence, type InputCapacityAssessment,
  type InputCapacityLimit, type InputCapacityPolicy, type CapacityReservation,type InputCapacityRefusal } from "@agent-anything/model-interaction/input";
import { copy, digest, NativeProtocolError } from "../NativeJson.js";
import { restoreResponsesInputTokenCount, type ResponsesInputTokenCountRequest,
  type ResponsesMeasurementApplicability } from "./ResponsesInputTokenCount.js";
import { reuseResponsesInputTokenCount, type ResponsesCountEvidence } from "./ResponsesCountEvidence.js";

/** No per-message apportionment: partial counts are not proven lower bounds on another rendering. */
export function responsesInputCapacityEvidence(request: ResponsesInputTokenCountRequest, result: ResponsesCountEvidence,
  current: ResponsesMeasurementApplicability, dimension: "input_tokens" | "shared_tokens" = "input_tokens"): InputMeasurementEvidence {
  request = restoreResponsesInputTokenCount(request);
  const reuse = reuseResponsesInputTokenCount(request, result, current);
  result = reuse.evidence;
  const complete = reuse.reusable && result.status === "measured" && result.coverage === "complete";
  const targetUncertainOnly=result.status==="measured"&&result.coverage==="complete"&&request.coverage==="complete"&&
    request.uncovered.length===0&&reuse.reasons.length>0&&reuse.reasons.every(reason=>
      reason==="target_validity_unknown"||reason==="target_validity_expired");
  const uncovered = [...request.uncovered, ...reuse.reasons];
  if (result.status === "refused") uncovered.push(`refused:${result.category}`);
  if (result.status === "unknown") uncovered.push(`unknown:${result.reason}`);
  const value = {
    encodedInputId:request.binding.encodedInputId, targetRevision:request.binding.targetRevision,
    methodRevision:request.revision, dimension, coverage:complete||targetUncertainOnly ? "complete" as const : "partial" as const,
    quantity:complete && result.status === "measured" ? {kind:"exact" as const, value:result.inputTokens} :
      targetUncertainOnly&&result.status==="measured"?{kind:"estimate" as const,value:result.inputTokens,
        limitations:[...reuse.reasons,"Retained count assumes unchanged target rendering; not a guaranteed capacity bound"]}:
      {kind:"unknown" as const, reason:uncovered.join(";") || "complete_input_count_unavailable"},
    basis:`native_count:${result.id}`, uncovered:targetUncertainOnly?[]:uncovered,
  };
  return copy({ ...value, id:digest(value) });
}

/** Exact count payload refusal transfers only with established complete-input applicability. */
export function responsesInputCapacityRefusal(request:ResponsesInputTokenCountRequest,result:ResponsesCountEvidence,
  current:ResponsesMeasurementApplicability):InputCapacityRefusal|null {
  request=restoreResponsesInputTokenCount(request);
  const retained=reuseResponsesInputTokenCount(request,result,current);
  result=retained.evidence;
  if(result.status!=="refused"||result.category!=="overflow"||result.errorCode!=="context_length_exceeded"||
    request.coverage!=="complete"||request.dispatchBlock!==null||retained.reasons.some(reason=>reason!=="count_refused"))return null;
  const value={encodedInputId:request.binding.encodedInputId,targetRevision:request.binding.targetRevision,
    conditionId:"responses_count_admissibility",evidenceId:result.id,reason:"bound_native_count_refused:context_length_exceeded",
    basis:`Complete native count mapping for generation ${request.generation.digest}; not a numerical lower bound`,
    source:{owner:"openai.responses",id:result.operationId,revision:result.id}};
  return copy({...value,id:`responses-capacity-refusal:${digest(value)}`});
}

/** Uses the existing scoped policy. It neither allocates output limits nor makes a task decision. */
export function assessResponsesInputCapacity(input: {
  readonly request: ResponsesInputTokenCountRequest;
  readonly result: ResponsesCountEvidence;
  readonly current: ResponsesMeasurementApplicability;
  readonly limits: readonly InputCapacityLimit[];
  readonly reservations: readonly CapacityReservation[];
  readonly policy: InputCapacityPolicy;
}): InputCapacityAssessment {
  const request = restoreResponsesInputTokenCount(input.request);
  if (input.current.binding.encodedInputId !== request.binding.encodedInputId || input.current.generationDigest !== request.generation.digest)
    throw new NativeProtocolError("responses_capacity_input_changed");
  const dimensions = new Set(input.limits.filter(limit => limit.dimension === "input_tokens" || limit.dimension === "shared_tokens").map(limit => limit.dimension));
  const evidence = [...dimensions].map(dimension => responsesInputCapacityEvidence(request, input.result, input.current,
    dimension as "input_tokens" | "shared_tokens"));
  const reservations = [...input.reservations];
  if (dimensions.has("shared_tokens") && !reservations.some(item => item.dimension === "shared_tokens" && item.purpose === "generation"))
    reservations.push({id:"responses_generation_unplanned", purpose:"generation", dimension:"shared_tokens",
      quantity:{kind:"unknown", reason:"generation_planning_missing"}, basis:"no_purpose_specific_generation_planning", alreadyIncluded:false});
  const refusal=responsesInputCapacityRefusal(request,input.result,input.current);
  return assessInputCapacity({encodedInputId:request.binding.encodedInputId,targetRevision:request.binding.targetRevision,
    purpose:request.binding.scope.purpose,limits:input.limits,reservations,policy:input.policy,evidence,refusals:refusal?[refusal]:[]});
}
