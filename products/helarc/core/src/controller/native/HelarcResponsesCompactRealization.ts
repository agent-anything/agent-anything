import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import type {NativeInputGroup,ResponsesCompactedWindow} from "@agent-anything/provider-integrations/native";
import type {HelarcRetainedNativeInput} from "./HelarcNativeInputAcceptance.js";
import {HelarcNativeWorkingInput} from "./HelarcNativeWorkingSources.js";
import {helarcNativeWorkingGroupRevision} from "./HelarcNativeAccountScopes.js";
import {bindHelarcResponsesCompactPrefix,helarcResponsesCompactInventory} from "./HelarcResponsesCompactScopes.js";
import {helarcResponsesCompactedGroups,type HelarcResponsesCompactSource,type HelarcResponsesCompactAssessment} from "./HelarcResponsesCompaction.js";
import type {HelarcNativeSourcePublication} from "./HelarcNativeSourcePublications.js";

/** Proposes whole native output plus its finite suffix. No selection or receipt is created here. */
export function realizeHelarcResponsesCompact(input:{readonly original:HelarcRetainedNativeInput;
  readonly publications:readonly HelarcNativeSourcePublication[];
  readonly source:HelarcResponsesCompactSource;readonly candidate:ResponsesCompactedWindow;readonly assessment:HelarcResponsesCompactAssessment;
  readonly group:{readonly id:string;readonly representation:NativeInputGroup["representation"];readonly holds:readonly string[];readonly observation:string}}){
  const {original,source,candidate,assessment,group}=input,inventory=helarcResponsesCompactInventory(original,input.publications);
  const rebuilt=bindHelarcResponsesCompactPrefix(original,input.publications,source.groups.length,source.methodRequest.purpose);
  if(digest(rebuilt.duties)!==digest(source.duties)||digest(rebuilt.dutyBasis)!==digest(source.dutyBasis)||
    digest(rebuilt.ancestry)!==digest(source.ancestry)||original.resultPresentations?.length)throw new TypeError("compact_realization_source_changed");
  const groups=helarcResponsesCompactedGroups({source,candidate,assessment,current:inventory.manifest,dependencies:source.dependencies,group});
  const members=inventory.units.filter(u=>u.throughGroups<=source.groups.length).flatMap(u=>u.members),ids=new Set(members.map(g=>g.id));
  const unique=<T>(items:readonly T[])=>[...new Map(items.map(i=>[digest(i),i])).values()];
  const working=new HelarcNativeWorkingInput();
  working.append(candidate.items,{id:group.id,originRunId:original.manifest.scope.runId,
    sources:unique(members.flatMap(g=>g.sources)),duties:unique(members.flatMap(g=>g.duties)),
    preservation:{obligations:members.flatMap(g=>g.preservation.obligations.map(o=>({...o,id:`${g.id}:${o.id}`}))),
      relationships:unique(members.flatMap(g=>g.preservation.relationships))},
    exchangeId:null,protection:[],acceptedBy:null,
    derivedFrom:unique(members.flatMap(g=>[{groupId:g.id,originRunId:g.originRunId,revision:helarcNativeWorkingGroupRevision(g)},...g.derivedFrom??[]])),
    representations:unique([...members.flatMap(g=>g.representations),group.representation])});
  const items=original.manifest.groups.flatMap(g=>g.items);
  for(const g of original.workingSources!.groups)if(!ids.has(g.id)){
    const {occurrence,...basis}=g;working.append(items.slice(occurrence.start,occurrence.start+occurrence.count),basis);
  }
  if(digest(working.items)!==digest(groups.flatMap(g=>g.items)))throw new TypeError("compact_realization_coverage_changed");
  return {groups,items:working.items,workingSources:working.snapshot(),originalGroups:members.map(g=>({id:g.id,revision:helarcNativeWorkingGroupRevision(g)}))};
}
