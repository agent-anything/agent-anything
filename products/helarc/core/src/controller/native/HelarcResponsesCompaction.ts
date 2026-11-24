import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {snapshotModelJsonValue} from "@agent-anything/model-interaction";
import {OPENAI_RESPONSES} from "@agent-anything/model-interaction/protocol";
import {assessTransformationQuality,type TransformationDependencies,type TransformationDuty,type TransformationFinding,type TransformationQuality} from "@agent-anything/context/representation";
import type {ProtocolRepresentationMethodRequest,RepresentationMethodQuotation} from "@agent-anything/agent-runtime/context-representation";
import {helarcResponsesInRequestFindings,type HelarcResponsesInRequestEligibility} from "./HelarcResponsesInRequestEligibility.js";
import {assertNativeInputManifest,nativeInputGroupDigest,nativeInputCoverage,prepareResponsesCompact,RESPONSES_COMPACT_METHOD,
  RESPONSES_IN_REQUEST_COMPACTION,responsesCompactionOccurrences,validateResponsesCompactionOptions,restoreResponsesCompactedWindow,
  type NativeInputManifest,type NativeInputGroup,type ResponsesCompactPreparation,type ResponsesCompactedWindow} from "@agent-anything/provider-integrations/native";

const copy=<T>(value:T):T=>snapshotModelJsonValue(value,"Responses transformation") as unknown as T;
export interface HelarcResponsesCompactSource {
  readonly manifest:NativeInputManifest;
  readonly groups:readonly {readonly id:string;readonly digest:string;readonly deliveredBasis:string}[];
  readonly sourceDigest:string;
  readonly dependencies:TransformationDependencies;
  readonly duties:readonly TransformationDuty[];
  readonly methodRequest:ResponsesCompactPreparation;
  readonly ancestry:readonly string[];
  readonly assessmentModelCalls?:number;
  readonly assessmentInput?:{readonly capacity:import("./HelarcNativeStructuredInput.js").HelarcNativeStructuredInputPolicy;readonly maximumMeasurements:number};
  readonly dutyBasis?:readonly {readonly dutyId:string;readonly description:string;readonly sourceGroups:readonly string[]}[];
}
/** The owner freezes a lawful historical prefix. First delivery and a running exchange are not historical receipts. */
export function bindHelarcResponsesCompactSource(input:{readonly manifest:NativeInputManifest;readonly throughGroups:number;
  readonly receipts:readonly {readonly groupId:string;readonly basis:string}[];readonly dependencies:TransformationDependencies;
  readonly duties:readonly TransformationDuty[];readonly purpose:{readonly id:string;readonly revision:string};readonly ancestry:readonly string[];
  readonly dutyBasis?:HelarcResponsesCompactSource["dutyBasis"];readonly assessmentModelCalls?:number;readonly assessmentInput?:HelarcResponsesCompactSource["assessmentInput"]}):HelarcResponsesCompactSource {
  assertNativeInputManifest(input.manifest);
  if(input.manifest.protocol.id!==OPENAI_RESPONSES.id||!Number.isSafeInteger(input.throughGroups)||input.throughGroups<1||input.throughGroups>input.manifest.groups.length)
    throw new TypeError("compact_source_boundary_invalid");
  const groups=input.manifest.groups.slice(0,input.throughGroups),coverage=groups.map(g=>{
    const receipt=input.receipts.find(r=>r.groupId===g.id);if(!receipt?.basis)throw new TypeError("compact_history_delivery_basis_missing");
    if(g.replay!=="local"||g.requires.some(required=>!groups.some(source=>source.id===required.id&&nativeInputGroupDigest(source)===required.digest)))
      throw new TypeError("compact_source_dependency_unavailable");
    return {id:g.id,digest:nativeInputGroupDigest(g),deliveredBasis:receipt.basis};
  });
  const sourceDigest=digest(coverage),dependencies=input.dependencies;
  if(dependencies.source!==sourceDigest||dependencies.target!==input.manifest.target.configuration||dependencies.authority!==input.manifest.target.disclosure||
    dependencies.recipient!==input.manifest.scope.id||dependencies.method!==`${RESPONSES_COMPACT_METHOD.id}:${RESPONSES_COMPACT_METHOD.revision}`||
    dependencies.requirements!==digest(input.duties))throw new TypeError("compact_source_dependencies_invalid");
  if(input.duties.some(d=>d.requirement!=="semantic"))throw new TypeError("compact_exact_duty_requires_excluded_source");
  if(input.dutyBasis&&(input.dutyBasis.length!==input.duties.length||new Set(input.dutyBasis.map(b=>b.dutyId)).size!==input.duties.length||
    input.dutyBasis.some(b=>!input.duties.some(d=>d.id===b.dutyId)||!b.description.trim()||!b.sourceGroups.length||
      b.sourceGroups.some(id=>!groups.some(g=>g.id===id)))))throw new TypeError("compact_duty_basis_invalid");
  const methodRequest=prepareResponsesCompact({model:input.manifest.target.model,input:groups.flatMap(g=>g.items),purpose:input.purpose});
  if(input.assessmentModelCalls!==undefined&&(!Number.isSafeInteger(input.assessmentModelCalls)||input.assessmentModelCalls<1||input.assessmentModelCalls>8))
    throw new TypeError("compact_assessment_plan_invalid");
  if(input.assessmentInput&&(!Number.isSafeInteger(input.assessmentInput.maximumMeasurements)||input.assessmentInput.maximumMeasurements<0||
    (input.assessmentModelCalls!==3&&input.assessmentModelCalls!==4)||input.assessmentInput.maximumMeasurements>input.assessmentModelCalls||input.assessmentInput.capacity.policy.purpose!=="context_compaction_assessment"))
    throw new TypeError("compact_assessment_input_plan_invalid");
  return copy({manifest:input.manifest,groups:coverage,sourceDigest,dependencies,duties:input.duties,methodRequest,ancestry:input.ancestry,
    ...(input.assessmentInput?{assessmentInput:input.assessmentInput}:{}),
    ...(input.assessmentModelCalls!==undefined?{assessmentModelCalls:input.assessmentModelCalls}:{}),
    ...(input.dutyBasis?{dutyBasis:input.dutyBasis}:{})});
}
export function assertHelarcResponsesCompactSource(source:HelarcResponsesCompactSource):void {
  const rebuilt=bindHelarcResponsesCompactSource({manifest:source.manifest,throughGroups:source.groups.length,
    receipts:source.groups.map(g=>({groupId:g.id,basis:g.deliveredBasis})),dependencies:source.dependencies,duties:source.duties,
    purpose:source.methodRequest.purpose,ancestry:source.ancestry,...(source.dutyBasis?{dutyBasis:source.dutyBasis}:{}),
    ...(source.assessmentInput?{assessmentInput:source.assessmentInput}:{}),
    ...(source.assessmentModelCalls!==undefined?{assessmentModelCalls:source.assessmentModelCalls}:{})});
  if(digest({...rebuilt,methodRequest:{...rebuilt.methodRequest,encoded:source.methodRequest.encoded}})!==digest(source)||
    digest(JSON.parse(source.methodRequest.encoded))!==source.methodRequest.digest)
    throw new TypeError("responses_compact_original_source_changed");
}
export function quoteHelarcResponsesCompact(input:{readonly source:HelarcResponsesCompactSource;readonly bounds:ProtocolRepresentationMethodRequest["bounds"];
  readonly probeRequired:boolean;readonly materialAccesses?:ProtocolRepresentationMethodRequest["materialAccesses"]}):{readonly request:ProtocolRepresentationMethodRequest;readonly quotation:RepresentationMethodQuotation}{
  const {source,bounds}=input;
  const request:ProtocolRepresentationMethodRequest={method:"protocol",methodRevision:source.dependencies.method,
    recipient:{runId:source.manifest.scope.runId,recipient:"context-representation",purpose:source.methodRequest.purpose.id},
    targetRevision:source.dependencies.target,sourceBoundary:source.sourceDigest,bounds,materialAccesses:input.materialAccesses??[],
    execution:{owner:RESPONSES_COMPACT_METHOD.id,protocol:OPENAI_RESPONSES,request:source}};
  const readBytes=Buffer.byteLength(source.methodRequest.encoded),modelCalls=1+(input.probeRequired?(source.assessmentModelCalls??1):0);
  const cost=(minimum:number,maximum:number|null,basis:string)=>({minimum,maximum,basis});
  const value:Omit<RepresentationMethodQuotation,"id">={owner:"context-representation",revision:"1",requestDigest:digest(request),
    targetRevision:request.targetRevision,boundary:request.sourceBoundary,phases:[
      {kind:"read",condition:"required",basis:"Frozen lawful historical native groups and original disclosure"},
      {kind:"input",condition:"required",basis:"Actual compact request must fit; no tools or task instructions injected"},
      {kind:"generate",condition:"required",basis:"One original standalone compact operation"},
      {kind:"check",condition:"required",basis:input.probeRequired?"Independent bounded continuation probe and scoped assurance":"Scoped quality findings; no ciphertext semantic inspection"},
      {kind:"retain",condition:"required",basis:"Whole compacted window, original source, checks and independent holds"}],
    minimum:{stages:5,attempts:5,modelCalls:modelCalls===5?4:modelCalls,readBytes},costs:{readBytes:cost(readBytes,null,"Exact frozen compact input plus unknown result/check reads"),
      storedBytes:cost(0,null,"Whole output and recovery evidence; output size unknown"),modelCalls:modelCalls===5?
        cost(4,5,"One optional pre-authorized ownership correction; no repeat compact or candidate probe"):
        cost(modelCalls,modelCalls,"No automatic retry; revised work needs new acceptance"),
      externalMeasurements:source.assessmentInput?cost(0,source.assessmentInput.maximumMeasurements,"Bounded independent assessment input counts; recipient measurement remains separate"):
        cost(0,null,"Complete recipient input measurement remains separate"),elapsedMs:cost(0,null,"No latency observation supplied"),
      billedTokens:cost(0,null,"Native usage is observed independently of adoption")},limits:bounds,
    gaps:[...(readBytes>bounds.readBytes?["known_read_work_exceeds_limit"]:[]),...(modelCalls>bounds.modelCalls?["known_model_work_exceeds_limit"]:[])],
    unknowns:["candidate_size","semantic_retention","complete_successor_fit","elapsed_time","billed_tokens"],
    handoff:["recipient_input_organization","recipient_combination_judgment","shared_adoption","protection_transfer"]};
  return copy({request,quotation:{id:`method-quotation:${digest(value)}`,...value}});
}

