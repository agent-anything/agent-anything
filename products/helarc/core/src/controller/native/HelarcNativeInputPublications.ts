import {createHash} from "node:crypto";
import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {OPENAI_RESPONSES} from "@agent-anything/model-interaction/protocol";
import type {ActivityHandoffPort,ActivitySnapshot} from "@agent-anything/agent-runtime/activity";
import {sourceMaterialOutcome,validateSourceMaterialRequest,validatePublishedSourceMaterial,SOURCE_MATERIAL_PUBLICATION_PURPOSE,
  type OriginalInputSourcePublication,type SourceMaterialPublicationRequest} from "@agent-anything/agent-runtime/context-representation";
import type {HelarcNativeInputDemandWork} from "./HelarcNativeInputDemandWork.js";
import {planHelarcNativeSourcePublications} from "./HelarcNativeSourcePublications.js";

/** Plans custody for the original native input and its working sources, without capturing or selecting them. */
export async function planHelarcNativeInputPublications(input:{
  readonly demand:Extract<Awaited<ReturnType<HelarcNativeInputDemandWork["result"]>>,{kind:"needed"}>;
  readonly activities:ActivityHandoffPort;readonly maximumSourceBytes:number;readonly signal:AbortSignal;
}){
  const {demand,maximumSourceBytes}=input,{scope}=demand.plan.inputNeed,{prepared,activity}=demand.plan;
  input.signal.throwIfAborted();
  if(demand.source.status!=="accepted"||!demand.source.receipt||!demand.source.result||!prepared.workingSources||
    !Number.isSafeInteger(maximumSourceBytes)||maximumSourceBytes<1)throw new TypeError("native_input_publication_origin_invalid");
  const body=JSON.parse(prepared.wire.body),all=body[activity.composition.composition.protocol.id===OPENAI_RESPONSES.id?"input":"messages"];
  if(!Array.isArray(all)||body.previous_response_id||body.conversation||digest(body)!==prepared.wire.digest)
    throw new TypeError("native_input_publication_explicit_history_required");
  const prefix=activity.composition.composition.protocol.id!==OPENAI_RESPONSES.id&&all[0]?.role==="system"?1:0;
  const items=all.slice(prefix),recipient={runId:scope.runId,recipient:scope.recipient,purpose:scope.purpose},observedAt=demand.source.result.recordedAt;
  const groups=await planHelarcNativeSourcePublications({items,sources:prepared.workingSources,recipient,target:scope.target,
    observedAt,maximumSourceBytes,activities:input.activities,signal:input.signal});
  const bytes=Buffer.from(JSON.stringify(all));
  if(bytes.length>maximumSourceBytes)throw new TypeError("native_input_history_capture_limit");
  const revision=digest(all),pathId=`${scope.runId}:native-history:${digest({recipient,target:scope.target,revision})}`;
  const request:SourceMaterialPublicationRequest={kind:"source_material_publication",recipient,purpose:scope.purpose,target:scope.target,bytesBase64:bytes.toString("base64"),
    intent:{id:`${pathId}:custody`,instanceId:`${pathId}:instance`,activityId:pathId,owner:"material-source",maximumBytes:bytes.length,
      version:{ref:{materialId:pathId,version:revision},origin:{runId:scope.runId,owner:"helarc-native-input",recordId:demand.source.request.id,revision:digest(demand.source.request),occurredAt:observedAt},
        label:"Complete original native items",format:"json",mediaType:"application/json",bytes:bytes.length,
        digest:`sha256:${createHash("sha256").update(bytes).digest("hex")}`,capture:"complete",limitations:[]}}};
  validateSourceMaterialRequest(request);
  const snapshot=await input.activities.command({kind:"read_snapshot",pathId,requestIds:[`${pathId}:capture`],inputNeedIds:[]},
    {observation:{owner:"helarc-native-input",purpose:"history-publication-evidence",operationId:demand.need.id}}) as ActivitySnapshot;
  let history:OriginalInputSourcePublication={pathId,request,state:"new",published:null};
  if(snapshot.path){
    const path=snapshot.path,stage=snapshot.stages[0];
    if(!stage||path.intent.runId!==scope.runId||path.intent.owner!=="material-source"||path.intent.purpose.digest!==digest(SOURCE_MATERIAL_PUBLICATION_PURPOSE))
      throw new TypeError("native_input_history_origin_changed");
    const original=stage.request.input as SourceMaterialPublicationRequest;
    validateSourceMaterialRequest(original);
    const {lifecycle:_lifecycle,...source}=original;
    // An unchanged history can already have original custody from an earlier demand.
    const expected={...request,intent:{...request.intent,version:{...request.intent.version,origin:original.intent.version.origin}}};
    if(digest(source)!==digest(expected))throw new TypeError("native_input_history_changed");
    const outcome=sourceMaterialOutcome(path,stage);
    if(path.cancelled&&outcome?.kind!=="source_material_unavailable")throw new TypeError("native_input_history_unavailable");
    if(outcome?.kind==="published_source_material")validatePublishedSourceMaterial(original,outcome);
    history={pathId,request:original,state:outcome?.kind==="published_source_material"?"published":outcome?"unavailable":"pending",
      published:outcome?.kind==="published_source_material"?outcome:null,...outcome?.kind==="source_material_unavailable"?{unavailable:outcome}:{}};
  }
  return {items,groups,history,publications:[...groups.map(({unavailable,...group})=>({...group,...unavailable?{unavailable}:{}})),history]};
}
