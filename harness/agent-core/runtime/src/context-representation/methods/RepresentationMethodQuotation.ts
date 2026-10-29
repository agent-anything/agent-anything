import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {validateRepresentationMethodRequest,type RepresentationMethodRequest} from "./RepresentationMethod.js";

export interface MethodCostQuantity {
  readonly minimum:number;
  /** Null is unknown, not zero; an execution limit is not a forecast. */
  readonly maximum:number|null;
  readonly basis:string;
}
export interface RepresentationMethodQuotation {
  readonly id:string;
  readonly owner:"context-representation";
  readonly revision:"1";
  readonly requestDigest:string;
  readonly targetRevision:string;
  readonly boundary:string;
  readonly phases:readonly {
    readonly kind:"read"|"partition"|"generate"|"check"|"merge"|"relation"|"input"|"retain"|"repair";
    readonly condition:"required"|"conditional";
    readonly basis:string;
  }[];
  readonly minimum:{readonly stages:number;readonly attempts:number;readonly modelCalls:number;readonly readBytes:number};
  readonly costs:{readonly readBytes:MethodCostQuantity;readonly storedBytes:MethodCostQuantity;readonly modelCalls:MethodCostQuantity;
    readonly externalMeasurements:MethodCostQuantity;readonly elapsedMs:MethodCostQuantity;readonly billedTokens:MethodCostQuantity};
  readonly limits:RepresentationMethodRequest["bounds"];
  readonly gaps:readonly string[];
  readonly unknowns:readonly string[];
  /** These belong to the receiving path. A completed method does not establish them. */
  readonly handoff:readonly ("recipient_input_organization"|"recipient_combination_judgment"|"shared_adoption"|"protection_transfer")[];
}

/** A method-owned initial path quotation. It is neither a scheduling promise nor a quality judgment. */
export function quoteRepresentationMethod(request:RepresentationMethodRequest):RepresentationMethodQuotation {
  validateRepresentationMethodRequest(request);
  const exact=["preserve","excerpt","omit","search"].includes(request.method);
  const generates=!exact&&!["check","check_combination"].includes(request.method);
  const reusableCheck=!generates&&!exact&&Boolean(request.reuseJudgments?.length);
  const bytes=request.sources.reduce((sum,s)=>sum+s.access.range.end-s.access.range.start,0);
  const partition=!exact&&request.sources.some(s=>s.division);
  const rangeBytes=partition?request.sources.filter(s=>s.division).reduce((n,s)=>n+s.access.range.end-s.access.range.start,0):0;
  const reads=request.method==="preserve"?0:request.sources.reduce((n,s)=>n+Math.max(1,Math.ceil((s.access.range.end-s.access.range.start)/request.bounds.pageBytes)),0);
  // Search can stop at its match limit. Its worst case still scans the frozen scope.
  const minimumReads=request.method==="search"?request.sources.length:reads;
  const modelCalls=exact||reusableCheck?0:generates?2:1;
  // Each non-reused model job includes assembly, fixed/full input organization, binding and dispatch.
  const stages=minimumReads+(partition?1:0)+(exact?1:reusableCheck?1:modelCalls*5);
  const generatedEvidenceBytes=request.sources.filter(s=>s.role!=="candidate").reduce((n,s)=>n+s.access.range.end-s.access.range.start,0);
  const exactEvidenceBytes=request.sources.filter(s=>s.role==="source").reduce((n,s)=>n+s.access.range.end-s.access.range.start,0);
  const readBytes=request.method==="preserve"?0:request.method==="search"?exactEvidenceBytes:
    bytes+rangeBytes+(exact?exactEvidenceBytes:reusableCheck?0:generates?2*generatedEvidenceBytes:bytes);
  const phases:RepresentationMethodQuotation["phases"][number][]=[];
  if(request.method!=="preserve")phases.push({kind:"read",condition:"required",basis:"Versioned source ranges; bounded pages, including background and candidate evidence"});
  if(partition)phases.push({kind:"partition",condition:"required",basis:"Declared text-line ranges only; partition is not semantic independence"});
  if(!exact)phases.push({kind:"input",condition:"required",basis:"Fixed background and complete actual input must each be organized; remote measurement is conditional"});
  if(generates)phases.push({kind:"generate",condition:"required",basis:"Generation is followed by preservation assessment; it does not itself justify adoption"});
  if(!exact)phases.push({kind:"check",condition:"required",basis:"Both evidence directions and explicit requirements; exact applicable retained judgments may discharge checks"});
  if(!exact&&request.relationships.some(r=>r.requiresCommonEvidence))phases.push({kind:"relation",condition:"conditional",basis:"Any required relation not covered by accepted checks needs common evidence"});
  if(generates&&request.combine==="merge")phases.push({kind:"merge",condition:"conditional",basis:"Multiple results require bounded pairwise merge and assessment of every merged result"});
  if(!exact&&request.bounds.repairs)phases.push({kind:"repair",condition:"conditional",basis:"Only an identified failure with new evidence; all repairs share original resource limits"});
  phases.push({kind:"retain",condition:"required",basis:"Original responses, candidate material, assessments and protection obligations survive process interruption"});
  const unknowns=exact?[]:["candidate_size","partition_and_check_expansion","quality_and_repair_outcome","actual_measurement_need"];
  unknowns.push("elapsed_time","storage_record_overhead");
  if(!exact)unknowns.push("billed_tokens","recipient_adoption_cost");
  const gaps:string[]=[];
  if(readBytes>request.bounds.readBytes)gaps.push("known_read_work_exceeds_limit");
  if(modelCalls>request.bounds.modelCalls)gaps.push("known_model_work_exceeds_limit");
  const quantity=(minimum:number,maximum:number|null,basis:string):MethodCostQuantity=>({minimum,maximum,basis});
  const value={owner:"context-representation" as const,revision:"1" as const,requestDigest:modelInputValueDigest(request),targetRevision:request.targetRevision,boundary:request.sourceBoundary,
    phases,minimum:{stages,attempts:stages,modelCalls,readBytes},costs:{
      readBytes:quantity(readBytes,exact?request.method==="preserve"?0:bytes+exactEvidenceBytes:null,"Source reading plus known evidence assembly; further candidate reads are not predicted"),
      storedBytes:quantity(0,null,"Material limit excludes durable response and recovery-record overhead; no invented output size"),
      modelCalls:quantity(modelCalls,exact?0:null,"Generation, preservation checks, conditional relation/merge/repair jobs share one ledger"),
      externalMeasurements:quantity(0,exact?0:null,"Actual measurement needs depend on each full encoded input"),
      elapsedMs:quantity(0,null,"No elapsed-time evidence supplied by method declaration"),
      billedTokens:quantity(0,exact?0:null,"Input and output usage require actual target-specific observations")},
    limits:request.bounds,gaps,unknowns,handoff:["recipient_input_organization","recipient_combination_judgment","shared_adoption","protection_transfer"] as const};
  return {id:`method-quotation:${modelInputValueDigest(value)}`,...value};
}
