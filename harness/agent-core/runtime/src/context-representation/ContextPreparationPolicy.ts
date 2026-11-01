import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import type {ContextUseScope} from "@agent-anything/context/selection";
import {validatePreparedContextInput,type PreparedContextInput,type ContextInputPreparationGap} from "./ContextInputPreparation.js";
import {quoteRepresentationMethod,type RepresentationMethodQuotation} from "./methods/RepresentationMethodQuotation.js";
import type {RepresentationMethodRequest} from "./methods/RepresentationMethod.js";

export const INITIAL_CONTEXT_PREPARATION_POLICY={id:"context.normal-preparation",revision:"8",maximumOptions:16,maximumReceptionInspections:256,
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
  | {readonly kind:"input_capacity_risk";readonly evidence:ContextPolicyEvidence}
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
  /** Declared transformable text only, not token savings or a candidate-fit prediction. */
  readonly sourceExtent?:{readonly utf8Bytes:number;readonly evidence:ContextPolicyEvidence};
  readonly admissionConditions?:readonly ContextPolicyEvidence[];
  /** An explicit CRM revision of settled original work, not permission to restart unknown execution. */
  readonly replaces?:{readonly workId:string;readonly pathId:string;readonly evidence:ContextPolicyEvidence};
  /** A new disjoint source, not a retry of the receiver or any of its original producers. */
  readonly extendsReception?:{readonly optionId:string;readonly evidence:ContextPolicyEvidence};
}
export interface ContextPreparationAdmissionLimitation {
  readonly optionId:string;
  readonly conditionsDigest:string;
  readonly acceptanceId:string;
  readonly code:string;
}
/** A source-owned proposal for a whole recipient input, not another production request. */
export interface ContextInputReceptionOption {
  readonly id:string;
  readonly members:readonly {readonly workId:string;readonly pathId:string;readonly requestDigest:string}[];
  readonly addresses:readonly string[];
  readonly comparisons:readonly ContextCostComparison[];
  readonly evidence:ContextPolicyEvidence;
}
export interface ContextMethodSupplyReport {
  readonly owner:string;
  readonly revision:string;
  readonly sourceBoundary:string;
  readonly enumeration:{readonly complete:boolean;readonly eligible:number;readonly returned:number};
  readonly unavailable:readonly {readonly groupId:string;readonly reasons:readonly string[]}[];
  readonly offers:readonly {readonly optionId:string;readonly scopeId:string;readonly requirementIds:readonly string[];
    readonly sources:readonly {readonly role:"source"|"background";readonly materialId:string;readonly version:string}[]}[];
  readonly originalWork?:readonly {readonly workId:string;readonly pathId:string;readonly optionId:string;
    readonly available:boolean;readonly reason:string}[];
}
export interface ContextPreparationPolicyInput {
  readonly scope:ContextUseScope;
  readonly boundary:string;
  readonly requirementsDigest:string;
  readonly current:ContextCurrentInput;
  readonly currentRejectedInputId:string|null;
  readonly rejectedInputs?:readonly {readonly stageId:string;readonly targetRevision:string;readonly bodyDigest:string;readonly evidence:ContextPolicyEvidence}[];
  readonly alternatives:readonly {readonly input:ContextCurrentInput;readonly comparisons:readonly ContextCostComparison[]}[];
  readonly pressure:readonly ContextPreparationPressure[];
  readonly options:readonly ContextPreparationOption[];
  /** Revalidated original work, not additional opportunities for new investment. */
  readonly reuseOptions?:readonly {readonly workId:string;readonly pathId:string;readonly option:ContextPreparationOption}[];
  readonly inFlight:readonly {readonly workId:string;readonly pathId:string;readonly preparationKey:string;
    readonly producerState:"accepted"|"active"|"ready"|"unknown"|"failed"|"cancelled";readonly evidence:ContextPolicyEvidence}[];
  readonly explorationHistory:readonly {readonly key:string;readonly decisionId:string}[];
  readonly optionalInFlight:number;
  readonly autoPrepare:boolean;
  readonly consumerActive:boolean;
  readonly receptionOptions?:readonly ContextInputReceptionOption[];
  readonly receptionSupplyReport?:{readonly complete:boolean;readonly examined:number;readonly conflicts:number;
    readonly returned:readonly string[];readonly restored:readonly string[]};
  /** Accepted work for this exact recipient input, distinct from the method that produced its material. */
  readonly inputReceptions?:readonly {readonly optionId:string;readonly workId:string;readonly pathId:string;
    readonly state:"active"|"checked"|"unavailable"|"unknown";readonly reason:string|null;readonly evidence:ContextPolicyEvidence;
    readonly inputGap?:Extract<ContextCurrentInput,{kind:"gap"}>;
    readonly providerRejection?:NonNullable<ContextPreparationPolicyInput["rejectedInputs"]>[number]}[];
  readonly admissionLimitations?:readonly ContextPreparationAdmissionLimitation[];
  /** Record the received rejection first; choosing a replacement is a later, separately justified decision. */
  readonly admissionResponse?:string;
  readonly unusedProducers?:readonly {readonly workId:string;readonly pathId:string;readonly evidence:ContextPolicyEvidence}[];
  readonly observationReport?:import("./ContextPreparationEvidence.js").ContextPreparationEvidenceReport;
  readonly methodSupplyReport?:ContextMethodSupplyReport;
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
    | {readonly kind:"reuse_input";readonly workId:string;readonly pathId:string;readonly requiredService:"necessary"|"opportunity"|null}
    | {readonly kind:"prepare_input";readonly optionId:string;readonly reason:"necessary"|"opportunity"|"optional"}
    | {readonly kind:"defer";readonly reason:string;readonly reconsiderOn:readonly string[]}
    | {readonly kind:"propose";readonly optionId:string;readonly quotation:RepresentationMethodQuotation;readonly reason:"necessary"|"opportunity"|"optional";
        readonly explorationKey:string|null;readonly uncertainty:readonly string[];readonly replaces?:ContextPreparationOption["replaces"]};
  readonly excluded:readonly {readonly optionId:string;readonly reasons:readonly string[]}[];
  readonly limitations:readonly string[];
}

