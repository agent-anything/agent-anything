import {modelInputValueDigest as digest,assessInputCapacity,readModelResultContentTextSlot} from "@agent-anything/model-interaction/input";
import {containsMaterialRange,type MaterialCustodyPort,type MaterialReadPage,type MaterialAccess,type MaterialHold,type MaterialAccessDescription} from "@agent-anything/context/custody";
import type {RepresentationCatalogPort,RepresentationRecord,RepresentationJudgment} from "@agent-anything/context/representation";
import type {ContextUseScope} from "@agent-anything/context/selection";
import {nativeInputBodyDigest,type NativeInputPreparationValue,type ContextRecipientInputReadiness,
  type RepresentationMethodWork,type RepresentationMethodRequest,type ContextRecipientInputCapacity} from "@agent-anything/agent-runtime/context-representation";
import type {ProtocolModelActivity} from "@agent-anything/agent-runtime/model-access";
import type {TaskDecisionInputSources} from "@agent-anything/agent-runtime/decision";
import {bindNativeInputManifest,nativeInputSettings,type NativeInputGroup} from "@agent-anything/provider-integrations/native";
import type {HelarcAgentOutput} from "../HelarcController.js";
import {helarcResultTextDeclaration} from "../../prompt/HelarcResultTextDeclaration.js";
import type {HelarcNativeRunTask} from "./HelarcNativeTaskExecution.js";
import {helarcNativeTaskResultDeliveries,presentHelarcNativeTaskResults,type HelarcNativeTaskResultSources} from "./HelarcNativeTaskResultDelivery.js";
import {helarcNativeInputAcceptance,type HelarcRetainedNativeInput} from "./HelarcNativeInputAcceptance.js";
import {substituteHelarcNativeWorkingSources} from "./HelarcNativeWorkingSources.js";
import {realizeHelarcNativeInput} from "./HelarcNativeInputRealization.js";
import {helarcNativeGroupSourceIds,helarcNativeSourceInputGroup} from "./HelarcNativeInputGroups.js";
import {validateHelarcNativeSourcePublication,type HelarcNativeSourcePublication} from "./HelarcNativeSourcePublications.js";

export interface HelarcNativeResultReceptionPorts {
  readonly methods:RepresentationMethodWork;
  readonly materials:MaterialCustodyPort;
  readonly representations:RepresentationCatalogPort;
  readonly measurement?:import("./HelarcNativeInputMeasurement.js").HelarcNativeInputMeasurementPort;
}
export interface HelarcNativeResultReceptionInput {
  readonly activity:ProtocolModelActivity;
  readonly prepared:HelarcNativeRunTask;
  readonly input:TaskDecisionInputSources<HelarcAgentOutput>|HelarcNativeTaskResultSources;
  readonly scope:ContextUseScope;
  readonly inputId:string;
  readonly selectionId:string;
  readonly methodPathId:string;
  readonly callId:string;
  readonly candidateId:string;
  readonly history:{readonly record:RepresentationRecord;readonly hold:MaterialHold};
  readonly publications?:readonly HelarcNativeSourcePublication[];
  readonly sourceHold:MaterialHold;
  readonly continuity:HelarcRetainedNativeInput["continuity"];
  readonly capacity:RepresentationMethodRequest["capacity"];
  readonly maximumReadBytes:number;
  readonly measurement?:import("./HelarcNativeInputMeasurement.js").HelarcNativeInputMeasurementSelection;
}

