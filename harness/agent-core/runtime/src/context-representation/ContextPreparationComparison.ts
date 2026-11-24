import type {ContextCostComparison,ContextMethodSupplyReport,ContextPreparationOption} from "./ContextPreparationPolicy.js";
import type {ContextPreparationMethodRequest} from "./ProtocolRepresentationMethod.js";
import type {RepresentationMethodQuotation} from "./methods/RepresentationMethodQuotation.js";

interface Offer {
  option:ContextPreparationOption<ContextPreparationMethodRequest>;
  quote:RepresentationMethodQuotation;
  unknown:string[];
}
const dimensions=["external_calls","billed_tokens","elapsed_ms","retained_bytes","detail_accesses"] as const;
function cheaper(a:readonly ContextCostComparison[],b:readonly ContextCostComparison[]) {
  let better=false;
  for(const dimension of dimensions){
    if(a.filter(c=>c.dimension===dimension).length!==1||b.filter(c=>c.dimension===dimension).length!==1)return false;
    const x=a.find(c=>c.dimension===dimension),y=b.find(c=>c.dimension===dimension);
    if(!x||!y||x.coverage!=="remaining_path_and_use"||y.coverage!==x.coverage||
      x.baseline.minimum!==y.baseline.minimum||x.baseline.maximum!==y.baseline.maximum||
      x.basis.owner!==y.basis.owner||x.basis.id!==y.basis.id||x.basis.revision!==y.basis.revision)return false;
    const p=x.alternative,q=y.alternative;
    if(p.maximum===null||p.maximum>q.minimum)return false;
    if(p.maximum<q.minimum)better=true;
  }
  return better;
}
function strictSubset<T>(small:readonly T[],large:readonly T[]){
  return small.every(x=>large.includes(x))&&large.some(x=>!small.includes(x));
}
/** Compare investable paths; only the recipient can certify a usable complete input. */
export function comparePreparationOffers(offers:readonly Offer[],supply:ContextMethodSupplyReport|undefined,capacityGap:boolean){
  const rows=offers.map(({option:o,quote:q,unknown})=>{
    const declaration=supply?.offers.find(s=>s.optionId===o.id);
    return {optionId:o.id,quotationId:q.id,scope:declaration?.scopeId??null,
      sources:declaration?.sources.filter(s=>s.role==="source")??[],
      requirements:[...declaration?.requirementIds??[]].sort(),addresses:[...o.addresses].sort(),
      gapEvidence:o.comparisons.length?"see_coverage_and_basis":"declared_relevance_only",
      costs:q.costs,comparisons:o.comparisons,minimum:q.minimum,extent:o.sourceExtent??null,
      unknown:[...unknown].sort(),uncertainEntries:q.phases.filter(p=>p.condition==="required"&&o.entries.find(e=>e.phase===p.kind)?.state!=="supported").length,
      generation:q.phases.some(p=>p.kind==="generate"),extraSemanticStages:q.phases.filter(p=>p.condition==="conditional"&&
        (p.kind==="relation"||p.kind==="partition"||p.kind==="merge")).map(p=>p.kind),
      family:o.request.method,cut:"" };
  }).sort((a,b)=>a.optionId<b.optionId?-1:a.optionId>b.optionId?1:0);
  type Row=typeof rows[number];
  let frontier=rows.slice();
  const steps:{criterion:string;removed:string[]}[]=[];
  function retain(criterion:string,lost:(v:Row)=>boolean){
    const removed=frontier.filter(lost);
    if(!removed.length)return;
    if(removed.length===frontier.length)throw new TypeError("context_comparison_empty_frontier");
    for(const row of removed)row.cut=criterion;
    steps.push({criterion,removed:removed.map(r=>r.optionId)});
    frontier=frontier.filter(r=>!r.cut);
  }
  function minimize(criterion:string,quantity:(v:Row)=>number){
    const min=Math.min(...frontier.map(quantity));retain(criterion,row=>quantity(row)>min);
  }
  // A partial quotation does not dominate another path on the strength of one cheap stage.
  retain("complete_remaining_cost_dominated",r=>frontier.some(s=>cheaper(s.comparisons,r.comparisons)));
  minimize("required_entry_less_established",r=>r.uncertainEntries);
  minimize("additional_generation_required",r=>Number(r.generation));
  const unresolved=frontier.length>1;
  // These are bounded exploration criteria, not claims about final fit or total price.
  const versions=(r:Row)=>r.sources.map(s=>JSON.stringify([s.materialId,s.version]));
  retain("broader_declared_change_for_same_duties",r=>frontier.some(s=>s.sources.length&&s.requirements.length&&
    JSON.stringify(s.requirements)===JSON.stringify(r.requirements)&&JSON.stringify(s.addresses)===JSON.stringify(r.addresses)&&strictSubset(versions(s),versions(r))));
  retain("additional_conditional_semantic_work",r=>frontier.some(s=>strictSubset(s.extraSemanticStages,r.extraSemanticStages)));
  minimize("higher_unavoidable_model_call_floor",r=>r.minimum.modelCalls);
  const extentComparable=capacityGap&&frontier.length>1&&frontier.every(r=>r.family===frontier[0]!.family&&r.extent!==null);
  if(extentComparable)minimize("comparable_transformable_extent",r=>-r.extent!.utf8Bytes);
  const stable=frontier.length>1,chosen=frontier[0]!;
  retain("stable_tie_break",r=>r!==chosen);
  return {chosenId:chosen.optionId,basis:rows.length===1?"only_admissible_offer":unresolved?"bounded_exploration":"evidence_order",
    extentComparable,stable,steps,offers:rows};
}
export type ContextPreparationComparison=ReturnType<typeof comparePreparationOffers>;