export function contextPreparationApplicabilityKey(input:Pick<ContextPreparationPolicyInput,"scope"|"boundary"|"requirementsDigest">):string {
  return modelInputValueDigest({scope:input.scope,boundary:input.boundary,requirements:input.requirementsDigest});
}
/** Original delegated work, not the moving boundary of a recipient's next complete input. */
export function contextPreparationWorkKey(scope:ContextUseScope,request:RepresentationMethodRequest):string {
  return modelInputValueDigest({scope,request});
}
export function contextPreparationAdmissionKey(input:Pick<ContextPreparationPolicyInput,"scope"|"boundary"|"requirementsDigest">,option:ContextPreparationOption):string {
  return modelInputValueDigest({work:contextPreparationWorkKey(input.scope,option.request),entries:option.entries,capability:option.capability,
    limits:option.limits,conditions:option.admissionConditions??[],replaces:option.replaces??null});
}
export function contextReceptionAdmissionKey(input:Pick<ContextPreparationPolicyInput,"scope"|"boundary"|"requirementsDigest">,option:ContextInputReceptionOption):string {
  return modelInputValueDigest({scope:input.scope,boundary:input.boundary,requirements:input.requirementsDigest,option});
}

/** Pure professional policy. Scheduling, accepting a selection and executing are separate owners. */
export function decideContextPreparation(input:ContextPreparationPolicyInput):ContextPreparationDecision {
  validateInput(input);
  const availableOptions=[...input.options,...(input.reuseOptions??[]).map(work=>work.option)];
  const key=contextPreparationApplicabilityKey(input),evidence:ContextPolicyEvidence[]=[input.current.evidence],excluded:ContextPreparationDecision["excluded"][number][]=[];
  const limitations:string[]=[],policy=INITIAL_CONTEXT_PREPARATION_POLICY;
  evidence.push(...(input.unusedProducers??[]).map(p=>p.evidence));
  const rejected=(prepared:PreparedContextInput)=>prepared.encoded.id===input.currentRejectedInputId||
    input.rejectedInputs?.some(r=>r.targetRevision===prepared.encoded.targetDigest&&r.bodyDigest===prepared.encoded.bodyDigest)===true;
  evidence.push(...(input.rejectedInputs??[]).map(r=>r.evidence));
  let selected=input.current.kind==="prepared"&&!rejected(input.current.prepared)?input.current:null;
  let adoption:"keep"|"propose"="keep";
  for(const alternative of input.alternatives.slice(0,policy.maximumOptions)) {
    if(alternative.input.kind!=="prepared"||rejected(alternative.input.prepared))continue;
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
  const applicable=input.inFlight.filter(work=>availableOptions.some(option=>contextPreparationWorkKey(input.scope,option.request)===work.preparationKey||
    option.replaces?.workId===work.workId&&option.replaces.pathId===work.pathId)&&
    !input.unusedProducers?.some(p=>p.workId===work.workId&&p.pathId===work.pathId));
  const receptionOptions=input.receptionOptions??[],receptions=input.inputReceptions??[];
  // Already accepted recipients are independent of new option enumeration and producer readiness.
  const receiving=receptions.find(r=>r.state==="active")??receptions.find(r=>r.state==="unknown");
  if(receiving) {
    const option=receptionOptions.find(o=>o.id===receiving.optionId)!;
    evidence.push(receiving.evidence,option.evidence,...option.members.map(m=>input.inFlight.find(w=>w.pathId===m.pathId)!.evidence));
    if(receiving.state==="unknown")return finish({kind:"defer",reason:"input_reception_outcome_unknown",reconsiderOn:["original_reception_resolved"]},
      selected?foreground:{kind:"needs_result",pathId:receiving.pathId,workId:receiving.workId});
    const pressure=input.pressure.filter(p=>p.kind!=="optional_improvement"&&supportsInvestment(p)&&option.addresses.includes(p.evidence.id));
    evidence.push(...pressure.map(p=>p.evidence));
    return finish({kind:"reuse_input",workId:receiving.workId,pathId:receiving.pathId,requiredService:!selected?"necessary":pressure.length?"opportunity":null},
      selected?foreground:{kind:"needs_result",workId:receiving.workId,pathId:receiving.pathId});
  }
  if(input.receptionSupplyReport?.complete===false)limitations.push("reception_option_search_incomplete");
  for(const option of receptionOptions) {
    if(receptions.some(r=>r.optionId===option.id)||!option.members.every(m=>applicable.some(w=>w.pathId===m.pathId&&w.workId===m.workId&&w.producerState==="ready")))continue;
    evidence.push(option.evidence,...option.members.map(m=>applicable.find(w=>w.pathId===m.pathId)!.evidence));
    if(!input.autoPrepare)return finish({kind:"none",reason:"automatic_preparation_disabled"});
    const limitation=input.admissionLimitations?.find(l=>l.optionId===option.id&&l.conditionsDigest===contextReceptionAdmissionKey(input,option));
    if(limitation) {
      evidence.push({owner:"activity",kind:"fact",id:limitation.acceptanceId,revision:"1"});
      excluded.push({optionId:option.id,reasons:[`admission_rejected:${limitation.code}`]});continue;
    }
    const pressure=input.pressure.filter(p=>supportsInvestment(p)&&option.addresses.includes(p.evidence.id));
    const reason=!selected?"necessary":pressure.some(p=>p.kind!=="optional_improvement")?"opportunity":
      pressure.length&&netImprovement(option.comparisons)&&input.optionalInFlight<policy.maximumOptionalPerRecipient?"optional":null;
    if(reason){evidence.push(...pressure.map(p=>p.evidence));return finish({kind:"prepare_input",optionId:option.id,reason});}
  }
  const extensions=new Set(input.options.filter(o=>o.extendsReception).map(o=>o.id));
  const residualGap=!selected&&extensions.size>0;
  const existing=applicable.find(work=>["accepted","active"].includes(work.producerState));
  if(existing) {
    evidence.push(existing.evidence);
    const opportunity=input.pressure.filter(p=>p.kind!=="optional_improvement"&&supportsInvestment(p));
    evidence.push(...opportunity.map(p=>p.evidence));
    return finish({kind:"reuse",workId:existing.workId,pathId:existing.pathId,requiredService:!selected?"necessary":opportunity.length?"opportunity":null},selected?foreground:{kind:"needs_result",workId:existing.workId,pathId:existing.pathId});
  }
  const unknown=applicable.find(work=>work.producerState==="unknown");
  if(unknown)return finish({kind:"defer",reason:"original_producer_outcome_unknown",reconsiderOn:["original_acceptance_resolved"]},
    selected?foreground:{kind:"needs_result",workId:unknown.workId,pathId:unknown.pathId});
  if(receptions.some(r=>r.state==="unavailable")&&!residualGap&&adoption!=="propose") {
    evidence.push(...receptions.filter(r=>r.state==="unavailable").map(r=>r.evidence));
    return finish({kind:"defer",reason:"input_reception_requires_bounded_revision",reconsiderOn:["reception_path_changed","relevant_evidence_changed"]});
  }
  if(adoption!=="propose"&&!residualGap&&applicable.some(w=>w.producerState==="ready"))return finish({kind:"defer",reason:"retained_result_requires_recipient_input_organization",reconsiderOn:["complete_input_prepared","result_applicability_changed","admission_conditions_changed"]});
  const settled=applicable.filter(work=>["failed","cancelled"].includes(work.producerState));
  if(settled.length&&!input.options.some(option=>option.replaces&&settled.some(work=>work.workId===option.replaces!.workId&&work.pathId===option.replaces!.pathId)))
    return finish({kind:"defer",reason:"original_path_requires_bounded_revision",reconsiderOn:["replacement_path_accepted","relevant_evidence_changed"]});
  if(!input.autoPrepare)return finish({kind:"none",reason:"automatic_preparation_disabled"});
  const pressure=input.pressure.filter(p=>supportsInvestment(p));
  const reason=!selected?"necessary":pressure.some(p=>p.kind!=="optional_improvement")?"opportunity":pressure.length?"optional":null;
  if(!reason)return finish({kind:"none",reason:adoption==="propose"?"qualified_recipient_input_available":"no_current_gap_or_supported_opportunity"});
  if(reason==="optional"&&input.optionalInFlight>=policy.maximumOptionalPerRecipient)return finish({kind:"defer",reason:"optional_work_already_active",reconsiderOn:["optional_work_settled"]});
  const relevant=reason==="necessary"?[input.current.evidence.id]:pressure.filter(p=>reason==="opportunity"?p.kind!=="optional_improvement":true).map(p=>p.evidence.id);
  evidence.push(...pressure.filter(p=>relevant.includes(p.evidence.id)).map(p=>p.evidence));
  evidence.push(...pressure.filter(p=>p.kind==="optional_improvement"&&relevant.includes(p.evidence.id)).flatMap(p=>p.kind==="optional_improvement"?p.comparisons.map(c=>c.basis):[]));
  const eligible:{option:ContextPreparationOption;quote:RepresentationMethodQuotation;unknown:string[];explorationKey:string|null}[]=[];
  for(const option of input.options.slice(0,policy.maximumOptions)) {
    const quote=quoteRepresentationMethod(option.request),reasons=[...quote.gaps],unknown=[...quote.unknowns];
    if(residualGap&&!extensions.has(option.id))reasons.push("residual_capacity_extension_unconfirmed");
    if(!option.replaces&&applicable.some(work=>work.preparationKey===contextPreparationWorkKey(input.scope,option.request)))reasons.push("original_work_already_accepted");
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
    const explorationKey=exploratory?modelInputValueDigest({work:contextPreparationWorkKey(input.scope,option.request),
      pressure:[...new Set(pressure.map(p=>p.kind))].sort(),conditions:option.entries.map(e=>({phase:e.phase,state:e.state}))}):null;
    if(explorationKey&&input.explorationHistory.some(h=>h.key===explorationKey))reasons.push("same_opportunity_exploration_already_attempted");
    if(reasons.length)excluded.push({optionId:option.id,reasons});else eligible.push({option,quote,unknown,explorationKey});
  }
  if(input.options.length>policy.maximumOptions)limitations.push("method_option_search_incomplete");
  if(!eligible.length)return finish(adoption==="propose"?{kind:"none",reason:"qualified_recipient_input_available"}:
    {kind:"defer",reason:"no_supported_complete_path",reconsiderOn:["relevant_evidence_changed","method_path_changed","current_control_changed"]});
  const capacityGap=reason==="necessary"&&input.current.kind==="gap"&&input.current.gap.capacity.some(c=>!c.allowed);
  const comparableExtents=capacityGap&&eligible.every(value=>value.option.sourceExtent!==undefined);
  // Text extent orders bounded exploration of a known capacity gap; actual savings remain unknown.
  const extent=(a:ContextPreparationOption,b:ContextPreparationOption)=>comparableExtents&&a.sourceExtent&&b.sourceExtent?
    b.sourceExtent.utf8Bytes-a.sourceExtent.utf8Bytes:0;
  eligible.sort((a,b)=>a.unknown.filter(v=>v.startsWith("entry_")).length-b.unknown.filter(v=>v.startsWith("entry_")).length||
    Number(a.quote.phases.some(p=>p.kind==="generate"))-Number(b.quote.phases.some(p=>p.kind==="generate"))||a.option.request.method.localeCompare(b.option.request.method)||extent(a.option,b.option)||a.option.id.localeCompare(b.option.id));
  const choice=eligible[0]!;
  if(comparableExtents&&choice.option.sourceExtent){evidence.push(...eligible.map(value=>value.option.sourceExtent!.evidence));limitations.push("transformable_source_extent_is_not_predicted_savings_or_fit");}
  evidence.push(...choice.option.comparisons.map(c=>c.basis));
  evidence.push(...choice.option.entries.map(e=>e.evidence),...choice.option.capability
    .filter(c=>c.targetRevision===choice.option.request.targetRevision&&c.methodRevision===choice.option.request.methodRevision)
    .flatMap(c=>c.response?[c.evidence,c.response]:[c.evidence]));
  if(choice.option.stableScope)evidence.push(choice.option.stableScope);
  if(choice.option.replaces)evidence.push(choice.option.replaces.evidence);
  if(choice.option.extendsReception)evidence.push(choice.option.extendsReception.evidence,
    receptions.find(r=>r.optionId===choice.option.extendsReception!.optionId)!.evidence);
  return finish({kind:"propose",optionId:choice.option.id,quotation:choice.quote,reason,explorationKey:choice.explorationKey,uncertainty:choice.unknown,
    ...(choice.option.replaces?{replaces:choice.option.replaces}:{})});
}

export function timingSupportsPreparation(value:ContextTimingComparison):"now"|"later"|"unknown" {
  interval(value.preparation);interval(value.pressure);
  if(!value.includesQueue||!value.evidence.length||value.preparation.maximum===null)return "unknown";
  return value.preparation.maximum>=value.pressure.minimum?"now":"later";
}
function supportsInvestment(pressure:ContextPreparationPressure):boolean {
  if(pressure.kind==="input_capacity_risk")return true;
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
  for(const rejection of input.rejectedInputs??[]) {
    uniqueEvidence([rejection.evidence]);
    if(!rejection.stageId||rejection.targetRevision!==input.scope.target||!rejection.bodyDigest||rejection.evidence.kind!=="fact")
      throw new TypeError("context_policy_input_rejection_invalid");
  }
  const receptions=input.inputReceptions??[];
  const receptionOptions=input.receptionOptions??[];
  if(new Set(receptionOptions.map(o=>o.id)).size!==receptionOptions.length)throw new TypeError("context_policy_reception_ambiguous");
  for(const option of receptionOptions) {
    uniqueEvidence([option.evidence]);
    if(!option.id||!option.members.length||new Set(option.members.map(m=>m.pathId)).size!==option.members.length||new Set(option.members.map(m=>m.workId)).size!==option.members.length)
      throw new TypeError("context_policy_reception_binding_invalid");
    for(const member of option.members)if(!input.inFlight.some(work=>work.pathId===member.pathId&&work.workId===member.workId&&
      [...input.options,...(input.reuseOptions??[]).map(r=>r.option)].some(o=>modelInputValueDigest(o.request)===member.requestDigest&&contextPreparationWorkKey(input.scope,o.request)===work.preparationKey)))
      throw new TypeError("context_policy_reception_binding_invalid");
  }
  if(new Set(receptions.map(r=>r.optionId)).size!==receptions.length||new Set(receptions.map(r=>r.pathId)).size!==receptions.length)
    throw new TypeError("context_policy_reception_ambiguous");
  for(const reception of receptions) {
    uniqueEvidence([reception.evidence]);
    const option=receptionOptions.find(o=>o.id===reception.optionId);
    if(!reception.pathId||!reception.workId||!option||option.members.some(m=>m.pathId===reception.pathId)||
      !["active","checked","unavailable","unknown"].includes(reception.state))
      throw new TypeError("context_policy_reception_binding_invalid");
    if(reception.inputGap){
      uniqueEvidence([reception.inputGap.evidence]);
      if(reception.state!=="unavailable"||reception.inputGap.gap.targetRevision!==input.scope.target)
        throw new TypeError("context_policy_reception_gap_invalid");
    }
    if(reception.providerRejection&&(!["checked","unavailable"].includes(reception.state)||
      !input.rejectedInputs?.some(r=>modelInputValueDigest(r)===modelInputValueDigest(reception.providerRejection))))
      throw new TypeError("context_policy_reception_rejection_invalid");
  }
  if(input.observationReport) {
    const report=input.observationReport,window=report.window,last=window.inputs.at(-1);
    if(modelInputValueDigest(window.scope)!==modelInputValueDigest(input.scope)||!window.settingsRevision||
      window.inputs.length>INITIAL_CONTEXT_PREPARATION_POLICY.observations||!last||input.current.kind!=="prepared"||
      last.inputId!==input.current.prepared.encoded.id||modelInputValueDigest(last.measurements)!==modelInputValueDigest(input.current.prepared.measurement))
      throw new TypeError("context_policy_observation_scope_invalid");
    for(let i=0;i<window.inputs.length;i++) {
      const value=window.inputs[i]!;uniqueEvidence([value.evidence]);
      if(!value.inputId||!value.representationContinuity||!Number.isFinite(Date.parse(value.observedAt))||
        !Number.isSafeInteger(value.sequence)||value.sequence<0||!Number.isSafeInteger(value.inputRevision)||value.inputRevision<0||i>0&&window.inputs[i-1]!.sequence>=value.sequence)
        throw new TypeError("context_policy_observation_window_invalid");
    }
    uniqueEvidence([...report.growth.map(g=>g.evidence),...report.costs.map(c=>c.evidence)]);
    if(report.costs.some(cost=>cost.actual&&(cost.actual.runId!==input.scope.runId||cost.actual.pathId!==cost.pathId)))
      throw new TypeError("context_policy_cost_scope_invalid");
  }
  const reuseOptions=input.reuseOptions??[];
  if(new Set(reuseOptions.map(r=>r.workId)).size!==reuseOptions.length||new Set(reuseOptions.map(r=>r.pathId)).size!==reuseOptions.length)
    throw new TypeError("context_policy_reuse_ambiguous");
  for(const reuse of reuseOptions)if(!input.inFlight.some(work=>work.workId===reuse.workId&&work.pathId===reuse.pathId&&
    work.preparationKey===contextPreparationWorkKey(input.scope,reuse.option.request)))throw new TypeError("context_policy_reuse_binding_invalid");
  for(const option of [...input.options,...reuseOptions.map(r=>r.option)]) {
    if(option.extendsReception){
      const original=receptions.find(r=>r.optionId===option.extendsReception!.optionId),gap=original?.inputGap;
      const evidence=original?.state==="unavailable"&&gap?.gap.capacity.some(c=>!c.allowed)?gap.evidence:original?.providerRejection?.evidence;
      if(!evidence||modelInputValueDigest(evidence)!==modelInputValueDigest(option.extendsReception.evidence))
        throw new TypeError("context_policy_reception_extension_invalid");
    }
    if(option.sourceExtent){
      if(!Number.isSafeInteger(option.sourceExtent.utf8Bytes)||option.sourceExtent.utf8Bytes<0)throw new TypeError("context_policy_source_extent_invalid");
      uniqueEvidence([option.sourceExtent.evidence]);
    }
    if(option.request.recipient.runId!==input.scope.runId||option.request.targetRevision!==input.scope.target||!option.request.sourceBoundary)throw new TypeError("context_policy_method_scope_mismatch");
    if(!Number.isSafeInteger(option.limits.maximumStages)||option.limits.maximumStages<1||!Number.isSafeInteger(option.limits.maximumAttempts)||option.limits.maximumAttempts<1)throw new TypeError("context_policy_execution_limit_invalid");
  }
}
