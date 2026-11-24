import {retainHelarcNativeUsageObservation,retainHelarcNativeUsageSubmission} from "@agent-anything/helarc/controller";
import type {ProtocolExecutionState,ProtocolJournalRecord,ProtocolEvidencePage} from "@agent-anything/agent-runtime/model-access";
import type {HelarcExecutionStore} from "../execution-storage/HelarcExecutionStore.js";

export async function hasHelarcNativeUsage(store:HelarcExecutionStore,record:ProtocolJournalRecord):Promise<boolean>{
  let afterKey:string|null=null,expectedVersion:number|undefined;
  do{
    const page=await store.protocolJournal.command({kind:"evidence_list",activityId:record.activityId,scopeId:`${record.activityId}:usage`,
      evidenceKind:"usage",afterKey,limit:32,...(expectedVersion===undefined?{}:{expectedVersion})}) as ProtocolEvidencePage|null;
    if(!page)return false;
    if(page.entries.some(entry=>entry.references.some(ref=>ref.id===record.content.id&&ref.digest===record.content.digest&&ref.bytes===record.content.bytes)))return true;
    if(page.version===null)throw new TypeError("native_usage_index_version_missing");
    afterKey=page.next;expectedVersion=page.version;
  }while(afterKey!==null);
  return false;
}
type SubmissionInput={readonly operationId:string;readonly endpoint:string|null;readonly submittedAt:string|null;
  readonly operation?:"generation"|"compact"|"count"|"read"|"cancel";readonly requestedTier?:string|null};
function submission(state:ProtocolExecutionState,input:SubmissionInput){
  const a=state.activity,c=a.composition.composition;
  return {id:input.operationId,scope:a.scope,protocol:c.protocol,operation:input.operation??"generation",endpoint:input.endpoint,
    account:c.configuration.connectionBinding.id,submittedAt:input.submittedAt,model:c.configuration.model,requestedTier:input.requestedTier??null,
    reportedTier:null,region:null,modality:null,reconciliationOwner:c.adapter.implementation.id,
    beneficiaries:[...new Set([a.scope.runId,a.scope.recipientId,a.scope.purpose.id])],stage:a.scope.purpose.id};
}
export async function registerHelarcNativeUsage(store:HelarcExecutionStore,state:ProtocolExecutionState,record:ProtocolJournalRecord,input:SubmissionInput){
  await retainHelarcNativeUsageSubmission({journal:store.protocolJournal,acceptance:store.sharedAcceptance,state,record,submission:submission(state,input)});
}

/** Native observers supply original metadata; absent historical facts remain absent. */
export async function recordHelarcNativeUsage(store:HelarcExecutionStore,state:ProtocolExecutionState,record:ProtocolJournalRecord,
  input:SubmissionInput&{readonly response:Record<string,unknown>;readonly receivedAt:string|null;readonly channel:"create"|"stream"|"get"|"recovery"}){
  await retainHelarcNativeUsageObservation({journal:store.protocolJournal,acceptance:store.sharedAcceptance,state,record,
    submission:submission(state,input),
    response:input.response,receivedAt:input.receivedAt,channel:input.channel,finality:"terminal",
    work:{startedAt:input.submittedAt,completedAt:input.receivedAt,reportedTier:typeof input.response.service_tier==="string"?input.response.service_tier:null}});
}
