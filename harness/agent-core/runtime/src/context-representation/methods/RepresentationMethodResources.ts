import {createHash} from "node:crypto";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {containsMaterialRange,type MaterialCustodyPort,type MaterialAccessDescription,type MaterialRange,type MaterialHold,type MaterialAccess,type MaterialCustodyIntent} from "@agent-anything/context/custody";
import type {RepresentationCatalogPort,RepresentationRecord,RepresentationRef} from "@agent-anything/context/representation";
import type {SharedAcceptancePart} from "../../activity/SharedAcceptance.js";
import type {MethodSource,RepresentationMethodRequest} from "./RepresentationMethod.js";

export interface MethodStagedMaterial {readonly access:MaterialAccess;readonly instanceId:string;readonly hold:MaterialHold;readonly parts:readonly SharedAcceptancePart[];readonly bytes:number;}
/** Idempotent staging is separate from publication and professional progress acceptance. */
export async function stageMethodMaterial(input:{materials:MaterialCustodyPort;request:RepresentationMethodRequest;id:string;pathId:string;recordId:string;text:string;remainingBytes:number;occurredAt:string}):Promise<MethodStagedMaterial> {
  const bytes=Buffer.from(input.text,"utf8"),digest=`sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if(bytes.length>input.remainingBytes)throw new TypeError("representation_storage_budget_exhausted");
  const range:MaterialRange={materialId:input.id,version:digest,start:0,end:bytes.length,coordinate:"bytes"};
  const intent:MaterialCustodyIntent={id:`${input.id}:capture`,instanceId:`${input.id}:instance`,activityId:input.pathId,owner:input.request.recipient.recipient,maximumBytes:bytes.length,
    version:{ref:{materialId:range.materialId,version:range.version},origin:{runId:input.request.recipient.runId,owner:input.request.recipient.recipient,recordId:input.recordId,revision:"1",occurredAt:input.occurredAt},
      label:input.id,format:"utf8",mediaType:"text/plain",bytes:bytes.length,digest,capture:"complete",limitations:[]}};
  await input.materials.command({kind:"begin",intent});
  for(let offset=0;offset<bytes.length;offset+=65536)await input.materials.command({kind:"append",id:`${input.id}:chunk:${offset}`,intentId:intent.id,offset,bytesBase64:bytes.subarray(offset,offset+65536).toString("base64")});
  await input.materials.command({kind:"complete",intentId:intent.id});
  const hold:MaterialHold={id:`${input.id}:hold`,instanceId:intent.instanceId,consumer:input.request.recipient,responsibility:"checkpoint",range,basis:input.pathId,releaseCondition:"explicit method result transfer or disposal"};
  const access={id:`${input.id}:access`,holdId:hold.id,recipient:hold.consumer,range};
  return {access,instanceId:intent.instanceId,hold,bytes:bytes.length,parts:[{owner:"material_custody",kind:"publish",proposal:{intentId:intent.id,holds:[hold],
    grants:[{id:`${input.id}:grant`,instanceId:intent.instanceId,recipient:hold.consumer,range,revision:0,allowed:true,basis:input.pathId}]}}]};
}
export async function checkMethodAccess(materials:MaterialCustodyPort,source:MethodSource):Promise<MaterialAccessDescription> {
  const value=await materials.command({kind:"describe",holdId:source.access.holdId,recipient:source.access.recipient}) as MaterialAccessDescription;
  if(!value||!containsMaterialRange(value.hold.range,source.access.range))throw new TypeError("representation_source_unavailable");
  return value;
}
export async function originalMethodRepresentation(request:RepresentationMethodRequest,source:MethodSource,catalog:RepresentationCatalogPort):Promise<RepresentationRecord> {
  if(source.representation) {
    const record=await catalog.command({kind:"read",ref:source.representation}) as RepresentationRecord|null;
    if(!record||!containsMaterialRange(record.body,source.access.range))throw new TypeError("representation_source_binding_invalid");
    return record;
  }
  const record:RepresentationRecord={ref:sourceRepresentationRef(request,source),owner:request.recipient.recipient,runId:request.recipient.runId,purpose:request.recipient.purpose,target:request.targetRevision,
    form:"original",body:source.access.range,inputs:[{role:"source",material:source.access.range,representation:null}],declaredCoverage:[source.access.range],details:[],holds:[source.access.holdId],requirements:[],losses:[],restorations:[],method:null};
  await catalog.command({kind:"record",record});return record;
}
function sourceRepresentationRef(request:RepresentationMethodRequest,source:MethodSource):RepresentationRef {
  return {id:`${source.access.id}:original:${modelInputValueDigest({range:source.access.range,target:request.targetRevision})}`,revision:source.access.range.version};
}
