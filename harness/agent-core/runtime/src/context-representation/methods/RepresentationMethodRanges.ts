import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import type {MethodSource,RepresentationMethodProgress} from "./RepresentationMethod.js";

/** Declared text boundaries are access units, never evidence of semantic independence. */
export function methodTextUnits(source:MethodSource,text:string,targetBytes:number):RepresentationMethodProgress["rangeUnits"] {
  if(!source.division)return [];
  if(!Number.isSafeInteger(targetBytes)||targetBytes<1)throw new TypeError("representation_range_target_invalid");
  const bytes=Buffer.from(text,"utf8");
  if(bytes.length!==source.access.range.end-source.access.range.start)throw new TypeError("representation_range_bytes_mismatch");
  const boundaries=[0];let previous=0;
  if(source.division.kind==="text_lines") {
    for(let i=0;i<bytes.length;i++)if(bytes[i]===10&&i+1-previous>=targetBytes){boundaries.push(i+1);previous=i+1;}
  }else while(bytes.length-previous>targetBytes){
    let end=previous+targetBytes;
    while(end>previous&&(bytes[end]!&0xc0)===0x80)end--;
    if(end===previous){end=previous+1;while(end<bytes.length&&(bytes[end]!&0xc0)===0x80)end++;}
    const line=bytes.lastIndexOf(10,end-1);if(line>=previous)end=line+1;
    if(end===bytes.length)break;boundaries.push(end);previous=end;
  }
  if(boundaries.at(-1)!==bytes.length)boundaries.push(bytes.length);
  if(boundaries.length<=2)return [];
  return boundaries.slice(1).map((end,index)=>{
    const start=boundaries[index]!,range={...source.access.range,start:source.access.range.start+start,end:source.access.range.start+end};
    const alias=`range_${modelInputValueDigest({alias:source.alias,range}).slice(-24)}`;
    const {division,...original}=source;void division;
    return {originalAlias:source.alias,source:{...original,alias,access:{...source.access,id:`${source.access.id}:${alias}`,range},label:`${source.label}, bytes ${range.start}-${range.end} (partial original)`,indivisibleGroup:alias}};
  });
}
export function methodSources(progress:RepresentationMethodProgress):readonly MethodSource[] {return [...progress.request.sources,...progress.rangeUnits.map(u=>u.source)];}

export function methodLeafRanges(progress:RepresentationMethodProgress,originalAlias:string):RepresentationMethodProgress["rangeUnits"] {
  return progress.rangeUnits.filter(u=>u.originalAlias===originalAlias&&!progress.rangeUnits.some(child=>child.parentAlias===u.source.alias));
}

export function refinableMethodSource(progress:RepresentationMethodProgress):MethodSource|null {
  const job=progress.current;
  if(!job||job.kind!=="generate"||job.sources.length!==1||job.level>=progress.request.bounds.levels)return null;
  const alias=job.sources[0]!,unit=progress.rangeUnits.find(u=>u.source.alias===alias),
    original=progress.request.sources.find(s=>s.alias===(unit?.originalAlias??alias)),source=unit?.source??original;
  if(!source||!original?.division||source.access.range.end-source.access.range.start<=4)return null;
  return {...source,division:original.division};
}
