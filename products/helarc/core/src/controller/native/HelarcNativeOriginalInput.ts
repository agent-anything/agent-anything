import {modelInputValueDigest as digest,assessInputCapacity} from "@agent-anything/model-interaction/input";
import {containsMaterialRange,type MaterialCustodyPort,type MaterialReadPage,type MaterialHold} from "@agent-anything/context/custody";
import type {RepresentationCatalogPort,RepresentationRecord,RepresentationJudgment} from "@agent-anything/context/representation";
import type {ActivityStageState} from "@agent-anything/agent-runtime/activity";
import {nativeInputBodyDigest,type NativeInputPreparationValue,type ContextRecipientInputReadiness} from "@agent-anything/agent-runtime/context-representation";
import {bindNativeInputManifest,nativeInputSettings} from "@agent-anything/provider-integrations/native";
import {OPENAI_RESPONSES} from "@agent-anything/model-interaction/protocol";
import {helarcNativeInputAcceptance,type HelarcRetainedNativeInput} from "./HelarcNativeInputAcceptance.js";
import type {HelarcNativeInputDemandPlan} from "./HelarcNativeInputDemandWork.js";
import {validateHelarcNativeWorkingSources} from "./HelarcNativeWorkingSources.js";
import {helarcNativePublishedInputGroups} from "./HelarcNativeInputGroups.js";
import type {HelarcNativeSourcePublication} from "./HelarcNativeSourcePublications.js";
import {realizeHelarcNativeInput} from "./HelarcNativeInputRealization.js";

