import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import type {ContextUseScope} from "@agent-anything/context/selection";
import {validatePreparedContextInput,type PreparedContextInput,type ContextInputPreparationGap} from "./ContextInputPreparation.js";
import {quoteRepresentationMethod,type RepresentationMethodQuotation} from "./methods/RepresentationMethodQuotation.js";
import type {RepresentationMethodRequest} from "./methods/RepresentationMethod.js";

export const INITIAL_CONTEXT_PREPARATION_POLICY={id:"context.normal-preparation",revision:"1",maximumOptions:16,
  observations:8,minimumObservations:3,maximumExplorations:1,maximumOptionalPerRecipient:1,
  input:{maximumCombinations:32,maximumExternalMeasurements:8},
  method:{maximumStages:2048,maximumAttempts:4096,maximumConcurrent:1,deadlineMs:60*60*1000,
    bounds:{readBytes:64*1024*1024,storedBytes:32*1024*1024,modelCalls:32,repairs:1,levels:4,pageBytes:64*1024,ranges:64}},
  maximumTransportAttempts:3} as const;

export interface ContextPolicyEvidence {
  readonly id:string;
  readonly revision:string;
  readonly owner:string;
  readonly kind:"fact"|"estimate"|"judgment"|"policy";
}
export interface ContextCostComparison {
  readonly dimension:"external_calls"|"billed_tokens"|"elapsed_ms"|"retained_bytes"|"detail_accesses";
  readonly basis:ContextPolicyEvidence;
  /** A comparison covers all remaining preparation, checks, adoption and subsequent use. */
  readonly coverage:"remaining_path_and_use"|"partial";
  readonly baseline:{readonly minimum:number;readonly maximum:number|null};
  readonly alternative:{readonly minimum:number;readonly maximum:number|null};
}
export type ContextCurrentInput =
  | {readonly kind:"prepared";readonly prepared:PreparedContextInput;readonly evidence:ContextPolicyEvidence}
  | {readonly kind:"gap";readonly gap:ContextInputPreparationGap;readonly evidence:ContextPolicyEvidence};
export type ContextPreparationPressure =
  | {readonly kind:"successor_gap";readonly input:ContextInputPreparationGap;readonly evidence:ContextPolicyEvidence}
  | {readonly kind:"growth_scenario";readonly evidence:ContextPolicyEvidence;readonly timing:ContextTimingComparison|null}
  | {readonly kind:"method_entry_loss";readonly evidence:ContextPolicyEvidence;readonly changedBackground:readonly string[]}
  | {readonly kind:"optional_improvement";readonly evidence:ContextPolicyEvidence;readonly comparisons:readonly ContextCostComparison[]};
