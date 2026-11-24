import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {OPENAI_RESPONSES,type ProtocolRevisionRef} from "@agent-anything/model-interaction/protocol";
import type {TransformationDuty} from "@agent-anything/context/representation";
import {assertNativeInputManifest,bindNativeInputManifest,nativeInputGroupDigest,RESPONSES_COMPACT_METHOD,type NativeInputManifest} from "@agent-anything/provider-integrations/native";
import type {HelarcRetainedNativeInput} from "./HelarcNativeInputAcceptance.js";
import {validateHelarcNativeWorkingSources,type HelarcNativeWorkingGroup} from "./HelarcNativeWorkingSources.js";
import {helarcNativeWorkingGroupRevision} from "./HelarcNativeAccountScopes.js";
import {bindHelarcResponsesCompactSource,type HelarcResponsesCompactSource} from "./HelarcResponsesCompaction.js";
import {validateHelarcNativeSourcePublication,type HelarcNativeSourcePublication} from "./HelarcNativeSourcePublications.js";

export interface HelarcResponsesCompactInventory {
  readonly manifest:NativeInputManifest;
  readonly units:readonly {readonly groupId:string;readonly throughGroups:number;readonly nativeGroups:readonly string[];readonly members:readonly HelarcNativeWorkingGroup[];
    readonly receipt:string|null;readonly exclusions:readonly string[]}[];
}
const unique=<T>(items:readonly T[])=>[...new Map(items.map(i=>[digest(i),i])).values()];

