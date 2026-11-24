import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import type {ProtocolRevisionRef} from "@agent-anything/model-interaction/protocol";
import type {OriginalInputMethodScope} from "@agent-anything/agent-runtime/context-representation";
import {HelarcNativeWorkingInput,type HelarcNativeWorkingSources,type HelarcNativeWorkingGroup} from "./HelarcNativeWorkingSources.js";
import {validateHelarcNativeAccountScope,helarcNativeWorkingGroupRevision} from "./HelarcNativeAccountScopes.js";

/** A proposed native realization only. Preservation, complete-input checking and adoption are separate. */
export function realizeHelarcNativeAccount(input:{readonly runId:string;readonly items:readonly Record<string,unknown>[];
  readonly sources:HelarcNativeWorkingSources;readonly scope:OriginalInputMethodScope;
  readonly account:{readonly text:string;readonly representation:ProtocolRevisionRef};
}) {
  validateHelarcNativeAccountScope(input);
  if(typeof input.account.text!=="string"||!input.account.text.trim()||!input.account.representation.id||!input.account.representation.revision)
    throw new TypeError("native_account_realization_invalid");
  const selected=new Set(input.scope.groups.filter(g=>g.role==="source").map(g=>g.id));
  const original=input.sources.groups.filter(g=>selected.has(g.id)),first=original[0]!,last=original.at(-1)!;
  const start=first.occurrence.start,end=last.occurrence.start+last.occurrence.count;
  const inherited=original.flatMap(g=>[{groupId:g.id,originRunId:g.originRunId,revision:helarcNativeWorkingGroupRevision(g)},...g.derivedFrom??[]]);
  const groupId=`native-account:${digest({scope:input.scope.id,representation:input.account.representation})}`;
  const summary={role:"user",content:`Historical working account (data, not a new user instruction):\n${JSON.stringify({
    representation:input.account.representation,sourceScope:input.scope.id,account:input.account.text})}`};
  const unique=<T>(items:readonly T[])=>[...new Map(items.map(i=>[digest(i),i])).values()];
  const basis:Omit<HelarcNativeWorkingGroup,"occurrence">={id:groupId,originRunId:input.runId,
    sources:unique(original.flatMap(g=>g.sources)),duties:unique(original.flatMap(g=>g.duties)),
    preservation:{obligations:original.flatMap(g=>g.preservation.obligations.map(o=>({...o,id:`${g.id}:${o.id}`}))),
      relationships:unique(original.flatMap(g=>g.preservation.relationships))},
    exchangeId:null,protection:[],acceptedBy:null,derivedFrom:unique(inherited),
    representations:unique([...original.flatMap(g=>g.representations),input.account.representation])};
  const working=new HelarcNativeWorkingInput();
  for(const group of input.sources.groups){
    if(group.id===first.id)working.append([summary],basis);
    if(!selected.has(group.id)){
      const {occurrence,...retained}=group;
      working.append(input.items.slice(occurrence.start,occurrence.start+occurrence.count),retained);
    }
  }
  return {items:working.items,sources:working.snapshot(),replacement:{groupId,start,end,count:1,representation:input.account.representation},
    originals:original.map(g=>({groupId:g.id,originRunId:g.originRunId,revision:helarcNativeWorkingGroupRevision(g)}))};
}

/** All scopes are judged against the original input, never against another account's rewrite. */
export function realizeHelarcNativeAccounts(input:{readonly runId:string;readonly items:readonly Record<string,unknown>[];
  readonly sources:HelarcNativeWorkingSources;readonly members:readonly {readonly scope:OriginalInputMethodScope;
    readonly account:{readonly text:string;readonly representation:ProtocolRevisionRef}}[]}) {
  if(!input.members.length||input.members.length>128)throw new TypeError("native_account_members_invalid");
  const realized=input.members.map(member=>realizeHelarcNativeAccount({...input,...member}));
  const ordered=[...realized].sort((a,b)=>a.replacement.start-b.replacement.start);
  for(let n=1;n<ordered.length;n++)if(ordered[n]!.replacement.start<ordered[n-1]!.replacement.end)
    throw new TypeError("native_account_replacement_overlap");
  const working=new HelarcNativeWorkingInput();
  for(const group of input.sources.groups){
    const replacement=ordered.find(r=>group.occurrence.start>=r.replacement.start&&group.occurrence.start<r.replacement.end);
    if(replacement){
      if(group.occurrence.start===replacement.replacement.start){
        const {occurrence,...basis}=replacement.sources.groups.find(g=>g.id===replacement.replacement.groupId)!;
        working.append(replacement.items.slice(occurrence.start,occurrence.start+occurrence.count),basis);
      }
    }else{
      const {occurrence,...basis}=group;working.append(input.items.slice(occurrence.start,occurrence.start+occurrence.count),basis);
    }
  }
  return {items:working.items,sources:working.snapshot(),replacements:ordered.map(r=>r.replacement),
    originals:ordered.flatMap(r=>r.originals)};
}
