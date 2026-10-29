import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import type {MethodSource,RepresentationMethodProgress} from "./RepresentationMethod.js";

/** Exact line boundaries are access units, never evidence of semantic independence. */
export function methodLineUnits(source:MethodSource,text:string,targetBytes:number):RepresentationMethodProgress["rangeUnits"] {
  if(!source.division)return [];
  const bytes=Buffer.from(text,"utf8");
  if(bytes.length!==source.access.range.end-source.access.range.start)throw new TypeError("representation_range_bytes_mismatch");
  const boundaries=[0];let previous=0;
  for(let i=0;i<bytes.length;i++)if(bytes[i]===10&&i+1-previous>=targetBytes){boundaries.push(i+1);previous=i+1;}
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
