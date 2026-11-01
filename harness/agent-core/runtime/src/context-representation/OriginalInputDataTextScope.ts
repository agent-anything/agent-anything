import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {validateOriginalInputSources,type OriginalInputSources} from "./OriginalInputSources.js";
import type {OriginalInputMethodScope} from "./OriginalInputMethodScope.js";
import {validateOriginalDataTextDeclaration,type OriginalDataTextDeclaration} from "./OriginalDataTextDeclaration.js";
import {originalDeclaredTextScopes,originalDeclaredTextGroups} from "./OriginalDeclaredTextScopes.js";

export interface OriginalInputDataTextScope extends OriginalInputMethodScope {readonly declaration:OriginalDataTextDeclaration;}
export function originalInputDataTextScopes(input:{readonly sources:OriginalInputSources;readonly maximum:number;readonly backgroundGroupIds:readonly string[]}) {
  return originalDeclaredTextScopes(input,group=>group.dataTexts??[],describeOriginalInputDataTextScope);
}
export function describeOriginalInputDataTextScope(sources:OriginalInputSources,declaration:OriginalDataTextDeclaration,included:readonly string[]):OriginalInputDataTextScope {
  validateOriginalDataTextDeclaration(sources,declaration);
  const group=sources.groups.find(g=>g.dataTexts?.some(d=>modelInputValueDigest(d)===modelInputValueDigest(declaration)));
  if(!group)throw new TypeError("original_data_text_authorization_missing");
  const groups=originalDeclaredTextGroups(sources,group.id,included);
  const relationships=[{id:`declaration:${declaration.id}`,basis:"Source-owned data body and unchanged surrounding input",sources:groups.map(g=>g.alias),requiresCommonEvidence:true,
    description:`Only the Host data body in section ${declaration.sectionId} is represented. Its source, role, position and delivery identity are unchanged. Preserve the declared obligations and relations to exact instructions, objectives, current evidence and read-only background. Do not claim that this recipient already received it.`}];
  const basis={runId:sources.runId,owner:sources.owner,groups,requirements:declaration.requirements,relationships,declaration};
  return {id:`original-data-text-scope:${modelInputValueDigest(basis)}`,...basis};
}
export function validateOriginalInputDataTextScope(sources:OriginalInputSources,scope:OriginalInputDataTextScope):void {
  validateOriginalInputSources(sources);
  if(modelInputValueDigest(scope)!==modelInputValueDigest(describeOriginalInputDataTextScope(sources,scope.declaration,scope.groups.map(g=>g.id))))
    throw new TypeError("original_data_text_scope_changed");
}
