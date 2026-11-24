import {modelInputValueDigest as digest,snapshotModelInputPreservation,snapshotModelInputSourceRef,
  type InputDuty,type ModelInputPreservation,type ModelInputSourceRef} from "@agent-anything/model-interaction/input";
import type {ModelPurposeEvidence,ProtocolRevisionRef} from "@agent-anything/model-interaction/protocol";

type Item=Record<string,unknown>;
export interface HelarcNativeWorkingGroup {
  readonly id:string;
  readonly originRunId:string;
  readonly sources:readonly {readonly source:ModelInputSourceRef;readonly position:string}[];
  readonly duties:readonly InputDuty[];
  readonly preservation:ModelInputPreservation;
  readonly exchangeId:string|null;
  readonly protection:readonly ("first_delivery"|"active_exchange")[];
  readonly acceptedBy:{readonly runId:string;readonly activityId:string;readonly acceptance:ProtocolRevisionRef}|null;
  readonly representations:readonly ProtocolRevisionRef[];
  readonly derivedFrom?:readonly {readonly groupId:string;readonly originRunId:string;readonly revision:string}[];
  readonly occurrence:{readonly start:number;readonly count:number;readonly digest:string};
}
/** Coordinates refer to working native items, excluding separately bound system instructions. */
export interface HelarcNativeWorkingSources {
  readonly revision:"1";
  readonly itemsDigest:string;
  readonly groups:readonly HelarcNativeWorkingGroup[];
}
export type HelarcNativeWorkingGroupBasis=Omit<HelarcNativeWorkingGroup,"occurrence">;
const duties=new Set<InputDuty>(["behavior","objective","capabilities","continuity","working_understanding","evidence","new_information"]);

export function bindHelarcNativeWorkingSources(items:readonly Item[],groups:readonly HelarcNativeWorkingGroup[]):HelarcNativeWorkingSources {
  const value:HelarcNativeWorkingSources={revision:"1",itemsDigest:digest(items),groups};
  validateHelarcNativeWorkingSources(value,items);
  return structuredClone(value);
}
export function validateHelarcNativeWorkingSources(value:HelarcNativeWorkingSources,items:readonly Item[]):void {
  if(value?.revision!=="1"||value.itemsDigest!==digest(items)||!Array.isArray(value.groups))throw new TypeError("native_working_sources_changed");
  let offset=0;
  const ids=new Set<string>();
  for(const group of value.groups as readonly HelarcNativeWorkingGroup[]){
    const o=group.occurrence;
    if(!group.id||ids.has(group.id)||!group.originRunId||!group.sources.length||!group.duties.length||
      new Set(group.duties).size!==group.duties.length||group.duties.some(d=>!duties.has(d))||
      !Number.isSafeInteger(o.start)||o.start!==offset||!Number.isSafeInteger(o.count)||o.count<1||o.start+o.count>items.length||
      o.digest!==digest(items.slice(o.start,o.start+o.count)))throw new TypeError("native_working_group_invalid");
    ids.add(group.id);offset+=o.count;
    for(const source of group.sources){snapshotModelInputSourceRef(source.source);if(typeof source.position!=="string"||source.position!==""&&!source.position.startsWith("/"))throw new TypeError("native_working_source_position_invalid");}
    snapshotModelInputPreservation(group.preservation);
    if(new Set(group.protection).size!==group.protection.length||group.protection.some(p=>p!=="first_delivery"&&p!=="active_exchange")||
      group.exchangeId!==null&&!group.exchangeId||group.protection.includes("active_exchange")&&!group.exchangeId||
      group.acceptedBy!==null&&(!group.acceptedBy.runId||!group.acceptedBy.activityId||!group.acceptedBy.acceptance.id||!group.acceptedBy.acceptance.revision)||
      group.representations.some(r=>!r.id||!r.revision)||
      group.derivedFrom?.some(r=>!r.groupId||!r.originRunId||!r.revision))throw new TypeError("native_working_group_basis_invalid");
  }
  if(offset!==items.length)throw new TypeError("native_working_source_coverage_missing");
}

/** Comparable growth keeps its baseline across new facts, but not adopted representations. */
export function helarcNativeObservationContinuity(sources:HelarcNativeWorkingSources,items:readonly Item[]):string {
  validateHelarcNativeWorkingSources(sources,items);
  const represented=sources.groups.filter(group=>group.representations.length>0).map(group=>({
    originRunId:group.originRunId,groupId:group.id,representations:group.representations,
    derivedFrom:group.derivedFrom??[],
  }));
  const native=sources.groups.flatMap(group=>items.slice(group.occurrence.start,group.occurrence.start+group.occurrence.count)
    .filter(item=>item.type==="compaction").map(item=>({originRunId:group.originRunId,groupId:group.id,content:digest(item)})));
  return represented.length||native.length?`native-representation-baseline:${digest({represented,native})}`:"original";
}

/** Assembly declares meaning; this builder checks only positions and complete coverage. */
export class HelarcNativeWorkingInput {
  readonly items:Item[]=[];
  private readonly groups:HelarcNativeWorkingGroup[]=[];
  append(items:readonly Item[],basis:HelarcNativeWorkingGroupBasis):void {
    if(!items.length)return;
    this.groups.push({...basis,occurrence:{start:this.items.length,count:items.length,digest:digest(items)}});
    this.items.push(...items);
  }
  inherit(items:readonly Item[],sources:HelarcNativeWorkingSources,evidence:ModelPurposeEvidence):void {
    validateHelarcNativeWorkingSources(sources,items);
    const acceptedBy={runId:evidence.scope.runId,activityId:evidence.scope.activityId,acceptance:evidence.acceptance};
    for(const group of sources.groups){
      const {occurrence,...basis}=group;
      this.append(items.slice(occurrence.start,occurrence.start+occurrence.count),{...basis,protection:[],acceptedBy});
    }
  }
  snapshot():HelarcNativeWorkingSources{return bindHelarcNativeWorkingSources(this.items,this.groups);}
}

/** Only explicitly declared body substitutions may change the source inventory this way. */
export function substituteHelarcNativeWorkingSources(input:{readonly original:readonly Item[];readonly selected:readonly Item[];
  readonly sources:HelarcNativeWorkingSources;readonly changes:readonly {readonly index:number;readonly representation:ProtocolRevisionRef}[]}):HelarcNativeWorkingSources {
  validateHelarcNativeWorkingSources(input.sources,input.original);
  if(input.original.length!==input.selected.length)throw new TypeError("native_working_substitution_shape_changed");
  const changed=new Map<number,ProtocolRevisionRef[]>();
  for(const change of input.changes){
    if(!Number.isSafeInteger(change.index)||change.index<0||change.index>=input.original.length||!change.representation.id||!change.representation.revision)
      throw new TypeError("native_working_substitution_position_invalid");
    changed.set(change.index,[...(changed.get(change.index)??[]),change.representation]);
  }
  for(const [index,item]of input.original.entries())if(!changed.has(index)&&digest(item)!==digest(input.selected[index]))
    throw new TypeError("native_working_unrelated_content_changed");
  return bindHelarcNativeWorkingSources(input.selected,input.sources.groups.map(group=>{
    const {start,count}=group.occurrence;
    const representations=[...group.representations,...input.changes.filter(c=>c.index>=start&&c.index<start+count).map(c=>c.representation)];
    return {...group,representations:[...new Map(representations.map(r=>[digest(r),r])).values()],
      occurrence:{start,count,digest:digest(input.selected.slice(start,start+count))}};
  }));
}