export interface ContextTimingComparison {
  readonly preparation:{readonly minimum:number;readonly maximum:number|null};
  readonly pressure:{readonly minimum:number;readonly maximum:number|null};
  readonly evidence:readonly ContextPolicyEvidence[];
  readonly includesQueue:boolean;
  readonly arrangement:"serial"|"critical_path";
}
export interface ContextPreparationOption {
  readonly id:string;
  readonly request:RepresentationMethodRequest;
  readonly stableScope:ContextPolicyEvidence|null;
  /** The proposal's owner declares relevance; the policy does not infer it from natural language. */
  readonly addresses:readonly string[];
  readonly entries:readonly {readonly phase:RepresentationMethodQuotation["phases"][number]["kind"];
    readonly state:"supported"|"unknown"|"blocked";readonly evidence:ContextPolicyEvidence}[];
  readonly limits:{readonly maximumStages:number;readonly maximumAttempts:number};
  readonly capability:readonly {readonly duty:"generation"|"assessment";readonly conclusion:"supported"|"limited"|"unknown"|"conflicting";
    readonly targetRevision:string;readonly methodRevision:string;readonly evidence:ContextPolicyEvidence;readonly response:ContextPolicyEvidence|null}[];
  readonly comparisons:readonly ContextCostComparison[];
  readonly admissionConditions?:readonly ContextPolicyEvidence[];
  /** An explicit CRM revision of settled original work, not permission to restart unknown execution. */
  readonly replaces?:{readonly workId:string;readonly pathId:string;readonly evidence:ContextPolicyEvidence};
}
export interface ContextPreparationAdmissionLimitation {
  readonly optionId:string;
  readonly conditionsDigest:string;
  readonly acceptanceId:string;
  readonly code:string;
}
export interface ContextPreparationPolicyInput {
  readonly scope:ContextUseScope;
  readonly boundary:string;
  readonly requirementsDigest:string;
  readonly current:ContextCurrentInput;
  readonly currentRejectedInputId:string|null;
  readonly alternatives:readonly {readonly input:ContextCurrentInput;readonly comparisons:readonly ContextCostComparison[]}[];
  readonly pressure:readonly ContextPreparationPressure[];
  readonly options:readonly ContextPreparationOption[];
  readonly inFlight:readonly {readonly workId:string;readonly pathId:string;readonly applicabilityKey:string;
    readonly producerState:"accepted"|"active"|"ready"|"unknown"|"failed"|"cancelled";readonly evidence:ContextPolicyEvidence}[];
  readonly explorationHistory:readonly {readonly key:string;readonly decisionId:string}[];
  readonly optionalInFlight:number;
  readonly autoPrepare:boolean;
  readonly consumerActive:boolean;
  readonly admissionLimitations?:readonly ContextPreparationAdmissionLimitation[];
  /** Record the received rejection first; choosing a replacement is a later, separately justified decision. */
  readonly admissionResponse?:string;
  readonly unusedProducers?:readonly {readonly workId:string;readonly pathId:string;readonly evidence:ContextPolicyEvidence}[];
}
export interface ContextPreparationDecision {
  readonly id:string;
  readonly policy:typeof INITIAL_CONTEXT_PREPARATION_POLICY;
  readonly scope:ContextUseScope;
  readonly boundary:string;
  readonly applicabilityKey:string;
  readonly evidence:readonly ContextPolicyEvidence[];
  readonly foreground:
    | {readonly kind:"continue";readonly preparedInputId:string;readonly adoption:"keep"|"propose";readonly risks:readonly string[]}
    | {readonly kind:"needs_result";readonly workId:string;readonly pathId:string}
    | {readonly kind:"limited";readonly reason:string};
  readonly investment:
    | {readonly kind:"none";readonly reason:string}
    | {readonly kind:"reuse";readonly workId:string;readonly pathId:string;readonly requiredService:"necessary"|"opportunity"|null}
    | {readonly kind:"defer";readonly reason:string;readonly reconsiderOn:readonly string[]}
    | {readonly kind:"propose";readonly optionId:string;readonly quotation:RepresentationMethodQuotation;readonly reason:"necessary"|"opportunity"|"optional";
        readonly explorationKey:string|null;readonly uncertainty:readonly string[];readonly replaces?:ContextPreparationOption["replaces"]};
  readonly excluded:readonly {readonly optionId:string;readonly reasons:readonly string[]}[];
  readonly limitations:readonly string[];
}

export function contextPreparationApplicabilityKey(input:Pick<ContextPreparationPolicyInput,"scope"|"boundary"|"requirementsDigest">):string {
  return modelInputValueDigest({scope:input.scope,boundary:input.boundary,requirements:input.requirementsDigest});
}
export function contextPreparationAdmissionKey(input:Pick<ContextPreparationPolicyInput,"scope"|"boundary"|"requirementsDigest">,option:ContextPreparationOption):string {
  return modelInputValueDigest({scope:contextPreparationApplicabilityKey(input),option});
}

