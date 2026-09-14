import type { ContentTarget } from "../content/ContentLocation.js";

const focusKeys = ["fact", "content", "flowRun", "flowInvocation", "flowOccurrence", "flowStep"];
export function inspectionReadLocation(params:URLSearchParams):string {
  const read=new URLSearchParams(params);
  for(const key of focusKeys) read.delete(key);
  return read.toString();
}
export function readContentTarget(value:string|null):ContentTarget|null {
  if(!value) return null;
  try {
    const target=JSON.parse(value);
    if(!target || typeof target.id!=="string" || target.id.length>512) return null;
    if(["jsonPointer","stage","recordId"].some(key=>target[key]!==undefined && (typeof target[key]!=="string" || target[key].length>4096))) return null;
    return {id:target.id,jsonPointer:target.jsonPointer,stage:target.stage,recordId:target.recordId};
  } catch{return null;}
}
