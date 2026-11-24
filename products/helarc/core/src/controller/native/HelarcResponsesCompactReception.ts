import {modelInputValueDigest as digest,assessInputCapacity} from "@agent-anything/model-interaction/input";
import {containsMaterialRange,type MaterialCustodyPort,type MaterialAccessDescription,type MaterialReadPage,type MaterialHold,type MaterialAccessAdmission} from "@agent-anything/context/custody";
import type {RepresentationCatalogPort,RepresentationRecord,RepresentationJudgment} from "@agent-anything/context/representation";
import type {ContextUseScope} from "@agent-anything/context/selection";
import type {ProtocolExecutionJournal,ProtocolExecutionState,ProtocolPurposeAcceptance,ProtocolJournalRecord} from "@agent-anything/agent-runtime/model-access";
import {nativeInputBodyDigest,type ContextRecipientInputCapacity,type ContextRecipientInputReadiness,type NativeInputPreparationValue} from "@agent-anything/agent-runtime/context-representation";
import {bindNativeInputManifest,RESPONSES_COMPACT_METHOD} from "@agent-anything/provider-integrations/native";
import type {HelarcResponsesCompactWork} from "./HelarcResponsesCompactWork.js";
import {helarcResponsesCompactAdoption} from "./HelarcResponsesCompactAdoption.js";
import type {HelarcRetainedNativeInput} from "./HelarcNativeInputAcceptance.js";
import type {HelarcNativeSourcePublication} from "./HelarcNativeSourcePublications.js";
import {realizeHelarcResponsesCompact} from "./HelarcResponsesCompactRealization.js";
import type {HelarcNativeInputDemandPlan} from "./HelarcNativeInputDemandWork.js";
import type {HelarcResponsesCompactSource} from "./HelarcResponsesCompaction.js";
import {realizeHelarcNativeInput} from "./HelarcNativeInputRealization.js";

export interface HelarcResponsesCompactReceptionInput {
  readonly original:HelarcRetainedNativeInput;
  readonly publications:readonly HelarcNativeSourcePublication[];
  readonly methodPathId:string;
  readonly scope:ContextUseScope;
  readonly activityId:string;
  readonly inputId:string;
  readonly selectionId:string;
  readonly capacity:HelarcNativeInputDemandPlan["capacity"];
  readonly maximumReadBytes:number;
  readonly measurement?:import("./HelarcNativeInputMeasurement.js").HelarcNativeInputMeasurementSelection;
}
export interface HelarcResponsesCompactReceptionPorts {
  readonly methods:HelarcResponsesCompactWork;
  readonly journal:ProtocolExecutionJournal;
  readonly materials:MaterialCustodyPort;
  readonly representations:RepresentationCatalogPort;
  readonly measurement?:import("./HelarcNativeInputMeasurement.js").HelarcNativeInputMeasurementPort;
}

