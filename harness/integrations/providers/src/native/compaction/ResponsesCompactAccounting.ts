import {createNativeAccountingState,applyNativeAccountingCommand,type NativeAccountingState,type NativeWorkSubmission} from "../accounting/NativeAccounting.js";
import type {NativeModelSourceRef} from "@agent-anything/model-interaction/protocol";
import type {ResponsesCompactSession} from "./ResponsesCompactSession.js";
import {NativeProtocolError} from "../NativeJson.js";

/** One original method submission, whether used or discarded. Enclosing Response usage is not counted again here. */
export function responsesCompactAccounting(input:{readonly session:ResponsesCompactSession;readonly submission:NativeWorkSubmission;
  readonly source:NativeModelSourceRef;readonly observedAt:string;readonly previous?:NativeAccountingState}):NativeAccountingState {
  const {session,submission,source}=input,snapshot=session.snapshot(),candidate=session.candidate();
  if(submission.operation!=="compact"||submission.scope.activityId!==source.scope.activityId||submission.scope.runId!==source.scope.runId||
    submission.model!==session.binding.prepared.body.model||!candidate||snapshot.status!=="observed"||source.nativeIdentity?.kind!=="response.compaction"||
    source.nativeIdentity.id!==candidate.resourceId)throw new NativeProtocolError("responses_compact_usage_binding_invalid");
  let state=applyNativeAccountingCommand(input.previous??createNativeAccountingState(),{id:`${submission.id}:register`,kind:"register",submission});
  state=applyNativeAccountingCommand(state,{id:`${submission.id}:remote`,kind:"bind_remote",submissionId:submission.id,
    remote:{kind:"response.compaction",id:candidate.resourceId},evidence:source});
  state=applyNativeAccountingCommand(state,{id:`${submission.id}:usage`,kind:"observe",observation:{id:`${submission.id}:usage`,submissionId:submission.id,
    source:{...source,position:{format:"json-pointer",value:"/usage"}},receivedAt:input.observedAt,channel:"create",finality:"terminal",
    authority:"OpenAI",revisionDomain:candidate.resourceId,cumulativeRevision:null,
    profile:{kind:"openai.responses",revision:"1",cacheWrites:"not_applicable",basis:{id:"openai.responses.compact.usage",revision:"1"}},usage:candidate.raw.usage??{}}});
  return state;
}
