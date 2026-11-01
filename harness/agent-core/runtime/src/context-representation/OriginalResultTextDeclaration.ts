import {readModelResultTextSlot,type ModelResultTextSlot,type ModelInputSourceRef} from "@agent-anything/model-interaction/input";
import type {OriginalInputSources} from "./OriginalInputSources.js";
import type {MethodRequirement} from "./methods/RepresentationMethod.js";

/** Declared by the result/source owner, never inferred from the name of a string field. */
export interface OriginalResultTextDeclaration {
  readonly id:string;
  readonly owner:ModelInputSourceRef;
  readonly sectionId:string;
  readonly slot:ModelResultTextSlot;
  readonly requirements:readonly MethodRequirement[];
}

export function validateOriginalResultTextDeclaration(sources:OriginalInputSources,declaration:OriginalResultTextDeclaration):void {
  const groups=sources.groups.filter(g=>g.occurrences.some(o=>o.section.id===declaration.sectionId));
  const section=groups[0]?.occurrences.find(o=>o.section.id===declaration.sectionId)?.section;
  if(groups.length!==1||!declaration.id||!declaration.owner.id||!declaration.owner.revision||declaration.owner.owner!==groups[0]!.owner||
    !section||section.role!=="tool"||section.content.kind!=="model_message"||section.content.message.role!=="tool"||
    !declaration.requirements.length||new Set(declaration.requirements.map(r=>r.id)).size!==declaration.requirements.length||
    declaration.requirements.some(r=>!r.id||!r.revision||!r.basis||!r.description))throw new TypeError("original_result_text_declaration_invalid");
  readModelResultTextSlot(section.content.message,declaration.slot);
}
