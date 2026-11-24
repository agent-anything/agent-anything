import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import type {OriginalInputMethodScope} from "@agent-anything/agent-runtime/context-representation";
import {validateHelarcNativeWorkingSources,type HelarcNativeWorkingSources,type HelarcNativeWorkingGroup} from "./HelarcNativeWorkingSources.js";

export interface HelarcNativeAccountScopes {
  readonly scopes:readonly OriginalInputMethodScope[];
  readonly exclusions:readonly {readonly groupId:string;readonly reasons:readonly string[]}[];
  readonly enumeration:{readonly complete:boolean;readonly eligible:number;readonly returned:number};
}
/** A stable source version excludes request-relative coordinates and transient delivery protection. */
export function helarcNativeWorkingGroupRevision(group:HelarcNativeWorkingGroup):string {
  return digest({id:group.id,originRunId:group.originRunId,sources:group.sources,duties:group.duties,preservation:group.preservation,
    exchangeId:group.exchangeId,representations:group.representations,...(group.derivedFrom?{derivedFrom:group.derivedFrom}:{}),content:group.occurrence.digest});
}

/** Original accepted work is revalidated directly, not rediscovered in a bounded offer list. */
export function validateHelarcNativeAccountScope(input:{readonly runId:string;readonly items:readonly Record<string,unknown>[];
  readonly sources:HelarcNativeWorkingSources;readonly scope:OriginalInputMethodScope}):void {
  validateHelarcNativeWorkingSources(input.sources,input.items);
  const {scope}=input,groups=input.sources.groups;
  if(scope.runId!==input.runId||scope.owner!=="helarc-native-input"||scope.groups.length>128||
    new Set(scope.groups.map(g=>g.id)).size!==scope.groups.length||
    scope.groups.some(g=>g.role!=="source"&&g.role!=="background"||!groups.some(s=>s.id===g.id&&helarcNativeWorkingGroupRevision(s)===g.revision)))
    throw new TypeError("native_account_method_scope_changed");
  const selected=new Set(scope.groups.filter(g=>g.role==="source").map(g=>g.id));
  const positions=groups.flatMap((g,index)=>selected.has(g.id)?[index]:[]);
  if(!positions.length||positions.at(-1)!-positions[0]!+1!==positions.length)throw new TypeError("native_account_method_scope_changed");
  const start=positions[0]!,end=positions.at(-1)!;
  const exchanges=new Set(groups.slice(start,end+1).flatMap(g=>g.exchangeId?[g.exchangeId]:[]));
  if(groups.some((g,index)=>g.exchangeId&&exchanges.has(g.exchangeId)&&(index<start||index>end)))
    throw new TypeError("native_account_method_exchange_split");
  const candidates=accountScopes({runId:input.runId,items:input.items,sources:input.sources,maximum:1,
    backgroundGroupIds:scope.groups.filter(g=>g.role==="background").map(g=>g.id)},selected);
  if(!candidates.scopes.some(s=>digest(s)===digest(scope)))throw new TypeError("native_account_method_scope_changed");
}

