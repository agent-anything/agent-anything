import {createHash} from "node:crypto";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import type {MaterialCustodyPort,MaterialCustodyIntent,MaterialCustodyState,MaterialHold,MaterialAccess,MaterialVersion,MaterialRecipient} from "@agent-anything/context/custody";
import type {RepresentationRecord} from "@agent-anything/context/representation";
import type {ContextDelivery,ContextSelectionPort} from "@agent-anything/context/selection";
import {ActivityPurposeRegistry,type ActivityPurposeContract} from "../activity/ActivityPurpose.js";
import type {ActivityPurposeHandler} from "../activity/ActivityHandoffProcessor.js";
import type {ActivityHandoffPort,ActivityPathIntent,ActivityPathState,ActivityStageState,ActivityAttempt,ActivityRawResult} from "../activity/ActivityHandoff.js";
import type {ActivityProfessionalLimitation} from "../activity/ActivityProfessionalStop.js";
import type {SharedAcceptancePart} from "../activity/SharedAcceptance.js";
import {activityFactSourceId,activityToken,type ActivitySchedulingIntent,type ActivityScopeLifetime} from "../activity/index.js";
import {SourcePublicationLifecycle,validateSourcePublicationLifecycle,type SourcePublicationLifecyclePlan} from "./SourcePublicationLifecycle.js";
import {ContextDeliveryLifecycle} from "./ContextDeliveryLifecycle.js";
import {contextDeliveryFactSource} from "./ContextDeliveryFacts.js";

export const SOURCE_MATERIAL_PUBLICATION_PURPOSE:ActivityPurposeContract={
  ref:{id:"context.source-publication",revision:"3"},inputOwner:"material-source",executionOwner:"material-capture",
  interpretationOwner:"material-source",acceptanceOwner:"material-source",recoveryOwner:"material-source",
  stageKinds:["capture"],capabilities:["material-write"],continuationKinds:[],
};
export interface SourceMaterialPublicationRequest {
  readonly lifecycle?:SourcePublicationLifecyclePlan;
  readonly kind:"source_material_publication";
  readonly intent:MaterialCustodyIntent;
  readonly bytesBase64:string;
  readonly recipient:MaterialRecipient;
  readonly purpose:string;
  readonly target:string;
  /** Explicit pending deliveries of this original source, never acknowledgements of receipt. */
  readonly deliveries?:readonly Pick<ContextDelivery,"id"|"sourceId">[];
  readonly deliveryLifetime?:ActivityScopeLifetime;
}
export interface PublishedSourceMaterial {
  readonly kind:"published_source_material";
  readonly version:MaterialVersion;
  readonly access:MaterialAccess;
  readonly representation:RepresentationRecord;
}
export interface UnavailableSourceMaterial {
  readonly kind:"source_material_unavailable";
  readonly pathId:string;
  readonly stopAcceptanceId:string;
  readonly limitation:ActivityProfessionalLimitation;
}
export function sourceMaterialOutcome(path:ActivityPathState,stage:ActivityStageState):PublishedSourceMaterial|UnavailableSourceMaterial|null {
  requestOf(path,stage);
  const progress=path.progress as PublishedSourceMaterial|UnavailableSourceMaterial|null;
  if(progress?.kind==="published_source_material") {
    if(stage.status!=="accepted"||!stage.receipt)throw new TypeError("source_publication_not_accepted");
    return progress;
  }
  if(progress?.kind==="source_material_unavailable") {
    if(!path.cancelled||!stage.stop||progress.pathId!==path.intent.id||stage.stop.id!==progress.stopAcceptanceId||
      modelInputValueDigest(stage.stop.progress)!==modelInputValueDigest(progress)||
      modelInputValueDigest(stage.stop.limitation)!==modelInputValueDigest(progress.limitation))throw new TypeError("source_publication_stop_invalid");
    return progress;
  }
  return null;
}

