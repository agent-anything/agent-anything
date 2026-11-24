import {validateHelarcNativeAccountScope} from "./HelarcNativeAccountScopes.js";
import type {HelarcNativeWorkingSources} from "./HelarcNativeWorkingSources.js";
import type {HelarcNativeAccountMethodSupply} from "./HelarcNativeAccountMethodSupply.js";

export interface HelarcNativeAccountReceptionMember {
  readonly methodPathId:string;
  readonly candidateId:string;
  readonly supply:Pick<HelarcNativeAccountMethodSupply,"scope"|"request">;
}

export interface HelarcNativeAccountCombinationBasis {
  readonly runId:string;
  readonly items:readonly Record<string,unknown>[];
  readonly sources:HelarcNativeWorkingSources;
}
/** Placement compatibility only. Semantic preservation is assessed by the receiving path. */
export function validateHelarcNativeAccountMembers(basis:HelarcNativeAccountCombinationBasis,members:readonly HelarcNativeAccountReceptionMember[]):void {
  if(!members.length||members.length>128||new Set(members.map(m=>m.methodPathId)).size!==members.length)
    throw new TypeError("native_account_members_invalid");
  const replaced=new Set<string>();
  for(const member of members){
    validateHelarcNativeAccountScope({...basis,scope:member.supply.scope});
    for(const group of member.supply.scope.groups.filter(g=>g.role==="source")){
      if(replaced.has(group.id))throw new TypeError("native_account_replacement_overlap");replaced.add(group.id);
    }
  }
}

/** Bounded new-option search must not be used to rediscover an already accepted receiver. */
export function helarcNativeAccountCombinations(input:HelarcNativeAccountCombinationBasis&{
  readonly members:readonly HelarcNativeAccountReceptionMember[];readonly maximum:number;readonly maximumInspections:number;
}) {
  if(!Number.isSafeInteger(input.maximum)||input.maximum<1||!Number.isSafeInteger(input.maximumInspections)||input.maximumInspections<1||
    new Set(input.members.map(m=>m.methodPathId)).size!==input.members.length)throw new TypeError("native_account_combination_bound_invalid");
  const members=[...input.members].sort((a,b)=>a.methodPathId.localeCompare(b.methodPathId));
  for(const member of members)validateHelarcNativeAccountMembers(input,[member]);
  const combinations:HelarcNativeAccountReceptionMember[][]=[],pending:{at:number;selected:HelarcNativeAccountReceptionMember[]}[]=[{at:0,selected:[]}];
  let examined=0,conflicts=0;
  while(pending.length&&combinations.length<input.maximum&&examined<input.maximumInspections){
    const {at,selected}=pending.pop()!;examined++;
    if(at===members.length){if(selected.length)combinations.push(selected);continue;}
    pending.push({at:at+1,selected});const next=[...selected,members[at]!];
    try{validateHelarcNativeAccountMembers(input,next);}
    catch(error){if(error instanceof TypeError&&error.message==="native_account_replacement_overlap"){conflicts++;continue;}throw error;}
    pending.push({at:at+1,selected:next});
  }
  return {combinations,complete:pending.length===0,examined,conflicts};
}
