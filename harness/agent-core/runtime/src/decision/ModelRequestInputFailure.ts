import type { RuntimeFailure } from "../run/RunFailure.js";
import {schedulingAdmissionLimitation} from "../activity/ActivityScheduling.js";

export const MODEL_REQUEST_INPUT_FAILURE = "model_request_input_preparation_failed";

const explanations = new Map<string, string>([
  ["original_source_unavailable", "Publication of a required source stopped before the input could be assembled."],
  ["input_preparation_cancelled", "Preparation of the required input was cancelled."],
  ["original_preparation_cancelled", "Preparation of the required input was cancelled."],
  ["original_preparation_stopped", "Preparation stopped before it produced a usable input."],
  ["input_encoding_unsupported:assistant_content_order_unsupported", "The model protocol cannot encode the recorded order of assistant text and calls."],
  ["input_encoding_unsupported:assistant_content_shape_unsupported", "The model protocol cannot encode the recorded assistant content in its original form."],
  ["remote_measurement_dependency_unavailable", "The required input count could not be requested using the original connection binding."],
  ["remote_measurement_result_invalid", "The input counting service returned a result that could not be used."],
  ["input_preparation_execution_budget_exhausted", "Input preparation reached its stage, attempt, or time limit."],
  ["automatic_preparation_disabled", "No usable input was ready and automatic preparation of an alternative was disabled."],
  ["no_supported_complete_path", "No available preparation method met all requirements for this input."],
  ["admission_rejected:activity_schedule_pool_missing", "A resource pool required to schedule input preparation was missing."],
  ["admission_rejected:activity_schedule_claim_exceeds_pool_capacity", "The scheduler cannot allocate the requested resources: the claim exceeds the pool's total capacity."],
  ["retained_result_requires_recipient_input_organization", "A preparation result was retained, but it was not assembled into a complete request for this recipient."],
  ["input_reception_requires_bounded_revision", "The receiving stage could not provide a usable replacement input; no applicable revision was accepted."],
  ["original_path_requires_bounded_revision", "The previous preparation path failed or was cancelled, and no supported replacement for it was accepted."],
  ["replacement_count_exhausted", "The provider rejected the input and no more input replacements are allowed."],
  ["replacement_deadline_elapsed", "The provider rejected the input and the deadline for preparing a replacement passed."],
  ["replacement_count_and_deadline_exhausted", "The provider rejected the input, the replacement allowance was exhausted, and the replacement deadline passed."],
]);

function record(value:unknown):Readonly<Record<string,unknown>> {
  return value!==null && typeof value==="object" ? value as Readonly<Record<string,unknown>> : {};
}

/** Only known findings are published. Raw protocol, credential and source data remain internal. */
export function describeModelRequestInputFailure(metadata:RuntimeFailure["metadata"]):string {
  const limitation=record(metadata.limitation), reason=limitation.reason??metadata.reason;
  const budget=record(limitation.workInputBudget), measured=budget.measuredTokens, maximum=budget.maximumTokens;
  const parts:string[]=[];
  if(typeof measured==="number" && Number.isSafeInteger(measured) && typeof maximum==="number" &&
    Number.isSafeInteger(maximum) && maximum>=0 && measured>maximum)
    parts.push(`The original input measured ${measured} tokens, exceeding this work's input budget of ${maximum} tokens.`);
  else if(limitation.originalBlock==="capacity_limit")parts.push("A capacity limit was exceeded during input preparation.");
  else if(limitation.originalBlock==="required_count_missing")parts.push("The required complete input token count was not available.");
  else if(limitation.originalBlock==="capacity_uncertain")parts.push("The available measurements did not establish that the original input fit.");
  else if(limitation.originalBlock==="information_gap")parts.push("The original input did not satisfy its information requirements.");
  if(limitation.optionSearch==="search_budget_exhausted")parts.push("Some input combinations were not examined before the search limit was reached.");
  else if(limitation.optionSearch==="options_exhausted")parts.push("The available original input combinations were exhausted.");
  if(limitation.preservationUnconfirmed===true){
    const issues=Array.isArray(limitation.assessmentIssues)?limitation.assessmentIssues:[];
    if(issues.includes("candidate_contradiction"))parts.push("The candidate's answer contradicted the retained source.");
    else if(issues.includes("plan_attribution")||issues.includes("plan_scope"))parts.push("The assessment plan could not establish the correct responsibility or scope; this does not establish a candidate error.");
    else parts.push("The compaction assessment did not establish that the required information was preserved.");
  }
  const prefix="admission_rejected:";
  const scheduling=typeof reason==="string"&&reason.startsWith(prefix)?schedulingAdmissionLimitation(reason.slice(prefix.length)):null;
  const detail=typeof reason==="string"?explanations.get(scheduling?prefix+scheduling:reason):undefined;
  if(reason==="original_source_unavailable" && limitation.sourceStop==="authorization")
    parts.push("Publication of a required source was denied authorization.");
  else if(reason==="original_source_unavailable" && limitation.sourceStop==="deadline")
    parts.push("The deadline passed before a required source could be published.");
  else if(detail)parts.push(detail);
  else if(typeof reason==="string" && reason.startsWith("input_encoding_unsupported:"))
    parts.push("The model protocol cannot encode the recorded input in its original form.");
  else if(typeof reason==="string" && reason.startsWith("admission_rejected:"))
    parts.push("The scheduler did not admit the work needed to prepare this input.");
  else parts.push("No usable input could be prepared for this model request.");
  return parts.join(" ");
}

export function modelRequestInputFailure(metadata:RuntimeFailure["metadata"]) {
  return {kind:"input_preparation",failure:{code:MODEL_REQUEST_INPUT_FAILURE,message:describeModelRequestInputFailure(metadata),
    retryable:false,metadata}} as const;
}
