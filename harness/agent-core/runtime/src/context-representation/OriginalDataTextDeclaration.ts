import {modelInputValueDigest,type ModelInputSourceRef} from "@agent-anything/model-interaction/input";
import type {OriginalInputSources} from "./OriginalInputSources.js";
import type {MethodRequirement} from "./methods/RepresentationMethod.js";

/** Only an explicitly declared Host data body, not user-authored text or protocol instructions. */
export interface OriginalDataTextDeclaration {
  readonly id:string;
  readonly owner:ModelInputSourceRef;
  readonly sectionId:string;
  readonly contentDigest:string;
  readonly requirements:readonly MethodRequirement[];
}
export function validateOriginalDataTextDeclaration(sources:OriginalInputSources,declaration:OriginalDataTextDeclaration):void {
  const groups=sources.groups.filter(g=>g.occurrences.some(o=>o.section.id===declaration.sectionId));
  const section=groups[0]?.occurrences.find(o=>o.section.id===declaration.sectionId)?.section;
  if(groups.length!==1||!declaration.id||!declaration.owner.id||!declaration.owner.revision||declaration.owner.owner!==groups[0]!.owner||
    !section||section.role!=="user"||section.content.kind!=="text"||section.provenance?.author!=="host"||
    section.provenance.recipientRunId!==sources.runId||modelInputValueDigest(section.content)!==declaration.contentDigest||
    !section.preservation?.obligations.length||section.preservation.obligations.some(o=>o.requirement!=="account")||
    !declaration.requirements.length||new Set(declaration.requirements.map(r=>r.id)).size!==declaration.requirements.length||
    declaration.requirements.some(r=>!r.id||!r.revision||!r.basis||!r.description))throw new TypeError("original_data_text_declaration_invalid");
}
