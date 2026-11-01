import assert from "node:assert/strict";

export const baselineScenarios = Object.freeze([
  "accepted", "effect", "child", "opening_prepared", "continued_child", "approval", "approval_applied",
  "ending_feedback", "ending_exhausted", "interaction_admitted", "interaction_prepared", "interaction_accepted",
  "interaction_call_feedback", "interaction_steering", "material_child", "material_read_prepared",
]);

// These are real verifier invocations, not acknowledgements that retired cases passed.
export const recoveryChecks = Object.freeze([
  {id:"task-input",script:"verify-activity-handoffs.mjs",args:["--task-input-supply"],
    coverage:"Original need, source publication, prepared selection, saved response and professional acceptance across five processes; exact sent bytes and one external call."},
  {id:"method-adoption",script:"verify-representation-methods.mjs",args:["--adoption"],
    coverage:"Saved generation/check responses, retained candidate, independent materialization, combination check, joint selection and actual recipient request across seven processes."},
  {id:"layered-adoption",script:"verify-representation-methods.mjs",args:["--layered","--adoption","--whole-check-target-capacity"],
    coverage:"Bounded leaf/merge processing under the local fixture split limit, then whole-input checking against the actual target capacity and recipient adoption; source/generation/check/consumer recovery, not interruption after every merge raw result."},
  {id:"background-policy",script:"verify-representation-methods.mjs",args:["--normal-policy","--adoption"],
    coverage:"Accepted background investment while foreground continues, durable reconsideration and separately checked adoption; generation alone does not acknowledge recipient delivery."},
  {id:"method-resupply",script:"verify-representation-methods.mjs",args:["--ordinary-resupply"],
    coverage:"An original producer reused after a later input boundary, without repeating generation; each complete recipient input is independently checked and sent."},
  {id:"host-pressure",script:"verify-host-activities.mjs",args:["--application","--pressure"],
    coverage:"Real application Host recovery, actual representation work, retained effects and Child reports, independent response interpretation before Continue, and settled activity lifecycles."},
  {id:"provider-attempt",script:"verify-representation-methods.mjs",args:["--method-retry"],
    coverage:"A saved 503 result at the original generate stage survives process exit; shared attempt retry preserves the original encoded body and original method responsibility."},
  {id:"method-input-rejection",script:"verify-representation-methods.mjs",args:["--provider-input-rejection"],
    coverage:"A saved Provider capacity refusal is interpreted under the original method; replacement input differs from the rejected bytes instead of technically retrying them."},
  {id:"host-input-rejection",script:"verify-host-activities.mjs",args:["--application","--capacity-recovery"],
    coverage:"A saved task capacity refusal resumes under the real Host, prepares a supported replacement and finishes without repeating the original write or Child work."},
]);

export const migratedScenarios = Object.freeze({
  context_intent:["task-input"],
  context_candidate:["task-input"],
  context_selected:["task-input"],
  context_frozen:["task-input"],
  context_returned:["task-input"],
  context_accepted:["task-input"],
  semantic_generated:["method-adoption"],
  semantic_assessed:["method-adoption"],
  semantic_candidate:["method-adoption"],
  semantic_leaf:["layered-adoption"],
  semantic_merge:["layered-adoption"],
  semantic_background:["background-policy","host-pressure"],
  semantic_background_adopt:["background-policy","method-resupply","host-pressure"],
  provider_failure_saved:["provider-attempt"],
  provider_capacity_saved:["method-input-rejection","host-input-rejection"],
});

export function planRecoveryVerification(selectors = []) {
  const requested=selectors.length?selectors:[...baselineScenarios,...Object.keys(migratedScenarios)];
  const baselines=new Set(),checks=new Set(),migrations=[];
  for(const selector of new Set(requested)) {
    if(baselineScenarios.includes(selector)) {baselines.add(selector);continue;}
    if(recoveryChecks.some(check=>check.id===selector)) {checks.add(selector);continue;}
    assert(Object.hasOwn(migratedScenarios,selector),`Unknown recovery scenario: ${selector}`);
    const replacements=migratedScenarios[selector];
    // Old mixed fixtures also asserted one retained shell effect. Keep that real
    // baseline alongside the independent public-protocol verifications.
    baselines.add("effect");
    replacements.forEach(id=>checks.add(id));
    migrations.push({retired:selector,baseline:["effect"],checks:replacements});
  }
  return {
    baseline:baselineScenarios.filter(id=>baselines.has(id)),
    checks:recoveryChecks.filter(check=>checks.has(check.id)),
    migrations,
  };
}
