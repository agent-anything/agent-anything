import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {assertProtocolModelActivityOriginal,readProtocolContent,type ProtocolExecutionJournal,type ProtocolModelActivity,
  type ProtocolJournalRecord,type ProtocolContentWork} from "@agent-anything/agent-runtime/model-access";
import {NativeProtocolError} from "@agent-anything/provider-integrations/native";
import {requireModelPurpose,type ProtocolRevisionRef} from "@agent-anything/model-interaction/protocol";
import {nativeTaskCatalog,type HelarcNativeTaskBinding,type HelarcNativeTaskProposal,type HelarcCommittedTaskReply} from "./HelarcNativeTask.js";
import type {ContextSelectionPort,ContextSelectionSnapshot} from "@agent-anything/context/selection";
import type {HelarcRetainedNativeInput} from "./HelarcNativeInputAcceptance.js";
import {validateHelarcResponsesCompactionAgreement,type inspectHelarcResponsesCompaction} from "./HelarcResponsesCompaction.js";

export type {HelarcNativePreparedTask} from "./HelarcNativePreparedTask.js";
import type {HelarcNativePreparedTask} from "./HelarcNativePreparedTask.js";
export interface HelarcNativeRecoveryWork extends ProtocolContentWork {}

/** Recovery reads original preparation and observation, never today's configuration or model. */
export async function recoverHelarcNativeTask(input:{readonly journal:ProtocolExecutionJournal;readonly activity:ProtocolModelActivity;
  readonly observation:ProtocolRevisionRef;readonly interpret:(response:Record<string,unknown>,binding:HelarcNativeTaskBinding,previous:HelarcCommittedTaskReply|null,
    compaction?:Omit<Parameters<typeof inspectHelarcResponsesCompaction>[0],"response">|null)=>HelarcNativeTaskProposal;
  readonly contextSelections?:ContextSelectionPort;
  readonly validateOriginalInput:(encoded:string,binding:HelarcNativeTaskBinding,model:string)=>void;
  readonly observe?:(work:HelarcNativeRecoveryWork)=>void}):Promise<HelarcNativeTaskProposal>{
  const {journal,activity}=input,activityId=activity.scope.activityId;
  const state=await journal.command({kind:"state",activityId});
  if(!state||!("activity" in state)||!("input" in state))throw new NativeProtocolError("helarc_original_activity_missing");
  assertProtocolModelActivityOriginal(state.activity,activity);
  const prepared=JSON.parse((await readProtocolContent(journal,state.input,activityId,32*1024*1024,input.observe)).toString("utf8")) as HelarcNativePreparedTask;
  const b=prepared.binding,purpose=requireModelPurpose(activity.composition,activity.scope.purpose);
  if(prepared.format!=="helarc.native-prepared-task.v1"||modelInputValueDigest(b.scope)!==modelInputValueDigest(activity.scope)||
    modelInputValueDigest(b.protocol)!==modelInputValueDigest(activity.composition.composition.protocol)||
    modelInputValueDigest(b.adapter)!==modelInputValueDigest(activity.composition.composition.adapter.implementation)||
    modelInputValueDigest(b.interpreter)!==modelInputValueDigest(purpose.interpreter.implementation)||
    nativeTaskCatalog(b).revision!==b.catalogRevision||modelInputValueDigest(JSON.parse(prepared.wire.body))!==prepared.wire.digest)
    throw new NativeProtocolError("helarc_original_preparation_mismatch");
  input.validateOriginalInput(prepared.wire.body,b,activity.composition.composition.configuration.model);
  if(modelInputValueDigest(b.record)!==modelInputValueDigest(input.observation))throw new NativeProtocolError("helarc_original_observation_mismatch");
  const record=await journal.command({kind:"record",activityId,ref:input.observation}) as ProtocolJournalRecord|null;
  if(!record?.source||record.kind!=="observation"||record.operationId!==b.operationId||modelInputValueDigest(record.source.scope)!==modelInputValueDigest(activity.scope))
    throw new NativeProtocolError("helarc_original_observation_missing");
  const response=JSON.parse((await readProtocolContent(journal,record.content,activityId,32*1024*1024,input.observe)).toString("utf8"));
  let compaction:Omit<Parameters<typeof inspectHelarcResponsesCompaction>[0],"response">|null=null;
  const internalCompaction=JSON.parse(prepared.wire.body).context_management!==undefined;
  if(internalCompaction&&!prepared.selectedInputId)throw new NativeProtocolError("helarc_original_compaction_acceptance_missing");
  if(prepared.selectedInputId){
    if(!input.contextSelections)throw new NativeProtocolError("helarc_original_selection_acceptance_missing");
    const selected=await input.contextSelections.command({kind:"binding",inputId:prepared.selectedInputId,checkCurrentControl:true}) as ContextSelectionSnapshot;
    const native=selected.input.exactInput as HelarcRetainedNativeInput;
    if(native.kind!=="helarc_native_input"||native.wire.digest!==prepared.wire.digest||
      modelInputValueDigest(native.resultPresentations??[])!==modelInputValueDigest(prepared.resultPresentations??[])||selected.scope.runId!==activity.scope.runId||
      selected.scope.recipient!==activity.scope.recipientId||selected.scope.purpose!==activity.scope.purpose.id||
      native.manifest.scope.recipientId!==activity.scope.recipientId||modelInputValueDigest(native.manifest.scope.purpose)!==modelInputValueDigest(activity.scope.purpose)||
      native.manifest.target.model!==activity.composition.composition.configuration.model||
      native.manifest.scope.compositionDigest!==activity.scope.compositionDigest)throw new NativeProtocolError("helarc_original_compaction_acceptance_changed");
    if(internalCompaction){
      if(!native.compactionAgreement)throw new NativeProtocolError("helarc_original_compaction_acceptance_missing");
      validateHelarcResponsesCompactionAgreement(native.compactionAgreement,native.manifest,JSON.parse(prepared.wire.body));
      compaction={agreement:native.compactionAgreement,acceptedAgreementId:native.compactionAgreement.id,originalRequestDigest:prepared.wire.digest};
    }
  }
  const result=input.interpret(response,b,prepared.previous,compaction);
  if(modelInputValueDigest(result.evidence.scope)!==modelInputValueDigest(activity.scope)||
    modelInputValueDigest(result.evidence.acceptance)!==modelInputValueDigest(b.acceptance))throw new NativeProtocolError("helarc_recovered_purpose_mismatch");
  return result;
}

