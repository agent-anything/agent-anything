import {providerResponseUsage} from "@agent-anything/model-interaction";
import type {ProviderObservation} from "@agent-anything/model-interaction/transport";
import type {InspectionRecordInput,InspectionMeasuredUsage} from "../records/index.js";
import type {InspectionRecorder} from "../recording/index.js";

export function providerMeasurement(r:InspectionRecorder,value:ProviderObservation):InspectionRecordInput|null {
  if(!["request","dispatch","settled"].includes(value.stage))return null;
  const usage=value.result?.kind==="succeeded"?providerResponseUsage(value.result.response):null;
  const count=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0?Number(v):null;
  const normalized=typeof usage?.metadata.accountingRevision==="string"&&typeof usage.metadata.accountingConsistent==="boolean";
  const measured:InspectionMeasuredUsage|null=usage?{inputTokens:usage.inputTokens,outputTokens:usage.outputTokens,
    cacheReadTokens:normalized?count(usage.metadata.cachedInputTokens):null,cacheWriteTokens:null,
    cacheRelation:normalized?"input_subsets":"unknown",accountingRevision:normalized?String(usage.metadata.accountingRevision):null,
    consistent:normalized?Boolean(usage.metadata.accountingConsistent):null}:null;
  return {subject:r.ref("provider","provider-attempt",value.attemptId,value.runId),occurredAt:value.occurredAt,
    payload:{kind:"work_measurement",version:"1",origin:{owner:"provider",id:value.attemptId,runId:value.runId,revision:"1"},
      purpose:value.request?.purpose??null,target:JSON.stringify([value.providerId,value.model]),data:{kind:"attempt",
        boundary:value.stage==="request"?"bound":value.stage==="dispatch"?"dispatched":"settled",requestId:value.requestId,
        providerId:value.providerId,model:value.model,status:value.status,usage:measured,price:null}}};
}
