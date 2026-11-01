import type {OriginalInputSources} from "./OriginalInputSources.js";
import {validateOriginalInputRepresentationMembers,type OriginalInputRepresentationMember} from "./OriginalInputRepresentationDemand.js";
import type {ContextPreparationOption,ContextCurrentInput,ContextPreparationPolicyInput} from "./ContextPreparationPolicy.js";

/** Declare placement compatibility with a settled recipient gap; do not predict transformed content. */
export function originalInputReceptionExtension(input:{readonly sources:OriginalInputSources;
  readonly proposed:OriginalInputRepresentationMember;readonly receptions:readonly {readonly optionId:string;
    readonly members:readonly OriginalInputRepresentationMember[];readonly inputGap?:Extract<ContextCurrentInput,{kind:"gap"}>;
    readonly providerRejection?:NonNullable<ContextPreparationPolicyInput["rejectedInputs"]>[number]}[]}):ContextPreparationOption["extendsReception"] {
  validateOriginalInputRepresentationMembers(input.sources,[input.proposed]);
  for(const reception of input.receptions) {
    const evidence=reception.inputGap?.gap.capacity.some(c=>!c.allowed)?reception.inputGap.evidence:reception.providerRejection?.evidence;
    if(!evidence)continue;
    try {validateOriginalInputRepresentationMembers(input.sources,[...reception.members,input.proposed]);}
    catch(error) {
      if(error instanceof TypeError&&["original_representation_placements_overlap","original_representation_members_invalid"].includes(error.message))continue;
      throw error;
    }
    return {optionId:reception.optionId,evidence};
  }
  return undefined;
}

/** Bounded placement exploration, not semantic compatibility or predicted capacity savings. */
export function originalInputReceptionCombinations(input:{readonly sources:OriginalInputSources;
  readonly members:readonly OriginalInputRepresentationMember[];readonly maximum:number;readonly maximumInspections:number}) {
  if(!Number.isSafeInteger(input.maximum)||input.maximum<1||!Number.isSafeInteger(input.maximumInspections)||input.maximumInspections<1||
    new Set(input.members.map(m=>m.pathId)).size!==input.members.length)throw new TypeError("original_reception_enumeration_invalid");
  const members=[...input.members].sort((a,b)=>a.pathId<b.pathId?-1:a.pathId>b.pathId?1:0);
  for(const member of members)validateOriginalInputRepresentationMembers(input.sources,[member]);
  const combinations:OriginalInputRepresentationMember[][]=[];
  const pending:{at:number;selected:OriginalInputRepresentationMember[]}[]=[{at:0,selected:[]}];
  let examined=0,conflicts=0;
  while(pending.length&&combinations.length<input.maximum&&examined<input.maximumInspections) {
    const {at,selected}=pending.pop()!;examined++;
    if(at===members.length){if(selected.length)combinations.push(selected);continue;}
    pending.push({at:at+1,selected});
    const next=[...selected,members[at]!];
    try {validateOriginalInputRepresentationMembers(input.sources,next);}
    catch(error) {if(error instanceof TypeError&&error.message==="original_representation_placements_overlap"){conflicts++;continue;}throw error;}
    pending.push({at:at+1,selected:next});
  }
  return {combinations,complete:pending.length===0,examined,conflicts};
}