/** Whole native reception after qualified production; measurement is declared, adoption is separate. */
export async function prepareHelarcResponsesCompactReception(i:HelarcResponsesCompactReceptionInput,p:HelarcResponsesCompactReceptionPorts,signal:AbortSignal,
  receivingActivity?:HelarcNativeInputDemandPlan["activity"]){
  const {scope,inputId,selectionId,original}=i,s=original.manifest.scope;
  if(scope.id!==s.id||scope.runId!==s.runId||scope.recipient!==s.recipientId||scope.purpose!==s.purpose.id||
    scope.target!==original.manifest.target.configuration||scope.authorityBasis!==original.manifest.target.disclosure||
    original.continuity.kind!=="responses"||!i.activityId||!inputId||!selectionId||!Number.isSafeInteger(i.maximumReadBytes)||i.maximumReadBytes<0)
    throw new TypeError("compact_reception_scope_changed");
  signal.throwIfAborted();
  const description=await p.methods.describe(i.methodPathId),method=await p.methods.result(i.methodPathId);
  if(description.state!=="ready"||method?.state!=="ready")return {kind:"unavailable" as const,reason:`compact_method_${description.state}`};
  if(!method.compact||!method.assessment?.quality.allowed||!method.publication||method.request.recipient.runId!==scope.runId)
    throw new TypeError("compact_reception_producer_unconfirmed");
  const source=method.request.execution.request as HelarcResponsesCompactSource;
  const record=await p.representations.command({kind:"read",ref:method.publication.representation}) as RepresentationRecord|null;
  const preserved=await p.representations.command({kind:"read_judgment",id:method.publication.judgmentId}) as RepresentationJudgment|null;
  if(!record||record.form!=="native"||record.runId!==scope.runId||record.target!==scope.target||record.method?.id!==RESPONSES_COMPACT_METHOD.id||
    record.method.revision!==RESPONSES_COMPACT_METHOD.revision||!record.method.protocolConfirmation||!preserved||preserved.id!==method.assessment.id||
    preserved.conclusion!=="supported"||preserved.kind!=="policy"||preserved.owner!==record.owner||preserved.runId!==record.runId||
    preserved.purpose!==record.purpose||preserved.target!==record.target||preserved.methodRevision!==method.assessment.dependencies.method||
    digest(preserved.dependencies)!==digest({...method.assessment.dependencies,candidate:method.assessment.candidateDigest,findings:digest(method.assessment.findings)})||
    digest(preserved.coverage)!==digest(record.declaredCoverage)||
    !preserved.subjects.some(r=>digest(r)===digest(record.ref)))throw new TypeError("compact_reception_publication_unconfirmed");
  const nativeId=record.method.activityId,state=await p.journal.command({kind:"state",activityId:nativeId}) as ProtocolExecutionState|null;
  const accepted=await p.journal.command({kind:"acceptance",activityId:nativeId}) as ProtocolPurposeAcceptance|null;
  const terminalRef={id:record.method.rawResultId,revision:record.method.protocolConfirmation.rawRevision};
  const terminal=await p.journal.command({kind:"record",activityId:nativeId,ref:terminalRef}) as ProtocolJournalRecord|null;
  if(!state||!accepted||!terminal||state.activity.scope.runId!==scope.runId||state.activity.composition.digest!==s.compositionDigest||
    digest(accepted.evidence)!==digest(method.compact.evidence)||record.method.acceptanceId!==accepted.evidence.acceptance.id||
    record.method.protocolConfirmation.acceptanceRevision!==accepted.evidence.acceptance.revision||
    !accepted.evidence.sources.some(s=>s.scope.activityId===nativeId&&digest(s.record)===digest(terminalRef)))
    throw new TypeError("compact_reception_native_evidence_changed");
  if(state.cancelled)return {kind:"unavailable" as const,reason:"compact_native_operation_cancelled"};
  const publicationReader={runId:record.runId,recipient:record.owner,purpose:record.purpose},protectedHolds:MaterialHold[]=[];
  for(const holdId of record.holds){
    signal.throwIfAborted();const d=await p.materials.command({kind:"describe",holdId,recipient:publicationReader}) as MaterialAccessDescription;
    protectedHolds.push(d.hold);
  }
  const outputHold=protectedHolds.find(h=>containsMaterialRange(h.range,record.body));
  if(!outputHold||record.body.end-record.body.start>i.maximumReadBytes)throw new TypeError("compact_reception_output_unavailable");
  const chunks:Buffer[]=[];let readBytes=0;
  for(let offset=record.body.start;offset<record.body.end;){
    signal.throwIfAborted();const page=await p.materials.command({kind:"read",access:{id:`${inputId}:compact`,holdId:outputHold.id,recipient:publicationReader,range:record.body},
      offset,length:Math.min(65536,record.body.end-offset)}) as MaterialReadPage;
    const bytes=Buffer.from(page.bytesBase64,"base64");
    if(page.start!==offset||page.end<=offset||page.end>record.body.end||bytes.length!==page.end-offset)throw new TypeError("compact_reception_page_invalid");
    chunks.push(bytes);readBytes+=bytes.length;offset=page.end;
  }
  const retainedItems=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks)));
  if(digest(retainedItems)!==digest(method.compact.candidate.items))throw new TypeError("compact_reception_output_changed");
  const realized=realizeHelarcResponsesCompact({original,publications:i.publications,source,candidate:method.compact.candidate,assessment:method.assessment,
    group:{id:`${inputId}:compacted`,representation:record.ref,holds:[outputHold.id],observation:terminalRef.id}});
  for(const publication of i.publications){
    const published=publication.published!;
    const retained=await p.representations.command({kind:"read",ref:published.representation.ref}) as RepresentationRecord|null;
    if(!retained||digest(retained)!==digest(published.representation))throw new TypeError("compact_reception_source_record_changed");
    const d=await p.materials.command({kind:"describe",holdId:published.access.holdId,recipient:published.access.recipient}) as MaterialAccessDescription;
    if(!containsMaterialRange(d.hold.range,published.access.range))throw new TypeError("compact_reception_source_access_changed");
    protectedHolds.push(d.hold);
  }
  const recipient={runId:scope.runId,recipient:scope.recipient,purpose:scope.purpose},inputHolds:MaterialHold[]=[],selectionHolds:MaterialHold[]=[],admissions:MaterialAccessAdmission[]=[];
  const retainedHolds=[...new Map(protectedHolds.map(h=>[h.id,h])).values()],mapped=new Map<string,string>();
  const equivalent=(h:MaterialHold)=>digest([h.instanceId,h.range]);
  const preferred=new Map<string,MaterialHold>();
  for(const h of retainedHolds)if(!preferred.has(equivalent(h))||digest(h.consumer)===digest(recipient))preferred.set(equivalent(h),h);
  const holds=[...preferred.values()];
  for(const [index,h]of holds.entries()){
    const hold={...h,id:`${inputId}:hold:${index}`,consumer:recipient,responsibility:"input" as const,basis:inputId};
    inputHolds.push(hold);selectionHolds.push({...hold,id:`${selectionId}:hold:${index}`,responsibility:"selection",basis:selectionId});
    for(const retained of retainedHolds)if(equivalent(retained)===equivalent(h))mapped.set(retained.id,hold.id);
    if(digest(h.consumer)!==digest(recipient))admissions.push({source:{id:`${inputId}:source:${index}`,holdId:h.id,recipient:h.consumer,range:h.range},hold,
      grant:{id:`${inputId}:grant:${index}`,instanceId:hold.instanceId,recipient,range:hold.range,revision:0,allowed:true,basis:scope.authorityBasis}});
  }
  const judgmentId=`${inputId}:complete-input`,manifest=bindNativeInputManifest({...original.manifest,
    selection:{id:selectionId,revision:"1",boundary:original.manifest.selection.boundary,judgments:[judgmentId]},
    groups:realized.groups.map(g=>({...g,holds:g.holds.map(id=>{const mappedId=mapped.get(id);if(!mappedId)throw new TypeError("compact_reception_hold_unmapped");return mappedId;})}))});
  const body={...JSON.parse(original.wire.body),input:realized.items};
  const continuity={...original.continuity,conditions:{...original.continuity.conditions,reestablish:true,basis:`Qualified compact reception ${method.assessment.id}`}};
  const selected:HelarcRetainedNativeInput={kind:"helarc_native_input",manifest,
    ...realizeHelarcNativeInput(manifest,{body:JSON.stringify(body),digest:digest(body)},continuity),workingSources:realized.workingSources};
  const measurement=i.measurement?await (()=>{
    if(!p.measurement)throw new TypeError("compact_reception_measurement_unavailable");
    if(!receivingActivity||receivingActivity.scope.activityId!==i.activityId||receivingActivity.scope.runId!==scope.runId||
      receivingActivity.scope.recipientId!==scope.recipient||digest(receivingActivity.scope.purpose)!==digest(s.purpose)||
      receivingActivity.composition.digest!==s.compositionDigest)throw new TypeError("compact_reception_measurement_consumer_changed");
    return p.measurement.measure({activity:receivingActivity,native:selected,inputId,selection:i.measurement},signal);
  })():null;
  const measurementUsage=measurement?.usage??{measurementCalls:0};
  const measurements:ContextRecipientInputCapacity["measurements"]=[{id:`${inputId}:bytes`,encodedInputId:inputId,targetRevision:scope.target,
    methodRevision:"native-body-bytes:1",dimension:"request_bytes",coverage:"complete",quantity:{kind:"exact",value:Buffer.byteLength(selected.wire.body)},
    basis:"Whole compacted window and finite current suffix in the complete native request",uncovered:[]},
    ...measurement?.evidence??[]];
  const capacity:ContextRecipientInputCapacity={inputId,measurements,limits:i.capacity.limits,assessment:assessInputCapacity({encodedInputId:inputId,
    targetRevision:scope.target,purpose:scope.purpose,...i.capacity,evidence:measurements,refusals:measurement?.refusals})};
  if(!capacity.assessment.allowed)return {kind:"unavailable" as const,reason:"recipient_input_capacity_unavailable",capacity:capacity.assessment,readBytes,measurementUsage};
  const representations=[...new Map(manifest.groups.map(g=>[digest(g.representation),g.representation])).values()];
  const preparation:NativeInputPreparationValue={kind:"native_input_preparation",revision:"1",scope,inputId,exactInput:selected,
    projection:{owner:"helarc-native-input",revision:"1"},encoded:{mediaType:"application/json",body:selected.wire.body,bodyDigest:nativeInputBodyDigest(selected.wire.body)},capacity};
  const judgment:RepresentationJudgment={id:judgmentId,owner:scope.owner,runId:scope.runId,kind:"combination",subjects:representations,
    inputs:holds.map(h=>h.range),purpose:scope.purpose,target:scope.target,methodRevision:"responses-compact-reception:1",
    dependencies:{inputDigest:digest(selected),bodyDigest:preparation.encoded.bodyDigest,capacityDigest:digest(capacity),preservation:preserved.id},
    evidenceSources:[{owner:preserved.owner,id:preserved.id,runId:scope.runId,revision:null}],coverage:record.declaredCoverage,conclusion:"supported",
    limitations:preserved.limitations,basis:"Qualified whole native compact output replaces a source-matched closed prefix; all suffix items and declared relationships remain intact"};
  const nativeGuard={activityId:nativeId,controlRevision:state.fence.controlRevision,result:terminalRef,acceptance:accepted.evidence.acceptance};
  const proposal=helarcResponsesCompactAdoption({source,candidate:method.compact.candidate,assessment:method.assessment,original:nativeGuard,
    acceptance:{id:`${inputId}:accept`,scope,expectedSelectionId:null,expectedControlRevision:0,retainedSelectionId:null,
      selection:{id:selectionId,representations,judgmentIds:[judgmentId],holds:selectionHolds},native:selected,judgment,inputId,activityId:i.activityId,stageRequestId:null,
      nativeConsumer:{protocol:manifest.protocol,compositionDigest:s.compositionDigest},inputHolds,materialAdmissions:admissions,releaseHolds:[]}});
  const readiness:ContextRecipientInputReadiness={kind:"recipient_prepared",scope,inputId,bodyDigest:preparation.encoded.bodyDigest,exactInputDigest:digest(selected),judgmentId,
    allowed:true,capacity,risks:capacity.assessment.decisions.filter(d=>d.conclusion!=="within").map(d=>`${d.limitId}:${d.reason}`),
    evidence:{owner:scope.owner,kind:"fact",id:judgmentId,revision:"1"}};
  return {kind:"ready" as const,selected,judgment,proposal,preparation,readiness,nativeGuard,readBytes,measurementUsage};
}