/** Pure professional policy. Scheduling, accepting a selection and executing are separate owners. */
export function decideContextPreparation(input:ContextPreparationPolicyInput):ContextPreparationDecision {
  validateInput(input);
  const key=contextPreparationApplicabilityKey(input),evidence:ContextPolicyEvidence[]=[input.current.evidence],excluded:ContextPreparationDecision["excluded"][number][]=[];
  const limitations:string[]=[],policy=INITIAL_CONTEXT_PREPARATION_POLICY;
  evidence.push(...(input.unusedProducers??[]).map(p=>p.evidence));
  let selected=input.current.kind==="prepared"&&input.current.prepared.encoded.id!==input.currentRejectedInputId?input.current:null;
  let adoption:"keep"|"propose"="keep";
  for(const alternative of input.alternatives.slice(0,policy.maximumOptions)) {
    if(alternative.input.kind!=="prepared"||alternative.input.prepared.encoded.id===input.currentRejectedInputId)continue;
    if(!selected||netImprovement(alternative.comparisons)) {
      selected=alternative.input;adoption="propose";evidence.push(alternative.input.evidence,...alternative.comparisons.map(c=>c.basis));break;
    }
  }
  if(input.alternatives.length>policy.maximumOptions)limitations.push("alternatives_search_incomplete");
  const foreground:ContextPreparationDecision["foreground"]=selected?{kind:"continue",preparedInputId:selected.prepared.encoded.id,adoption,
    risks:selected.prepared.capacity.decisions.filter(d=>d.conclusion!=="within").map(d=>`${d.limitId}:${d.reason}`)}:{kind:"limited",reason:"no_accepted_producer_or_usable_input"};
  const finish=(investment:ContextPreparationDecision["investment"],front:ContextPreparationDecision["foreground"]=foreground):ContextPreparationDecision=>{
    const value={policy,scope:input.scope,boundary:input.boundary,applicabilityKey:key,evidence:uniqueEvidence(evidence),foreground:front,investment,excluded,limitations};
    return {id:`context-decision:${modelInputValueDigest({input,value})}`,...value};
  };
  if(!input.consumerActive)return finish({kind:"none",reason:"no_active_consumer"},{kind:"limited",reason:"no_active_consumer"});
  if(input.admissionResponse) {
    const limitation=input.admissionLimitations?.find(l=>l.acceptanceId===input.admissionResponse);
    if(!limitation)throw new TypeError("context_policy_admission_response_missing");
    evidence.push({owner:"activity",kind:"fact",id:limitation.acceptanceId,revision:"1"});
    return finish({kind:"defer",reason:`admission_rejected:${limitation.code}`,reconsiderOn:["admission_conditions_changed","alternative_path_available","current_control_changed"]});
  }
  const applicable=input.inFlight.filter(work=>work.applicabilityKey===key&&!input.unusedProducers?.some(p=>p.workId===work.workId&&p.pathId===work.pathId));
  const ready=applicable.find(work=>work.producerState==="ready");
  if(ready) {
    evidence.push(ready.evidence);
    return finish({kind:"defer",reason:"retained_result_requires_recipient_input_organization",reconsiderOn:["complete_input_prepared","result_applicability_changed"]});
  }
  const existing=applicable.find(work=>["accepted","active"].includes(work.producerState));
  if(existing) {
    evidence.push(existing.evidence);
    const opportunity=input.pressure.filter(p=>p.kind!=="optional_improvement"&&supportsInvestment(p));
    evidence.push(...opportunity.map(p=>p.evidence));
    return finish({kind:"reuse",workId:existing.workId,pathId:existing.pathId,requiredService:!selected?"necessary":opportunity.length?"opportunity":null},selected?foreground:{kind:"needs_result",workId:existing.workId,pathId:existing.pathId});
  }
  if(applicable.some(work=>work.producerState==="unknown"))return finish({kind:"defer",reason:"original_producer_outcome_unknown",reconsiderOn:["original_acceptance_resolved"]});
  const settled=applicable.filter(work=>["failed","cancelled"].includes(work.producerState));
  if(settled.length&&!input.options.some(option=>option.replaces&&settled.some(work=>work.workId===option.replaces!.workId&&work.pathId===option.replaces!.pathId)))
    return finish({kind:"defer",reason:"original_path_requires_bounded_revision",reconsiderOn:["replacement_path_accepted","relevant_evidence_changed"]});
  if(!input.autoPrepare)return finish({kind:"none",reason:"automatic_preparation_disabled"});
  const pressure=input.pressure.filter(p=>supportsInvestment(p));
  const reason=!selected?"necessary":pressure.some(p=>p.kind!=="optional_improvement")?"opportunity":pressure.length?"optional":null;
  if(!reason)return finish({kind:"none",reason:"no_current_gap_or_supported_opportunity"});
  if(reason==="optional"&&input.optionalInFlight>=policy.maximumOptionalPerRecipient)return finish({kind:"defer",reason:"optional_work_already_active",reconsiderOn:["optional_work_settled"]});
  const relevant=reason==="necessary"?[input.current.evidence.id]:pressure.filter(p=>reason==="opportunity"?p.kind!=="optional_improvement":true).map(p=>p.evidence.id);
  evidence.push(...pressure.filter(p=>relevant.includes(p.evidence.id)).map(p=>p.evidence));
  evidence.push(...pressure.filter(p=>p.kind==="optional_improvement"&&relevant.includes(p.evidence.id)).flatMap(p=>p.kind==="optional_improvement"?p.comparisons.map(c=>c.basis):[]));
  const eligible:{option:ContextPreparationOption;quote:RepresentationMethodQuotation;unknown:string[];explorationKey:string|null}[]=[];
  for(const option of input.options.slice(0,policy.maximumOptions)) {
    const quote=quoteRepresentationMethod(option.request),reasons=[...quote.gaps],unknown=[...quote.unknowns];
    if(settled.length&&!option.replaces)reasons.push("original_work_revision_required");
    if(option.replaces) {
      uniqueEvidence([option.replaces.evidence]);
      if(!settled.some(work=>work.workId===option.replaces!.workId&&work.pathId===option.replaces!.pathId))reasons.push("original_work_not_settled");
    }
    for(const limited of input.admissionLimitations??[])if(limited.optionId===option.id&&limited.conditionsDigest===contextPreparationAdmissionKey(input,option)) {
      reasons.push(`admission_rejected:${limited.code}`);
      evidence.push({owner:"activity",kind:"fact",id:limited.acceptanceId,revision:"1"});
    }
    if(!option.addresses.some(id=>relevant.includes(id)))reasons.push("no_relevance_basis");
    if(reason!=="necessary"&&!option.stableScope)reasons.push("stable_processing_scope_unconfirmed");
    if(quote.minimum.stages>option.limits.maximumStages||quote.minimum.attempts>option.limits.maximumAttempts)reasons.push("known_execution_work_exceeds_limit");
    for(const phase of quote.phases) {
      const entry=option.entries.find(e=>e.phase===phase.kind);
      if(!entry)reasons.push(`entry_evidence_missing:${phase.kind}`);
      else if(entry.state==="blocked"&&phase.condition==="required")reasons.push(`entry_blocked:${phase.kind}`);
      else if(entry.state!=="supported")unknown.push(`entry_${entry.state}:${phase.kind}`);
    }
    for(const duty of ["generation","assessment"] as const) {
      if(duty==="generation"&&!quote.phases.some(p=>p.kind==="generate")||duty==="assessment"&&!quote.phases.some(p=>p.kind==="check"))continue;
      const observed=option.capability.filter(c=>c.duty===duty&&c.targetRevision===option.request.targetRevision&&c.methodRevision===option.request.methodRevision);
      if(!observed.length)unknown.push(`capability_unknown:${duty}`);
      for(const capability of observed) {
        if(["limited","conflicting"].includes(capability.conclusion)&&!capability.response)reasons.push(`capability_response_missing:${duty}`);
        if(capability.conclusion!=="supported")unknown.push(`capability_${capability.conclusion}:${duty}`);
      }
    }
    if(reason==="optional"&&!netImprovement(option.comparisons))reasons.push("net_improvement_not_established");
    // A known successor gap needs no statistical warm-up; uncertainty still remains in its bounded path.
    const exploratory=reason==="opportunity"&&!pressure.some(p=>p.kind==="successor_gap"||p.kind==="method_entry_loss"||p.kind==="growth_scenario"&&p.timing&&timingSupportsPreparation(p.timing)==="now");
    const explorationKey=exploratory?modelInputValueDigest({key,pressure:pressure.map(p=>p.evidence),method:option.request.method,
      target:option.request.targetRevision,requirements:option.request.requirements,conditions:option.entries}):null;
    if(explorationKey&&input.explorationHistory.some(h=>h.key===explorationKey))reasons.push("same_opportunity_exploration_already_attempted");
    if(reasons.length)excluded.push({optionId:option.id,reasons});else eligible.push({option,quote,unknown,explorationKey});
  }
  if(input.options.length>policy.maximumOptions)limitations.push("method_option_search_incomplete");
  if(!eligible.length)return finish({kind:"defer",reason:"no_supported_complete_path",reconsiderOn:["relevant_evidence_changed","method_path_changed","current_control_changed"]});
  // Prefer a path with fewer unresolved entry conditions, then less new semantic generation; no currency weights.
  eligible.sort((a,b)=>a.unknown.filter(v=>v.startsWith("entry_")).length-b.unknown.filter(v=>v.startsWith("entry_")).length||
    Number(a.quote.phases.some(p=>p.kind==="generate"))-Number(b.quote.phases.some(p=>p.kind==="generate"))||a.option.request.method.localeCompare(b.option.request.method)||a.option.id.localeCompare(b.option.id));
  const choice=eligible[0]!;
  evidence.push(...choice.option.comparisons.map(c=>c.basis));
  evidence.push(...choice.option.entries.map(e=>e.evidence),...choice.option.capability
    .filter(c=>c.targetRevision===choice.option.request.targetRevision&&c.methodRevision===choice.option.request.methodRevision)
    .flatMap(c=>c.response?[c.evidence,c.response]:[c.evidence]));
  if(choice.option.stableScope)evidence.push(choice.option.stableScope);
  if(choice.option.replaces)evidence.push(choice.option.replaces.evidence);
  return finish({kind:"propose",optionId:choice.option.id,quotation:choice.quote,reason,explorationKey:choice.explorationKey,uncertainty:choice.unknown,
    ...(choice.option.replaces?{replaces:choice.option.replaces}:{})});
}

