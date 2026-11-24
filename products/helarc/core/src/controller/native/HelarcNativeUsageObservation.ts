import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {createNativeAccountingState,applyNativeAccountingCommand,nativeWorkForSubmission,restoreNativeAccountingState,
  type NativeWorkSubmission,type NativeUsageProfile} from "@agent-anything/provider-integrations/native";
import {readProtocolContent,type ProtocolExecutionState,type ProtocolJournalRecord,type ProtocolEvidenceRevision,type ProtocolEvidenceScope} from "@agent-anything/agent-runtime/model-access";
import {retainHelarcNativeWork} from "./HelarcNativeAccounting.js";

type Ports=Pick<Parameters<typeof retainHelarcNativeWork>[0],"journal"|"acceptance">;
type WorkInput=Ports&{readonly state:ProtocolExecutionState;readonly record:ProtocolJournalRecord;readonly submission:NativeWorkSubmission};

async function originalWork(input:WorkInput){
  const {state,record,submission}=input,a=state.activity,id=a.scope.activityId;
  if(record.activityId!==id||digest(submission.scope)!==digest(a.scope)||
    digest(submission.protocol)!==digest(a.composition.composition.protocol))throw new TypeError("native_usage_submission_owner_changed");
  const retained=await input.journal.command({kind:"record",activityId:id,ref:record.ref});
  if(digest(retained)!==digest(record))throw new TypeError("native_usage_original_record_missing");
  const scope:ProtocolEvidenceScope={id:`${id}:usage`,runId:a.scope.runId,recipientId:a.scope.recipientId,purpose:a.scope.purpose,
    compositionDigest:a.scope.compositionDigest,owner:a.composition.composition.adapter.implementation.id};
  const receipt=await input.acceptance.accept({id:`${id}:usage-scope`,scope:a.scope.runId,actor:"execution-coordinator",
    parts:[{owner:"protocol_execution",kind:"evidence_scope",proposal:{activityId:id,scope}}]});
  if(receipt.outcome!=="accepted")throw new TypeError(`native_usage_scope_rejected:${receipt.rejection?.code}`);
  let accounting=applyNativeAccountingCommand(createNativeAccountingState(),{id:`${submission.id}:register`,kind:"register",submission});
  const key=nativeWorkForSubmission(accounting,submission.id).id;
  const prior=await input.journal.command({kind:"evidence",activityId:id,scopeId:scope.id,evidenceKind:"usage",key}) as ProtocolEvidenceRevision|null;
  if(prior){
    const value=JSON.parse((await readProtocolContent(input.journal,prior.content,id,4*1024*1024)).toString());
    accounting=restoreNativeAccountingState(value.state);
    const original=nativeWorkForSubmission(accounting,submission.id).origin;
    // Timing and reported tier can arrive later; the original registration is
    // never replaced, including records created before dispatch registration.
    if(digest({...original,submittedAt:null,reportedTier:null})!==digest({...submission,endpoint:submission.endpoint??original.endpoint,submittedAt:null,reportedTier:null}))
      throw new TypeError("native_usage_submission_changed");
  }
  return {scope,accounting,prior};
}

export async function retainHelarcNativeUsageSubmission(input:WorkInput){
  if(input.record.kind!=="dispatch_intent"&&input.record.kind!=="reconciliation_intent")throw new TypeError("native_usage_dispatch_basis_missing");
  const {scope,accounting,prior}=await originalWork(input);
  if(prior)return prior;
  return retainHelarcNativeWork({...input,scope,fence:input.state.fence,state:accounting,submissionId:input.submission.id,cost:null,
    expectedRevision:null,references:[input.record.content],dependencies:[{activityId:input.record.activityId,ref:input.record.ref}],maximumSnapshotBytes:4*1024*1024});
}

export async function retainHelarcNativeDispatchUsage(input:Ports&{
  readonly state:ProtocolExecutionState;readonly record:ProtocolJournalRecord;
  readonly operation:NativeWorkSubmission["operation"];readonly endpoint:string|null;readonly submittedAt:string|null;
}){
  const a=input.state.activity,c=a.composition.composition;
  return retainHelarcNativeUsageSubmission({...input,submission:{id:input.record.operationId,scope:a.scope,protocol:c.protocol,
    operation:input.operation,endpoint:input.endpoint,account:c.configuration.connectionBinding.id,submittedAt:input.submittedAt,
    model:c.configuration.model,requestedTier:null,reportedTier:null,region:null,modality:null,
    reconciliationOwner:c.adapter.implementation.id,beneficiaries:[...new Set([a.scope.runId,a.scope.recipientId,a.scope.purpose.id])],stage:a.scope.purpose.id}});
}
/** Native usage is a physical-work fact, not a task decision or a synthetic Model Turn. */
export async function retainHelarcNativeUsageObservation(input:Ports&{
  readonly state:ProtocolExecutionState;readonly record:ProtocolJournalRecord;
  readonly submission:NativeWorkSubmission;readonly response:Record<string,unknown>;
  readonly receivedAt:string|null;readonly channel:"create"|"stream"|"get"|"recovery";
  readonly finality:"partial"|"terminal";
  readonly work?:{readonly startedAt:string|null;readonly completedAt:string|null;readonly reportedTier:string|null};
}){
  const {state,record,submission}=input,a=state.activity,id=a.scope.activityId,protocol=a.composition.composition.protocol;
  if(!record.source||record.activityId!==id||record.kind!=="observation"||digest(record.source.scope)!==digest(a.scope)||
    digest(submission.scope)!==digest(a.scope)||digest(submission.protocol)!==digest(protocol))
    throw new TypeError("native_usage_observation_owner_changed");
  let {scope,accounting,prior}=await originalWork(input);
  const basis={id:`${protocol.id}:usage`,revision:"1"},profile:NativeUsageProfile=protocol.id==="openai.responses"?
    {kind:"openai.responses",revision:"1",cacheWrites:"unestablished",basis}:protocol.id==="ollama.chat"?
      {kind:"ollama.chat",revision:"1",basis}:{kind:"deepseek.chat-completions",revision:"1",basis};
  if(protocol.id!==profile.kind)throw new TypeError("native_usage_protocol_unavailable");
  const response=input.response;
  const usage=protocol.id==="ollama.chat"?Object.fromEntries(["prompt_eval_count","eval_count","total_duration","load_duration","prompt_eval_duration","eval_duration"]
    .filter(k=>Object.hasOwn(response,k)).map(k=>[k,response[k]])):response.usage??null;
  const before=accounting;
  accounting=applyNativeAccountingCommand(accounting,{id:`${record.ref.id}:${record.ref.revision}:usage`,kind:"observe",
    observation:{id:`${record.ref.id}:${record.ref.revision}:usage`,submissionId:submission.id,source:record.source,
      receivedAt:input.receivedAt,channel:input.channel,finality:input.finality,authority:protocol.id,
      revisionDomain:submission.id,cumulativeRevision:null,profile,usage,...(input.work?{work:input.work}:{})}});
  if(prior&&digest(before)===digest(accounting))return prior;
  const work=nativeWorkForSubmission(accounting,submission.id);
  const cost=[...work.costCalculations].reverse().find(value=>value.workId===work.id&&value.usageRevision===work.contribution.revision)??null;
  return retainHelarcNativeWork({...input,scope,fence:state.fence,state:accounting,submissionId:submission.id,cost,
    expectedRevision:prior?.revision??null,references:[record.content],dependencies:[],maximumSnapshotBytes:4*1024*1024});
}