/** Legal alternatives, not a decision that transformation is beneficial or semantically safe. */
export function helarcNativeAccountScopes(input:{readonly runId:string;readonly items:readonly Record<string,unknown>[];
  readonly sources:HelarcNativeWorkingSources;readonly maximum:number;readonly backgroundGroupIds:readonly string[]}):HelarcNativeAccountScopes {
  return accountScopes(input);
}
function accountScopes(input:Parameters<typeof helarcNativeAccountScopes>[0],original?:ReadonlySet<string>):HelarcNativeAccountScopes {
  validateHelarcNativeWorkingSources(input.sources,input.items);
  const groups=input.sources.groups,{maximum}=input;
  if(!input.runId||!Number.isSafeInteger(maximum)||maximum<1||maximum>128||new Set(input.backgroundGroupIds).size!==input.backgroundGroupIds.length||
    input.backgroundGroupIds.some(id=>!groups.some(g=>g.id===id)))throw new TypeError("native_account_scope_configuration_invalid");
  const sourceIndex=new Map<string,HelarcNativeWorkingGroup[]>();
  for(const g of groups)for(const {source}of g.sources){const key=digest(source);sourceIndex.set(key,[...(sourceIndex.get(key)??[]),g]);}
  const reasons=new Map<string,Set<string>>(),companions=new Map<string,Set<HelarcNativeWorkingGroup>>(),lastExchange=new Map<string,number>();
  for(const [index,g]of groups.entries()){
    const blocked=new Set<string>(g.protection),related=new Set<HelarcNativeWorkingGroup>();
    if(g.preservation.obligations.some(o=>o.requirement==="exact"))blocked.add("exact_preservation");
    for(const relation of g.preservation.relationships){
      const found=sourceIndex.get(digest(relation.source));
      if(!found?.length)blocked.add("declared_companion_unavailable");
      for(const other of found??[])related.add(other);
    }
    reasons.set(g.id,blocked);companions.set(g.id,related);
    if(g.exchangeId)lastExchange.set(g.exchangeId,index);
  }
  // A native exchange can surround addressed notifications; its interval cannot be cut in half.
  const units:HelarcNativeWorkingGroup[][]=[];
  for(let start=0;start<groups.length;){
    let end=start;
    for(let index=start;index<=end;index++){const exchange=groups[index]!.exchangeId;if(exchange)end=Math.max(end,lastExchange.get(exchange)!);}
    units.push(groups.slice(start,end+1));start=end+1;
  }
  const intervals:HelarcNativeWorkingGroup[][][]=[],current:HelarcNativeWorkingGroup[][]=[];
  const flush=()=>{if(current.length)intervals.push(current.splice(0));};
  for(const unit of units){
    if(unit.some(g=>reasons.get(g.id)!.size)){
      for(const g of unit)if(!reasons.get(g.id)!.size)reasons.get(g.id)!.add("native_exchange_companion_protected");
      flush();
    }else current.push(unit);
  }
  flush();
  const retained=original?groups.filter(g=>original.has(g.id)):null;
  const candidates=retained?(retained.some(g=>reasons.get(g.id)!.size)?[]:[retained]):
    intervals.flatMap(interval=>interval.length===1?[interval[0]!]:[interval.flat(),...interval]);
  const scopes:OriginalInputMethodScope[]=[],seen=new Set<string>();let eligible=0;
  for(const selected of candidates){
    const selectedIds=new Set(selected.map(g=>g.id)),includedIds=new Set([...selectedIds,...input.backgroundGroupIds]);
    const queue=groups.filter(g=>includedIds.has(g.id)),visited=new Set<string>();
    for(let index=0;index<queue.length;index++){
      const g=queue[index]!;if(visited.has(g.id))continue;visited.add(g.id);
      for(const companion of companions.get(g.id)??[])if(!includedIds.has(companion.id)){includedIds.add(companion.id);queue.push(companion);}
    }
    const included=groups.filter(g=>includedIds.has(g.id));
    const unavailable=included.some(g=>reasons.get(g.id)!.has("declared_companion_unavailable"));
    if(unavailable||included.length>128){for(const g of selected)reasons.get(g.id)!.add(unavailable?"declared_companion_unavailable":"method_source_bound");continue;}
    const declarations=included.map((g,i)=>({id:g.id,revision:helarcNativeWorkingGroupRevision(g),alias:`source_${i}`,role:selectedIds.has(g.id)?"source" as const:"background" as const}));
    const requirements=selected.flatMap(g=>g.preservation.obligations.map(o=>({id:`${g.id}:${o.id}`,revision:helarcNativeWorkingGroupRevision(g),
      basis:`Source-owned native preservation ${g.id}`,description:o.basis})));
    const relationships=selected.flatMap(g=>g.preservation.relationships.map((relation,i)=>({id:`${g.id}:relationship:${i}`,basis:`Source-declared ${relation.kind} relationship`,
      sources:[...new Set([g,...sourceIndex.get(digest(relation.source))!].map(member=>declarations.find(d=>d.id===member.id)!.alias))],
      description:`Preserve the declared ${relation.kind} relation to ${relation.source.owner}:${relation.source.kind}:${relation.source.id}@${relation.source.revision}.`,requiresCommonEvidence:true})));
    const value={runId:input.runId,owner:"helarc-native-input",groups:declarations,requirements,relationships},id=`native-account-scope:${digest(value)}`;
    if(seen.has(id))continue;seen.add(id);eligible++;
    if(scopes.length<maximum)scopes.push({id,...value});
  }
  return {scopes,exclusions:groups.filter(g=>reasons.get(g.id)!.size).map(g=>({groupId:g.id,reasons:[...reasons.get(g.id)!].sort()})),
    enumeration:{complete:eligible===scopes.length,eligible,returned:scopes.length}};
}
