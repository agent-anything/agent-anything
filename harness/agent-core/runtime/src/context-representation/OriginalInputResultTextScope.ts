import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {validateOriginalInputSources,type OriginalInputSources} from "./OriginalInputSources.js";
import type {OriginalInputMethodScope} from "./OriginalInputMethodScope.js";
import {validateOriginalResultTextDeclaration,type OriginalResultTextDeclaration} from "./OriginalResultTextDeclaration.js";
import {originalDeclaredTextScopes} from "./OriginalDeclaredTextScopes.js";
export interface OriginalInputResultTextScope extends OriginalInputMethodScope {
  readonly declaration:OriginalResultTextDeclaration;
}

export function originalInputResultTextScopes(input:{readonly sources:OriginalInputSources;readonly maximum:number;
  readonly backgroundGroupIds:readonly string[]}) {
  return originalDeclaredTextScopes(input,group=>group.resultTexts??[],describeOriginalInputResultTextScope);
}

export function validateOriginalInputResultTextScope(sources:OriginalInputSources,scope:OriginalInputResultTextScope):void {
  validateOriginalInputSources(sources);
  if(modelInputValueDigest(scope)!==modelInputValueDigest(describeOriginalInputResultTextScope(sources,scope.declaration,scope.groups.map(g=>g.id))))
    throw new TypeError("original_result_text_scope_changed");
}
export function describeOriginalInputResultTextScope(sources:OriginalInputSources,declaration:OriginalResultTextDeclaration,included:readonly string[]):OriginalInputResultTextScope {
  validateOriginalResultTextDeclaration(sources,declaration);
  const source=sources.groups.find(g=>g.resultTexts?.some(d=>modelInputValueDigest(d)===modelInputValueDigest(declaration)));
  if(!source||!included.includes(source.id)||included.length>128||new Set(included).size!==included.length||
    included.some(id=>!sources.groups.some(g=>g.id===id)))throw new TypeError("original_result_text_authorization_missing");
  for(const group of sources.groups.filter(g=>included.includes(g.id)))for(const occurrence of group.occurrences)
    for(const relation of occurrence.section.preservation?.relationships??[]) {
      const related=sources.groups.filter(g=>g.occurrences.some(o=>[o.section.source,...o.section.provenance?.sources??[]]
        .some(ref=>modelInputValueDigest(ref)===modelInputValueDigest(relation.source))));
      if(!related.length||related.some(g=>!included.includes(g.id)))throw new TypeError("original_result_text_companion_missing");
    }
  const groups=sources.groups.filter(g=>included.includes(g.id)).sort((a,b)=>a.occurrences[0]!.position-b.occurrences[0]!.position)
    .map((g,i)=>({id:g.id,revision:g.revision,alias:`source_${i}`,role:g.id===source.id?"source" as const:"background" as const}));
  const relationships=[{id:`${declaration.id}:native-group`,basis:"Original correlated call and result group",
    sources:groups.map(g=>g.alias),requiresCommonEvidence:true,
    description:`Only the text at ${declaration.sectionId}, call ${declaration.slot.callId}, content path ${JSON.stringify(declaration.slot.contentPath)} is represented. Preserve its meaning, scope, uncertainty and relations to the unchanged call, result outcome, effects, limitations, siblings and read-only background. Do not summarize the whole exchange or claim the recipient already received it.`}];
  const basis={runId:sources.runId,owner:sources.owner,groups,requirements:declaration.requirements,relationships,declaration};
  return {id:`original-result-text-scope:${modelInputValueDigest(basis)}`,...basis};
}
