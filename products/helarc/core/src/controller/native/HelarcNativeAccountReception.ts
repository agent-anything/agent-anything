import {modelInputValueDigest as digest,assessInputCapacity} from "@agent-anything/model-interaction/input";
import {containsMaterialRange,type MaterialHold,type MaterialAccess,type MaterialReadPage,type MaterialAccessDescription} from "@agent-anything/context/custody";
import type {RepresentationRecord,RepresentationJudgment} from "@agent-anything/context/representation";
import type {ContextUseScope} from "@agent-anything/context/selection";
import {nativeInputBodyDigest,type RepresentationMethodRequest,type NativeInputPreparationValue} from "@agent-anything/agent-runtime/context-representation";
import type {ProtocolModelActivity} from "@agent-anything/agent-runtime/model-access";
import {bindNativeInputManifest,nativeInputSettings,type NativeInputGroup} from "@agent-anything/provider-integrations/native";
import {OPENAI_RESPONSES} from "@agent-anything/model-interaction/protocol";
import type {HelarcNativeRunTask} from "./HelarcNativeTaskExecution.js";
import {validateHelarcNativeSourcePublication,type HelarcNativeSourcePublication} from "./HelarcNativeSourcePublications.js";
import {realizeHelarcNativeAccounts} from "./HelarcNativeAccountRealization.js";
import {validateHelarcNativeAccountMembers,type HelarcNativeAccountReceptionMember} from "./HelarcNativeAccountCombinations.js";
import {helarcNativeInputAcceptance,type HelarcRetainedNativeInput} from "./HelarcNativeInputAcceptance.js";
import type {HelarcNativeResultReceptionPorts} from "./HelarcNativeResultReception.js";
import {realizeHelarcNativeInput} from "./HelarcNativeInputRealization.js";
import {helarcNativeGroupSourceIds,helarcNativeSourceInputGroup} from "./HelarcNativeInputGroups.js";

export type {HelarcNativeAccountReceptionMember} from "./HelarcNativeAccountCombinations.js";
export function helarcNativeAccountReceptionRequirements(members:readonly HelarcNativeAccountReceptionMember[]){
  const requirements=new Map<string,RepresentationMethodRequest["requirements"][number]>();
  for(const member of members)for(const requirement of member.supply.request.requirements){
    const previous=requirements.get(requirement.id);
    if(previous&&digest(previous)!==digest(requirement))throw new TypeError("native_account_requirement_conflict");
    requirements.set(requirement.id,requirement);
  }
  return [...requirements.values()];
}
export interface HelarcNativeAccountReceptionInput {
  readonly activity:ProtocolModelActivity;
  readonly prepared:HelarcNativeRunTask;
  readonly scope:ContextUseScope;
  readonly inputId:string;readonly selectionId:string;readonly judgmentId:string;
  readonly members:readonly HelarcNativeAccountReceptionMember[];
  readonly publications:readonly HelarcNativeSourcePublication[];
  readonly history:{readonly record:RepresentationRecord;readonly hold:MaterialHold};
  readonly continuity:HelarcRetainedNativeInput["continuity"];
  readonly capacity:RepresentationMethodRequest["capacity"];
  readonly maximumReadBytes:number;
  readonly measurement?:import("./HelarcNativeInputMeasurement.js").HelarcNativeInputMeasurementSelection;
}
export interface HelarcNativeAccountReception {
  readonly kind:"proposed";
  readonly preparation:NativeInputPreparationValue;
  readonly selected:HelarcRetainedNativeInput;
  readonly representations:readonly RepresentationRecord["ref"][];
  readonly inputHolds:readonly MaterialHold[];
  readonly selectionHolds:readonly MaterialHold[];
  readonly admissions:NonNullable<Parameters<typeof helarcNativeInputAcceptance>[0]["materialAdmissions"]>;
  readonly preservationJudgmentIds:readonly string[];
  readonly readBytes:number;
  readonly measurementUsage?:import("./HelarcNativeInputMeasurement.js").HelarcNativeInputMeasurementResult["usage"];
}

