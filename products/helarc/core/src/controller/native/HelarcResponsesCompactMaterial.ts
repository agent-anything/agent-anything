import {createHash} from "node:crypto";
import {containsMaterialRange,type MaterialCustodyPort,type MaterialCustodyState,type MaterialHold,type MaterialGrant,type MaterialRecipient,type MaterialRange,type MaterialAccessAdmission} from "@agent-anything/context/custody";
import type {RepresentationCatalogPort,RepresentationRecord,RepresentationJudgment} from "@agent-anything/context/representation";
import type {SharedAcceptancePort} from "@agent-anything/agent-runtime/activity";
import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {RESPONSES_COMPACT_METHOD,restoreResponsesCompactedWindow,type ResponsesCompactedWindow} from "@agent-anything/provider-integrations/native";
import type {HelarcResponsesCompactSource,HelarcResponsesCompactAssessment} from "./HelarcResponsesCompaction.js";

/** Original source/checkpoint/detail holds survive publication independently of the candidate's later use. */
export async function retainHelarcResponsesCompactMaterial(input:{readonly materials:MaterialCustodyPort;readonly representations:RepresentationCatalogPort;
  readonly acceptance:SharedAcceptancePort;readonly source:HelarcResponsesCompactSource;readonly candidate:ResponsesCompactedWindow;
  readonly owner:string;readonly purpose:string;readonly activityId:string;readonly observationId:string;readonly occurredAt:string;
  readonly confirmation:{readonly rawRevision:string;readonly acceptanceId:string;readonly acceptanceRevision:string};
  readonly sources:readonly {readonly record:RepresentationRecord;readonly holds:readonly MaterialHold[]}[];
  readonly sourceAdmissions?:readonly MaterialAccessAdmission[];
}):Promise<{readonly record:RepresentationRecord;readonly hold:MaterialHold;readonly grant:MaterialGrant;readonly instanceId:string}> {
  const {candidate,source}=input;
  if(digest(restoreResponsesCompactedWindow(candidate.raw))!==digest(candidate)||!input.observationId||
    source.groups.length!==input.sources.length||source.groups.some((g,i)=>digest(source.manifest.groups[i].representation)!==digest(input.sources[i].record.ref)))
    throw new TypeError("compact_material_source_mismatch");
  const runId=source.manifest.scope.runId,reader:MaterialRecipient={runId,recipient:input.owner,purpose:input.purpose};
  const id=`compact-material:${digest({source:source.sourceDigest,candidate:candidate.digest,observation:input.observationId,reader})}`;
  const originalHolds=input.sources.flatMap(s=>s.holds),admissions=input.sourceAdmissions??[];
  for(const admission of admissions){
    const original=originalHolds.find(h=>h.id===admission.source.holdId),h=admission.hold,g=admission.grant;
    if(!original||digest(admission.source.recipient)!==digest(original.consumer)||!containsMaterialRange(original.range,admission.source.range)||
      h.instanceId!==original.instanceId||!containsMaterialRange(admission.source.range,h.range)||digest(h.consumer)!==digest(reader)||
      g.instanceId!==h.instanceId||digest(g.recipient)!==digest(reader)||!containsMaterialRange(g.range,h.range)||!g.allowed||
      g.basis!==source.dependencies.authority)throw new TypeError("compact_material_source_admission_invalid");
  }
  const inherited=[...originalHolds.filter(h=>digest(h.consumer)===digest(reader)),...admissions.map(a=>a.hold)];
  const details=[...new Map(input.sources.flatMap(s=>[s.record.body,...s.record.details]).map(r=>[digest(r),r])).values()];
  if(details.some(range=>!inherited.some(h=>containsMaterialRange(h.range,range))))throw new TypeError("compact_material_source_protection_missing");
  const bytes=Buffer.from(JSON.stringify(candidate.items)),range:MaterialRange={materialId:id,version:"1",coordinate:"bytes",start:0,end:bytes.length};
  const intent={id:`${id}:capture`,instanceId:id,activityId:input.activityId,owner:input.owner,maximumBytes:bytes.length,
    version:{ref:{materialId:id,version:"1"},origin:{runId,owner:input.owner,recordId:input.observationId,revision:"1",occurredAt:input.occurredAt},
      label:"Complete Responses compacted window",format:"json" as const,mediaType:"application/json",bytes:bytes.length,
      digest:`sha256:${createHash("sha256").update(bytes).digest("hex")}`,capture:"complete" as const,limitations:["Opaque content is not directly semantically inspectable"]}};
  let state=await input.materials.command({kind:"state",intentId:intent.id}) as MaterialCustodyState|null;
  if(!state)state=await input.materials.command({kind:"begin",intent}) as MaterialCustodyState;
  if(digest(state.intent)!==digest(intent))throw new TypeError("compact_material_original_changed");
  if(state.state==="staging"){
    for(let offset=state.bytes;offset<bytes.length;offset+=65536)await input.materials.command({kind:"append",id:`${id}:chunk:${offset}`,intentId:intent.id,offset,bytesBase64:bytes.subarray(offset,offset+65536).toString("base64")});
    await input.materials.command({kind:"complete",intentId:intent.id});
  }
  const hold:MaterialHold={id:`${id}:checkpoint`,instanceId:id,consumer:reader,responsibility:"checkpoint",range,basis:input.observationId,releaseCondition:"Original method and independently accepted consumers settled"};
  const grant:MaterialGrant={id:`${id}:grant`,instanceId:id,recipient:reader,range,revision:0,allowed:true,basis:source.dependencies.authority};
  const losses=new Map(input.sources.flatMap(s=>s.record.losses).map(loss=>[loss.id,loss]));
  for(const s of input.sources)losses.set(`${id}:unknown:${digest(s.record.ref)}`,{id:`${id}:unknown:${digest(s.record.ref)}`,source:s.record.body,
    kind:"unknown",description:"Native opaque retention cannot be inspected directly; scoped quality findings are separate",basis:input.observationId});
  const record:RepresentationRecord={ref:{id,revision:"1"},runId,owner:input.owner,purpose:input.purpose,target:source.dependencies.target,form:"native",body:range,
    inputs:input.sources.map(s=>({role:"source",material:s.record.body,representation:s.record.ref})),declaredCoverage:input.sources.map(s=>s.record.body),
    details,holds:[hold.id,...new Set(inherited.map(h=>h.id))],requirements:source.duties.map(d=>({id:d.id,revision:d.revision,basis:source.dependencies.requirements,
      description:source.dutyBasis?.find(b=>b.dutyId===d.id)?.description??d.requirement})),
    losses:[...losses.values()],restorations:[],method:{...RESPONSES_COMPACT_METHOD,activityId:input.activityId,rawResultId:input.observationId,
      acceptanceId:input.confirmation.acceptanceId,protocolConfirmation:{rawRevision:input.confirmation.rawRevision,acceptanceRevision:input.confirmation.acceptanceRevision}}};
  const receipt=await input.acceptance.accept({id:`${id}:publish`,scope:runId,actor:input.owner,parts:[
    ...admissions.map(proposal=>({owner:"material_custody",kind:"admit_access",proposal})),
    {owner:"material_custody",kind:"publish",proposal:{intentId:intent.id,holds:[hold],grants:[grant]}},
    {owner:"representation",kind:"record",proposal:record}]});
  if(receipt.outcome!=="accepted")throw new TypeError(`compact_material_publish_rejected:${receipt.rejection?.code}`);
  return {record,hold,grant,instanceId:id};
}

