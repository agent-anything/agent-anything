import type {ActivityStageState} from "../activity/ActivityHandoff.js";
import type {PreparedContextInput} from "../context-representation/ContextInputPreparation.js";
import type {ProviderCallResult} from "@agent-anything/model-interaction";
import {createAcceptedInputUsage} from "@agent-anything/model-interaction/input";

/** Derives measurement evidence from the original complete exchange, never from a model's narrative. */
export function acceptedModelInputUsage(stage:ActivityStageState,acceptanceId:string) {
  const prepared=stage.request.input as PreparedContextInput,raw=stage.result;
  if(prepared?.kind!=="prepared_context_input"||!prepared.accounting||raw?.outcome!=="returned"||raw.completeness!=="complete")return null;
  const result=raw.value as ProviderCallResult;
  if(result?.kind!=="succeeded"||result.response.kind==="native_tool_turn"&&result.response.turn.finish.kind!=="normal")return null;
  const usage=result.response.kind==="native_tool_turn"?result.response.turn.usage:result.response.usage;
  return createAcceptedInputUsage({runId:prepared.demand.runId,purpose:prepared.demand.purpose,targetRevision:prepared.encoded.targetDigest,
    encodedInputId:prepared.encoded.id,stageId:stage.request.id,rawResultId:raw.id,acceptanceId,recordedAt:raw.recordedAt,footprint:prepared.accounting},usage);
}
