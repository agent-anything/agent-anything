import {modelInputValueDigest as digest,assessInputCapacity} from "@agent-anything/model-interaction/input";
import type {MaterialHold,MaterialAccessAdmission} from "@agent-anything/context/custody";
import type {RepresentationJudgment} from "@agent-anything/context/representation";
import type {ContextSelectionProposal} from "@agent-anything/context/selection";
import {nativeInputBodyDigest,type NativeInputPreparationValue,type ContextRecipientInputReadiness} from "@agent-anything/agent-runtime/context-representation";
import {bindNativeInputManifest,nativeInputSettings,RESPONSES_IN_REQUEST_COMPACTION} from "@agent-anything/provider-integrations/native";
import type {ProtocolModelActivity} from "@agent-anything/agent-runtime/model-access";
import {helarcNativeInputAcceptance,type HelarcRetainedNativeInput} from "./HelarcNativeInputAcceptance.js";
import {realizeHelarcNativeInput} from "./HelarcNativeInputRealization.js";
import {bindHelarcResponsesCompactionAgreement} from "./HelarcResponsesCompaction.js";
import {assessHelarcResponsesInRequestUse,helarcResponsesInRequestFindings,type HelarcResponsesInRequestUse} from "./HelarcResponsesInRequestEligibility.js";
import type {HelarcNativeOriginalInputWork} from "./HelarcNativeOriginalInputWork.js";
import type {HelarcNativeInputDemandPlan} from "./HelarcNativeInputDemandWork.js";
import type {HelarcNativeInputMeasurementPort,HelarcNativeInputMeasurementSelection} from "./HelarcNativeInputMeasurement.js";