/** Captures original bytes and proposes publication; it does not summarize or acknowledge delivery. */
export class SourceMaterialPublication implements ActivityPurposeHandler {
  constructor(private readonly ports:{materials:MaterialCustodyPort;authorize:ActivityPurposeHandler["authorize"];now:()=>string}) {}
  async authorize(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal,action:Parameters<ActivityPurposeHandler["authorize"]>[3]):ReturnType<ActivityPurposeHandler["authorize"]> {
    requestOf(path,stage);
    return this.ports.authorize(path,stage,signal,action);
  }
  async handleLimitation(path:ActivityPathState,stage:ActivityStageState,limitation:ActivityProfessionalLimitation,signal:AbortSignal,acceptance:{readonly id:string}) {
    signal.throwIfAborted();requestOf(path,stage);
    if(path.cancelled||stage.receipt||stage.stop||limitation.kind==="deadline"&&stage.attempt)return {kind:"wait" as const};
    return {kind:"stop" as const,progress:{kind:"source_material_unavailable",pathId:path.intent.id,
      stopAcceptanceId:acceptance.id,limitation} satisfies UnavailableSourceMaterial};
  }
  async execute(path:ActivityPathState,stage:ActivityStageState,attempt:ActivityAttempt,signal:AbortSignal):Promise<ActivityRawResult> {
    const started=performance.now(),request=requestOf(path,stage),bytes=Buffer.from(request.bytesBase64,"base64");
    signal.throwIfAborted();
    let state=await this.ports.materials.command({kind:"begin",intent:request.intent}) as MaterialCustodyState;
    if(state.state==="staging") {
      for(let offset=state.bytes;offset<bytes.length;offset+=65536) {
        signal.throwIfAborted();
        state=await this.ports.materials.command({kind:"append",id:`${request.intent.id}:chunk:${offset}`,intentId:request.intent.id,
          offset,bytesBase64:bytes.subarray(offset,offset+65536).toString("base64")}) as MaterialCustodyState;
      }
      state=await this.ports.materials.command({kind:"complete",intentId:request.intent.id}) as MaterialCustodyState;
    }
    if(state.state!=="complete"||!state.version)throw new TypeError("source_capture_state_invalid");
    return {id:`${attempt.id}:raw`,attemptId:attempt.id,completeness:"complete",outcome:"returned",
      value:{kind:"captured",version:state.version},usage:{capturedBytes:bytes.length,localMs:performance.now()-started},recordedAt:this.ports.now()};
  }
  async reconcile(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal):Promise<ActivityRawResult|null> {
    if(!path.cancelled)return this.execute(path,stage,stage.attempt!,signal);
    const request=requestOf(path,stage);
    const state=await this.ports.materials.command({kind:"state",intentId:request.intent.id}) as MaterialCustodyState|null;
    return {id:`${stage.attempt!.id}:raw`,attemptId:stage.attempt!.id,completeness:"complete",outcome:"returned",
      value:{kind:"capture_cancelled",capturedBytes:state?.bytes??0},usage:null,recordedAt:this.ports.now()};
  }
  async interpret(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal) {
    signal.throwIfAborted();
    const request=requestOf(path,stage),raw=stage.result?.value as {kind:string;version:MaterialVersion}|null;
    const state=await this.ports.materials.command({kind:"state",intentId:request.intent.id}) as MaterialCustodyState|null;
    if(stage.result?.outcome!=="returned"||stage.result.completeness!=="complete"||raw?.kind!=="captured"||
      state?.state!=="complete"||!state.version||modelInputValueDigest(raw.version)!==modelInputValueDigest(state.version))throw new TypeError("source_publication_result_invalid");
    const range={...state.version.ref,start:0,end:state.version.bytes,coordinate:"bytes" as const};
    const sourceRecipient={...request.recipient,recipient:path.intent.owner};
    const hold:MaterialHold={id:`${request.intent.id}:source-hold`,instanceId:request.intent.instanceId,consumer:sourceRecipient,
      responsibility:"checkpoint",range,basis:path.intent.id,releaseCondition:"explicit source retention release after dependent consumers settle"};
    const consumerHold:MaterialHold={...hold,id:`${request.intent.id}:consumer-hold`,consumer:request.recipient};
    const deliveryHolds:MaterialHold[]=(request.deliveries??[]).map(delivery=>({...consumerHold,
      id:`${request.intent.id}:delivery-hold:${modelInputValueDigest(delivery.id)}`,responsibility:"delivery",basis:delivery.id,
      releaseCondition:"Explicit release after this recipient accepts or disposes the original delivery"}));
    const access:MaterialAccess={id:`${request.intent.id}:source-access`,holdId:consumerHold.id,recipient:request.recipient,range};
    const representation:RepresentationRecord={ref:{id:`${request.intent.id}:original`,revision:state.version.ref.version},owner:path.intent.owner,
      runId:path.intent.runId,form:"original",body:range,purpose:request.purpose,target:request.target,
      inputs:[{role:"source",material:range,representation:null}],declaredCoverage:[range],details:[],holds:[hold.id],requirements:[],losses:[],restorations:[],method:null};
    const participants:SharedAcceptancePart[]=[{owner:"material_custody",kind:"publish",proposal:{intentId:request.intent.id,holds:[hold,consumerHold,...deliveryHolds],
      grants:[sourceRecipient,request.recipient].map((recipient,index)=>({id:`${request.intent.id}:grant:${index}`,instanceId:request.intent.instanceId,recipient,range,revision:0,allowed:true,basis:path.intent.id}))}},
      {owner:"representation",kind:"record",proposal:representation},
      ...(request.deliveries??[]).flatMap((delivery,index)=>{
        const subscriptionId=`${delivery.id}:lifecycle`,scope=request.deliveryLifetime!;
        return [{owner:"context_delivery",kind:"publish",proposal:{...delivery,
          sourceRunId:state.version!.origin.runId,recipient:request.recipient,material:range,instanceId:request.intent.instanceId,
          holdId:deliveryHolds[index]!.id,detailHoldId:null,
          lifetime:{owner:path.intent.owner,sourcePathId:path.intent.id,subscriptionId,scope}} satisfies ContextDelivery},
          {owner:"activity",kind:"reconsideration_subscription",proposal:{id:subscriptionId,runId:request.recipient.runId,
            owner:path.intent.owner,binding:{kind:"activity_path",id:path.intent.id},
            sources:[contextDeliveryFactSource(request.recipient).id,scope.source.id,activityFactSourceId("control",path.intent.id)]}}];
      })];
    return {progress:{kind:"published_source_material",version:state.version,access,representation} satisfies PublishedSourceMaterial,next:[],participants};
  }
  async settle(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal) {
    signal.throwIfAborted();
    const request=requestOf(path,stage),cleanupId=`${request.intent.id}:cancelled`;
    let state=await this.ports.materials.command({kind:"state",intentId:request.intent.id}) as MaterialCustodyState|null;
    if(state&&state.state!=="deleted") {
      if(state.state==="published")throw new TypeError("source_already_published_requires_consumer_release");
      state=await this.ports.materials.command({kind:"abandon",intentId:request.intent.id,owner:path.intent.owner,basis:stage.request.id,cleanupId}) as MaterialCustodyState;
      while(state.state!=="deleted") {
        signal.throwIfAborted();
        state=await this.ports.materials.command({kind:"delete",instanceId:request.intent.instanceId,cleanupId,maximumChunks:64}) as MaterialCustodyState;
      }
    }
    return {disposition:{kind:"unpublished_capture_disposed",intentId:request.intent.id,resultId:stage.result!.id,published:false}};
  }
}

