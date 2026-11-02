import type {InspectionEvidenceOrigin} from "./InspectionProcessEvidence.js";

export interface InspectionPrice {
  readonly revision:string; readonly providerId:string; readonly model:string; readonly currency:string;
  readonly validFrom:string; readonly validUntil:string;
  readonly inputPerToken:number; readonly outputPerToken:number;
  readonly inputPricing:"uniform"|"cache_partitioned";
  /** Inclusive input subsets; a distinct price requires an explicit count. */
  readonly cachedReadPerToken:number|null; readonly cachedWritePerToken:number|null;
}
export interface InspectionMeasuredUsage {
  readonly inputTokens:number|null; readonly outputTokens:number|null;
  readonly cacheReadTokens:number|null; readonly cacheWriteTokens:number|null;
  readonly cacheRelation:"input_subsets"|"unknown";
  readonly accountingRevision:string|null; readonly consistent:boolean|null;
}
export type InspectionMeasurementData =
  | {readonly kind:"attempt";readonly boundary:"bound"|"dispatched"|"settled";
      readonly requestId:string;readonly providerId:string;readonly model:string;readonly status:string;
      readonly usage:InspectionMeasuredUsage|null;readonly price:InspectionPrice|null}
  | {readonly kind:"quantity";readonly metric:"capacity"|"material_read"|"material_transfer"|"material_stored"|"reuse_eligibility"|"reuse_content"|"reuse_check"|"reuse_input";
      readonly unit:"tokens"|"bytes"|"items"|"count";readonly evidence:"actual"|"estimate"|"bounds"|"unknown";
      readonly value:number|null;readonly upper:number|null;readonly method:string;readonly complete:boolean}
  | {readonly kind:"responsibility";readonly sequence:number;readonly state:"open"|"closed"};
/** Owner-supplied measurements, never an interpreter of arbitrary diagnostic JSON. */
export interface InspectionWorkMeasurement {
  readonly version:"1"; readonly origin:InspectionEvidenceOrigin;
  readonly purpose:string|null; readonly target:string|null;
  readonly data:InspectionMeasurementData;
}

/** A physical work identity may have several legitimate lifecycle observations. */
export function inspectionMeasurementObservationOrigin(value:InspectionWorkMeasurement):InspectionEvidenceOrigin {
  const part=value.data.kind==="attempt"?value.data.boundary:value.data.kind==="responsibility"?value.data.sequence:"quantity";
  return {...value.origin,id:JSON.stringify([value.origin.id,part])};
}

export function validWorkMeasurement(value:unknown):value is InspectionWorkMeasurement {
  const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
  const keys=(v:Record<string,unknown>,names:string[])=>Object.keys(v).length===names.length&&names.every(n=>Object.hasOwn(v,n));
  const text=(v:unknown)=>typeof v==="string"&&v.length>0&&v.length<=512;
  const count=(v:unknown)=>typeof v==="number"&&Number.isFinite(v)&&v>=0&&v<=Number.MAX_SAFE_INTEGER;
  const maybe=(v:unknown)=>v===null||count(v);
  if(!object(value)||!keys(value,["version","origin","purpose","target","data"])||value.version!=="1"||!object(value.origin)||
    !keys(value.origin,["owner","id","runId","revision"])||![value.origin.owner,value.origin.id,value.origin.revision].every(text)||
    !(value.origin.runId===null||text(value.origin.runId))||![value.purpose,value.target].every(v=>v===null||text(v))||!object(value.data))return false;
  const d=value.data;
  if(d.kind==="responsibility")return keys(d,["kind","sequence","state"])&&Number.isSafeInteger(d.sequence)&&Number(d.sequence)>=0&&["open","closed"].includes(String(d.state));
  if(d.kind==="quantity")return keys(d,["kind","metric","unit","evidence","value","upper","method","complete"])&&
    ["capacity","material_read","material_transfer","material_stored","reuse_eligibility","reuse_content","reuse_check","reuse_input"].includes(String(d.metric))&&
    ["tokens","bytes","items","count"].includes(String(d.unit))&&["actual","estimate","bounds","unknown"].includes(String(d.evidence))&&maybe(d.value)&&maybe(d.upper)&&
    (d.evidence==="unknown"?d.value===null:d.value!==null)&&(d.upper===null||d.value!==null&&Number(d.upper)>=Number(d.value))&&text(d.method)&&typeof d.complete==="boolean";
  if(d.kind!=="attempt"||!keys(d,["kind","boundary","requestId","providerId","model","status","usage","price"])||
    !["bound","dispatched","settled"].includes(String(d.boundary))||![d.requestId,d.providerId,d.model,d.status].every(text))return false;
  if(d.usage!==null){const u=d.usage;if(!object(u)||!keys(u,["inputTokens","outputTokens","cacheReadTokens","cacheWriteTokens","cacheRelation","accountingRevision","consistent"])||
    ![u.inputTokens,u.outputTokens,u.cacheReadTokens,u.cacheWriteTokens].every(v=>v===null||count(v)&&Number.isSafeInteger(v))||!["input_subsets","unknown"].includes(String(u.cacheRelation))||
    !(u.accountingRevision===null||text(u.accountingRevision))||!(u.consistent===null||typeof u.consistent==="boolean")||
    u.cacheRelation==="input_subsets"&&(!text(u.accountingRevision)||typeof u.consistent!=="boolean"))return false;}
  if(d.price!==null){const p=d.price;if(!object(p)||!keys(p,["revision","providerId","model","currency","validFrom","validUntil","inputPerToken","outputPerToken","inputPricing","cachedReadPerToken","cachedWritePerToken"])||
    ![p.revision,p.providerId,p.model,p.currency].every(text)||![p.validFrom,p.validUntil].every(v=>typeof v==="string"&&Number.isFinite(Date.parse(v)))||
    ![p.inputPerToken,p.outputPerToken].every(count)||![p.cachedReadPerToken,p.cachedWritePerToken].every(maybe)||
    !["uniform","cache_partitioned"].includes(String(p.inputPricing))||p.inputPricing==="uniform"&&(p.cachedReadPerToken!==null||p.cachedWritePerToken!==null))return false;}
  return true;
}