/** Realizes accepted producer output. It does not certify the combination or adopt the result. */
export async function prepareHelarcNativeAccountReception(i:HelarcNativeAccountReceptionInput,p:HelarcNativeResultReceptionPorts,signal:AbortSignal):Promise<
  HelarcNativeAccountReception|{readonly kind:"unavailable";readonly reason:string}> {
  const {activity,prepared,scope,members}=i,configuration=activity.composition.composition.configuration;
  const recipient={runId:scope.runId,recipient:scope.recipient,purpose:scope.purpose};
  if(scope.runId!==activity.scope.runId||scope.recipient!==activity.scope.recipientId||scope.purpose!==activity.scope.purpose.id||
    scope.target!==`${configuration.configuration.id}:${configuration.configuration.revision}`||!prepared.workingSources||prepared.selectedInputId||
    !Number.isSafeInteger(i.maximumReadBytes)||i.maximumReadBytes<0||!members.length||members.length>128||
    new Set(members.map(m=>m.methodPathId)).size!==members.length||members.some(m=>digest(m.supply.request.nativeComposition)!==digest(activity.composition)||
    m.supply.scope.runId!==scope.runId))throw new TypeError("native_account_reception_binding_changed");
  helarcNativeAccountReceptionRequirements(members);
  signal.throwIfAborted();
  const originalBody=JSON.parse(prepared.wire.body),path=activity.composition.composition.protocol.id===OPENAI_RESPONSES.id?"input":"messages";
  if(originalBody.previous_response_id||originalBody.conversation)throw new TypeError("native_account_reception_explicit_input_required");
  if(prepared.resultPresentations?.length)throw new TypeError("native_account_reception_composed_body_evidence_required");
  const all=originalBody[path] as Record<string,unknown>[],prefix=path==="messages"&&all[0]?.role==="system"?1:0,items=all.slice(prefix);
  validateHelarcNativeAccountMembers({runId:scope.runId,items,sources:prepared.workingSources},members);
  const accepted:{member:HelarcNativeAccountReceptionMember;candidate:{access:MaterialAccess};record:RepresentationRecord;preserved:RepresentationJudgment}[]=[];
  for(const member of members){
    signal.throwIfAborted();const produced=await p.methods.result(member.methodPathId);
    if(produced.kind!=="ready")return {kind:"unavailable",reason:`method_${produced.kind}`};
    const progress=produced.progress,candidate=progress.candidates.find(c=>c.id===member.candidateId&&progress.resultIds.includes(c.id));
    const assessment=[...progress.assessments].reverse().find(a=>a.supported&&a.scope==="both"&&a.candidateIds.includes(member.candidateId));
    if(!candidate||!assessment||digest(progress.request)!==digest(member.supply.request))throw new TypeError("native_account_reception_producer_changed");
    const record=await p.representations.command({kind:"read",ref:candidate.representation}) as RepresentationRecord|null;
    const preserved=await p.representations.command({kind:"read_judgment",id:assessment.judgmentIds[0]!}) as RepresentationJudgment|null;
    if(!record||!preserved||preserved.conclusion!=="supported"||preserved.kind!=="semantic"||preserved.runId!==scope.runId||preserved.target!==scope.target||
      !preserved.subjects.some(r=>digest(r)===digest(record.ref))||member.supply.request.sources.filter(s=>s.role==="source").some(s=>
        !record.declaredCoverage.some(r=>containsMaterialRange(r,s.access.range))||!record.inputs.some(r=>containsMaterialRange(r.material,s.access.range))))
      throw new TypeError("native_account_reception_preservation_unconfirmed");
    accepted.push({member,candidate,record,preserved});
  }
  let readBytes=0;
  const read=async(access:MaterialAccess)=>{
    if(access.range.end-access.range.start>i.maximumReadBytes-readBytes)throw new TypeError("native_account_reception_read_limit");
    const chunks:Buffer[]=[];
    for(let offset=access.range.start;offset<access.range.end;){
      signal.throwIfAborted();const page=await p.materials.command({kind:"read",access,offset,length:Math.min(65536,access.range.end-offset)}) as MaterialReadPage;
      const bytes=Buffer.from(page.bytesBase64,"base64");
      if(page.start!==offset||page.end<=offset||page.end>access.range.end||bytes.length!==page.end-offset)throw new TypeError("native_account_reception_page_invalid");
      readBytes+=bytes.length;chunks.push(bytes);offset=page.end;
    }
    return new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks));
  };
  const history=await p.representations.command({kind:"read",ref:i.history.record.ref}) as RepresentationRecord|null;
  if(!history||digest(history)!==digest(i.history.record)||digest(i.history.hold.consumer)!==digest(recipient)||!containsMaterialRange(i.history.hold.range,history.body)||
    digest(JSON.parse(await read({id:`${i.inputId}:history`,holdId:i.history.hold.id,recipient,range:history.body})))!==digest(all))
    throw new TypeError("native_account_reception_history_changed");
  const originals:MaterialHold[]=[i.history.hold];
  for(const group of prepared.workingSources.groups){
    const matches=i.publications.filter(p=>p.group.id===group.id);
    if(matches.length!==1)throw new TypeError("native_account_reception_source_missing");
    const published=validateHelarcNativeSourcePublication(matches[0]!,items,recipient,scope.target);
    const description=await p.materials.command({kind:"describe",holdId:published.access.holdId,recipient}) as MaterialAccessDescription;
    originals.push(description.hold);
  }
  const accounts:Parameters<typeof realizeHelarcNativeAccounts>[0]["members"][number][]=[];
  for(const {member,candidate,record}of accepted){
    const description=await p.materials.command({kind:"describe",holdId:candidate.access.holdId,recipient:candidate.access.recipient}) as MaterialAccessDescription;
    originals.push(description.hold);
    accounts.push({scope:member.supply.scope,account:{text:await read({...candidate.access,range:record.body}),representation:record.ref}});
  }
  const realized=realizeHelarcNativeAccounts({runId:scope.runId,items,sources:prepared.workingSources,members:accounts});
  const mapPosition=(position:string)=>{
    const match=new RegExp(`^/${path}/(\\d+)$`).exec(position),index=match?Number(match[1]):NaN;
    if(!Number.isSafeInteger(index)||index<0||index>=all.length||realized.replacements.some(r=>index>=r.start+prefix&&index<r.end+prefix))
      throw new TypeError("native_account_reception_pending_content_changed");
    const removed=realized.replacements.filter(r=>index>=r.end+prefix).reduce((n,r)=>n+r.end-r.start-1,0);
    return `/${path}/${index-removed}`;
  };
  // Current outcomes and first delivery cannot be consumed as historical account evidence.
  for(const value of [...prepared.results,...prepared.delivery])mapPosition(value.position);
  const inputHolds:MaterialHold[]=[],selectionHolds:MaterialHold[]=[],admissions:HelarcNativeAccountReception["admissions"][number][]=[];
  for(const [index,original]of originals.entries()){
    const hold:MaterialHold={...original,id:`${i.inputId}:hold:${index}`,consumer:recipient,responsibility:"input",basis:i.inputId};
    inputHolds.push(hold);selectionHolds.push({...hold,id:`${i.selectionId}:hold:${index}`,responsibility:"selection",basis:i.selectionId});
    if(digest(original.consumer)!==digest(recipient))admissions.push({source:{id:`${hold.id}:admission`,holdId:original.id,recipient:original.consumer,range:original.range},hold,
      grant:{id:`${hold.id}:grant`,instanceId:hold.instanceId,recipient,range:hold.range,revision:0,allowed:true,basis:scope.authorityBasis}});
  }
  const selectedItems=[...all.slice(0,prefix),...realized.items],body={...originalBody,[path]:selectedItems},settings=nativeInputSettings(body);
  const parts=[...(prefix?[{id:`${i.inputId}:fixed`,items:all.slice(0,prefix),representation:history.ref}]:[]),
    ...realized.sources.groups.map(g=>({id:g.id,items:realized.items.slice(g.occurrence.start,g.occurrence.start+g.occurrence.count),
      representation:realized.replacements.find(r=>r.groupId===g.id)?.representation??i.publications.find(p=>p.group.id===g.id)!.published!.representation.ref}))];
  const representations=[...new Map(parts.map(p=>[digest(p.representation),p.representation])).values()];
  const groups:NativeInputGroup[]=[];
  for(const part of parts){
    const source=realized.sources.groups.find(g=>g.id===part.id);
    groups.push(helarcNativeSourceInputGroup(activity.composition.composition.protocol.id,{...part,
      sources:source?helarcNativeGroupSourceIds(source):["original-task-contract"],
      holds:inputHolds.map(h=>h.id),deliveries:[]},groups));
  }
  const manifest=bindNativeInputManifest({protocol:activity.composition.composition.protocol,
    scope:{id:scope.id,runId:scope.runId,recipientId:scope.recipient,purpose:activity.scope.purpose,compositionDigest:activity.composition.digest},
    target:{model:body.model,configuration:scope.target,connection:configuration.connectionBinding.id,disclosure:scope.authorityBasis},
    selection:{id:i.selectionId,revision:"1",boundary:prepared.sourceDigest,judgments:[i.judgmentId]},settings,
    settingSources:Object.keys(settings).map(field=>({field,source:"original-task-contract",digest:digest(settings[field])})),
    groups});
  const presentations=(prepared.resultPresentations??[]).map(p=>{
    const position=mapPosition(p.position),index=Number(position.split("/").at(-1));let offset=0;
    const group=manifest.groups.find(g=>{const end=offset+g.items.length,contains=index>=offset&&index<end;offset=end;return contains;});
    if(!group)throw new TypeError("native_account_reception_result_position_invalid");return {...p,position,groupId:group.id};
  });
  const realization=realizeHelarcNativeInput(manifest,{body:JSON.stringify(body),digest:digest(body)},i.continuity);
  const omitted=manifest.groups.slice(0,realization.prefixGroups).reduce((count,g)=>count+g.items.length,0);
  const selected:HelarcRetainedNativeInput={kind:"helarc_native_input",manifest,...realization,
    workingSources:realized.sources,...(presentations.length?{resultPresentations:presentations.map(p=>{
      const index=Number(p.position.split("/").at(-1))-omitted;
      if(index<0)throw new TypeError("native_result_presentation_already_in_predecessor");
      return {...p,position:`/${path}/${index}`};
    })}:{})};
  const measurement=i.measurement?await (()=>{
    if(!p.measurement)throw new TypeError("native_account_measurement_unavailable");
    return p.measurement.measure({activity:i.activity,native:selected,inputId:i.inputId,selection:i.measurement},signal);
  })():null;
  const measurements:NativeInputPreparationValue["capacity"]["measurements"]=[{id:`${i.inputId}:bytes`,encodedInputId:i.inputId,targetRevision:scope.target,
    methodRevision:"native-body-bytes:1",dimension:"request_bytes",coverage:"complete",quantity:{kind:"exact",value:Buffer.byteLength(selected.wire.body)},
    basis:"Complete proposed native task input, including unchanged fixed content",uncovered:[]},
    ...measurement?.evidence??[]];
  const capacity={inputId:i.inputId,measurements,limits:i.capacity.limits,assessment:assessInputCapacity({encodedInputId:i.inputId,targetRevision:scope.target,
    purpose:scope.purpose,...i.capacity,evidence:measurements,refusals:measurement?.refusals})};
  return {kind:"proposed",selected,representations,inputHolds,selectionHolds,admissions,preservationJudgmentIds:accepted.map(a=>a.preserved.id),readBytes,
    measurementUsage:measurement?.usage??{measurementCalls:0},
    preparation:{kind:"native_input_preparation",revision:"1",scope,inputId:i.inputId,exactInput:selected,
      projection:{owner:"helarc-native-input",revision:"1"},encoded:{mediaType:"application/json",body:selected.wire.body,bodyDigest:nativeInputBodyDigest(selected.wire.body)},capacity}};
}

