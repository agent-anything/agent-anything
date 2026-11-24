import type {ContextPreparationPolicyInput} from "./ContextPreparationPolicy.js";

/** A supplier's bounded result for the original input need, not a model response or Run outcome. */
export interface ContextInputUnavailability {
  readonly kind:"context_input_unavailable";
  readonly needId:string;
  readonly supplier:string;
  readonly boundary:string;
  readonly reason:string;
  readonly sourceStop?:"deadline"|"authorization";
  readonly workInputBudget?:{readonly measuredTokens:number;readonly maximumTokens:number};
  readonly originalBlock?:"required_count_missing"|"capacity_limit"|"capacity_uncertain"|"information_gap";
  readonly optionSearch?:"options_exhausted"|"search_budget_exhausted";
  readonly preservationUnconfirmed?:true;
  readonly assessmentIssues?:readonly NonNullable<import("@agent-anything/context/representation").TransformationFinding["assessmentIssue"]>["category"][];
  readonly evidence:readonly {readonly owner:string;readonly kind:string;readonly id:string;readonly revision:string}[];
}

/** Describe existing judgments, without recounting, judging a candidate, or changing admissibility. */
export function originalInputLimitationFacts(current:ContextPreparationPolicyInput["current"]):
    Pick<ContextInputUnavailability,"workInputBudget"|"originalBlock"|"optionSearch"> {
  const cap=current.kind==="recipient_prepared"?current.capacity:current.kind==="prepared"?{
    assessment:current.prepared.capacity,measurements:current.prepared.measurement,limits:current.prepared.limits}:undefined;
  const assessments=cap?[cap.assessment]:current.kind==="gap"?current.gap.capacity:[];
  const decisions=assessments.filter(a=>!a.allowed).flatMap(a=>a.decisions);
  const over=cap?.assessment.decisions.find(d=>d.conclusion==="violated"&&d.reason==="observed_count_exceeds_work_budget");
  const measured=over&&cap?.measurements.find(e=>e.id===over.evidenceId)?.observedInputCount?.tokens;
  const maximum=over&&cap?.limits.find(l=>l.id===over.limitId&&l.requires==="observed_input_count")?.maximum;
  const originalBlock=decisions.some(d=>d.conclusion==="violated")?"capacity_limit":
    decisions.some(d=>d.reason==="complete_count_required")?"required_count_missing":
    decisions.length?"capacity_uncertain":current.kind==="gap"&&current.gap.information.length?"information_gap":undefined;
  const search=current.kind==="gap"?current.gap.reason:null;
  return {...(measured!==undefined&&maximum!==undefined&&measured>maximum?{workInputBudget:{measuredTokens:measured,maximumTokens:maximum}}:{}),
    ...(originalBlock?{originalBlock}:{}),...(search==="options_exhausted"||search==="search_budget_exhausted"?{optionSearch:search}:{})};
}

export function validateContextInputUnavailability(value:ContextInputUnavailability):void {
  if(value?.kind!=="context_input_unavailable"||![value.needId,value.supplier,value.boundary,value.reason].every(v=>typeof v==="string"&&v.trim().length>0)||
    (value.sourceStop!==undefined&&(value.reason!=="original_source_unavailable"||!["deadline","authorization"].includes(value.sourceStop)))||
    (value.workInputBudget!==undefined&&(!Number.isSafeInteger(value.workInputBudget?.measuredTokens)||!Number.isSafeInteger(value.workInputBudget?.maximumTokens)||
      value.workInputBudget.maximumTokens<0||value.workInputBudget.measuredTokens<=value.workInputBudget.maximumTokens))||
    (value.preservationUnconfirmed!==undefined&&value.preservationUnconfirmed!==true)||
    (value.assessmentIssues!==undefined&&(value.preservationUnconfirmed!==true||!Array.isArray(value.assessmentIssues)||value.assessmentIssues.length>4||
      value.assessmentIssues.some(v=>!["plan_attribution","plan_scope","evidence_insufficient","candidate_contradiction"].includes(v))))||
    (value.originalBlock!==undefined&&!["required_count_missing","capacity_limit","capacity_uncertain","information_gap"].includes(value.originalBlock))||
    (value.optionSearch!==undefined&&!["options_exhausted","search_budget_exhausted"].includes(value.optionSearch))||
    !Array.isArray(value.evidence)||!value.evidence.length||value.evidence.some(e=>!e||![e.owner,e.kind,e.id,e.revision].every(v=>typeof v==="string"&&v.trim().length>0)))
    throw new TypeError("context_input_unavailability_invalid");
}
