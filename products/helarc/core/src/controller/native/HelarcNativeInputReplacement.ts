import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {readProtocolInputRejection,createModelActivityBinding,type ProtocolInputRejectionEvidence,type ProtocolExecutionJournal,type ProtocolExecutionState} from "@agent-anything/agent-runtime/model-access";
import {ActivityContinuationCoordinator,createActivityContinuationArrangement} from "@agent-anything/agent-runtime/execution-coordinator";
import type {AgentActivityExecutionContext,TaskDecisionInputSources} from "@agent-anything/agent-runtime/decision";
import type {HelarcAgentOutput} from "../HelarcController.js";

export const HELARC_NATIVE_REPLACEMENT_CHECKPOINT="helarc.native-input-replacement.v1";
export interface HelarcNativeInputReplacement {
  readonly revision:"1";
  readonly rootActivityId:string;
  readonly activityId:string;
  readonly sourceDigest:string;
  readonly deadlineAt:string;
  readonly maximum:number;
  readonly rejections:readonly ProtocolInputRejectionEvidence[];
  readonly continuationId:string;
}
export function nativeReplacementActivityId(rootActivityId:string,rejections:readonly ProtocolInputRejectionEvidence[]):string {
  return `${rootActivityId}:replacement:${rejections.length}:${digest(rejections)}`;
}
export function readHelarcNativeInputReplacement(input:TaskDecisionInputSources<HelarcAgentOutput>,context:AgentActivityExecutionContext,
  sourceDigest:string):HelarcNativeInputReplacement|null {
  const saved=context.checkpoints?.read(HELARC_NATIVE_REPLACEMENT_CHECKPOINT) as HelarcNativeInputReplacement|null|undefined;
  if(!saved)return null;
  const root=`${input.toolExposure.controllerRequestId}:native-task`;
  if(saved.revision!=="1"||saved.rootActivityId!==root||saved.sourceDigest!==sourceDigest||saved.deadlineAt!==context.retry.deadlineAt||
    !Number.isSafeInteger(saved.maximum)||saved.maximum<1||!Array.isArray(saved.rejections)||!saved.rejections.length||saved.rejections.length>saved.maximum||
    !saved.continuationId||saved.activityId!==nativeReplacementActivityId(root,saved.rejections)||
    saved.rejections.some((r,i)=>r.kind!=="recipient"||r.boundary!==sourceDigest||r.activityId!==(i===0?root:nativeReplacementActivityId(root,saved.rejections.slice(0,i)))))
    throw new TypeError("native_input_replacement_checkpoint_changed");
  return saved;
}

export async function confirmHelarcNativeInputReplacement(journal:ProtocolExecutionJournal,replacement:HelarcNativeInputReplacement,
  input:TaskDecisionInputSources<HelarcAgentOutput>,context:AgentActivityExecutionContext):Promise<void>{
  let original:ProtocolExecutionState|null=null;
  const inputIds=new Set<string>();
  for(const evidence of replacement.rejections){
    const state=await journal.command({kind:"state",activityId:evidence.activityId}) as ProtocolExecutionState|null;
    if(!state||state.activity.scope.runId!==input.runId||digest(state.inputRefusal)!==digest(evidence)||
      evidence.boundary!==replacement.sourceDigest||state.accepted||inputIds.has(evidence.inputId))
      throw new TypeError("native_input_replacement_rejection_changed");
    if(original&&(digest(state.activity.composition)!==digest(original.activity.composition)||
      state.activity.scope.recipientId!==original.activity.scope.recipientId||
      digest(state.activity.scope.purpose)!==digest(original.activity.scope.purpose)||
      digest(state.activity.conditions.authority)!==digest(original.activity.conditions.authority)))
      throw new TypeError("native_input_replacement_scope_changed");
    const retained=await readProtocolInputRejection(journal,state);
    if(!retained||retained.proof.scope.id!==evidence.scopeId)throw new TypeError("native_input_replacement_basis_missing");
    const activity=createModelActivityBinding({runId:input.runId,activityId:input.toolExposure.controllerRequestId,
      purpose:state.activity.scope.purpose.id,owner:{kind:"task_decision",inputOwner:"context_representation"}});
    const sequence=inputIds.size+1,expected=createActivityContinuationArrangement({activity,
      sourceRequestId:`${state.activity.scope.activityId}:request`,sourceResponseId:null,sequence,
      cause:{kind:"capacity_rejection",location:"provider",code:"provider_context_window_exceeded"}});
    const accepted=new ActivityContinuationCoordinator(context.checkpoints).readAccepted(expected);
    if(!accepted||sequence>replacement.maximum||sequence===replacement.rejections.length&&accepted.id!==replacement.continuationId)
      throw new TypeError("native_input_replacement_continuation_missing");
    original??=state;inputIds.add(evidence.inputId);
  }
}