/** Source declarations determine atomic intervals; no natural-language dependency is inferred. */
export function helarcResponsesCompactInventory(native:HelarcRetainedNativeInput,publications:readonly HelarcNativeSourcePublication[]):HelarcResponsesCompactInventory {
  const {manifest,workingSources}=native;
  assertNativeInputManifest(manifest);
  if(manifest.protocol.id!==OPENAI_RESPONSES.id||!workingSources||!Number.isSafeInteger(native.prefixGroups)||
    native.prefixGroups<0||native.prefixGroups>manifest.groups.length)throw new TypeError("compact_original_inventory_required");
  const items=manifest.groups.flatMap(g=>g.items),body=JSON.parse(native.wire.body);
  if(digest(body)!==native.wire.digest||digest(body.input)!==digest(manifest.groups.slice(native.prefixGroups).flatMap(g=>g.items))||
    (body.previous_response_id??null)!==native.predecessor||native.prefixGroups>0&&!native.predecessor)
    throw new TypeError("compact_original_inventory_changed");
  validateHelarcNativeWorkingSources(workingSources,items);
  const recipient={runId:manifest.scope.runId,recipient:manifest.scope.recipientId,purpose:manifest.scope.purpose.id};
  const groups=workingSources.groups,ends=groups.map((_,index)=>index),missing=new Set<string>();
  if(publications.length!==groups.length)throw new TypeError("compact_source_publication_membership_changed");
  const grouped=manifest.groups.length===groups.length&&manifest.groups.every((g,i)=>g.id===groups[i]!.id);
  if(!grouped&&(manifest.groups.length!==1||manifest.groups[0]!.replay!=="local"||native.prefixGroups!==0||native.predecessor!==null))
    throw new TypeError("compact_original_inventory_membership_unmapped");
  if(!grouped&&(manifest.groups[0]!.deliveries.length||manifest.groups[0]!.requires.length))
    throw new TypeError("compact_original_inventory_relationship_unmapped");
  const bySource=new Map<string,number[]>(),byExchange=new Map<string,number[]>();
  for(const [index,g]of groups.entries()){
    for(const {source}of g.sources)bySource.set(digest(source),[...bySource.get(digest(source))??[],index]);
    if(g.exchangeId)byExchange.set(g.exchangeId,[...byExchange.get(g.exchangeId)??[],index]);
  }
  const connect=(indices:readonly number[])=>{const first=Math.min(...indices),last=Math.max(...indices);ends[first]=Math.max(ends[first]!,last);};
  for(const indices of byExchange.values())connect(indices);
  for(const [index,g]of groups.entries())for(const relation of g.preservation.relationships){
    const found=bySource.get(digest(relation.source));
    if(!found?.length)missing.add(g.id);else connect([index,...found]);
  }
  // A native dependency is a declared preservation boundary, not a chronological guess.
  if(grouped)for(const [index,g]of manifest.groups.entries())for(const required of g.requires){
    const other=manifest.groups.findIndex(candidate=>candidate.id===required.id);
    if(other<0)throw new TypeError("compact_native_dependency_missing");
    connect([index,other]);
  }
  const units:HelarcResponsesCompactInventory["units"][number][]=[],nativeGroups:NativeInputManifest["groups"][number][]=[];
  for(let start=0;start<groups.length;){
    let end=start;
    for(let index=start;index<=end;index++)end=Math.max(end,ends[index]!);
    const members=groups.slice(start,end+1);
    const exclusions=unique(members.flatMap((g,index)=>[...g.protection,
      ...g.preservation.obligations.some(o=>o.requirement==="exact")?["exact_preservation"]:[],
      ...!g.acceptedBy?["recipient_acceptance_missing"]:g.acceptedBy.runId!==manifest.scope.runId?["different_recipient_run"]:[],
      ...missing.has(g.id)?["declared_relationship_unavailable"]:[],
      ...grouped&&manifest.groups[start+index]!.replay!=="local"?["native_source_not_locally_replayable"]:[],
      ...grouped&&manifest.groups[start+index]!.deliveries.length?["pending_native_delivery"]:[]]));
    const groupId=`native-compact-unit:${digest(members.map(g=>({id:g.id,revision:helarcNativeWorkingGroupRevision(g)})))}`;
    const receipt=exclusions.length?null:digest(members.map(g=>({groupId:g.id,revision:helarcNativeWorkingGroupRevision(g),acceptedBy:g.acceptedBy})));
    const memberIds:string[]=[];
    for(const g of members){
      const matches=publications.filter(p=>p.group.id===g.id);
      if(matches.length!==1||digest(matches[0]!.group)!==digest(g))throw new TypeError("compact_source_publication_membership_changed");
      const published=validateHelarcNativeSourcePublication(matches[0]!,items,recipient,manifest.target.configuration);
      const declared=grouped?manifest.groups[groups.indexOf(g)]!:null;
      const sourceItems=items.slice(g.occurrence.start,g.occurrence.start+g.occurrence.count);
      if(declared&&(digest(declared.items)!==digest(sourceItems)||digest(declared.representation)!==digest(published.representation.ref)))
        throw new TypeError("compact_native_source_publication_changed");
      const id=declared?.id??`native-compact-source:${digest({id:g.id,revision:helarcNativeWorkingGroupRevision(g)})}`;
      memberIds.push(id);
      nativeGroups.push(declared?{...declared,holds:[published.access.holdId]}:{id,representation:published.representation.ref,holds:[published.access.holdId],
        items:items.slice(g.occurrence.start,g.occurrence.start+g.occurrence.count),
        sources:unique(g.sources.map(s=>digest(s.source))),requires:[],deliveries:[],replay:"local"});
    }
    units.push({groupId,throughGroups:end+1,nativeGroups:memberIds,members,receipt,exclusions});
    start=end+1;
  }
  return {manifest:bindNativeInputManifest({...manifest,groups:nativeGroups}),units};
}

