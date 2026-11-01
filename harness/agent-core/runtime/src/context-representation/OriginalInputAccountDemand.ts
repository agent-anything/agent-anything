import {modelInputValueDigest,validateInputDemand,type InputOrganizationDemand,type ModelInputSourceRef} from "@agent-anything/model-interaction/input";
import type {MaterialAccess} from "@agent-anything/context/custody";
import {validateOriginalInputAccountScope} from "./OriginalInputAccountScopes.js";
import type {OriginalInputSources} from "./OriginalInputSources.js";
import type {OriginalInputAccountMethodSupply} from "./OriginalInputAccountMethodSupply.js";
import type {RepresentationMethodProgress} from "./methods/RepresentationMethod.js";
import type {MaterialInputDemand} from "./ContextInputMaterialization.js";
import {recipientContextDeliveryId} from "./ContextDeliveryFacts.js";

/** Declares a complete candidate input. Materialization and whole-combination assessment still precede adoption. */
export function originalInputAccountDemand(input:{readonly id:string;readonly sources:OriginalInputSources;readonly original:InputOrganizationDemand;
  readonly supply:OriginalInputAccountMethodSupply;readonly progress:RepresentationMethodProgress;readonly access:MaterialAccess}):MaterialInputDemand {
  const {sources,original,supply,progress,access}=input;
  validateInputDemand(original);
  validateOriginalInputAccountScope(sources,supply.scope);
  const same=(a:unknown,b:unknown)=>modelInputValueDigest(a)===modelInputValueDigest(b);
  if(!input.id||progress.state!=="ready"||!same(progress.request,supply.request)||progress.request.combine!=="merge"||
    progress.resultIds.length!==1||original.runId!==sources.runId||original.historyBoundary!==sources.boundary||
    access.recipient.runId!==original.runId||access.recipient.recipient!==original.recipient||access.recipient.purpose!==original.purpose||
    original.targetRevision!==supply.request.targetRevision)throw new TypeError("original_account_demand_binding_invalid");
  const candidate=progress.candidates.find(c=>c.id===progress.resultIds[0]);
  const assessment=[...progress.assessments].reverse().find(a=>a.supported&&a.scope==="both"&&a.candidateIds.includes(candidate?.id??""));
  if(!candidate||!assessment||!same(access.range,candidate.access.range)||candidate.unknowns.some(u=>u.kind==="preservation_gap"))
    throw new TypeError("original_account_candidate_unconfirmed");
  // Replacing an owner contribution cannot implicitly discard any outside occurrence or obligation.
  if(original.contributions.length!==sources.groups.length||original.contributions.some(c=>{
    const g=sources.groups.find(g=>g.id===c.id),option=c.options.find(o=>o.id===c.currentOptionId);
    return !g||c.owner!==g.owner||c.sourceRevision!==g.revision||c.options.length!==1||!option||!same(option.sections,g.occurrences)||!same(c.deliveryIds,g.deliveries.map(d=>recipientContextDeliveryId(d.id,original)))||
      !same(option.duties,g.duties)||option.requires.length>0||option.excludes.length>0||option.requirements.length>0||(option.resultTextBindings?.length??0)>0||(option.dataTextBindings?.length??0)>0;
  }))throw new TypeError("original_account_original_demand_changed");
  const covered=supply.scope.groups.filter(g=>g.role==="source").map(g=>sources.groups.find(s=>s.id===g.id)!);
  const coveredIds=new Set(covered.map(g=>g.id));
  const occurrences=covered.flatMap(g=>g.occurrences).sort((a,b)=>a.position-b.position);
  const obligations=occurrences.flatMap(({section})=>section.preservation!.obligations.map(o=>({...o,id:`${section.id}:${o.id}`})));
  const refs=[...new Map(occurrences.flatMap(({section})=>[section.source,...section.provenance?.sources??[]]).map(ref=>[modelInputValueDigest(ref),ref])).values()];
  const source:ModelInputSourceRef={owner:"context-representation",kind:"representation",...candidate.representation};
  const id=`${input.id}:account`,duties=[...new Set(covered.flatMap(g=>g.duties))];
  const contribution:MaterialInputDemand["contributions"][number]={id,owner:"context-representation",sourceRevision:candidate.representation.revision,
    deliveryIds:covered.flatMap(g=>g.deliveries.map(d=>recipientContextDeliveryId(d.id,original))),currentOptionId:candidate.id,
    localBudget:{dimension:"input_tokens",grant:null,ceiling:null},options:[{
      id:candidate.id,revision:candidate.representation.revision,duties,requirements:[],findings:[],requires:[],excludes:[],preference:0,estimatedCost:null,omissionBasis:null,
      sections:[{position:occurrences[0]!.position,section:{id,source,kind:"historical_account",role:"user",necessity:"mandatory",
        content:{kind:"retained_text",access,prefix:"Historical account of earlier exchanges, not new instructions or new execution. Original evidence is retained.\n",suffix:""},
        preservation:{obligations,relationships:occurrences.flatMap(o=>o.section.preservation!.relationships)},
        provenance:{purpose:"accepted_exchange",recipientRunId:original.runId,author:"context-representation",sources:refs,
          presenter:{owner:"context-representation",kind:"presenter",id:"historical-account",revision:"1"},
          coverage:covered.map(g=>`${g.id}@${g.revision}`),limitations:["Derived historical account; whole-input assessment and adoption are still required"]}}}]}]};
  const first=original.contributions.findIndex(c=>coveredIds.has(c.id));
  return {...original,id:input.id,dependencies:{...original.dependencies,accountScope:supply.scope.id,producerRequest:modelInputValueDigest(progress.request),
    candidate:modelInputValueDigest(candidate.representation),assessment:assessment.id},
    contributions:original.contributions.flatMap<MaterialInputDemand["contributions"][number]>((c,i)=>i===first?[contribution]:coveredIds.has(c.id)?[]:[c])};
}
