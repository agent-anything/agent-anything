import type {MaterialAccess,MaterialRange,MaterialRecipient} from "@agent-anything/context/custody";
import type {RepresentationRef,RepresentationLoss} from "@agent-anything/context/representation";
import type {ProviderRequest} from "@agent-anything/model-interaction";
import type {InputCapacityLimit,InputCapacityPolicy,CapacityReservation} from "@agent-anything/model-interaction/input";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import type {ActivityPurposeContract} from "../../activity/ActivityPurpose.js";
import type {ContextUseScope} from "@agent-anything/context/selection";
import {validatePreparedContextInput,type PreparedContextInput} from "../ContextInputPreparation.js";

export const REPRESENTATION_METHOD_PURPOSE:ActivityPurposeContract={
  ref:{id:"context.representation-method",revision:"1"},inputOwner:"context-representation",executionOwner:"representation-execution",
  interpretationOwner:"context-representation",acceptanceOwner:"context-representation",recoveryOwner:"context-representation",
  stageKinds:["read","ranges","exact","assemble","organize","measure","bind","model","release"],
  capabilities:["material-read","material-write","model-access","model-measurement"],continuationKinds:["stage_request"],
};
export type RepresentationMethodKind="preserve"|"excerpt"|"detail"|"omit"|"summarize"|"restore"|"search"|"check"|"check_combination";
export interface MethodSource {
  readonly alias:string;
  readonly role:"source"|"background"|"candidate";
  readonly access:MaterialAccess;
  readonly representation:RepresentationRef|null;
  readonly order:number;
  readonly label:string;
  readonly originalRole:string;
  /** Explicit native/contract unit, not a claim that all natural-language links are known. */
  readonly indivisibleGroup:string;
  readonly division?:{readonly kind:"text_lines";readonly basis:string};
}
export interface MethodRequirement {readonly id:string;readonly revision:string;readonly basis:string;readonly description:string;}
export interface MethodRelationship {readonly id:string;readonly sources:readonly string[];readonly basis:string;readonly description:string;readonly requiresCommonEvidence:boolean;}
export interface RepresentationMethodRequest {
  readonly kind:"representation_method";
  readonly method:RepresentationMethodKind;
  readonly methodRevision:"1";
  readonly recipient:MaterialRecipient;
  readonly objective:string;
  readonly sources:readonly MethodSource[];
  /** Protection/disclosure dependencies, not evidence claimed as read by the model. */
  readonly dependencyAccesses?:readonly MaterialAccess[];
  readonly requirements:readonly MethodRequirement[];
  readonly relationships:readonly MethodRelationship[];
  readonly sourceBoundary:string;
  readonly deliveryIds:readonly string[];
  readonly combinationDigest:string|null;
  readonly combination?:{readonly prepared:PreparedContextInput;readonly scope:ContextUseScope;readonly subjects:readonly RepresentationRef[]};
  readonly reuseJudgments?:readonly string[];
  readonly restorations?:readonly {readonly lossId:string;readonly sourceAlias:string;readonly range:MaterialRange;readonly description:string}[];
  readonly combine:"keep"|"merge";
  /** Required for exact omission; the owner supplies the permitted body, not a summarizer heuristic. */
  readonly omission:{readonly basis:string;readonly body:string}|null;
  readonly search:{readonly query:string;readonly caseMode:"sensitive"|"ascii_insensitive";readonly maximumMatches:number}|null;
  readonly template:ProviderRequest;
  readonly targetRevision:string;
  readonly capacity:{readonly limits:readonly InputCapacityLimit[];readonly reservations:readonly CapacityReservation[];readonly policy:InputCapacityPolicy;readonly maximumCombinations:number;readonly maximumMeasurements:number};
  readonly bounds:{readonly readBytes:number;readonly storedBytes:number;readonly modelCalls:number;readonly repairs:number;readonly levels:number;readonly pageBytes:number;readonly ranges:number};
}
export interface MethodPage {readonly alias:string;readonly start:number;readonly end:number;readonly stageId:string;}
export interface MethodCandidate {
  readonly id:string;
  readonly representation:RepresentationRef;
  readonly access:MaterialAccess;
  readonly sources:readonly string[];
  readonly losses:readonly RepresentationLoss[];
  readonly relationships:readonly MethodRelationship[];
  readonly unknowns:readonly MethodUnknown[];
  readonly generatedBy:string;
  readonly level:number;
  readonly segments:readonly {readonly id:string;readonly range:MaterialRange;readonly sources:readonly string[]}[];
}
export interface MethodUnknown {readonly kind:"source"|"preservation_gap"|"residual";readonly source:string;readonly description:string;}
export interface MethodFinding {
  readonly direction:"source_to_candidate"|"candidate_to_source"|"relationships"|"precision";
  readonly conclusion:"supported"|"unsupported"|"unknown";
  readonly sources:readonly string[];
  readonly candidates:readonly string[];
  readonly basis:string;
  readonly unknowns:readonly MethodUnknown[];
}
export interface MethodAssessment {
  readonly id:string;
  readonly jobId:string;
  readonly candidateIds:readonly string[];
  readonly sourceAliases:readonly string[];
  readonly findings:readonly MethodFinding[];
  readonly requirements:readonly {readonly id:string;readonly conclusion:"supported"|"unsupported"|"unknown";readonly basis:string}[];
  readonly supported:boolean;
  readonly rawResultId:string;
  readonly judgmentIds:readonly string[];
  readonly scope:"both"|"source"|"candidate";
}
export interface MethodJob {
  readonly id:string;
  readonly kind:"generate"|"check"|"merge"|"relation"|"combination";
  readonly sources:readonly string[];
  readonly candidates:readonly string[];
  readonly level:number;
  readonly repair:number;
  readonly feedback:string|null;
  readonly checkScope?:"source"|"candidate";
}
export interface MethodCheckGroup {readonly candidateId:string;readonly jobs:readonly string[];}
export interface RepresentationMethodProgress {
  readonly kind:"representation_method_progress";
  readonly request:RepresentationMethodRequest;
  readonly state:"working"|"ready"|"gap";
  readonly pages:readonly MethodPage[];
  readonly rangeUnits:readonly {readonly originalAlias:string;readonly source:MethodSource}[];
  readonly candidates:readonly MethodCandidate[];
  readonly assessments:readonly MethodAssessment[];
  readonly queue:readonly MethodJob[];
  readonly current:MethodJob|null;
  readonly resultIds:readonly string[];
  readonly readBytes:number;
  readonly storedBytes:number;
  readonly modelCalls:number;
  readonly tried:readonly string[];
  readonly acceptedInputs:readonly {readonly inputId:string;readonly scopeId:string;readonly selectionId:string;readonly holds:readonly string[]}[];
  readonly checkGroups:readonly MethodCheckGroup[];
  readonly gap:{readonly code:string;readonly stageId:string;readonly details:unknown}|null;
}

