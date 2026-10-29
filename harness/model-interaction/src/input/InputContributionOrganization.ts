import type {ModelInputComposition} from "./ModelInput.js";
import type {InputContribution,InputDuty,InputOrganizationDemand} from "./InputContribution.js";
import {validateInputDemand} from "./InputContribution.js";

/** Organizes known sources without requiring Tools or source producers to allocate a window. */
export function organizeOriginalInput(input:{
  readonly demand:Omit<InputOrganizationDemand,"contributions">;
  readonly composition:ModelInputComposition;
  readonly groups:readonly {readonly id:string;readonly owner:string;readonly revision:string;readonly sectionIds:readonly string[];
    readonly duties:readonly InputDuty[];readonly deliveryIds:readonly string[]}[];
}):InputOrganizationDemand {
  const covered=new Set<string>();
  const contributions:InputContribution[]=input.groups.map(group=>{
    const sections=group.sectionIds.map(id=>{
      const position=input.composition.sections.findIndex(s=>s.id===id);
      if(position<0 || covered.has(id))throw new TypeError("input_source_group_invalid");
      covered.add(id);return {position,section:input.composition.sections[position]!};
    });
    if(!sections.length)throw new TypeError("input_source_group_empty");
    return {id:group.id,owner:group.owner,sourceRevision:group.revision,deliveryIds:group.deliveryIds,currentOptionId:"original",
      options:[{id:"original",revision:group.revision,sections,duties:group.duties,requirements:[],findings:[],requires:[],excludes:[],preference:0,estimatedCost:null,omissionBasis:null}],
      localBudget:{dimension:"input_tokens",grant:null,ceiling:null}};
  });
  if(covered.size!==input.composition.sections.length)throw new TypeError("input_source_coverage_missing");
  const demand={...input.demand,contributions};validateInputDemand(demand);return demand;
}
