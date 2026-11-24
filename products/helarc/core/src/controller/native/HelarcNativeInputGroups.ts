import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {OPENAI_RESPONSES} from "@agent-anything/model-interaction/protocol";
import {nativeInputGroupDigest,type NativeInputGroup} from "@agent-anything/provider-integrations/native";
import type {MaterialHold,MaterialRecipient} from "@agent-anything/context/custody";
import {validateHelarcNativeSourcePublication,type HelarcNativeSourcePublication} from "./HelarcNativeSourcePublications.js";
import {validateHelarcNativeWorkingSources,type HelarcNativeWorkingSources,type HelarcNativeWorkingGroup} from "./HelarcNativeWorkingSources.js";

export function helarcNativeGroupSourceIds(source:HelarcNativeWorkingGroup):readonly string[]{
  return [...new Set(source.sources.flatMap(s=>[s.source.id,`${s.source.owner}:${s.source.kind}:${s.source.id}:${s.source.revision??""}:${s.position}`]))];
}
export function helarcNativeSourceInputGroup(protocol:string,value:Omit<NativeInputGroup,"requires"|"replay">,
  preceding:readonly NativeInputGroup[]):NativeInputGroup{
  const reasoning=protocol===OPENAI_RESPONSES.id&&value.items.some(item=>item.type==="reasoning");
  return {...value,requires:reasoning?preceding.map(g=>({id:g.id,digest:nativeInputGroupDigest(g)})):[],
    replay:reasoning&&value.items.some(item=>item.type==="reasoning"&&!item.encrypted_content)?"remote_only":"local"};
}

/** Stable source groups carry native prefix evidence; custody identifiers are not content identity. */
export function helarcNativePublishedInputGroups(input:{
  readonly protocol:string;readonly items:readonly Record<string,unknown>[];
  readonly sources:HelarcNativeWorkingSources;readonly publications:readonly HelarcNativeSourcePublication[];
  readonly recipient:MaterialRecipient;readonly target:string;readonly inputId:string;readonly selectionId:string;
}){
  validateHelarcNativeWorkingSources(input.sources,input.items);
  if(input.publications.length!==input.sources.groups.length)throw new TypeError("native_input_publication_coverage_missing");
  const groups:NativeInputGroup[]=[],inputHolds:MaterialHold[]=[],selectionHolds:MaterialHold[]=[];
  for(const [index,source]of input.sources.groups.entries()){
    const publication=input.publications[index]!;
    if(digest(publication.group)!==digest(source))throw new TypeError("native_input_publication_group_changed");
    const published=validateHelarcNativeSourcePublication(publication,input.items,input.recipient,input.target);
    const body=published.representation.body;
    const hold:MaterialHold={id:`${input.inputId}:group:${index}:hold`,instanceId:publication.request.intent.instanceId,
      consumer:input.recipient,range:body,responsibility:"input",basis:input.inputId,releaseCondition:"input-consumer-released"};
    inputHolds.push(hold);selectionHolds.push({...hold,id:`${input.selectionId}:group:${index}:hold`,responsibility:"selection",basis:input.selectionId});
    const items=input.items.slice(source.occurrence.start,source.occurrence.start+source.occurrence.count);
    groups.push(helarcNativeSourceInputGroup(input.protocol,{id:source.id,representation:published.representation.ref,items,holds:[hold.id],
      sources:helarcNativeGroupSourceIds(source),
      deliveries:[]},groups));
  }
  return {groups,inputHolds,selectionHolds};
}
