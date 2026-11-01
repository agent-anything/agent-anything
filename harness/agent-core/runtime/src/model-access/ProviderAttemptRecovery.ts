import {snapshotProviderFailure,type ProviderFailure,type ProviderCallResult} from "@agent-anything/model-interaction";
import {activityStageEvidence} from "../activity/ActivityProfessionalStop.js";
import type {ActivityPathState,ActivityStageState,ActivityAttemptRetryReceipt} from "../activity/ActivityHandoff.js";
import type {ActivityPurposeContract} from "../activity/ActivityPurpose.js";

export const MODEL_ATTEMPT_RETRY:NonNullable<ActivityPurposeContract["attemptRetry"]>={
  ref:{id:"model.transport-retry",revision:"1"},stageKinds:["model"],maximumAttempts:3,
};

export function providerRetryCategory(failure:ProviderFailure):string|null {
  if(["provider_attempt_interrupted","provider_cancellation_unconfirmed","provider_operation_deadline","provider_context_window_exceeded",
    "provider_result_contract_invalid","provider_response_malformed","provider_response_too_large"].includes(failure.code)||
    ["cancellation","deadline","authentication","response","invalid_request"].includes(failure.category))return null;
  if(failure.category==="timeout"||failure.code==="provider_timeout"||failure.statusCode===408)return "timeout";
  if(failure.category==="rate_limit"||failure.statusCode===429)return "rate_limit";
  if(failure.category==="server_error"||(failure.statusCode!==undefined&&failure.statusCode>=500&&failure.statusCode<=599))return "server_error";
  return failure.category==="transport"?"transport":null;
}

/** Original purpose binding fixes this policy. No inference from messages or retry of unsettled attempts. */
export function prepareProviderAttemptRetry(path:ActivityPathState,stage:ActivityStageState,now:string):ActivityAttemptRetryReceipt|null {
  const rule=path.intent.purpose.contract.attemptRetry,count=stage.attemptCount??(stage.attempt?1:0);
  if(!rule||rule.ref.id!==MODEL_ATTEMPT_RETRY.ref.id||rule.ref.revision!==MODEL_ATTEMPT_RETRY.ref.revision||
    rule.maximumAttempts!==MODEL_ATTEMPT_RETRY.maximumAttempts||!rule.stageKinds.includes(stage.request.stageKind)||path.cancelled||
    stage.status!=="raw_result"||stage.processing||!stage.attempt||!stage.result||stage.result.outcome==="unknown"||stage.result.completeness!=="complete"||
    count>=rule.maximumAttempts||path.resourceUse.dispatchedAttempts>=path.intent.maximumAttempts)return null;
  const result=stage.result.value as ProviderCallResult;
  if(result?.kind!=="failed")return null;
  let failure:ProviderFailure;
  try {failure=snapshotProviderFailure(result.failure);} catch {return null;}
  const category=providerRetryCategory(failure);if(category===null)return null;
  // Server delay is a minimum, not permission to retry earlier when it exceeds this work's horizon.
  const delay=Math.max(500*2**(count-1),failure.retryAfterMs??0);
  if(delay>10_000||!Number.isFinite(Date.parse(now))||Date.parse(now)+delay>=Date.parse(path.intent.deadlineAt))return null;
  return {id:`${stage.attempt.id}:retry`,requestId:stage.request.id,attemptId:stage.attempt.id,resultId:stage.result.id,
    owner:path.intent.purpose.contract.executionOwner,policy:rule.ref,expectedStageEvidence:activityStageEvidence(stage),
    decidedAt:now,notBefore:new Date(Date.parse(now)+delay).toISOString(),reason:{code:failure.code,category}};
}
