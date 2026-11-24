import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {readProtocolContent,type ProtocolExecutionJournal,type ProtocolExecutionState,type ProtocolEvidencePage,
  type ProtocolPurposeAcceptance} from "@agent-anything/agent-runtime/model-access";
import {restoreResponsesInputTokenCount,reuseResponsesInputTokenCount,type ResponsesInputTokenCountRequest,
  type ResponsesMeasurementApplicability,type ResponsesCountEvidence} from "@agent-anything/provider-integrations/native";
import {HELARC_RESPONSES_COUNT_INTERPRETER,type HelarcResponsesCountRequest} from "@agent-anything/helarc/controller";

/** Discovery is not authorization. The caller checks current disclosure and dependencies before and after this read. */
export async function reuseHelarcResponsesMeasurement(input:{journal:ProtocolExecutionJournal;request:HelarcResponsesCountRequest;
  current:ResponsesMeasurementApplicability;signal:AbortSignal}):Promise<ResponsesCountEvidence|null>{
  const {journal,request,current,signal}=input,count=restoreResponsesInputTokenCount(request.count),scope=request.activity.scope;
  const page=await journal.command({kind:"measurement_candidates",runId:scope.runId,recipientId:scope.recipientId,
    compositionDigest:scope.compositionDigest,key:count.id,limit:16}) as ProtocolEvidencePage;
  for(const candidate of page.entries){
    signal.throwIfAborted();
    const state=await journal.command({kind:"state",activityId:candidate.activityId}) as ProtocolExecutionState|null;
    const accepted=await journal.command({kind:"acceptance",activityId:candidate.activityId}) as ProtocolPurposeAcceptance|null;
    if(!state||!accepted||candidate.owner!==HELARC_RESPONSES_COUNT_INTERPRETER.id||
      state.activity.scope.runId!==scope.runId||state.activity.scope.recipientId!==scope.recipientId||
      state.activity.scope.compositionDigest!==scope.compositionDigest||digest(state.activity.scope.purpose)!==digest(scope.purpose)||
      digest(accepted.evidence.scope)!==digest(state.activity.scope)||digest(accepted.evidence.interpreter)!==digest(HELARC_RESPONSES_COUNT_INTERPRETER)||
      accepted.effects.length||accepted.deliveries.length||digest(accepted.result)!==digest(candidate.content))
      throw new TypeError("responses_measurement_reuse_original_changed");
    const original=JSON.parse((await readProtocolContent(journal,state.input,candidate.activityId,32*1024*1024)).toString()) as HelarcResponsesCountRequest;
    if(original.format!=="helarc.responses-count-request.v1"||digest(original.activity)!==digest(state.activity)||
      digest(restoreResponsesInputTokenCount(original.count))!==digest(count))throw new TypeError("responses_measurement_reuse_request_changed");
    const result=JSON.parse((await readProtocolContent(journal,accepted.result,candidate.activityId,2*1024*1024)).toString()) as ResponsesCountEvidence;
    if(result.operationId!==`${candidate.activityId}:count`)throw new TypeError("responses_measurement_reuse_operation_changed");
    const reusable=reuseResponsesInputTokenCount(count,result,current);
    if(reusable.reusable)return reusable.evidence;
  }
  return null;
}

/** Stable numerical identity excludes the receiving input ID, never its source, scope or rendering. */
export function responsesMeasurementInputIdentity(input:{generationDigest:string;binding:Omit<ResponsesInputTokenCountRequest["binding"],"encodedInputId">}):string {
  return `responses-input:${digest(input)}`;
}