export interface HelarcResponsesCompactAssessment {
  readonly id:string;readonly candidateDigest:string;readonly sourceDigest:string;
  readonly dependencies:TransformationDependencies;readonly findings:readonly TransformationFinding[];readonly quality:TransformationQuality;
}
export function assessHelarcResponsesCompact(input:{readonly source:HelarcResponsesCompactSource;readonly candidate:ResponsesCompactedWindow;
  readonly findings:readonly TransformationFinding[]}):HelarcResponsesCompactAssessment {
  const candidate=restoreResponsesCompactedWindow(input.candidate.raw);
  if(digest(candidate)!==digest(input.candidate))throw new TypeError("compact_candidate_changed");
  const quality=assessTransformationQuality({subject:candidate.digest,dependencies:input.source.dependencies,duties:input.source.duties,findings:input.findings});
  const value={candidateDigest:candidate.digest,sourceDigest:input.source.sourceDigest,dependencies:input.source.dependencies,findings:input.findings,quality};
  return copy({id:`compact-assessment:${digest(value)}`,...value});
}
/** Candidate + finite suffix only. No compact resource ID can enter a continuation. */
export function helarcResponsesCompactedGroups(input:{readonly source:HelarcResponsesCompactSource;readonly candidate:ResponsesCompactedWindow;
  readonly assessment:HelarcResponsesCompactAssessment;readonly current:NativeInputManifest;readonly dependencies:TransformationDependencies;
  readonly group:{readonly id:string;readonly representation:NativeInputGroup["representation"];readonly holds:readonly string[];readonly observation:string}}):readonly NativeInputGroup[]{
  const {source,current,candidate,assessment}=input;assertNativeInputManifest(current);
  if(digest(source.manifest.scope)!==digest(current.scope)||digest(source.manifest.target)!==digest(current.target)||
    digest(input.dependencies)!==digest(source.dependencies)||assessment.sourceDigest!==source.sourceDigest||
    assessment.candidateDigest!==candidate.digest||digest(assessment)!==digest(assessHelarcResponsesCompact({source,candidate,findings:assessment.findings}))||!assessment.quality.allowed)
    throw new TypeError("compact_candidate_not_applicable");
  if(source.groups.some((g,i)=>g.id!==current.groups[i]?.id||g.digest!==nativeInputGroupDigest(current.groups[i]!)))throw new TypeError("compact_source_prefix_changed");
  const suffix=current.groups.slice(source.groups.length),removed=new Set(source.groups.map(g=>g.id));
  if(suffix.some(g=>g.requires.some(r=>removed.has(r.id))))throw new TypeError("compact_suffix_requires_original_prefix");
  if(!input.group.observation||!input.group.holds.length)throw new TypeError("compact_candidate_custody_missing");
  return copy([{id:input.group.id,representation:input.group.representation,sources:[input.group.observation],holds:input.group.holds,
    deliveries:[],requires:[],items:candidate.items,replay:"local"},...suffix]);
}

