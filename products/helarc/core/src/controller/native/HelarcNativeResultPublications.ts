import {createHash} from "node:crypto";
import {modelInputValueDigest as digest,readModelResultContentTextSlot} from "@agent-anything/model-interaction/input";
import type {MaterialCustodyPort,MaterialAccess,MaterialHold,MaterialAccessDescription} from "@agent-anything/context/custody";
import type {RepresentationRecord} from "@agent-anything/context/representation";
import type {ActivityHandoffPort,ActivitySnapshot} from "@agent-anything/agent-runtime/activity";
import {SOURCE_MATERIAL_PUBLICATION_PURPOSE,validateSourceMaterialRequest,validatePublishedSourceMaterial,sourceMaterialOutcome,
  type OriginalInputSourcePublication,type SourceMaterialPublicationRequest} from "@agent-anything/agent-runtime/context-representation";
import {helarcResultTextDeclaration} from "../../prompt/HelarcResultTextDeclaration.js";
import {helarcNativeTaskResultDeliveries} from "./HelarcNativeTaskResultDelivery.js";
import type {HelarcNativeInputDemandWork} from "./HelarcNativeInputDemandWork.js";

export interface HelarcNativeResultBodySource {
  readonly delivery:ReturnType<typeof helarcNativeTaskResultDeliveries>[number];
  readonly declaration:NonNullable<ReturnType<typeof helarcResultTextDeclaration>>;
  readonly hold:MaterialHold;
  readonly access:MaterialAccess;
  readonly representation:RepresentationRecord["ref"]|null;
}

/** Declared bodies only; an existing material is admitted, not recaptured. No policy or execution here. */
export async function planHelarcNativeResultPublications(input:{
  readonly demand:Extract<Awaited<ReturnType<HelarcNativeInputDemandWork["result"]>>,{kind:"needed"}>;
  readonly activities:ActivityHandoffPort;readonly materials:MaterialCustodyPort;
  readonly maximumSourceBytes:number;readonly signal:AbortSignal;
}){
  const {demand,signal}=input,{prepared,resultSources}=demand.plan,scope=demand.plan.inputNeed.scope;
  if(demand.source.status!=="accepted"||!demand.source.receipt||!demand.source.result||
    !Number.isSafeInteger(input.maximumSourceBytes)||input.maximumSourceBytes<1)throw new TypeError("native_result_publication_origin_invalid");
  const publications:OriginalInputSourcePublication[]=[],sources:HelarcNativeResultBodySource[]=[],
    exclusions:{id:string;reason:string}[]=[];
  if(!resultSources){if(prepared.results.length)throw new TypeError("native_result_publication_sources_missing");return {publications,sources,exclusions};}
  const recipient={runId:scope.runId,recipient:scope.recipient,purpose:scope.purpose};
  for(const delivery of helarcNativeTaskResultDeliveries(prepared,resultSources)){
    signal.throwIfAborted();const result=delivery.result,id=result.modelCallRef.id,declaration=helarcResultTextDeclaration(result,"original","1");
    if(!declaration){exclusions.push({id,reason:"result_owner_did_not_declare_convertible_body"});continue;}
    if(declaration.source.kind==="retained_material"){
      const original=await input.materials.command({kind:"resolve_reference",reference:declaration.source.reference,recipient}) as MaterialAccessDescription;
      sources.push({delivery,declaration,hold:original.hold,representation:null,
        access:{id:`${demand.need.id}:body:${digest(id)}`,holdId:original.hold.id,recipient,range:original.hold.range}});
      continue;
    }
    const bytes=Buffer.from(readModelResultContentTextSlot(result,declaration.slot)),version=digest({result,declaration});
    if(bytes.length>input.maximumSourceBytes){exclusions.push({id,reason:"inline_body_capture_limit"});continue;}
    const pathId=`${scope.runId}:native-result-body:${digest({id,version,recipient,target:scope.target})}`;
    const request:SourceMaterialPublicationRequest={kind:"source_material_publication",recipient,purpose:scope.purpose,target:scope.target,bytesBase64:bytes.toString("base64"),
      intent:{id:`${pathId}:custody`,instanceId:`${pathId}:instance`,activityId:pathId,owner:"material-source",maximumBytes:bytes.length,
        version:{ref:{materialId:id,version},origin:{runId:scope.runId,owner:declaration.owner.owner,recordId:id,revision:version,occurredAt:demand.source.result.recordedAt},
          label:"Original declared result body",format:"utf8",mediaType:"text/plain",bytes:bytes.length,
          digest:`sha256:${createHash("sha256").update(bytes).digest("hex")}`,capture:"complete",limitations:[]}}};
    validateSourceMaterialRequest(request);
    const snapshot=await input.activities.command({kind:"read_snapshot",pathId,requestIds:[`${pathId}:capture`],inputNeedIds:[]},
      {observation:{owner:"helarc-native-input",purpose:"result-body-publication-evidence",operationId:demand.need.id}}) as ActivitySnapshot;
    if(!snapshot.path){publications.push({pathId,request,state:"new",published:null});continue;}
    const path=snapshot.path,stage=snapshot.stages[0];
    if(!stage||path.intent.runId!==scope.runId||path.intent.owner!=="material-source"||path.intent.purpose.digest!==digest(SOURCE_MATERIAL_PUBLICATION_PURPOSE))
      throw new TypeError("native_result_publication_origin_changed");
    const original=stage.request.input as SourceMaterialPublicationRequest;validateSourceMaterialRequest(original);
    const {lifecycle:_lifecycle,...retained}=original,expected={...request,intent:{...request.intent,version:{...request.intent.version,
      origin:{...request.intent.version.origin,occurredAt:original.intent.version.origin.occurredAt}}}};
    if(digest(retained)!==digest(expected))throw new TypeError("native_result_publication_changed");
    const outcome=sourceMaterialOutcome(path,stage);
    if(path.cancelled&&outcome?.kind!=="source_material_unavailable")throw new TypeError("native_result_publication_unavailable");
    const published=outcome?.kind==="published_source_material"?outcome:null;
    publications.push({pathId,request:original,state:published?"published":outcome?"unavailable":"pending",published,
      ...outcome?.kind==="source_material_unavailable"?{unavailable:outcome}:{}});
    if(published){
      validatePublishedSourceMaterial(original,published);
      const access=await input.materials.command({kind:"describe",holdId:published.access.holdId,recipient}) as MaterialAccessDescription;
      sources.push({delivery,declaration,hold:access.hold,access:published.access,representation:published.representation.ref});
    }
  }
  return {publications,sources,exclusions};
}
