import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import type {ActivityPathIntent,ActivityPathState,ActivitySchedulingIntent,ActivitySchedulingAcceptance,ActivityReconsiderationSnapshot,SharedAcceptanceProposal} from "../activity/index.js";
import {decideContextPreparation,type ContextPreparationPolicyInput,type ContextPreparationDecision} from "./ContextPreparationPolicy.js";
import type {RepresentationMethodWork} from "./methods/RepresentationMethodWork.js";

export interface ContextPreparationExecutionArrangement {
  readonly path:Omit<ActivityPathIntent,"purpose"|"owner"|"scheduledWorkId">;
  readonly workId:string;
  readonly resources:ActivitySchedulingIntent["resources"];
  readonly timing:ActivitySchedulingIntent["timing"];
  readonly original?:{readonly path:ActivityPathState;readonly scheduling:ActivitySchedulingAcceptance};
}

/** CRM packages a professional decision; common participants accept it and dispatch separately. */
export function contextPreparationAcceptance(input:{
  readonly id:string;
  readonly input:ContextPreparationPolicyInput;
  readonly expectedDecisionId:string|null;
  readonly expectedControlRevision:number;
  readonly reconsideration:ActivityReconsiderationSnapshot|null;
  readonly execution:ContextPreparationExecutionArrangement|null;
  readonly methods:Pick<RepresentationMethodWork,"prepareSubmission">;
}):{readonly decision:ContextPreparationDecision;readonly acceptance:SharedAcceptanceProposal} {
  const decision=decideContextPreparation(input.input),parts:SharedAcceptanceProposal["parts"][number][]=[];
  if(input.input.scope.owner!=="context-representation")throw new TypeError("context_policy_owner_invalid");
  let investment:import("./ContextPreparationDecisionStore.js").ContextPreparationInvestment|null=null;
  if(decision.investment.kind==="propose") {
    const execution=input.execution;
    // Narrow the chosen proposal once; the method still validates its complete request and bounds.
    const chosenId=decision.investment.optionId;
    const chosen=input.input.options.find(o=>o.id===chosenId);
    if(!execution||!chosen||execution.path.runId!==decision.scope.runId||
      execution.path.maximumStages!==chosen.limits.maximumStages||execution.path.maximumAttempts!==chosen.limits.maximumAttempts)
      throw new TypeError("context_policy_execution_arrangement_invalid");
    investment={workId:execution.workId,pathId:execution.path.id};
    const intent:ActivitySchedulingIntent={id:`${input.id}:scheduling`,workId:execution.workId,runId:decision.scope.runId,scopeId:decision.scope.runId,
      owner:"context-representation",decisionId:decision.id,policyRevision:`${decision.policy.id}:${decision.policy.revision}`,
      reason:decision.investment.reason,delayImpact:decision.investment.reason==="necessary"?"No usable current input":
        decision.investment.reason==="opportunity"?"Evidence-backed future input or method-entry opportunity":"Optional improvement; current input remains usable",
      resources:execution.resources,timing:execution.timing};
    const original=execution.original,replaces=decision.investment.replaces;
    if(Boolean(original)!==Boolean(replaces))throw new TypeError("context_policy_revision_binding_missing");
    if(original&&replaces) {
      const previous=original.path.intent;
      if(previous.id!==replaces.pathId||previous.id===execution.path.id||previous.scheduledWorkId!==replaces.workId||execution.workId!==replaces.workId||
        original.scheduling.intent.workId!==replaces.workId||original.scheduling.closed||previous.runId!==execution.path.runId||
        previous.resourceScope!==execution.path.resourceScope||previous.deadlineAt!==execution.path.deadlineAt||
        previous.maximumStages!==execution.path.maximumStages||previous.maximumAttempts!==execution.path.maximumAttempts||previous.maximumConcurrent!==execution.path.maximumConcurrent||
        previous.permissionBasis!==execution.path.permissionBasis||modelInputValueDigest(original.scheduling.intent.resources)!==modelInputValueDigest(execution.resources))
        throw new TypeError("context_policy_revision_cannot_reset_original_work");
      investment={...investment,previousPathId:previous.id};
      if(!original.path.cancelled)parts.push({owner:"activity",kind:"path_cancellation",proposal:{kind:"cancel",pathId:previous.id,expectedControlRevision:original.path.controlRevision}});
    }
    parts.push({owner:"activity",kind:"scheduling_acceptance",proposal:{kind:"schedule_work",intent:original?{...original.scheduling.intent,
      id:intent.id,decisionId:decision.id,reason:intent.reason,delayImpact:intent.delayImpact,timing:intent.timing}:intent,expectedRevision:original?.scheduling.revision??0}},
      ...input.methods.prepareSubmission({...execution.path,scheduledWorkId:execution.workId},chosen.request));
  } else if(input.execution)throw new TypeError("context_policy_execution_without_investment");
  if(input.reconsideration) {
    const boundary=input.reconsideration;
    if(boundary.state.closed||boundary.state.subscription.owner!=="context-representation"||boundary.state.subscription.runId!==decision.scope.runId)
      throw new TypeError("context_policy_reconsideration_scope_invalid");
    parts.unshift({owner:"activity",kind:"reconsideration_acceptance",proposal:{id:input.id,subscriptionId:boundary.state.subscription.id,
      expectedRevision:boundary.state.revision,through:boundary.through,factIds:boundary.facts.map(f=>f.id),
      decision:{owner:"context-representation",kind:"context_preparation_decision",id:decision.id,revision:decision.policy.revision},close:!input.input.consumerActive}});
  }
  parts.push({owner:"context_preparation_policy",kind:"decision",proposal:{input:input.input,
    expectedDecisionId:input.expectedDecisionId,expectedControlRevision:input.expectedControlRevision,investment}});
  return {decision,acceptance:{id:input.id,scope:decision.scope.runId,actor:"context-representation",parts}};
}

/** Stable retry identity includes finite B and the expected predecessor, never a wall-clock retry count. */
export function contextPreparationAcceptanceId(input:ContextPreparationPolicyInput,expectedDecisionId:string|null,
  boundary:ActivityReconsiderationSnapshot|null):string {
  return `context-policy-acceptance:${modelInputValueDigest({input,expectedDecisionId,
    boundary:boundary?{subscriptionId:boundary.state.subscription.id,revision:boundary.state.revision,through:boundary.through,facts:boundary.facts.map(f=>f.id)}:null})}`;
}
