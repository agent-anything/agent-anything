import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {validateOriginalInputSources,type OriginalInputSources,type OriginalInputSourceGroup} from "./OriginalInputSources.js";

/** Enumerates declared bodies and explicit companions, not inferred semantic dependencies. */
export function originalDeclaredTextScopes<D,S>(input:{readonly sources:OriginalInputSources;readonly maximum:number;readonly backgroundGroupIds:readonly string[]},
  declarations:(group:OriginalInputSourceGroup)=>readonly D[],describe:(sources:OriginalInputSources,declaration:D,included:readonly string[])=>S) {
  const {sources}=input;validateOriginalInputSources(sources);
  if(!Number.isSafeInteger(input.maximum)||input.maximum<1||input.maximum>128||new Set(input.backgroundGroupIds).size!==input.backgroundGroupIds.length||
    input.backgroundGroupIds.some(id=>!sources.groups.some(g=>g.id===id)))throw new TypeError("original_text_scope_configuration_invalid");
  const scopes:S[]=[],exclusions:{groupId:string;reasons:string[]}[]=[];let eligible=0;
  for(const group of sources.groups)for(const declaration of declarations(group)) {
    const included=new Set([group.id,...input.backgroundGroupIds]);
    for(const id of included)for(const occurrence of sources.groups.find(g=>g.id===id)!.occurrences)
      for(const relation of occurrence.section.preservation?.relationships??[]) {
        const related=sources.groups.filter(g=>g.occurrences.some(o=>[o.section.source,...o.section.provenance?.sources??[]]
          .some(ref=>modelInputValueDigest(ref)===modelInputValueDigest(relation.source))));
        if(!related.length){exclusions.push({groupId:group.id,reasons:["declared_companion_unavailable"]});continue;}
        related.forEach(g=>included.add(g.id));
      }
    if(exclusions.some(e=>e.groupId===group.id))continue;
    if(included.size>128){exclusions.push({groupId:group.id,reasons:["method_source_bound"]});continue;}
    const scope=describe(sources,declaration,[...included]);eligible++;
    if(scopes.length<input.maximum)scopes.push(scope);
  }
  return {scopes,exclusions,enumeration:{complete:eligible===scopes.length,eligible,returned:scopes.length}};
}

export function originalDeclaredTextGroups(sources:OriginalInputSources,sourceId:string,included:readonly string[]) {
  if(!included.includes(sourceId)||included.length>128||new Set(included).size!==included.length||
    included.some(id=>!sources.groups.some(g=>g.id===id)))throw new TypeError("original_text_authorization_missing");
  for(const group of sources.groups.filter(g=>included.includes(g.id)))for(const occurrence of group.occurrences)
    for(const relation of occurrence.section.preservation?.relationships??[]) {
      const related=sources.groups.filter(g=>g.occurrences.some(o=>[o.section.source,...o.section.provenance?.sources??[]]
        .some(ref=>modelInputValueDigest(ref)===modelInputValueDigest(relation.source))));
      if(!related.length||related.some(g=>!included.includes(g.id)))throw new TypeError("original_text_companion_missing");
    }
  return sources.groups.filter(g=>included.includes(g.id)).sort((a,b)=>a.occurrences[0]!.position-b.occurrences[0]!.position)
    .map((g,i)=>({id:g.id,revision:g.revision,alias:`source_${i}`,role:g.id===sourceId?"source" as const:"background" as const}));
}