type Original=Extract<Awaited<ReturnType<HelarcNativeOriginalInputWork["result"]>>,{kind:"prepared"}>;
export async function prepareHelarcResponsesInRequestReception(i:{readonly original:Original;readonly inputId:string;readonly selectionId:string;
  readonly activity:ProtocolModelActivity;readonly use:HelarcResponsesInRequestUse;readonly capacity:HelarcNativeInputDemandPlan["capacity"];
  readonly measurement?:HelarcNativeInputMeasurementSelection},p:{readonly measurement?:HelarcNativeInputMeasurementPort},signal:AbortSignal){
  signal.throwIfAborted();const original=i.original.value,scope=original.preparation.scope,native=original.selected;
  const eligibility=assessHelarcResponsesInRequestUse({native,use:i.use,capacity:i.capacity});
  if(!eligibility.allowed||!original.readiness.allowed||!original.proposal)return {kind:"unavailable" as const,reason:"in_request_use_not_eligible",eligibility};
  const selection=original.proposal.parts.find(p=>p.owner==="context_selection"&&p.kind==="selection_input")?.proposal as ContextSelectionProposal|undefined;
  if(!selection||digest(selection.input.exactInput)!==digest(native))throw new TypeError("in_request_original_selection_missing");
  const holds=selection.input.holds,inputHolds:MaterialHold[]=holds.map((h,index)=>({...h,id:`${i.inputId}:hold:${index}`,responsibility:"input",basis:i.inputId}));
  const selectionHolds:MaterialHold[]=inputHolds.map((h,index)=>({...h,id:`${i.selectionId}:hold:${index}`,responsibility:"selection",basis:i.selectionId}));
  const mapped=new Map(holds.map((h,index)=>[h.id,inputHolds[index]!.id])),judgmentId=`${i.inputId}:agreement-input`;
  const t=eligibility.trigger!,body={...JSON.parse(native.wire.body),context_management:[{type:"compaction",compact_threshold:t.tokens}]};
  const settings=nativeInputSettings(body),manifest=bindNativeInputManifest({...native.manifest,settings,
    settingSources:[...native.manifest.settingSources.filter(s=>s.field!=="context_management"),
      {field:"context_management",source:eligibility.id,digest:digest(settings.context_management)}],
    selection:{id:i.selectionId,revision:"1",boundary:native.manifest.selection.boundary,judgments:[judgmentId]},
    groups:native.manifest.groups.map(g=>({...g,holds:g.holds.map(id=>{const v=mapped.get(id);if(!v)throw new TypeError("in_request_source_hold_missing");return v;})}))});
  const realized=realizeHelarcNativeInput(manifest,{body:JSON.stringify(body),digest:digest(body)},native.continuity);
  const oldPrefix=native.manifest.groups.slice(0,native.prefixGroups).reduce((n,g)=>n+g.items.length,0),
    newPrefix=manifest.groups.slice(0,realized.prefixGroups).reduce((n,g)=>n+g.items.length,0);
  const resultPresentations=native.resultPresentations?.flatMap(p=>{
    const position=/^\/input\/(\d+)$/u.exec(p.position);
    if(!position)throw new TypeError("in_request_result_position_invalid");
    const index=Number(position[1])+oldPrefix-newPrefix;
    return index<0?[]:[{...p,position:`/input/${index}`}];
  });
  const unbound:HelarcRetainedNativeInput={...native,manifest,...realized,...resultPresentations?{resultPresentations}:{}};
  const admissions=original.proposal.parts.filter(p=>p.owner==="material_custody"&&p.kind==="admit_access").map((p,index)=>{
    const a=p.proposal as MaterialAccessAdmission,hold=inputHolds.find(h=>h.id===mapped.get(a.hold.id));
    if(!hold)throw new TypeError("in_request_material_admission_unmapped");
    return {...a,hold,grant:{...a.grant,id:`${i.inputId}:grant:${index}`}};
  });
  const measurement=i.measurement?await (()=>{
    if(!p.measurement)throw new TypeError("in_request_measurement_unavailable");
    return p.measurement.measure({activity:i.activity,native:unbound,inputId:i.inputId,selection:i.measurement},signal);
  })():null;
  const measurements:NativeInputPreparationValue["capacity"]["measurements"]=[{id:`${i.inputId}:bytes`,encodedInputId:i.inputId,targetRevision:scope.target,
    methodRevision:"native-body-bytes:1",dimension:"request_bytes",coverage:"complete",quantity:{kind:"exact",value:Buffer.byteLength(realized.wire.body)},
    basis:"Complete native request with proposed in-request compaction options",uncovered:[]},...measurement?.evidence??[]];
  const limits=[...i.capacity.limits,...i.capacity.limits.some(l=>l.dimension==="shared_tokens")?[]:[{id:`${i.inputId}:configured-window`,
    targetRevision:scope.target,dimension:"shared_tokens" as const,maximum:t.window,source:t.basis}]];
  const capacity={inputId:i.inputId,measurements,limits,assessment:assessInputCapacity({...i.capacity,limits,encodedInputId:i.inputId,targetRevision:scope.target,
    purpose:scope.purpose,evidence:measurements,refusals:measurement?.refusals})};
  if(!capacity.assessment.allowed)return {kind:"unavailable" as const,reason:"in_request_input_capacity_unavailable",eligibility,capacity:capacity.assessment,
    measurementUsage:measurement?.usage??{measurementCalls:0}};
  const known=measurements.find(m=>m.dimension==="shared_tokens"&&m.coverage==="complete"&&m.quantity.kind==="exact");
  if(!known&&!i.capacity.policy.allowUnknown)return {kind:"unavailable" as const,reason:"in_request_count_unknown",eligibility,capacity:capacity.assessment,
    measurementUsage:measurement?.usage??{measurementCalls:0}};
  const dependencies={source:manifest.digest,target:manifest.target.configuration,authority:manifest.target.disclosure,recipient:manifest.scope.id,
    method:`${RESPONSES_IN_REQUEST_COMPACTION.id}:${RESPONSES_IN_REQUEST_COMPACTION.revision}`,requirements:digest(eligibility.duties)};
  const agreement=bindHelarcResponsesCompactionAgreement({manifest,body:JSON.parse(realized.wire.body),dependencies,duties:eligibility.duties,
    findings:helarcResponsesInRequestFindings(eligibility,realized.wire.digest,dependencies),useEvidence:eligibility,
    threshold:{...t,measurement:{id:known?.id??capacity.assessment.id,requestDigest:realized.wire.digest,coverage:known?"complete":"unknown",
      tokens:known?.quantity.kind==="exact"?known.quantity.value:null,unknowns:known?[]:["complete_native_token_count_unavailable"],
      acceptedUncertainty:known?null:i.capacity.policy.basis}},
    retentionBasis:`Original input ${i.original.stage.receipt!.id}; independent source/input/selection holds`,
    recoveryBasis:`Original demand and before-use receipt; same native execution and effect identities; policy ${digest(i.use.policy)}`});
  const selected:HelarcRetainedNativeInput={...unbound,compactionAgreement:agreement};
  const preparation:NativeInputPreparationValue={kind:"native_input_preparation",revision:"1",scope,inputId:i.inputId,exactInput:selected,
    projection:{owner:"helarc-native-input",revision:"1"},encoded:{mediaType:"application/json",body:selected.wire.body,bodyDigest:nativeInputBodyDigest(selected.wire.body)},capacity};
  const representations=[...new Map([...manifest.groups.map(g=>g.representation),...resultPresentations?.map(p=>p.representation)??[]].map(r=>[digest(r),r])).values()];
  const judgment:RepresentationJudgment={id:judgmentId,owner:scope.owner,runId:scope.runId,kind:"combination",subjects:representations,
    inputs:original.judgment.inputs,purpose:scope.purpose,target:scope.target,methodRevision:"responses-in-request-reception:1",
    dependencies:{inputDigest:digest(selected),bodyDigest:preparation.encoded.bodyDigest,capacityDigest:digest(capacity),
      sourceInput:original.preparation.inputId,eligibility:eligibility.id,agreement:agreement.id,configuredPolicy:digest(i.use.policy)},
    evidenceSources:[{owner:scope.owner,id:original.judgment.id,runId:scope.runId,revision:"1"},{owner:scope.owner,id:eligibility.id,runId:scope.runId,revision:"1"}],
    coverage:original.judgment.coverage,conclusion:"supported",limitations:agreement.quality.limitations,
    basis:"Unchanged content and explicit native before-use agreement; scoped method assurance, not inspection of a future conversion"};
  const proposal=helarcNativeInputAcceptance({id:`${i.inputId}:accept`,scope,expectedSelectionId:null,expectedControlRevision:0,retainedSelectionId:null,
    selection:{id:i.selectionId,representations,judgmentIds:[judgmentId],holds:selectionHolds},native:selected,judgment,
    inputId:i.inputId,activityId:i.activity.scope.activityId,stageRequestId:null,nativeConsumer:{protocol:manifest.protocol,compositionDigest:manifest.scope.compositionDigest},
    inputHolds,materialAdmissions:admissions,releaseHolds:[]});
  const readiness:ContextRecipientInputReadiness={kind:"recipient_prepared",scope,inputId:i.inputId,bodyDigest:preparation.encoded.bodyDigest,
    exactInputDigest:digest(selected),judgmentId,allowed:true,capacity,risks:capacity.assessment.decisions.filter(d=>d.conclusion!=="within").map(d=>`${d.limitId}:${d.reason}`),
    evidence:{owner:scope.owner,kind:"fact",id:judgmentId,revision:"1"}};
  return {kind:"ready" as const,selected,preparation,readiness,judgment,proposal,eligibility,measurementUsage:measurement?.usage??{measurementCalls:0}};
}
