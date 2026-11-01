import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {validateActivitySchedulingIntent,type ActivitySchedulingIntent} from "../activity/ActivityScheduling.js";
import type {ContextMethodInputPlan} from "./ContextMethodInputSupply.js";

/** Scope of recipient-owned scheduling, not ownership of the shared producer. */
export function validateMethodInputScheduling(plan:ContextMethodInputPlan):void {
  if(plan.revision!=="5")throw new TypeError("method_input_plan_revision_unavailable");
  const producers:ContextMethodInputPlan["producers"]=plan.producers;
  if(!Array.isArray(plan.producers)||!producers.length||new Set(producers.map(p=>p.pathId)).size!==producers.length||
    producers.some(p=>!p.pathId||!p.candidateIds.length||new Set(p.candidateIds).size!==p.candidateIds.length||p.candidateIds.some(id=>!id)))
    throw new TypeError("method_input_producers_invalid");
  const scheduling=plan.scheduling;
  if(scheduling===null)return;
  if(!scheduling)throw new TypeError("method_input_scheduling_binding_missing");
  validateActivitySchedulingIntent(scheduling);
  const paths=[plan.materialization.intent,plan.materialization.request.preparationIntent,plan.check.intent];
  if(scheduling.owner!==plan.scope.owner||scheduling.runId!==plan.scope.runId||scheduling.delegatedPathOwners?.length||
    !scheduling.allowedPathIds||scheduling.allowedPathIds.length!==3||new Set(paths.map(path=>path.id)).size!==3||
    paths.some(path=>plan.producers.some(p=>p.pathId===path.id)||path.runId!==scheduling.runId||path.scheduledWorkId!==scheduling.workId||!scheduling.allowedPathIds!.includes(path.id)))
    throw new TypeError("method_input_scheduling_scope_invalid");
}

export function sameMethodInputSchedulingBinding(original:ActivitySchedulingIntent,current:ActivitySchedulingIntent):boolean {
  const binding=(intent:ActivitySchedulingIntent)=>({workId:intent.workId,runId:intent.runId,scopeId:intent.scopeId,owner:intent.owner,
    resources:intent.resources,delegatedPathOwners:intent.delegatedPathOwners??[],allowedPathIds:intent.allowedPathIds?[...intent.allowedPathIds].sort():null});
  return modelInputValueDigest(binding(original))===modelInputValueDigest(binding(current));
}
