import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {nativeModelSourceKey,type ModelPurposeEvidence,type NativeModelSourceRef} from "@agent-anything/model-interaction/protocol";
import {readProtocolContent,type ProtocolExecutionJournal,type ProtocolPurposeAcceptance,type ProtocolJournalRecord} from "@agent-anything/agent-runtime/model-access";
import type {HelarcNativeTaskProposal,HelarcNativeTaskText} from "../../controller/native/HelarcNativeTaskContracts.js";
import {nativeReadableReasoning} from "./HelarcNativeReasoning.js";

export interface HelarcNativePresentation extends HelarcNativeTaskProposal {readonly reasoning?:readonly HelarcNativeTaskText[]}

export interface HelarcNativePresentationReader {
  read(evidence:ModelPurposeEvidence):Promise<HelarcNativePresentation>;
}
export const helarcNativePresentationId=(source:unknown):string=>`native-content:${digest(source)}`;
export const helarcNativeResponseGroupId=(source:NativeModelSourceRef):string=>`native-response:${digest([
  source.scope,source.protocol,source.interpretation,source.operationId,source.record])}`;

/** Product reading projection of an already accepted purpose, not a second task interpretation. */
export function createHelarcNativePresentationReader(journal:ProtocolExecutionJournal):HelarcNativePresentationReader {
  return {async read(evidence){
    const accepted=await journal.command({kind:"acceptance",activityId:evidence.scope.activityId}) as ProtocolPurposeAcceptance|null;
    if(!accepted||digest(accepted.evidence)!==digest(evidence))throw new TypeError("native_presentation_acceptance_unavailable");
    const retained=JSON.parse((await readProtocolContent(journal,accepted.result,evidence.scope.activityId,32*1024*1024)).toString());
    const p=retained.proposal as HelarcNativeTaskProposal;
    if(retained.format!=="helarc.native-task-decision.v1"||!p||digest(p.evidence)!==digest(evidence)||
      !Array.isArray(p.text)||!Array.isArray(p.calls)||!Array.isArray(p.refusals))throw new TypeError("native_presentation_source_invalid");
    const sources=new Set(evidence.sources.map(nativeModelSourceKey));
    for(const block of [...p.text,...p.refusals])if(typeof block.text!=="string"||!sources.has(nativeModelSourceKey(block.source)))
      throw new TypeError("native_presentation_text_source_invalid");
    for(const call of p.calls)if(!call.call.modelCallRef.nativeSource||!sources.has(nativeModelSourceKey(call.call.modelCallRef.nativeSource)))
      throw new TypeError("native_presentation_call_source_invalid");
    const source=evidence.sources.find(s=>s.position.format==="json-pointer"&&s.position.value==="");
    if(!source)return p;
    const record=await journal.command({kind:"record",activityId:evidence.scope.activityId,ref:source.record}) as ProtocolJournalRecord|null;
    if(!record||record.activityId!==source.scope.activityId||record.operationId!==source.operationId||digest(record.ref)!==digest(source.record))throw new TypeError("native_presentation_response_unavailable");
    const response=JSON.parse((await readProtocolContent(journal,record.content,evidence.scope.activityId,32*1024*1024)).toString());
    return {...p,reasoning:nativeReadableReasoning(response,source)};
  }};
}