/** Revalidates a named prefix directly, independent of bounded offer enumeration. */
export function bindHelarcResponsesCompactPrefix(native:HelarcRetainedNativeInput,publications:readonly HelarcNativeSourcePublication[],throughGroups:number,purpose:ProtocolRevisionRef):HelarcResponsesCompactSource {
  return bindPrefix(helarcResponsesCompactInventory(native,publications),throughGroups,purpose);
}
function bindPrefix(inventory:HelarcResponsesCompactInventory,throughGroups:number,purpose:ProtocolRevisionRef):HelarcResponsesCompactSource {
  const {manifest,units}=inventory;
  if(!Number.isSafeInteger(throughGroups)||throughGroups<1||!units.some(u=>u.throughGroups===throughGroups))
    throw new TypeError("compact_prefix_membership_invalid");
  const selected=units.filter(u=>u.throughGroups<=throughGroups);
  if(selected.some(u=>u.exclusions.length||!u.receipt))throw new TypeError("compact_prefix_protected");
  const duties:TransformationDuty[]=[],dutyBasis:NonNullable<HelarcResponsesCompactSource["dutyBasis"]>[number][]=[];
  for(const unit of selected)for(const g of unit.members){
    const revision=helarcNativeWorkingGroupRevision(g);
    for(const o of g.preservation.obligations){
      const id=`${g.id}:obligation:${o.id}`;
      duties.push({id,revision,requirement:"semantic",permittedEvidence:o.permittedEvidence??["method_assurance","continuation_probe"]});
      dutyBasis.push({dutyId:id,description:o.basis,sourceGroups:[unit.nativeGroups[unit.members.indexOf(g)]!]});
    }
    for(const [index,r]of g.preservation.relationships.entries()){
      const id=`${g.id}:relationship:${index}`;
      duties.push({id,revision,requirement:"semantic",permittedEvidence:["method_assurance","continuation_probe"]});
      dutyBasis.push({dutyId:id,description:`Preserve the source-declared ${r.kind} relationship to ${r.source.owner}:${r.source.kind}:${r.source.id}@${r.source.revision}.`,sourceGroups:unit.nativeGroups});
    }
  }
  const receipts=selected.flatMap(u=>u.nativeGroups.map(groupId=>({groupId,basis:u.receipt!})));
  const coverage=manifest.groups.slice(0,throughGroups).map(g=>({id:g.id,digest:nativeInputGroupDigest(g),deliveredBasis:receipts.find(r=>r.groupId===g.id)!.basis}));
  return bindHelarcResponsesCompactSource({manifest,throughGroups,receipts,purpose,duties,dutyBasis,
    dependencies:{source:digest(coverage),target:manifest.target.configuration,authority:manifest.target.disclosure,recipient:manifest.scope.id,
      method:`${RESPONSES_COMPACT_METHOD.id}:${RESPONSES_COMPACT_METHOD.revision}`,requirements:digest(duties)},
    ancestry:unique(selected.flatMap(u=>u.members.flatMap(g=>[...g.representations.map(r=>`${r.id}@${r.revision}`),...g.derivedFrom?.map(r=>`${r.groupId}@${r.revision}`)??[]])))});
}

export function helarcResponsesCompactScopes(native:HelarcRetainedNativeInput,publications:readonly HelarcNativeSourcePublication[],purpose:ProtocolRevisionRef,maximum:number){
  if(!Number.isSafeInteger(maximum)||maximum<1||maximum>128)throw new TypeError("compact_scope_enumeration_bound_invalid");
  const inventory=helarcResponsesCompactInventory(native,publications);
  const firstBlocked=inventory.units.findIndex(u=>u.exclusions.length),eligible=firstBlocked<0?inventory.units.length:firstBlocked;
  const scopes=Array.from({length:Math.min(eligible,maximum)},(_,i)=>bindPrefix(inventory,inventory.units[eligible-i-1]!.throughGroups,purpose));
  return {inventory,scopes,enumeration:{complete:scopes.length===eligible,eligible,returned:scopes.length},
    exclusions:inventory.units.filter(u=>u.exclusions.length).map(u=>({groupId:u.groupId,sourceGroups:u.members.map(g=>g.id),reasons:u.exclusions}))};
}
