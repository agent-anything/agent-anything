import {createHash} from "node:crypto";
import {validateProcessQuery} from "./InspectionProcessValidation.js";
import type {InspectionMetricQuery,InspectionMetricScope} from "./InspectionMetricQuery.js";

export const METRIC_QUERIES=["advance_process_metrics","read_process_metrics","release_process_metrics"];
export function metricDigest(value:unknown):string {return createHash("sha256").update(JSON.stringify(value,(_k,v)=>v&&typeof v==="object"&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v)).digest("hex");}
export function metricScope(query:InspectionMetricScope):InspectionMetricScope{return {manifest:query.manifest,runIds:query.runIds};}
export function validateMetricQuery(v:Record<string,unknown>):InspectionMetricQuery {
  const fail=()=>{throw new Error("inspection_query_invalid");};
  if(!METRIC_QUERIES.includes(String(v.kind)))fail();
  const allowed=v.kind==="advance_process_metrics"?["kind","manifest","runIds","cursor","limit"]:v.kind==="read_process_metrics"?["kind","manifest","runIds","cursor","section","metricId","identity","after","limit"]:["kind","manifest","runIds","cursor"];
  if(Object.keys(v).some(k=>!allowed.includes(k)))fail();
  if(!Array.isArray(v.runIds)||!v.runIds.length||v.runIds.length>64||v.runIds.some(id=>typeof id!=="string"||!id||id.length>512)||new Set(v.runIds).size!==v.runIds.length)fail();
  validateProcessQuery({kind:"get_process_observations",section:"facts",runId:(v.runIds as string[])[0],manifest:v.manifest});
  if(v.limit!==undefined&&(!Number.isSafeInteger(v.limit)||Number(v.limit)<1||Number(v.limit)>100))fail();
  if(v.cursor!==undefined&&(typeof v.cursor!=="string"||v.cursor.length>1024))fail();
  if(v.kind!=="advance_process_metrics"&&typeof v.cursor!=="string")fail();
  if(v.kind==="read_process_metrics"&&!["metrics","members","evidence","intervals"].includes(String(v.section)))fail();
  if(v.metricId!==undefined&&(v.section!=="members"||typeof v.metricId!=="string"||!/^[a-f0-9]{64}$/.test(v.metricId)))fail();
  if(v.identity!==undefined&&(v.section!=="evidence"||typeof v.identity!=="string"||v.identity.length>4096))fail();
  if(v.after!==undefined&&(typeof v.after!=="string"||v.after.length>2048))fail();
  return v as unknown as InspectionMetricQuery;
}
export interface MetricCursor {readonly slot:number;readonly id:string;readonly step:number;readonly scope:string;}
export function encodeMetricCursor(v:MetricCursor):string {return Buffer.from(JSON.stringify(v)).toString("base64url");}
export function decodeMetricCursor(text:string,scope:InspectionMetricScope):MetricCursor {
  try{const v=JSON.parse(Buffer.from(text,"base64url").toString("utf8")) as MetricCursor;
    if(!Number.isInteger(v.slot)||v.slot<0||v.slot>=8||typeof v.id!=="string"||!/^[-a-z0-9]{36}$/.test(v.id)||!Number.isSafeInteger(v.step)||v.step<0||v.scope!==metricDigest(scope))throw new Error();return v;
  }catch{throw new Error("inspection_cursor_invalid");}
}