export class SourceMaterialPublicationWork {
  readonly purpose;
  readonly lifecycle:SourcePublicationLifecycle;
  readonly deliveries:ContextDeliveryLifecycle|null;
  constructor(private readonly activities:ActivityHandoffPort,registry:ActivityPurposeRegistry<ActivityPurposeHandler>,ports:ConstructorParameters<typeof SourceMaterialPublication>[0]&{readonly selections?:ContextSelectionPort}) {
    this.purpose=registry.register(SOURCE_MATERIAL_PUBLICATION_PURPOSE,new SourceMaterialPublication(ports));
    this.lifecycle=new SourcePublicationLifecycle(activities,this.purpose,pathId=>this.result(pathId));
    this.deliveries=ports.selections?new ContextDeliveryLifecycle(activities,ports.selections):null;
  }
  prepareSubmission(intent:Omit<ActivityPathIntent,"purpose"|"owner">,request:SourceMaterialPublicationRequest):readonly SharedAcceptancePart[] {
    if(request.lifecycle)throw new TypeError("source_lifecycle_requires_independent_admission");
    return this.submission(intent,request);
  }
  prepareIndependentSubmission(intent:Omit<ActivityPathIntent,"purpose"|"owner">,request:SourceMaterialPublicationRequest,
    scheduling:ActivitySchedulingIntent):readonly SharedAcceptancePart[] {
    if(request.lifecycle)throw new TypeError("source_lifecycle_already_bound");
    const lifecycle:SourcePublicationLifecyclePlan={revision:"1",scheduling};
    validateSourcePublicationLifecycle(lifecycle,{...intent,purpose:this.purpose,owner:this.purpose.contract.acceptanceOwner});
    return [{owner:"activity",kind:"scheduling_acceptance",proposal:{kind:"schedule_work",intent:scheduling,expectedRevision:0}},
      ...this.submission(intent,{...request,lifecycle}),
      {owner:"activity",kind:"scheduling_path_seal",proposal:{kind:"seal_scheduled_paths",workId:scheduling.workId,expectedRevision:1,basis:`${intent.id}:source-lifecycle`}},
      {owner:"activity",kind:"reconsideration_subscription",proposal:{id:`${intent.id}:source-lifecycle`,runId:intent.runId,
        owner:this.purpose.contract.acceptanceOwner,binding:{kind:"activity_path",id:intent.id},
        sources:[activityFactSourceId("progress",intent.id),activityFactSourceId("control",intent.id),activityFactSourceId("scheduling",scheduling.workId)]}}];
  }
  private submission(intent:Omit<ActivityPathIntent,"purpose"|"owner">,request:SourceMaterialPublicationRequest):readonly SharedAcceptancePart[] {
    validateSourceMaterialRequest(request);
    if(request.deliveries?.length&&!this.deliveries)throw new TypeError("source_delivery_lifecycle_unbound");
    if(request.intent.activityId!==intent.id||request.intent.version.origin.runId!==intent.runId)throw new TypeError("source_publication_scope_invalid");
    return [{owner:"activity",kind:"path_opening",proposal:{...intent,purpose:this.purpose,owner:this.purpose.contract.acceptanceOwner}},
      {owner:"activity",kind:"stage_submission",proposal:{id:`${intent.id}:capture`,pathId:intent.id,stageKind:"capture",input:request,capabilities:["material-write"],dependencies:[]}}];
  }
  async result(pathId:string):Promise<PublishedSourceMaterial|UnavailableSourceMaterial|null> {
    const path=await this.activities.command({kind:"read_path",pathId}) as ActivityPathState|null;
    if(!path||path.intent.purpose.digest!==this.purpose.digest)throw new TypeError("source_publication_path_unavailable");
    const stage=await this.activities.command({kind:"read_stage",requestId:`${pathId}:capture`}) as ActivityStageState|null;
    if(!stage)throw new TypeError("source_publication_stage_unavailable");
    return sourceMaterialOutcome(path,stage);
  }
}

