import {createHash} from "node:crypto";
import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import type {MaterialRecipient} from "@agent-anything/context/custody";
import type {ActivityHandoffPort,ActivitySnapshot} from "@agent-anything/agent-runtime/activity";
import {SOURCE_MATERIAL_PUBLICATION_PURPOSE,validateSourceMaterialRequest,validatePublishedSourceMaterial,sourceMaterialOutcome,
  type SourceMaterialPublicationRequest,type PublishedSourceMaterial,type UnavailableSourceMaterial} from "@agent-anything/agent-runtime/context-representation";
import {validateHelarcNativeWorkingSources,type HelarcNativeWorkingSources,type HelarcNativeWorkingGroup} from "./HelarcNativeWorkingSources.js";
import {helarcNativeWorkingGroupRevision} from "./HelarcNativeAccountScopes.js";

export interface HelarcNativeSourcePublication {
  readonly group:HelarcNativeWorkingGroup;
  readonly pathId:string;
  readonly request:SourceMaterialPublicationRequest;
  readonly state:"new"|"pending"|"published"|"unavailable";
  readonly published:PublishedSourceMaterial|null;
  readonly unavailable:UnavailableSourceMaterial|null;
}

export function helarcNativeSourceMaterialRef(group:HelarcNativeWorkingGroup,recipient:MaterialRecipient,target:string){
  return {materialId:`${recipient.runId}:native-source-material:${digest({groupId:group.id,originRunId:group.originRunId,recipient,target})}`,
    version:helarcNativeWorkingGroupRevision(group)};
}

/** Keeps original native content and provenance, never a generic request or synthetic Turn. */
export function helarcNativeSourceBytes(group:HelarcNativeWorkingGroup,items:readonly Record<string,unknown>[]):Buffer {
  const {start,count}=group.occurrence,content=items.slice(start,start+count);
  if(digest(content)!==group.occurrence.digest)throw new TypeError("native_source_content_changed");
  return Buffer.from(JSON.stringify({kind:"native_working_source",id:group.id,revision:helarcNativeWorkingGroupRevision(group),
    originRunId:group.originRunId,sources:group.sources,duties:group.duties,preservation:group.preservation,
    exchangeId:group.exchangeId,representations:group.representations,...(group.derivedFrom?{derivedFrom:group.derivedFrom}:{}),items:content}),"utf8");
}

/** Planning reads the original capture receipt; execution and admission stay in shared custody. */
export async function planHelarcNativeSourcePublications(input:{
  readonly items:readonly Record<string,unknown>[];readonly sources:HelarcNativeWorkingSources;
  readonly recipient:MaterialRecipient;readonly target:string;readonly observedAt:string;
  readonly maximumSourceBytes:number;readonly activities:ActivityHandoffPort;readonly signal:AbortSignal;
}):Promise<readonly HelarcNativeSourcePublication[]> {
  validateHelarcNativeWorkingSources(input.sources,input.items);
  const {recipient,target}=input;
  if(!recipient.runId||!recipient.recipient||!recipient.purpose||!target||!Number.isFinite(Date.parse(input.observedAt))||
    !Number.isSafeInteger(input.maximumSourceBytes)||input.maximumSourceBytes<1)throw new TypeError("native_source_publication_binding_invalid");
  const plans:HelarcNativeSourcePublication[]=[];
  for(const group of input.sources.groups){
    input.signal.throwIfAborted();
    const bytes=helarcNativeSourceBytes(group,input.items),revision=helarcNativeWorkingGroupRevision(group);
    if(bytes.length>input.maximumSourceBytes)throw new TypeError("native_source_capture_limit");
    const pathId=`${recipient.runId}:native-source:${digest({id:group.id,revision,recipient,target})}`;
    const snapshot=await input.activities.command({kind:"read_snapshot",pathId,requestIds:[`${pathId}:capture`],inputNeedIds:[]},
      {observation:{owner:"helarc-native-input",purpose:"source-publication-evidence",operationId:input.sources.itemsDigest}}) as ActivitySnapshot;
    const request:SourceMaterialPublicationRequest={kind:"source_material_publication",bytesBase64:bytes.toString("base64"),recipient,purpose:recipient.purpose,target,
      intent:{id:`${pathId}:custody`,instanceId:`${pathId}:instance`,activityId:pathId,owner:"material-source",maximumBytes:bytes.length,
        version:{ref:helarcNativeSourceMaterialRef(group,recipient,target),origin:{runId:recipient.runId,owner:"helarc-native-input",recordId:pathId,revision,occurredAt:input.observedAt},
          label:"Native working source",format:"json",mediaType:"application/json",bytes:bytes.length,
          digest:`sha256:${createHash("sha256").update(bytes).digest("hex")}`,capture:"complete",limitations:[]}}};
    validateSourceMaterialRequest(request);
    if(!snapshot.path){plans.push({group,pathId,request,state:"new",published:null,unavailable:null});continue;}
    const path=snapshot.path,stage=snapshot.stages.find(s=>s?.request.id===`${pathId}:capture`);
    if(!stage||path.intent.runId!==recipient.runId||path.intent.owner!=="material-source"||
      path.intent.purpose.digest!==digest(SOURCE_MATERIAL_PUBLICATION_PURPOSE))throw new TypeError("native_source_publication_unavailable");
    const original=stage.request.input as SourceMaterialPublicationRequest;
    validateSourceMaterialRequest(original);
    // The first capture time and independently admitted lifetime belong to that publication.
    const {lifecycle:_lifecycle,...body}=original;
    const expected={...request,intent:{...request.intent,version:{...request.intent.version,
      origin:{...request.intent.version.origin,occurredAt:original.intent.version.origin.occurredAt}}}};
    if(digest(body)!==digest(expected))throw new TypeError("native_source_publication_changed");
    const outcome=sourceMaterialOutcome(path,stage);
    const published=outcome?.kind==="published_source_material"?outcome:null;
    const unavailable=outcome?.kind==="source_material_unavailable"?outcome:null;
    if(path.cancelled&&!unavailable)throw new TypeError("native_source_publication_unavailable");
    const plan:HelarcNativeSourcePublication={group,pathId,request:original,state:published?"published":unavailable?"unavailable":"pending",published,unavailable};
    if(published)validateHelarcNativeSourcePublication(plan,input.items,recipient,target);
    plans.push(plan);
  }
  return plans;
}

export function validateHelarcNativeSourcePublication(plan:HelarcNativeSourcePublication,items:readonly Record<string,unknown>[],
  recipient:MaterialRecipient,target:string):PublishedSourceMaterial {
  const {group,request,published}=plan;
  if(plan.state!=="published"||!published)throw new TypeError("native_source_publication_pending");
  if(request.intent.activityId!==plan.pathId||request.bytesBase64!==helarcNativeSourceBytes(group,items).toString("base64")||
    request.target!==target||request.purpose!==recipient.purpose||digest(request.recipient)!==digest(recipient)||
    digest(request.intent.version.ref)!==digest(helarcNativeSourceMaterialRef(group,recipient,target)))
    throw new TypeError("native_source_publication_mismatch");
  validatePublishedSourceMaterial(request,published);
  return published;
}