/** An assessment is reusable evidence, not selection, consumption or a second model request. */
export async function retainHelarcResponsesCompactAssessment(input:{readonly catalog:RepresentationCatalogPort;readonly assessment:HelarcResponsesCompactAssessment;
  readonly record:RepresentationRecord;readonly observationId:string;readonly assessmentResultId?:string}):Promise<RepresentationJudgment>{
  const {assessment:a,record:r}=input;
  if(a.dependencies.target!==r.target||a.sourceDigest!==a.dependencies.source)throw new TypeError("compact_assessment_material_mismatch");
  const judgment:RepresentationJudgment={id:a.id,runId:r.runId,owner:r.owner,kind:"policy",subjects:[r.ref],inputs:r.inputs.map(i=>i.material),
    purpose:r.purpose,target:r.target,methodRevision:a.dependencies.method,dependencies:{...a.dependencies,candidate:a.candidateDigest,findings:digest(a.findings)},
    evidenceSources:[{owner:"protocol-execution",id:input.observationId,revision:"1",runId:r.runId},
      ...(input.assessmentResultId?[{owner:"activity",id:input.assessmentResultId,revision:null,runId:r.runId}]:[])],
    coverage:r.declaredCoverage,conclusion:a.quality.allowed?"supported":a.quality.duties.some(d=>d.conclusion==="unsupported")?"unsupported":"unknown",
    limitations:[...a.quality.limitations,"Not a direct semantic inspection of opaque content"],basis:input.assessmentResultId?
      "Scoped preservation findings from the accepted assessment of this candidate and source.":
      JSON.stringify({duties:a.quality.duties,findings:a.findings})};
  return await input.catalog.command({kind:"judge",judgment}) as RepresentationJudgment;
}
