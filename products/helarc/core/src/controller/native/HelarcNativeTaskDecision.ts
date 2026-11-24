import {createNativeTaskModelItems,snapshotTaskModelCallCorrelation,type TaskDecisionProposal,type TaskDecisionInputSources,
  type ProgressionCandidate,type TaskDecisionModelItem,type ControllerInputDeliveryReceipt} from "@agent-anything/agent-runtime/decision";
import {snapshotContextMaterialRefs} from "@agent-anything/context/material";
import {modelCallRefKey} from "@agent-anything/model-interaction";
import {nativeModelSourceKey} from "@agent-anything/model-interaction/protocol";
import type {HelarcNativeTaskProposal} from "./HelarcNativeTask.js";
import type {HelarcAgentOutput} from "../HelarcController.js";

/** Native task meaning enters execution coordination; native response/state never becomes a Model Turn. */
export function helarcNativeTaskDecision(proposal:HelarcNativeTaskProposal,input:TaskDecisionInputSources<HelarcAgentOutput>,
  receipt:ControllerInputDeliveryReceipt|null=null):TaskDecisionProposal<HelarcAgentOutput> {
  if(input.interaction.kind!=="native_evidence"||proposal.evidence.scope.runId!==input.runId||
    proposal.calls.some(c=>c.call.modelCallRef.controllerRequestId!==input.toolExposure.controllerRequestId)||
    proposal.rejections.some(c=>c.call.controllerRequestId!==input.toolExposure.controllerRequestId))throw new TypeError("helarc_native_task_source_mismatch");
  const items=[...createNativeTaskModelItems(proposal.evidence,proposal.calls.map(c=>c.call))];
  const sources=new Set(proposal.evidence.sources.map(nativeModelSourceKey));
  for(const rejected of proposal.rejections) {
    if(!rejected.call.nativeSource||!sources.has(nativeModelSourceKey(rejected.call.nativeSource)))throw new TypeError("helarc_native_rejection_source_mismatch");
    items.push({id:rejected.call.id,kind:"native_rejected_call",call:snapshotTaskModelCallCorrelation({modelCallRef:rejected.call,
      name:rejected.name,ordinal:rejected.call.contentBlockOrdinal,providerCallRef:rejected.nativeCallId===null?null:
        {id:rejected.nativeCallId,providerId:rejected.call.nativeSource!.protocol.id}}),metadata:{}});
  }
  const modelItems:readonly TaskDecisionModelItem[]=[items[0]!,...items.slice(1).sort((a,b)=>
    ("call" in a?a.call.ordinal:0)-("call" in b?b.call.ordinal:0))];
  const candidates:ProgressionCandidate[]=[],ending=proposal.ending;
  const bindings=new Map(proposal.calls.map(c=>[modelCallRefKey(c.call.modelCallRef),c]));
  for(const item of modelItems) {
    if(item.kind==="native_rejected_call") {
      const rejection=proposal.rejections.find(r=>modelCallRefKey(r.call)===modelCallRefKey(item.call.modelCallRef))!;
      candidates.push({kind:"model_call_rejection",modelCallRef:rejection.call,name:rejection.name,code:rejection.code,message:rejection.message});
    } else if(item.kind==="model_tool_call") {
      const {call,binding}=bindings.get(modelCallRefKey(item.call.modelCallRef))!;
      if(binding.kind==="tool")candidates.push({kind:"tool_request",modelCallRef:call.modelCallRef,
        tool:{name:binding.toolName,revision:binding.tool.revision,input:call.input,origin:"model",controllerRequestId:input.toolExposure.controllerRequestId}});
      else if(binding.control==="update_plan")candidates.push({kind:"state_transition",transition:"plan_update",modelCallRef:call.modelCallRef,input:call.input});
      else if(ending?.call&&modelCallRefKey(ending.call)===modelCallRefKey(call.modelCallRef)) {
        if(Array.isArray(ending.plan)&&ending.plan.length)candidates.push({kind:"state_transition",transition:"plan_update",modelCallRef:call.modelCallRef,input:{plan:ending.plan}});
      } else throw new TypeError("helarc_native_output_control_uninterpreted");
    }
  }
  const common={modelItems,...(receipt?{inputDeliveryReceipt:receipt}:{})};
  if(ending)return {kind:"propose_completion",...common,candidates,
    completionSource:ending.call?{kind:"model_call",modelCallRef:ending.call}:{kind:"controller"},
    output:{kind:"complete",summary:ending.response,source:{kind:"native_response",evidence:proposal.evidence,
      disposition:ending.disposition,sources:ending.sources,...(ending.text?{text:ending.text}:{})},...(ending.materialRefs===null?{}:{materialRefs:snapshotContextMaterialRefs(ending.materialRefs)})}};
  if(candidates.length)return {kind:"advance",...common,candidates:candidates as [ProgressionCandidate,...ProgressionCandidate[]]};
  if(!proposal.feedback)throw new TypeError("helarc_native_task_disposition_missing");
  return {kind:"continue_with_feedback",...common,feedback:{...proposal.feedback,
    source:{owner:"helarc",kind:"native_task_acceptance",id:proposal.evidence.acceptance.id,revision:proposal.evidence.acceptance.revision}}};
}