/** Receive one deliberately chosen body; CRM still chooses investment and adoption. */
export async function prepareHelarcNativeResultReception(i:HelarcNativeResultReceptionInput,p:HelarcNativeResultReceptionPorts,signal:AbortSignal){
  const {activity,prepared,input,scope,inputId,selectionId,methodPathId}=i;
  const recipient={runId:scope.runId,recipient:scope.recipient,purpose:scope.purpose};
  const config=activity.composition.composition.configuration;
  if(scope.runId!==input.runId||scope.runId!==activity.scope.runId||scope.recipient!==activity.scope.recipientId||
    scope.purpose!==activity.scope.purpose.id||scope.target!==`${config.configuration.id}:${config.configuration.revision}`||
    !Number.isSafeInteger(i.maximumReadBytes)||i.maximumReadBytes<0)throw new TypeError("native_result_reception_scope_changed");
  signal.throwIfAborted();
  const delivery=helarcNativeTaskResultDeliveries(prepared,input).find(d=>d.result.modelCallRef.id===i.callId);
  const declaration=delivery&&helarcResultTextDeclaration(delivery.result,"original","1");
  if(!delivery||!declaration)throw new TypeError("native_result_reception_source_missing");
  const result=await p.methods.result(methodPathId);
  if(result.kind!=="ready")return {kind:"unavailable" as const,reason:`method_${result.kind}`};
  const progress=result.progress,candidate=progress.candidates.find(c=>c.id===i.candidateId&&progress.resultIds.includes(c.id));
  const assessment=[...progress.assessments].reverse().find(a=>a.supported&&a.candidateIds.includes(i.candidateId)&&a.scope==="both");
  if(!candidate||!assessment||digest(progress.request.nativeComposition)!==digest(activity.composition)||progress.request.recipient.runId!==input.runId||
    digest(progress.request.requirements)!==digest(declaration.requirements)||progress.request.sourceBoundary!==digest(delivery.result)||
    !progress.request.sources.some(s=>containsMaterialRange(s.access.range,i.sourceHold.range)))
    throw new TypeError("native_result_reception_method_changed");
  const record=await p.representations.command({kind:"read",ref:candidate.representation}) as RepresentationRecord|null;
  const preserved=await p.representations.command({kind:"read_judgment",id:assessment.judgmentIds[0]!}) as RepresentationJudgment|null;
  if(!record||!preserved||preserved.conclusion!=="supported"||!preserved.subjects.some(r=>digest(r)===digest(record.ref))||
    !record.declaredCoverage.some(r=>containsMaterialRange(r,i.sourceHold.range)))throw new TypeError("native_result_reception_preservation_unconfirmed");
  if(declaration.source.kind==="retained_material"){
    const original=await p.materials.command({kind:"resolve_reference",reference:declaration.source.reference,recipient}) as MaterialAccessDescription;
    if(!containsMaterialRange(i.sourceHold.range,original.hold.range)||!containsMaterialRange(original.hold.range,i.sourceHold.range))
      throw new TypeError("native_result_reception_original_range_changed");
  }
  let readBytes=0;
  async function read(access:MaterialAccess){
    const length=access.range.end-access.range.start;
    if(length>i.maximumReadBytes-readBytes)throw new TypeError("native_result_reception_read_limit");
    const chunks:Buffer[]=[];
    for(let offset=access.range.start;offset<access.range.end;){
      signal.throwIfAborted();
      const page=await p.materials.command({kind:"read",access,offset,length:Math.min(65536,access.range.end-offset)}) as MaterialReadPage;
      const bytes=Buffer.from(page.bytesBase64,"base64");
      if(page.start!==offset||page.end<=offset||page.end>access.range.end||bytes.length!==page.end-offset)throw new TypeError("native_result_reception_page_invalid");
      chunks.push(bytes);readBytes+=bytes.length;offset=page.end;
    }
    return new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks));
  }
  const originalBody=JSON.parse(prepared.wire.body),originalItems=originalBody.input??originalBody.messages;
  const history=await p.representations.command({kind:"read",ref:i.history.record.ref}) as RepresentationRecord|null;
  if(!history||digest(history)!==digest(i.history.record)||!containsMaterialRange(i.history.hold.range,history.body)||
    digest(i.history.hold.consumer)!==digest(recipient)||originalBody.previous_response_id||prepared.selectedInputId)
    throw new TypeError("native_result_reception_original_input_required");
  const historyText=await read({id:`${inputId}:original`,holdId:i.history.hold.id,recipient,range:history.body});
  if(digest(JSON.parse(historyText))!==digest(originalItems))throw new TypeError("native_result_reception_history_changed");
  if(declaration.source.kind!=="retained_material"&&await read({id:`${inputId}:original-body`,holdId:i.sourceHold.id,recipient:i.sourceHold.consumer,range:i.sourceHold.range})!==
    readModelResultContentTextSlot(delivery.result,declaration.slot))throw new TypeError("native_result_reception_original_body_changed");
  const text=await read({...candidate.access,range:record.body});
  const groupId=`${inputId}:history`,draft=presentHelarcNativeTaskResults(prepared,input,[{callId:i.callId,text,representation:record.ref,groupId}]);
  const body=JSON.parse(draft.wire.body),settings=nativeInputSettings(body);
  const candidateAccess=await p.materials.command({kind:"describe",holdId:candidate.access.holdId,recipient:candidate.access.recipient}) as MaterialAccessDescription;
  const originals=[i.history.hold,i.sourceHold,candidateAccess.hold],inputHolds:MaterialHold[]=[],selectionHolds:MaterialHold[]=[];
  const prefix=originalBody.messages?.[0]?.role==="system"?1:0;
  for(const publication of i.publications??[]){
    const published=validateHelarcNativeSourcePublication(publication,originalItems.slice(prefix),recipient,scope.target);
    const d=await p.materials.command({kind:"describe",holdId:published.access.holdId,recipient:published.access.recipient}) as MaterialAccessDescription;
    if(!containsMaterialRange(d.hold.range,published.access.range))throw new TypeError("native_result_source_access_changed");
    originals.push(d.hold);
  }
  const admissions:NonNullable<Parameters<typeof helarcNativeInputAcceptance>[0]["materialAdmissions"]>[number][]=[];
  for(const [index,original]of originals.entries()){
    const hold:MaterialHold={...original,id:`${inputId}:hold:${index}`,consumer:recipient,responsibility:"input",basis:inputId};
    inputHolds.push(hold);selectionHolds.push({...hold,id:`${selectionId}:hold:${index}`,responsibility:"selection",basis:selectionId});
    if(digest(original.consumer)!==digest(recipient))admissions.push({source:{id:`${inputId}:transfer:${index}`,holdId:original.id,recipient:original.consumer,range:original.range},hold,
      grant:{id:`${inputId}:grant:${index}`,instanceId:hold.instanceId,recipient,range:hold.range,revision:0,allowed:true,basis:scope.authorityBasis}});
  }
  if(!prepared.workingSources)throw new TypeError("native_result_reception_sources_missing");
  const workingSources=substituteHelarcNativeWorkingSources({original:originalItems.slice(prefix),selected:(body.input??body.messages).slice(prefix),sources:prepared.workingSources,
    changes:draft.resultPresentations.map(p=>({index:Number(p.position.split("/").at(-1))-prefix,representation:p.representation}))});
  const groups:NativeInputGroup[]=[];
  if(i.publications){
    if(prefix)groups.push(helarcNativeSourceInputGroup(activity.composition.composition.protocol.id,{id:`${inputId}:fixed`,representation:history.ref,
      sources:["original-task-contract"],items:originalItems.slice(0,prefix),holds:inputHolds.map(h=>h.id),deliveries:[]},groups));
    for(const source of workingSources.groups){
      const changed=draft.resultPresentations.some(value=>{const index=Number(value.position.split("/").at(-1))-prefix;
        return index>=source.occurrence.start&&index<source.occurrence.start+source.occurrence.count;});
      const original=i.publications.find(value=>value.group.id===source.id)?.published;
      if(!changed&&!original)throw new TypeError("native_result_source_publication_missing");
      groups.push(helarcNativeSourceInputGroup(activity.composition.composition.protocol.id,{id:source.id,
        representation:changed?record.ref:original!.representation.ref,sources:helarcNativeGroupSourceIds(source),
        items:(body.input??body.messages).slice(source.occurrence.start+prefix,source.occurrence.start+prefix+source.occurrence.count),
        holds:inputHolds.map(h=>h.id),deliveries:[]},groups));
    }
  }else groups.push(helarcNativeSourceInputGroup(activity.composition.composition.protocol.id,{id:groupId,representation:history.ref,
    sources:[prepared.sourceDigest],holds:inputHolds.map(h=>h.id),deliveries:[],items:body.input??body.messages},groups));
  // Retained history supports recovery; it is selected only when a group actually uses it.
  const refs=[...new Map([...groups.map(g=>g.representation),...draft.resultPresentations.map(p=>p.representation)]
    .map(ref=>[digest(ref),ref])).values()],judgmentId=`${inputId}:combination`;
  const manifest=bindNativeInputManifest({protocol:activity.composition.composition.protocol,
    scope:{id:scope.id,runId:scope.runId,recipientId:scope.recipient,purpose:activity.scope.purpose,compositionDigest:activity.composition.digest},
    target:{model:body.model,configuration:scope.target,connection:config.connectionBinding.id,disclosure:scope.authorityBasis},
    selection:{id:selectionId,revision:"1",boundary:prepared.sourceDigest,judgments:[judgmentId]},
    groups,
    settings,settingSources:Object.keys(settings).map(field=>({field,source:"original-task-contract",digest:digest(settings[field])}))});
  const realization=realizeHelarcNativeInput(manifest,draft.wire,i.continuity);
  const omitted=manifest.groups.slice(0,realization.prefixGroups).reduce((total,g)=>total+g.items.length,0),field=body.input?"input":"messages";
  const selected:HelarcRetainedNativeInput={kind:"helarc_native_input",manifest,...draft,workingSources,...realization,
    resultPresentations:draft.resultPresentations.map(value=>{
      const index=Number(value.position.split("/").at(-1));let offset=0;
      const group=groups.find(g=>{const end=offset+g.items.length,includes=index>=offset&&index<end;offset=end;return includes;});
      if(!group||index<omitted)throw new TypeError("native_result_presentation_already_in_predecessor");
      return {...value,groupId:group.id,position:`/${field}/${index-omitted}`};
    })};
  const measurement=i.measurement?await (()=>{
    if(!p.measurement)throw new TypeError("native_result_measurement_unavailable");
    return p.measurement.measure({activity,native:selected,inputId,selection:i.measurement},signal);
  })():null;
  const measurementUsage=measurement?.usage??{measurementCalls:0};
  const measurements:ContextRecipientInputCapacity["measurements"]=[{id:`${inputId}:bytes`,encodedInputId:inputId,targetRevision:scope.target,
    methodRevision:"native-body-bytes:1",dimension:"request_bytes",coverage:"complete",quantity:{kind:"exact",value:Buffer.byteLength(selected.wire.body)},
    basis:"Complete realized native input after continuity selection",uncovered:[]},
    ...measurement?.evidence??[]];
  const capacity=assessInputCapacity({encodedInputId:inputId,targetRevision:scope.target,purpose:scope.purpose,...i.capacity,evidence:measurements,refusals:measurement?.refusals});
  const capacityEvidence:ContextRecipientInputCapacity={inputId,measurements,limits:i.capacity.limits,assessment:capacity};
  if(!capacity.allowed)return {kind:"unavailable" as const,reason:"recipient_input_capacity_unavailable",capacity,readBytes,measurementUsage};
  const preparation:NativeInputPreparationValue={kind:"native_input_preparation",revision:"1",scope,inputId,exactInput:selected,
    projection:{owner:"helarc-native-input",revision:"1"},encoded:{mediaType:"application/json",body:selected.wire.body,bodyDigest:nativeInputBodyDigest(selected.wire.body)},capacity:capacityEvidence};
  const judgment:RepresentationJudgment={id:judgmentId,owner:scope.owner,runId:scope.runId,kind:"combination",subjects:refs,inputs:originals.map(h=>h.range),purpose:scope.purpose,target:scope.target,
    methodRevision:"declared-result-substitution:1",dependencies:{inputDigest:digest(selected),bodyDigest:preparation.encoded.bodyDigest,capacityDigest:digest(capacityEvidence),preservation:preserved.id,source:declaration.slot.resultDigest},
    evidenceSources:[{owner:preserved.owner,id:preserved.id,runId:scope.runId,revision:null}],coverage:record.declaredCoverage,conclusion:"supported",
    limitations:preserved.limitations,basis:"The original declared body assessment supports this substitution; the envelope and all other native input remain unchanged"};
  const proposal=helarcNativeInputAcceptance({id:`${inputId}:accepted`,scope,expectedSelectionId:null,expectedControlRevision:0,retainedSelectionId:null,
    selection:{id:selectionId,representations:refs,judgmentIds:[judgmentId],holds:selectionHolds},native:selected,judgment,inputId,activityId:activity.scope.activityId,
    stageRequestId:null,nativeConsumer:{protocol:manifest.protocol,compositionDigest:activity.composition.digest},inputHolds,materialAdmissions:admissions,releaseHolds:[]});
  signal.throwIfAborted();
  const readiness:ContextRecipientInputReadiness={kind:"recipient_prepared",scope,inputId,bodyDigest:preparation.encoded.bodyDigest,
    exactInputDigest:digest(selected),judgmentId:judgment.id,allowed:true,capacity:capacityEvidence,
    risks:capacity.decisions.filter(d=>d.conclusion!=="within").map(d=>`${d.limitId}:${d.reason}`),
    evidence:{owner:scope.owner,kind:"fact",id:judgment.id,revision:"1"}};
  return {kind:"ready" as const,selected,judgment,proposal,preparation,readiness,capacity,capacityEvidence,requirementsDigest:digest(declaration.requirements),readBytes,measurementUsage};
}
