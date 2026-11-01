import {createHash} from "node:crypto";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import type {MaterialRecipient} from "@agent-anything/context/custody";
import type {ActivityHandoffPort,ActivityPathState,ActivityStageState} from "../activity/index.js";
import {SOURCE_MATERIAL_PUBLICATION_PURPOSE,validateSourceMaterialRequest,sourceMaterialOutcome,type SourceMaterialPublicationRequest,type PublishedSourceMaterial,type UnavailableSourceMaterial} from "./SourceMaterialPublication.js";
import {originalInputSourceBytes,originalInputDataBody,validateOriginalInputSources,type OriginalInputSources,type OriginalInputSourceGroup} from "./OriginalInputSources.js";
import {recipientContextDeliveryId} from "./ContextDeliveryFacts.js";
import type {ActivityScopeLifetime} from "../activity/index.js";

export interface OriginalInputPublicationPlan {
  readonly group:OriginalInputSourceGroup;
  readonly pathId:string;
  readonly request:SourceMaterialPublicationRequest;
  readonly state:"new"|"pending"|"published"|"unavailable";
  readonly published:PublishedSourceMaterial|null;
  readonly unavailable?:UnavailableSourceMaterial;
}

/** Retains source identity across requests; publication and selection belong to their own paths. */
export async function planOriginalInputPublications(input:{
  readonly sources:OriginalInputSources;
  readonly recipient:MaterialRecipient;
  readonly target:string;
  readonly observedAt:string;
  readonly maximumSourceBytes:number;
  readonly deliveryLifetime?:ActivityScopeLifetime;
  readonly activities:ActivityHandoffPort;
  readonly signal:AbortSignal;
}):Promise<readonly OriginalInputPublicationPlan[]> {
  const {sources,recipient}=input;
  validateOriginalInputSources(sources);
  if(recipient.runId!==sources.runId||recipient.purpose!==sources.request.purpose||!input.target.trim()||
    !Number.isFinite(Date.parse(input.observedAt))||!Number.isSafeInteger(input.maximumSourceBytes)||input.maximumSourceBytes<1)
    throw new TypeError("input_source_material_binding_invalid");
  const result:OriginalInputPublicationPlan[]=[];
  for(const group of sources.groups) {
    input.signal.throwIfAborted();
    // Positions belong to this request, not to the immutable source material.
    const bytes=originalInputSourceBytes(group);
    const deliveries=group.deliveries.map(delivery=>({id:recipientContextDeliveryId(delivery.id,recipient),sourceId:delivery.source.id}));
    if(deliveries.length&&(!input.deliveryLifetime||input.deliveryLifetime.source.runId!==recipient.runId))
      throw new TypeError("original_source_delivery_lifetime_missing");
    if(bytes.length>input.maximumSourceBytes)throw new TypeError("input_source_material_capture_limit");
    const digest=`sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const pathId=`${sources.runId}:source-publication:${modelInputValueDigest({id:group.id,revision:group.revision,recipient,target:input.target})}`;
    const existing=await input.activities.command({kind:"read_path",pathId}) as ActivityPathState|null;
    if(existing) {
      const stage=await input.activities.command({kind:"read_stage",requestId:`${pathId}:capture`}) as ActivityStageState|null;
      if(!stage||existing.intent.runId!==sources.runId||existing.intent.owner!=="material-source"||
        existing.intent.purpose.digest!==modelInputValueDigest(SOURCE_MATERIAL_PUBLICATION_PURPOSE))
        throw new TypeError("original_source_publication_unavailable");
      const request=stage.request.input as SourceMaterialPublicationRequest;
      validateSourceMaterialRequest(request);
      if(request.intent.activityId!==pathId||request.target!==input.target||request.purpose!==recipient.purpose||
        request.intent.version.digest!==digest||request.bytesBase64!==bytes.toString("base64")||modelInputValueDigest(request.recipient)!==modelInputValueDigest(recipient)||
        modelInputValueDigest(request.deliveries??[])!==modelInputValueDigest(deliveries)||
        modelInputValueDigest(request.deliveryLifetime??null)!==modelInputValueDigest(deliveries.length?input.deliveryLifetime:null))
        throw new TypeError("original_source_publication_changed");
      const progress=sourceMaterialOutcome(existing,stage);
      const published=progress?.kind==="published_source_material"?progress:null;
      const unavailable=progress?.kind==="source_material_unavailable"?progress:null;
      if(existing.cancelled&&!unavailable)throw new TypeError("original_source_publication_unavailable");
      if(published&&stage.status!=="accepted")throw new TypeError("original_source_publication_not_accepted");
      const plan:OriginalInputPublicationPlan={group,pathId,request,state:published?"published":unavailable?"unavailable":"pending",published,...(unavailable?{unavailable}:{})};
      if(published)validateOriginalInputPublication(plan,recipient,input.target);
      result.push(plan);
      continue;
    }
    const request:SourceMaterialPublicationRequest={kind:"source_material_publication",bytesBase64:bytes.toString("base64"),recipient,
      ...(deliveries.length?{deliveries,deliveryLifetime:input.deliveryLifetime!}:{}),
      purpose:recipient.purpose,target:input.target,intent:{id:`${pathId}:custody`,instanceId:`${pathId}:instance`,activityId:pathId,
        owner:"material-source",maximumBytes:bytes.length,version:{ref:{materialId:group.id,version:group.revision},
          origin:{runId:sources.runId,owner:sources.owner,recordId:sources.originalSourceId,revision:group.revision,occurredAt:input.observedAt},
          label:originalInputDataBody(group)!==null?"Original declared Host data body":"Original input source",
          format:originalInputDataBody(group)!==null?"utf8":"json",mediaType:originalInputDataBody(group)!==null?"text/plain":"application/json",bytes:bytes.length,digest,capture:"complete",limitations:[]}}};
    validateSourceMaterialRequest(request);
    result.push({group,pathId,request,state:"new",published:null});
  }
  return result;
}

export function validateOriginalInputPublication(plan:OriginalInputPublicationPlan,recipient:MaterialRecipient,target:string):PublishedSourceMaterial {
  const {request,published,group}=plan;
  validateSourceMaterialRequest(request);
  if(plan.state!=="published"||!published)throw new TypeError("original_input_publication_pending");
  const range={materialId:group.id,version:group.revision,start:0,end:request.intent.version.bytes,coordinate:"bytes"};
  const equal=(a:unknown,b:unknown)=>modelInputValueDigest(a)===modelInputValueDigest(b);
  const representation=published.representation;
  if(request.intent.activityId!==plan.pathId||request.bytesBase64!==originalInputSourceBytes(group).toString("base64")||
    request.target!==target||request.purpose!==recipient.purpose||!equal(request.recipient,recipient)||
    !equal(request.deliveries??[],group.deliveries.map(delivery=>({id:recipientContextDeliveryId(delivery.id,recipient),sourceId:delivery.source.id})))||
    !equal(request.intent.version.ref,{materialId:group.id,version:group.revision})||!equal(published.version,request.intent.version)||
    !equal(published.access.recipient,recipient)||!equal(published.access.range,range)||
    published.access.holdId!==`${request.intent.id}:consumer-hold`||
    representation.runId!==recipient.runId||representation.owner!==request.intent.owner||representation.form!=="original"||
    representation.target!==target||representation.purpose!==recipient.purpose||
    !equal(representation.ref,{id:`${request.intent.id}:original`,revision:group.revision})||!equal(representation.body,range)||
    !equal(representation.inputs,[{role:"source",material:range,representation:null}])||!equal(representation.declaredCoverage,[range])||
    representation.losses.length||representation.restorations.length||representation.requirements.length||representation.details.length||representation.method!==null)
    throw new TypeError("original_input_publication_mismatch");
  return published;
}