export function timingSupportsPreparation(value:ContextTimingComparison):"now"|"later"|"unknown" {
  interval(value.preparation);interval(value.pressure);
  if(!value.includesQueue||!value.evidence.length||value.preparation.maximum===null)return "unknown";
  return value.preparation.maximum>=value.pressure.minimum?"now":"later";
}
function supportsInvestment(pressure:ContextPreparationPressure):boolean {
  if(pressure.kind==="successor_gap")return pressure.input.information.length>0||pressure.input.capacity.some(c=>!c.allowed);
  if(pressure.kind==="method_entry_loss")return pressure.changedBackground.length>0;
  if(pressure.kind==="optional_improvement")return netImprovement(pressure.comparisons);
  return !pressure.timing||timingSupportsPreparation(pressure.timing)!=="later";
}
function netImprovement(comparisons:readonly ContextCostComparison[]):boolean {
  const dimensions:readonly ContextCostComparison["dimension"][]=["external_calls","billed_tokens","elapsed_ms","retained_bytes","detail_accesses"];
  // A saving in one dimension cannot stand in for the complete path and its interference.
  if(comparisons.length!==dimensions.length||dimensions.some(d=>comparisons.filter(c=>c.dimension===d).length!==1))return false;
  let better=false;
  for(const c of comparisons) {
    interval(c.baseline);interval(c.alternative);
    if(c.coverage!=="remaining_path_and_use"||c.alternative.maximum===null||c.alternative.maximum>c.baseline.minimum)return false;
    if(c.alternative.maximum<c.baseline.minimum)better=true;
  }
  return better;
}
function interval(value:{minimum:number;maximum:number|null}):void {
  if(!Number.isFinite(value.minimum)||value.minimum<0||value.maximum!==null&&(!Number.isFinite(value.maximum)||value.maximum<value.minimum))throw new TypeError("context_cost_interval_invalid");
}
function uniqueEvidence(values:readonly ContextPolicyEvidence[]):ContextPolicyEvidence[] {
  const result=new Map<string,ContextPolicyEvidence>();
  for(const value of values) {
    if(!value.id||!value.revision||!value.owner||!["fact","estimate","judgment","policy"].includes(value.kind))throw new TypeError("context_policy_evidence_invalid");
    const key=JSON.stringify([value.owner,value.id,value.revision]),old=result.get(key);
    if(old&&modelInputValueDigest(old)!==modelInputValueDigest(value))throw new TypeError("context_policy_evidence_conflict");result.set(key,value);
  }
  return [...result.values()];
}
function validateInput(input:ContextPreparationPolicyInput):void {
  if(!input.boundary||!input.requirementsDigest||!input.scope.id||!input.scope.runId||!input.scope.target||
    !Number.isSafeInteger(input.optionalInFlight)||input.optionalInFlight<0)throw new TypeError("context_policy_scope_invalid");
  for(const current of [input.current,...input.alternatives.map(a=>a.input)]) {
    uniqueEvidence([current.evidence]);
    if(current.kind==="prepared") {
      validatePreparedContextInput(current.prepared);const demand=current.prepared.demand;
      if(demand.runId!==input.scope.runId||demand.recipient!==input.scope.recipient||demand.purpose!==input.scope.purpose||demand.targetRevision!==input.scope.target)throw new TypeError("context_policy_input_scope_mismatch");
    } else if(current.gap.targetRevision!==input.scope.target)throw new TypeError("context_policy_gap_target_mismatch");
  }
  for(const pressure of input.pressure)uniqueEvidence([pressure.evidence]);
  for(const option of input.options) {
    if(option.request.recipient.runId!==input.scope.runId||option.request.targetRevision!==input.scope.target||option.request.sourceBoundary!==input.boundary)throw new TypeError("context_policy_method_scope_mismatch");
    if(!Number.isSafeInteger(option.limits.maximumStages)||option.limits.maximumStages<1||!Number.isSafeInteger(option.limits.maximumAttempts)||option.limits.maximumAttempts<1)throw new TypeError("context_policy_execution_limit_invalid");
  }
}
