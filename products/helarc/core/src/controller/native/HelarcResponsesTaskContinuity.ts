import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {readProtocolContent,type ProtocolExecutionJournal,type ProtocolExecutionState,type ProtocolPurposeAcceptance,type ProtocolJournalRecord} from "@agent-anything/agent-runtime/model-access";
import type {ContextSelectionPort,ContextSelectionSnapshot} from "@agent-anything/context/selection";
import {resolveResponsesInputContinuity,acceptResponsesContinuation,responsesOutputGroup,type ResponsesContinuation} from "@agent-anything/provider-integrations/native";
import type {HelarcNativeRunTask} from "./HelarcNativeTaskExecution.js";
import type {HelarcRetainedNativeInput} from "./HelarcNativeInputAcceptance.js";
import {helarcNativeWorkingGroupRevision} from "./HelarcNativeAccountScopes.js";
import {helarcNativeGroupSourceIds} from "./HelarcNativeInputGroups.js";

/** Only the preceding accepted task purpose in this Run can establish its native predecessor. */
export async function readHelarcResponsesTaskContinuation(request:HelarcNativeRunTask,
  ports:{readonly journal:ProtocolExecutionJournal;readonly selections:ContextSelectionPort}):Promise<ResponsesContinuation|null>{
  const previous=request.previous;
  if(!previous)return null;
  const id=previous.scope.activityId,b=request.binding;
  if(previous.scope.runId!==b.scope.runId||previous.scope.recipientId!==b.scope.recipientId||
    digest(previous.scope.purpose)!==digest(b.scope.purpose)||previous.scope.compositionDigest!==b.scope.compositionDigest)
    throw new TypeError("responses_task_continuation_scope_changed");
  const state=await ports.journal.command({kind:"state",activityId:id}) as ProtocolExecutionState|null;
  const accepted=await ports.journal.command({kind:"acceptance",activityId:id}) as ProtocolPurposeAcceptance|null;
  if(!state?.accepted||!accepted||digest(accepted.evidence.acceptance)!==digest(previous.acceptance)||
    digest(accepted.evidence.scope)!==digest(previous.scope))throw new TypeError("responses_task_continuation_acceptance_missing");
  const original=JSON.parse((await readProtocolContent(ports.journal,state.input,id,32*1024*1024)).toString()) as HelarcNativeRunTask;
  if(!original.selectedInputId||original.binding.protocol.id!=="openai.responses"||digest(original.binding.record)!==digest(previous.responseRecord))
    throw new TypeError("responses_task_continuation_input_missing");
  const selection=await ports.selections.command({kind:"binding",inputId:original.selectedInputId,checkCurrentControl:false}) as ContextSelectionSnapshot;
  const native=selection.input.exactInput as HelarcRetainedNativeInput;
  if(native?.kind!=="helarc_native_input"||native.continuity.kind!=="responses"||native.wire.digest!==original.wire.digest||
    selection.scope.runId!==b.scope.runId||selection.input.activityId!==id||native.manifest.scope.compositionDigest!==b.scope.compositionDigest)
    throw new TypeError("responses_task_continuation_selection_changed");
  const record=await ports.journal.command({kind:"record",activityId:id,ref:previous.responseRecord}) as ProtocolJournalRecord|null;
  if(record?.kind!=="observation"||record.operationId!==original.binding.operationId||record.source?.scope.activityId!==id)
    throw new TypeError("responses_task_continuation_observation_missing");
  const response=JSON.parse((await readProtocolContent(ports.journal,record.content,id,32*1024*1024)).toString());
  const plan=resolveResponsesInputContinuity(native.manifest,native.continuity);
  const group=request.workingSources?.groups.find(g=>g.id===`${id}:response`);
  const revision=group?helarcNativeWorkingGroupRevision(group):null;
  const recipient={runId:b.scope.runId,recipient:b.scope.recipientId,purpose:b.scope.purpose.id};
  const pathId=group?`${b.scope.runId}:native-source:${digest({id:group.id,revision,recipient,target:selection.scope.target})}`:null;
  const output=responsesOutputGroup({manifest:native.manifest,response,observation:record.ref.id,id:`${id}:response`,
    representation:{id:`${pathId}:custody:original`,revision:revision??"1"},holds:[]});
  if(output&&!group||!output&&group)throw new TypeError("responses_task_continuation_output_missing");
  return acceptResponsesContinuation({pending:{...plan.next,pending:{operationId:original.binding.operationId,inputDigest:native.manifest.digest}},
    manifest:native.manifest,operationId:original.binding.operationId,response,observation:record.ref.id,
    outputGroup:output&&group?{...output,sources:helarcNativeGroupSourceIds(group)}:null});
}
