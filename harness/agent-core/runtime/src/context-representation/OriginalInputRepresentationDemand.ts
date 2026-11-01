import {modelInputValueDigest as digest,type InputOrganizationDemand} from "@agent-anything/model-interaction/input";
import type {MaterialAccess} from "@agent-anything/context/custody";
import type {OriginalInputSources} from "./OriginalInputSources.js";
import type {OriginalInputAccountMethodSupply} from "./OriginalInputAccountMethodSupply.js";
import type {OriginalInputResultTextMethodSupply} from "./OriginalInputResultTextMethod.js";
import type {RepresentationMethodProgress} from "./methods/RepresentationMethod.js";
import type {MaterialInputDemand,RetainedResultText} from "./ContextInputMaterialization.js";
import {validateOriginalInputAccountScope} from "./OriginalInputAccountScopes.js";
import {validateOriginalInputResultTextScope} from "./OriginalInputResultTextScope.js";
import {originalInputAccountDemand} from "./OriginalInputAccountDemand.js";
import {originalInputResultTextDemand} from "./OriginalInputResultTextDemand.js";
import type {OriginalInputDataTextMethodSupply} from "./OriginalInputDataTextMethod.js";
import {validateOriginalInputDataTextScope} from "./OriginalInputDataTextScope.js";
import {originalInputDataTextDemand} from "./OriginalInputDataTextDemand.js";

export type OriginalInputRepresentationSupply=OriginalInputAccountMethodSupply|OriginalInputResultTextMethodSupply|OriginalInputDataTextMethodSupply;
export interface OriginalInputRepresentationMember {readonly pathId:string;readonly supply:OriginalInputRepresentationSupply;}

/** Source-declared placements only. Disjoint placement does not establish semantic compatibility. */
export function validateOriginalInputRepresentationMembers(sources:OriginalInputSources,members:readonly OriginalInputRepresentationMember[]):void {
  if(!members.length||new Set(members.map(m=>m.pathId)).size!==members.length||members.some(m=>!m.pathId))
    throw new TypeError("original_representation_members_invalid");
  const whole=new Set<string>(),body=new Set<string>(),slots=new Set<string>();
  for(const {supply} of members) {
    if(supply.kind==="historical_account") {
      validateOriginalInputAccountScope(sources,supply.scope);
      for(const group of supply.scope.groups.filter(g=>g.role==="source")) {
        if(whole.has(group.id)||body.has(group.id))throw new TypeError("original_representation_placements_overlap");
        whole.add(group.id);
      }
    }else {
      if(supply.kind==="result_text")validateOriginalInputResultTextScope(sources,supply.scope);
      else validateOriginalInputDataTextScope(sources,supply.scope);
      const declaration=supply.scope.declaration,group=sources.groups.find(g=>g.occurrences.some(o=>o.section.id===declaration.sectionId))!;
      const slot=supply.kind==="result_text"?digest({section:declaration.sectionId,callId:supply.scope.declaration.slot.callId,path:supply.scope.declaration.slot.contentPath}):digest({section:declaration.sectionId});
      if(whole.has(group.id)||slots.has(slot))throw new TypeError("original_representation_placements_overlap");
      body.add(group.id);slots.add(slot);
    }
  }
}

/** Every projection is validated against the original, then joined without rewriting that authority. */
export function originalInputRepresentationDemand(input:{readonly id:string;readonly sources:OriginalInputSources;readonly original:InputOrganizationDemand;
  readonly members:readonly (OriginalInputRepresentationMember & {readonly progress:RepresentationMethodProgress;readonly access:MaterialAccess})[]}):MaterialInputDemand {
  validateOriginalInputRepresentationMembers(input.sources,input.members);
  const members=[...input.members].sort((a,b)=>a.pathId<b.pathId?-1:a.pathId>b.pathId?1:0);
  const projected=members.map(member=>{
    const basis={id:`${input.id}:producer:${digest(member.pathId)}`,sources:input.sources,original:input.original,progress:member.progress,access:member.access};
    const demand=member.supply.kind==="result_text"?originalInputResultTextDemand({...basis,supply:member.supply}):member.supply.kind==="data_text"?
      originalInputDataTextDemand({...basis,supply:member.supply}):originalInputAccountDemand({...basis,supply:member.supply});
    return {member,demand};
  });
  const dependencies={...input.original.dependencies};
  projected.forEach(({member,demand},index)=>{
    dependencies[`representationProducer:${index}`]=member.pathId;
    for(const key of ["producerRequest","candidate","assessment",member.supply.kind==="result_text"?"resultTextScope":member.supply.kind==="data_text"?"dataTextScope":"accountScope"])
      dependencies[`representationProducer:${index}:${key}`]=demand.dependencies[key]!;
  });
  const originals=new Set(input.original.contributions.map(c=>c.id));
  const contributions=input.original.contributions.flatMap<MaterialInputDemand["contributions"][number]>(original=>{
    const account=projected.find(p=>p.member.supply.kind==="historical_account"&&p.member.supply.scope.groups.some(g=>g.role==="source"&&g.id===original.id));
    if(account) {
      const groups=account.member.supply.scope.groups.filter(g=>g.role==="source").map(g=>g.id);
      if(input.original.contributions.find(c=>groups.includes(c.id))!.id!==original.id)return [];
      const replacement=account.demand.contributions.filter(c=>!originals.has(c.id));
      if(replacement.length!==1)throw new TypeError("original_representation_account_placement_invalid");
      return replacement;
    }
    const bodies=projected.filter(p=>p.member.supply.kind!=="historical_account"&&input.sources.groups.find(g=>g.id===original.id)!.occurrences
      .some(o=>p.member.supply.kind!=="historical_account"&&o.section.id===p.member.supply.scope.declaration.sectionId));
    if(!bodies.length)return [original];
    const options=bodies.map(p=>p.demand.contributions.find(c=>c.id===original.id)!.options[0]!);
    const revision=digest(options),id=`${input.id}:results:${revision}`;
    return [{...original,currentOptionId:id,options:[{...original.options[0]!,id,revision,
      resultTextBindings:options.flatMap(o=>o.resultTextBindings??[]),dataTextBindings:options.flatMap(o=>o.dataTextBindings??[]),sections:original.options[0]!.sections.map(occurrence=>{
        const data=options.filter(o=>o.dataTextBindings?.some(b=>b.sectionId===occurrence.section.id));
        if(data.length>1)throw new TypeError("original_representation_placements_overlap");
        if(data.length)return data[0]!.sections.find(s=>s.section.id===occurrence.section.id)!;
        const replacements=options.flatMap(o=>{
          const content=o.sections.find(s=>s.section.id===occurrence.section.id)!.section.content;
          return content.kind==="retained_result_text"?content.replacements:[];
        });
        if(!replacements.length)return occurrence;
        const content=occurrence.section.content;
        if(content.kind!=="model_message"||content.message.role!=="tool")throw new TypeError("original_representation_result_message_invalid");
        const joined:RetainedResultText={kind:"retained_result_text",message:content.message,replacements};
        return {...occurrence,section:{...occurrence.section,content:joined}};
      })}]}];
  });
  return {...input.original,id:input.id,dependencies,contributions};
}
