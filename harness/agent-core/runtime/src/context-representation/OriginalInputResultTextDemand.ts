import {modelInputValueDigest,validateInputDemand,type InputOrganizationDemand} from "@agent-anything/model-interaction/input";
import type {MaterialAccess} from "@agent-anything/context/custody";
import {validateOriginalInputResultTextScope} from "./OriginalInputResultTextScope.js";
import type {OriginalInputSources} from "./OriginalInputSources.js";
import type {OriginalInputResultTextMethodSupply} from "./OriginalInputResultTextMethod.js";
import type {RepresentationMethodProgress} from "./methods/RepresentationMethod.js";
import type {MaterialInputDemand} from "./ContextInputMaterialization.js";
import {recipientContextDeliveryId} from "./ContextDeliveryFacts.js";

/** Same protocol group, same result position, one explicitly authorized body replacement. */
export function originalInputResultTextDemand(input:{readonly id:string;readonly sources:OriginalInputSources;readonly original:InputOrganizationDemand;
  readonly supply:OriginalInputResultTextMethodSupply;readonly progress:RepresentationMethodProgress;readonly access:MaterialAccess}):MaterialInputDemand {
  const {sources,original,supply,progress,access}=input,same=(a:unknown,b:unknown)=>modelInputValueDigest(a)===modelInputValueDigest(b);
  validateInputDemand(original);validateOriginalInputResultTextScope(sources,supply.scope);
  if(!input.id||progress.state!=="ready"||!same(progress.request,supply.request)||progress.request.combine!=="merge"||progress.resultIds.length!==1||
    original.runId!==sources.runId||original.historyBoundary!==sources.boundary||original.targetRevision!==supply.request.targetRevision||
    access.recipient.runId!==original.runId||access.recipient.recipient!==original.recipient||access.recipient.purpose!==original.purpose)
    throw new TypeError("original_result_text_demand_binding_invalid");
  const candidate=progress.candidates.find(c=>c.id===progress.resultIds[0]);
  const assessment=[...progress.assessments].reverse().find(a=>a.supported&&a.scope==="both"&&a.candidateIds.includes(candidate?.id??""));
  if(!candidate||!assessment||!same(access.range,candidate.access.range)||candidate.unknowns.some(u=>u.kind==="preservation_gap"))
    throw new TypeError("original_result_text_candidate_unconfirmed");
  if(original.contributions.length!==sources.groups.length||original.contributions.some(c=>{
    const group=sources.groups.find(g=>g.id===c.id),option=c.options.find(o=>o.id===c.currentOptionId);
    return !group||c.owner!==group.owner||c.sourceRevision!==group.revision||c.options.length!==1||!option||
      !same(option.sections,group.occurrences)||!same(c.deliveryIds,group.deliveries.map(d=>recipientContextDeliveryId(d.id,original)))||!same(option.duties,group.duties)||
      option.requires.length>0||option.excludes.length>0||option.requirements.length>0||(option.resultTextBindings?.length??0)>0||(option.dataTextBindings?.length??0)>0;
  }))throw new TypeError("original_result_text_original_demand_changed");
  const declaration=supply.scope.declaration,group=sources.groups.find(g=>g.occurrences.some(o=>o.section.id===declaration.sectionId))!;
  const representation={owner:"context-representation",kind:"representation",...candidate.representation};
  const binding={sectionId:declaration.sectionId,slot:declaration.slot,source:declaration.owner,representation};
  return {...original,id:input.id,dependencies:{...original.dependencies,resultTextScope:supply.scope.id,
    producerRequest:modelInputValueDigest(progress.request),candidate:modelInputValueDigest(candidate.representation),assessment:assessment.id},
    contributions:original.contributions.map<MaterialInputDemand["contributions"][number]>(contribution=>contribution.id!==group.id?contribution:{...contribution,
      currentOptionId:candidate.id,options:[{...contribution.options[0]!,id:candidate.id,revision:candidate.representation.revision,resultTextBindings:[binding],
        sections:contribution.options[0]!.sections.map(occurrence=>{
          if(occurrence.section.id!==declaration.sectionId)return occurrence;
          const section=occurrence.section;
          if(section.content.kind!=="model_message"||section.content.message.role!=="tool")throw new TypeError("original_result_text_message_changed");
          return {...occurrence,section:{...section,content:{kind:"retained_result_text",message:section.content.message,replacements:[{access,slot:declaration.slot,
            prefix:"Derived representation of this result's report; the original result is retained.\n",suffix:""}]}}};
        })}]})};
}