export type {HelarcResponsesCompactionAgreement} from "./HelarcResponsesInRequestEvidence.js";
import type {HelarcResponsesCompactionAgreement} from "./HelarcResponsesInRequestEvidence.js";

export function bindHelarcResponsesCompactionAgreement(input:{readonly manifest:NativeInputManifest;readonly body:Record<string,unknown>;
  readonly dependencies:TransformationDependencies;readonly duties:readonly TransformationDuty[];readonly findings:readonly TransformationFinding[];
  readonly threshold:HelarcResponsesCompactionAgreement["threshold"];readonly retentionBasis:string;readonly recoveryBasis:string;
  readonly useEvidence?:HelarcResponsesInRequestEligibility}):HelarcResponsesCompactionAgreement {
  assertNativeInputManifest(input.manifest);
  const {threshold:t,dependencies:d}=input,requestDigest=digest(input.body);
  const options=validateResponsesCompactionOptions(input.body.context_management as Parameters<typeof validateResponsesCompactionOptions>[0]);
  if(input.manifest.protocol.id!==OPENAI_RESPONSES.id||input.body.model!==input.manifest.target.model||
    options[0].compact_threshold!==t.tokens||!t.basis||!t.measurement.id||t.measurement.requestDigest!==requestDigest||
    !["complete","partial","unknown"].includes(t.measurement.coverage)||
    t.measurement.tokens!==null&&(!Number.isSafeInteger(t.measurement.tokens)||t.measurement.tokens<0)||
    t.measurement.coverage==="complete"&&(t.measurement.tokens===null||t.measurement.unknowns.length>0)||
    t.measurement.coverage!=="complete"&&(!t.measurement.unknowns.length||!t.measurement.acceptedUncertainty)||
    !Number.isSafeInteger(t.window)||!Number.isSafeInteger(t.headroom)||
    t.headroom<0||t.tokens>t.window-t.headroom||d.source!==input.manifest.digest||d.requirements!==digest(input.duties)||
    d.target!==input.manifest.target.configuration||d.authority!==input.manifest.target.disclosure||d.recipient!==input.manifest.scope.id||
    d.method!==`${RESPONSES_IN_REQUEST_COMPACTION.id}:${RESPONSES_IN_REQUEST_COMPACTION.revision}`||!input.retentionBasis||!input.recoveryBasis)
    throw new TypeError("responses_compaction_agreement_basis_invalid");
  if(input.duties.some(d=>d.requirement!=="semantic"))throw new TypeError("responses_compaction_cannot_pin_required_content");
  if(input.useEvidence){
    const {id,...e}=input.useEvidence;
    if(id!==`in-request-eligibility:${digest(e)}`||!e.allowed||!e.use.enabled||!e.use.policy||
      digest(e.duties)!==digest(input.duties)||digest(input.findings)!==digest(helarcResponsesInRequestFindings(input.useEvidence,requestDigest,d)))
      throw new TypeError("responses_compaction_use_evidence_changed");
  }
  const quality=assessTransformationQuality({subject:requestDigest,dependencies:d,duties:input.duties,findings:input.findings});
  if(!quality.allowed)throw new TypeError("responses_compaction_assurance_insufficient");
  const value={requestDigest,inputDigest:input.manifest.digest,dependencies:d,method:RESPONSES_IN_REQUEST_COMPACTION,
    potentialScope:{groups:nativeInputCoverage(input.manifest),generatedOutput:true as const,cutoff:"unknown" as const},threshold:t,
    duties:input.duties,findings:input.findings,quality,retentionBasis:input.retentionBasis,recoveryBasis:input.recoveryBasis,
    ...(input.useEvidence?{useEvidence:input.useEvidence}:{})};
  return copy({id:`responses-compaction-agreement:${digest(value)}`,...value});
}
export function validateHelarcResponsesCompactionAgreement(agreement:HelarcResponsesCompactionAgreement,manifest:NativeInputManifest,body:Record<string,unknown>):void{
  const rebuilt=bindHelarcResponsesCompactionAgreement({manifest,body,dependencies:agreement.dependencies,duties:agreement.duties,findings:agreement.findings,
    threshold:agreement.threshold,retentionBasis:agreement.retentionBasis,recoveryBasis:agreement.recoveryBasis,
    ...(agreement.useEvidence?{useEvidence:agreement.useEvidence}:{})});
  if(digest(rebuilt)!==digest(agreement))throw new TypeError("responses_compaction_agreement_changed");
}
export function inspectHelarcResponsesCompaction(input:{readonly response:Record<string,unknown>;readonly agreement:HelarcResponsesCompactionAgreement|null;
  readonly acceptedAgreementId:string|null;readonly originalRequestDigest:string}):{
    readonly allowed:boolean;readonly violation:string|null;readonly agreementId:string|null;
    readonly occurrences:ReturnType<typeof responsesCompactionOccurrences>;readonly responseId:string;
  }{
  const occurrences=responsesCompactionOccurrences(input.response),a=input.agreement;
  const {id:agreementId,...agreementValue}=a??{id:null};
  const valid=Boolean(a&&agreementId===`responses-compaction-agreement:${digest(agreementValue)}`&&input.acceptedAgreementId===a.id&&
    a.requestDigest===input.originalRequestDigest&&a.quality.allowed&&digest(a.quality)===digest(assessTransformationQuality({
      subject:a.requestDigest,dependencies:a.dependencies,duties:a.duties,findings:a.findings})));
  return copy({allowed:!occurrences.length||valid,violation:occurrences.length&&!valid?"unaccepted_in_request_compaction":null,
    agreementId:a?.id??null,occurrences,responseId:String(input.response.id)});
}
