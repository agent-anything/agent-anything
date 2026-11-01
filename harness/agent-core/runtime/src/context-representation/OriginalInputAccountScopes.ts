import {createExactModelWorkingView,modelInputValueDigest,validateModelAccountScope} from "@agent-anything/model-interaction/input";
import type {MethodRelationship,MethodRequirement} from "./methods/RepresentationMethod.js";
import {validateOriginalInputSources,type OriginalInputSources,type OriginalInputSourceGroup} from "./OriginalInputSources.js";
import type {OriginalInputMethodScope} from "./OriginalInputMethodScope.js";

export interface OriginalInputAccountScope extends OriginalInputMethodScope {}
export interface OriginalInputAccountScopes {
  readonly scopes:readonly OriginalInputAccountScope[];
  readonly exclusions:readonly {readonly groupId:string;readonly reasons:readonly string[]}[];
  readonly enumeration:{readonly complete:boolean;readonly eligible:number;readonly returned:number};
}

/** Enumerates source-authorized alternatives. It neither measures benefit nor judges semantic preservation. */
export function originalInputAccountScopes(input:{readonly sources:OriginalInputSources;readonly maximum:number;
  readonly backgroundGroupIds:readonly string[]}):OriginalInputAccountScopes {
  const {sources,maximum}=input;validateOriginalInputSources(sources);
  if(!Number.isSafeInteger(maximum)||maximum<1||maximum>128||new Set(input.backgroundGroupIds).size!==input.backgroundGroupIds.length||
    input.backgroundGroupIds.some(id=>!sources.groups.some(g=>g.id===id)))throw new TypeError("original_account_scope_configuration_invalid");
  const sections=sources.request.composition.sections;
  const view=createExactModelWorkingView({sections,recipientRunId:sources.runId,boundary:"request"});
  const entries=new Map(view.entries.map(e=>[e.sectionId,e]));
  const groups=[...sources.groups].sort((a,b)=>first(a)-first(b));
  const companions=new Map<string,readonly OriginalInputSourceGroup[]>(),exclusions:OriginalInputAccountScopes["exclusions"][number][]=[];
  for(const group of groups) {
    const reasons=new Set<string>(),related=new Set<OriginalInputSourceGroup>();
    for(const {section} of group.occurrences) {
      const entry=entries.get(section.id)!;
      for(const protection of entry.protection)reasons.add(protection);
      if(entry.preservation.obligations.some(o=>o.requirement==="exact"))reasons.add("exact_preservation");
      for(const relation of entry.preservation.relationships) {
        const found=groups.filter(g=>g.occurrences.some(o=>[o.section.source,...o.section.provenance?.sources??[]]
          .some(ref=>modelInputValueDigest(ref)===modelInputValueDigest(relation.source))));
        if(!found.length)reasons.add("declared_companion_unavailable");
        for(const companion of found)related.add(companion);
      }
    }
    if(reasons.size)exclusions.push({groupId:group.id,reasons:[...reasons].sort()});
    companions.set(group.id,[...related]);
  }
  const excluded=new Set(exclusions.map(e=>e.groupId)),intervals:OriginalInputSourceGroup[][]=[];
  let interval:OriginalInputSourceGroup[]=[];
  const flush=()=>{if(interval.length)intervals.push(interval);interval=[];};
  for(const group of groups) {
    if(excluded.has(group.id)){flush();continue;}
    if(interval.length&&last(interval.at(-1)!)+1!==first(group))flush();
    interval.push(group);
  }
  flush();
  // Whole legal intervals and their indivisible units are alternatives, never arbitrary text slices.
  const candidates:OriginalInputSourceGroup[][]=[];
  for(const unit of intervals) {candidates.push(unit);if(unit.length>1)candidates.push(...unit.map(g=>[g]));}
  const scopes:OriginalInputAccountScope[]=[],seen=new Set<string>();let eligible=0;
  for(const selected of candidates) {
    const selectedIds=new Set(selected.map(g=>g.id));
    const background=new Set(input.backgroundGroupIds.filter(id=>!selectedIds.has(id)));
    const visited=new Set<string>();
    const visit=(group:OriginalInputSourceGroup)=>{
      if(visited.has(group.id))return;visited.add(group.id);
      for(const related of companions.get(group.id)??[]) {
        if(!selectedIds.has(related.id))background.add(related.id);
        visit(related);
      }
    };
    for(const group of [...selected,...groups.filter(g=>background.has(g.id))])visit(group);
    const included=groups.filter(g=>selectedIds.has(g.id)||background.has(g.id));
    // An unresolved declared relation in read-only background is not evidence of independence either.
    if(included.some(g=>exclusions.some(e=>e.groupId===g.id&&e.reasons.includes("declared_companion_unavailable")))||included.length>128) {
      for(const g of selected)exclusions.push({groupId:g.id,reasons:[included.length>128?"method_source_bound":"declared_companion_unavailable"]});
      continue;
    }
    validateModelAccountScope(sections,selected.flatMap(g=>g.occurrences.map(o=>o.section.id)),sources.runId);
    const scope=describeOriginalInputAccountScope(sources,selected,included);
    if(seen.has(scope.id))continue;seen.add(scope.id);eligible++;
    if(scopes.length<maximum)scopes.push(scope);
  }
  return {scopes,exclusions,enumeration:{complete:eligible===scopes.length,eligible,returned:scopes.length}};
}