function requestOf(path:ActivityPathState,stage:ActivityStageState):SourceMaterialPublicationRequest {
  const request=stage.request.input as SourceMaterialPublicationRequest;
  validateSourceMaterialRequest(request);
  if(path.intent.purpose.digest!==modelInputValueDigest(SOURCE_MATERIAL_PUBLICATION_PURPOSE)||stage.request.stageKind!=="capture"||
    path.intent.id!==request.intent.activityId||path.intent.runId!==request.intent.version.origin.runId||path.intent.owner!==request.intent.owner)
    throw new TypeError("source_publication_binding_invalid");
  if(request.lifecycle)validateSourcePublicationLifecycle(request.lifecycle,path.intent);
  return request;
}
export function validateSourceMaterialRequest(request:SourceMaterialPublicationRequest):void {
  if(request?.kind!=="source_material_publication"||typeof request.bytesBase64!=="string"||!request.target||!request.purpose||
    request.intent?.owner!==SOURCE_MATERIAL_PUBLICATION_PURPOSE.acceptanceOwner||request.recipient?.runId!==request.intent.version.origin.runId||request.recipient.purpose!==request.purpose)
    throw new TypeError("source_publication_request_invalid");
  if(request.deliveries!==undefined&&(!Array.isArray(request.deliveries)||new Set(request.deliveries.map(delivery=>delivery?.id)).size!==request.deliveries.length||
    request.deliveries.some(delivery=>!delivery||[delivery.id,delivery.sourceId].some(value=>typeof value!=="string"||!value.trim()))))
    throw new TypeError("source_publication_delivery_invalid");
  if(request.deliveries?.length) {
    const lifetime=request.deliveryLifetime;
    if(!lifetime||lifetime.source?.runId!==request.recipient.runId)throw new TypeError("source_publication_delivery_lifetime_missing");
    [lifetime.source.id,lifetime.source.owner,lifetime.closedFactId].forEach(activityToken);
  } else if(request.deliveryLifetime)throw new TypeError("source_publication_delivery_lifetime_unexpected");
  const bytes=Buffer.from(request.bytesBase64,"base64"),digest=`sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if(bytes.toString("base64")!==request.bytesBase64||request.intent.version.capture!=="complete"||request.intent.version.bytes!==bytes.length||
    request.intent.version.digest!==digest||bytes.length>request.intent.maximumBytes)throw new TypeError("source_publication_content_invalid");
}