/** Exact retention is assessed locally; it neither transforms content nor makes a semantic quality claim. */
export async function prepareHelarcNativeOriginalInput(input:{
  readonly plan:HelarcNativeInputDemandPlan;
  readonly source:ActivityStageState;
  readonly history:{readonly record:RepresentationRecord;readonly hold:MaterialHold};
  readonly publications?:readonly HelarcNativeSourcePublication[];
  readonly inputId:string;readonly selectionId:string;
  readonly continuity:HelarcRetainedNativeInput["continuity"];
  readonly maximumReadBytes:number;
  readonly measurement?:import("./HelarcNativeInputMeasurement.js").HelarcNativeInputMeasurementSelection;
},ports:{readonly materials:MaterialCustodyPort;readonly representations:RepresentationCatalogPort;
  readonly measurement?:import("./HelarcNativeInputMeasurement.js").HelarcNativeInputMeasurementPort},signal:AbortSignal){
  const {plan,source,history,inputId,selectionId}=input,{activity,prepared,inputNeed}=plan,scope=inputNeed.scope;
  const body=JSON.parse(prepared.wire.body),all=(body.input??body.messages) as Record<string,unknown>[];
  const evidence=source.result?.value as {originalDigest?:string;sourceDigest?:string;bodyDigest?:string}|undefined;
  if(source.status!=="accepted"||source.result?.outcome!=="returned"||source.result.completeness!=="complete"||!source.receipt||
    source.request.stageKind!=="source"||source.request.id!==`${source.request.pathId}:stage:1`||inputNeed.needId!==`${source.request.pathId}:need`||
    source.receipt.requestId!==source.request.id||source.receipt.resultId!==source.result.id||source.receipt.owner!==scope.owner||
    evidence?.originalDigest!==digest(prepared)||evidence.sourceDigest!==prepared.sourceDigest||evidence.bodyDigest!==nativeInputBodyDigest(prepared.wire.body)||
    digest((source.request.input as {plan?:HelarcNativeInputDemandPlan}).plan)!==digest(plan)||
    digest((source.receipt.progress as {contextInputNeed?:unknown}).contextInputNeed)!==digest(inputNeed)||
    prepared.wire.digest!==digest(body)||body.previous_response_id||body.conversation||prepared.selectedInputId||prepared.resultPresentations?.length||
    !Array.isArray(all)||!prepared.workingSources||!Number.isSafeInteger(input.maximumReadBytes)||input.maximumReadBytes<0)
    throw new TypeError("native_original_input_source_invalid");
  signal.throwIfAborted();
  const prefix=activity.composition.composition.protocol.id!==OPENAI_RESPONSES.id&&all[0]?.role==="system"?1:0;
  validateHelarcNativeWorkingSources(prepared.workingSources,all.slice(prefix));
  const record=await ports.representations.command({kind:"read",ref:history.record.ref}) as RepresentationRecord|null;
  const recipient={runId:scope.runId,recipient:scope.recipient,purpose:scope.purpose};
  if(!record||record.runId!==scope.runId||record.purpose!==scope.purpose||record.target!==scope.target||
    digest(record)!==digest(history.record)||digest(history.hold.consumer)!==digest(recipient)||
    !containsMaterialRange(history.hold.range,record.body)||record.body.end-record.body.start>input.maximumReadBytes)
    throw new TypeError("native_original_input_history_invalid");
  const access={id:`${inputId}:source`,holdId:history.hold.id,recipient,range:record.body},chunks:Buffer[]=[];
  for(let offset=record.body.start;offset<record.body.end;){
    signal.throwIfAborted();const page=await ports.materials.command({kind:"read",access,offset,length:Math.min(65536,record.body.end-offset)}) as MaterialReadPage;
    const bytes=Buffer.from(page.bytesBase64,"base64");
    if(page.start!==offset||page.end<=offset||page.end>record.body.end||bytes.length!==page.end-offset)throw new TypeError("native_original_input_page_invalid");
    chunks.push(bytes);offset=page.end;
  }
  if(digest(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks))))!==digest(all))throw new TypeError("native_original_input_content_changed");
  const inputHold={...history.hold,id:`${inputId}:hold`,responsibility:"input" as const,basis:inputId};
  const selectionHold={...inputHold,id:`${selectionId}:hold`,responsibility:"selection" as const,basis:selectionId};
  const configuration=activity.composition.composition.configuration,settings=nativeInputSettings(body),judgmentId=`${inputId}:original-identity`;
  const published=input.publications?helarcNativePublishedInputGroups({protocol:activity.composition.composition.protocol.id,
    items:all.slice(prefix),sources:prepared.workingSources,publications:input.publications,recipient,target:scope.target,inputId,selectionId}):null;
  const groups=published?[...(prefix?[{id:`${inputId}:system`,representation:record.ref,items:all.slice(0,prefix),holds:[inputHold.id],
    sources:[source.request.id],deliveries:[],requires:[],replay:"local" as const}]:[]),...published.groups]:
    [{id:`${inputId}:original`,representation:record.ref,items:all,holds:[inputHold.id],sources:[prepared.sourceDigest],deliveries:[],requires:[],replay:"local" as const}];
  const inputHolds=published?[...(prefix?[inputHold]:[]),...published.inputHolds]:[inputHold];
  const selectionHolds=published?[...(prefix?[selectionHold]:[]),...published.selectionHolds]:[selectionHold];
  const subjects=[...new Map(groups.map(group=>[digest(group.representation),group.representation])).values()];
  const coverage=published?[...(prefix?[record.body]:[]),...input.publications!.map(p=>p.published!.representation.body)]:[record.body];
  const manifest=bindNativeInputManifest({protocol:activity.composition.composition.protocol,
    scope:{id:scope.id,runId:scope.runId,recipientId:scope.recipient,purpose:activity.scope.purpose,compositionDigest:activity.composition.digest},
    target:{model:body.model,configuration:scope.target,connection:configuration.connectionBinding.id,disclosure:scope.authorityBasis},settings,
    settingSources:Object.keys(settings).map(field=>({field,source:source.request.id,digest:digest(settings[field])})),
    selection:{id:selectionId,revision:"1",boundary:prepared.sourceDigest,judgments:[judgmentId]},
    groups});
  const selected:HelarcRetainedNativeInput={kind:"helarc_native_input",manifest,
    ...realizeHelarcNativeInput(manifest,prepared.wire,input.continuity),workingSources:prepared.workingSources};
  const measurement=input.measurement?await (()=>{
    if(!ports.measurement)throw new TypeError("native_original_measurement_unavailable");
    return ports.measurement.measure({activity,native:selected,inputId,selection:input.measurement},signal);
  })():null;
  const measurements:NativeInputPreparationValue["capacity"]["measurements"]=[{id:`${inputId}:bytes`,encodedInputId:inputId,targetRevision:scope.target,
    methodRevision:"native-body-bytes:1",dimension:"request_bytes",coverage:"complete",quantity:{kind:"exact",value:Buffer.byteLength(selected.wire.body)},
    basis:"Complete unchanged native request byte size; not a token count",uncovered:[]},
    ...measurement?.evidence??[]];
  const capacity={inputId,measurements,limits:plan.capacity.limits,assessment:assessInputCapacity({encodedInputId:inputId,targetRevision:scope.target,purpose:scope.purpose,
    ...plan.capacity,evidence:measurements,refusals:measurement?.refusals})};
  const preparation:NativeInputPreparationValue={kind:"native_input_preparation",revision:"1",scope,inputId,exactInput:selected,
    projection:{owner:"helarc-native-input",revision:"1"},encoded:{mediaType:"application/json",body:selected.wire.body,bodyDigest:nativeInputBodyDigest(selected.wire.body)},capacity};
  const judgment:RepresentationJudgment={id:judgmentId,owner:scope.owner,runId:scope.runId,kind:"combination",subjects,inputs:coverage,
    purpose:scope.purpose,target:scope.target,methodRevision:"native-original-identity:1",dependencies:{inputDigest:digest(selected),bodyDigest:preparation.encoded.bodyDigest,
      capacityDigest:digest(capacity),original:digest(plan),sourceReceipt:source.receipt.id},
    evidenceSources:[source.request.id,source.result.id,source.receipt.id].map(id=>({owner:scope.owner,id,runId:scope.runId,revision:null})),
    coverage,conclusion:"supported",limitations:[],basis:"Exact original input, native settings and source declarations retained without representation conversion"};
  // Validate native realization now, but let policy decide whether this option is usable.
  const proposal=helarcNativeInputAcceptance({id:`${inputId}:accept`,scope,expectedSelectionId:null,expectedControlRevision:0,retainedSelectionId:null,
    selection:{id:selectionId,representations:subjects,judgmentIds:[judgment.id],holds:selectionHolds},native:selected,judgment,inputId,
    activityId:activity.scope.activityId,stageRequestId:null,nativeConsumer:{protocol:manifest.protocol,compositionDigest:manifest.scope.compositionDigest},
    inputHolds,releaseHolds:[]});
  const readiness:ContextRecipientInputReadiness={kind:"recipient_prepared",scope,inputId,bodyDigest:preparation.encoded.bodyDigest,
    exactInputDigest:digest(selected),judgmentId:judgment.id,allowed:capacity.assessment.allowed,capacity,
    risks:capacity.assessment.decisions.filter(d=>d.conclusion!=="within").map(d=>`${d.limitId}:${d.reason}`),
    evidence:{id:source.receipt.id,owner:scope.owner,revision:"1",kind:"fact"}};
  return {preparation,selected,judgment,readiness,proposal:capacity.assessment.allowed?proposal:null,readBytes:record.body.end-record.body.start,
    measurementUsage:measurement?.usage??{measurementCalls:0}};
}