export function helarcNativeAccountReceptionAcceptance(input:{readonly id:string;readonly reception:HelarcNativeAccountReception;
  readonly judgment:RepresentationJudgment;readonly expectedSelectionId:string|null;readonly expectedControlRevision:number;readonly activityId:string}) {
  const {reception:r,judgment}=input,{preparation:p,selected}=r;
  if(!p.capacity.assessment.allowed||judgment.kind!=="combination"||judgment.conclusion!=="supported"||judgment.owner!==p.scope.owner||judgment.runId!==p.scope.runId||
    judgment.purpose!==p.scope.purpose||judgment.target!==p.scope.target||digest(judgment.subjects)!==digest(r.representations)||
    digest(selected.manifest.selection.judgments)!==digest([judgment.id])||judgment.dependencies.inputDigest!==digest(selected)||
    judgment.dependencies.bodyDigest!==p.encoded.bodyDigest||judgment.dependencies.capacityDigest!==digest(p.capacity))
    throw new TypeError("native_account_reception_combination_unconfirmed");
  return helarcNativeInputAcceptance({id:input.id,scope:p.scope,expectedSelectionId:input.expectedSelectionId,expectedControlRevision:input.expectedControlRevision,
    retainedSelectionId:null,selection:{id:selected.manifest.selection.id,representations:r.representations,judgmentIds:[judgment.id],holds:r.selectionHolds},
    native:selected,judgment,inputId:p.inputId,activityId:input.activityId,stageRequestId:null,nativeConsumer:{protocol:selected.manifest.protocol,compositionDigest:selected.manifest.scope.compositionDigest},
    inputHolds:r.inputHolds,materialAdmissions:r.admissions,releaseHolds:[]});
}