export function validateRepresentationMethodRequest(value:RepresentationMethodRequest):void {
  if(value.kind!=="representation_method"||value.methodRevision!=="1"||!value.objective.trim()||!value.sourceBoundary||!value.targetRevision||
    value.recipient.recipient!=="context-representation"||value.template.purpose!==value.recipient.purpose)throw new TypeError("representation_method_binding_invalid");
  if(!["preserve","excerpt","detail","omit","summarize","restore","search","check","check_combination"].includes(value.method))throw new TypeError("representation_method_unsupported");
  if((value.reuseJudgments?.length??0)>128)throw new TypeError("representation_reuse_bound_invalid");
  if(!value.sources.length||value.sources.length>128||new Set(value.sources.map(s=>s.alias)).size!==value.sources.length)throw new TypeError("representation_sources_invalid");
  if(!value.sources.some(s=>s.role==="source")||["check","check_combination"].includes(value.method)&&!value.sources.some(s=>s.role==="candidate"))throw new TypeError("representation_source_roles_invalid");
  if((value.dependencyAccesses?.length??0)>256||value.dependencyAccesses?.some(access=>modelInputValueDigest(access.recipient)!==modelInputValueDigest(value.recipient)))throw new TypeError("representation_dependency_scope_invalid");
  const aliases=new Set(value.sources.map(s=>s.alias));
  for(const source of value.sources) {
    if(!/^[a-zA-Z0-9_-]{1,64}$/.test(source.alias)||!source.indivisibleGroup||!source.label||!source.originalRole||!Number.isSafeInteger(source.order)||source.order<0||
      modelInputValueDigest(source.access.recipient)!==modelInputValueDigest(value.recipient))throw new TypeError("representation_source_scope_invalid");
    const r=source.access.range;if(r.coordinate!=="bytes"||!r.materialId||!r.version||!Number.isSafeInteger(r.start)||!Number.isSafeInteger(r.end)||r.start<0||r.end<r.start)throw new TypeError("representation_source_range_invalid");
    if(source.division&&(source.division.kind!=="text_lines"||!source.division.basis||source.role!=="source"||value.sources.some(s=>s.alias!==source.alias&&s.indivisibleGroup===source.indivisibleGroup)))throw new TypeError("representation_division_invalid");
  }
  if(new Set(value.sources.map(s=>s.order)).size!==value.sources.length||new Set(value.requirements.map(r=>r.id)).size!==value.requirements.length)throw new TypeError("representation_identity_duplicate");
  for(const requirement of value.requirements)if(!requirement.id||!requirement.revision||!requirement.basis||!requirement.description)throw new TypeError("representation_requirement_invalid");
  for(const restoration of value.restorations??[]) {
    const source=value.sources.find(s=>s.alias===restoration.sourceAlias),range=restoration.range;
    if(value.method!=="restore"||!restoration.lossId||!restoration.description||!source||source.representation!==null||source.role!=="source"||range.coordinate!=="bytes"||!Number.isSafeInteger(range.start)||!Number.isSafeInteger(range.end)||range.end<range.start||range.materialId!==source.access.range.materialId||range.version!==source.access.range.version||range.start<source.access.range.start||range.end>source.access.range.end)throw new TypeError("representation_restoration_scope_invalid");
  }
  for(const relationship of value.relationships)if(!relationship.id||!relationship.basis||!relationship.sources.length||relationship.sources.some(s=>!aliases.has(s)))throw new TypeError("representation_relationship_invalid");
  if(value.method==="omit"&&(!value.omission?.basis||!value.omission.body.trim()))throw new TypeError("representation_omission_basis_required");
  if(value.method==="search"&&(!value.search?.query||!Number.isSafeInteger(value.search.maximumMatches)||value.search.maximumMatches<1))throw new TypeError("representation_search_invalid");
  if(value.method==="check_combination"&&!value.combinationDigest)throw new TypeError("representation_combination_identity_required");
  if(value.method==="check_combination") {
    const combination=value.combination;if(!combination||!combination.subjects.length)throw new TypeError("representation_combination_evidence_required");
    validatePreparedContextInput(combination.prepared);
    const {scope,prepared}=combination;
    if(modelInputValueDigest(prepared)!==value.combinationDigest||scope.owner!==value.recipient.recipient||scope.runId!==value.recipient.runId||prepared.demand.recipient!==scope.recipient||prepared.demand.purpose!==scope.purpose||prepared.demand.targetRevision!==scope.target)throw new TypeError("representation_combination_binding_invalid");
    if(combination.subjects.some(ref=>!value.sources.some(s=>s.representation&&modelInputValueDigest(s.representation)===modelInputValueDigest(ref))))throw new TypeError("representation_combination_subject_evidence_missing");
  }
  for(const key of ["readBytes","storedBytes","modelCalls","repairs","levels","pageBytes","ranges"] as const)if(!Number.isSafeInteger(value.bounds[key])||value.bounds[key]<0)throw new TypeError("representation_bound_invalid");
  if(value.bounds.pageBytes<1||value.bounds.pageBytes>65536||value.bounds.levels<1||value.bounds.levels>32||value.bounds.repairs>16||value.bounds.ranges<1||value.bounds.ranges>128)throw new TypeError("representation_bound_invalid");
  if(value.capacity.policy.purpose!==value.recipient.purpose)throw new TypeError("representation_capacity_purpose_invalid");
}
export function representationMethodRequirements(request:RepresentationMethodRequest):readonly MethodRequirement[] {
  return [...request.requirements,...(request.restorations??[]).map(r=>({id:`restore:${r.lossId}`,revision:"1",basis:`Original evidence ${r.sourceAlias} at bytes ${r.range.start}-${r.range.end}`,description:`Verify this specific lost precision is restored from the supplied original evidence: ${r.description}. No claim about other losses.`}))];
}
export function startRepresentationMethod(request:RepresentationMethodRequest):RepresentationMethodProgress {
  validateRepresentationMethodRequest(request);
  return {kind:"representation_method_progress",request,state:"working",pages:[],rangeUnits:[],candidates:[],assessments:[],queue:[],current:null,resultIds:[],readBytes:0,storedBytes:0,modelCalls:0,tried:[],acceptedInputs:[],checkGroups:[],gap:null};
}
export function sourceRanges(request:RepresentationMethodRequest,aliases:readonly string[]):readonly MaterialRange[] {
  return aliases.map(alias=>{const source=request.sources.find(s=>s.alias===alias);if(!source)throw new TypeError("representation_source_unknown");return source.access.range;});
}