/** Recheck against current source versions and protocol boundaries before using a previously offered scope. */
export function validateOriginalInputAccountScope(sources:OriginalInputSources,scope:OriginalInputAccountScope):void {
  // Validate this exact interval, independently of whether bounded enumeration still lists it first.
  validateOriginalInputSources(sources);
  if(scope.runId!==sources.runId||scope.owner!==sources.owner||scope.groups.some(g=>!sources.groups.some(s=>s.id===g.id&&s.revision===g.revision)))
    throw new TypeError("original_account_scope_changed");
  const selected=scope.groups.filter(g=>g.role==="source").map(g=>sources.groups.find(s=>s.id===g.id)!);
  validateModelAccountScope(sources.request.composition.sections,selected.flatMap(g=>g.occurrences.map(o=>o.section.id)),sources.runId);
  if(!selected.length||new Set(scope.groups.map(g=>g.id)).size!==scope.groups.length||scope.groups.length>128||
    scope.groups.some(g=>g.role!=="source"&&g.role!=="background"))throw new TypeError("original_account_scope_invalid");
  const included=scope.groups.map(g=>sources.groups.find(s=>s.id===g.id)!).sort((a,b)=>first(a)-first(b));
  if(modelInputValueDigest(scope)!==modelInputValueDigest(describeOriginalInputAccountScope(sources,selected,included)))
    throw new TypeError("original_account_scope_invalid");
}
export function describeOriginalInputAccountScope(sources:OriginalInputSources,selected:readonly OriginalInputSourceGroup[],included:readonly OriginalInputSourceGroup[]):OriginalInputAccountScope {
  const selectedIds=new Set(selected.map(g=>g.id));
  const declarations=included.map((g,i)=>({id:g.id,revision:g.revision,alias:`source_${i}`,role:selectedIds.has(g.id)?"source" as const:"background" as const}));
  const requirements=selected.flatMap(g=>g.occurrences.flatMap(({section})=>section.preservation!.obligations.map(o=>({
    id:`${section.id}:${o.id}`,revision:g.revision,basis:`Source-owned preservation ${g.id}@${g.revision}`,description:o.basis}))));
  const relationships:MethodRelationship[]=[];
  for(const group of included)for(const {section} of group.occurrences)for(const [i,relation] of (section.preservation?.relationships??[]).entries()) {
    const related=sources.groups.filter(g=>g.occurrences.some(o=>[o.section.source,...o.section.provenance?.sources??[]]
      .some(ref=>modelInputValueDigest(ref)===modelInputValueDigest(relation.source))));
    if(!related.length||related.some(g=>!included.some(value=>value.id===g.id)))throw new TypeError("original_account_companion_missing");
    if(selectedIds.has(group.id))relationships.push({id:`${section.id}:relationship:${i}`,basis:`Source-declared ${relation.kind} relationship`,
      sources:[...new Set([group,...related].map(g=>declarations.find(d=>d.id===g.id)!.alias))],
      description:`Preserve the declared ${relation.kind} relation from ${section.id} to ${relation.source.owner}:${relation.source.kind}:${relation.source.id}@${relation.source.revision}.`,requiresCommonEvidence:true});
  }
  const basis={runId:sources.runId,owner:sources.owner,groups:declarations,requirements,relationships};
  return {id:`original-account-scope:${modelInputValueDigest(basis)}`,...basis};
}
function first(group:OriginalInputSourceGroup):number{return Math.min(...group.occurrences.map(o=>o.position));}
function last(group:OriginalInputSourceGroup):number{return Math.max(...group.occurrences.map(o=>o.position));}
