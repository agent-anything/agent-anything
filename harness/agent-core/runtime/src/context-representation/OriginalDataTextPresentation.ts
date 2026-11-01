import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {validateOriginalInputSources,type OriginalInputSources} from "./OriginalInputSources.js";
import type {PreparedContextInput} from "./ContextInputPreparation.js";

/** Verifies declared data placements. Other representation kinds remain their own owners' responsibility. */
export function validateOriginalDataTextPresentations(sources:OriginalInputSources,input:PreparedContextInput):ReadonlySet<string> {
  validateOriginalInputSources(sources);
  const bindings=input.demand.contributions.flatMap(c=>c.options.find(o=>o.id===input.choice[c.id])?.dataTextBindings??[]),seen=new Set<string>();
  for(const binding of bindings) {
    const group=sources.groups.find(g=>g.dataTexts?.some(d=>d.sectionId===binding.sectionId));
    const declarations=group?.dataTexts?.filter(d=>d.sectionId===binding.sectionId&&d.contentDigest===binding.contentDigest&&
      modelInputValueDigest(d.owner)===modelInputValueDigest(binding.source));
    const original=group?.occurrences.find(o=>o.section.id===binding.sectionId)?.section;
    const actual=input.request.composition.sections.filter(s=>s.id===binding.sectionId);
    if(!original||declarations?.length!==1||actual.length!==1||actual[0]!.content.kind!=="text"||seen.has(binding.sectionId)||
      modelInputValueDigest({...actual[0]!,content:original.content})!==modelInputValueDigest(original))throw new TypeError("original_data_text_presentation_changed");
    seen.add(binding.sectionId);
  }
  return seen;
}
