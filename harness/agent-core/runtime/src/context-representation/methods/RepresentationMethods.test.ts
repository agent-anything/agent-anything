import {describe,expect,it} from "vitest";
import type {ProviderCallResult} from "@agent-anything/model-interaction";
import type {RepresentationCatalogPort,RepresentationJudgment} from "@agent-anything/context/representation";
import type {ActivityHandoffPort} from "../../activity/ActivityHandoff.js";
import {startRepresentationMethod,validateRepresentationMethodRequest,type RepresentationMethodRequest,type MethodJob,type MethodCandidate} from "./RepresentationMethod.js";
import {parseRepresentationMethodOutput,representationMethodOutputFormat,representationAssessmentSupported,type AssessedRepresentation} from "./RepresentationMethodOutput.js";
import {splitMethodJob,distributedMethodChecks,methodCoverageGaps,remainingMethodRelations,methodJobKey,nextMethodFinalJobs} from "./RepresentationMethodPlanning.js";
import {methodAssessmentConditions,findMethodAssessmentReuse} from "./RepresentationMethodReuse.js";
import {methodLineUnits} from "./RepresentationMethodRanges.js";
import {quoteRepresentationMethod} from "./RepresentationMethodQuotation.js";

const recipient={runId:"run",recipient:"context-representation",purpose:"aux"};
function request():RepresentationMethodRequest {
  return {kind:"representation_method",method:"summarize",methodRevision:"1",recipient,objective:"Preserve the agreement and its scoped correction",sourceBoundary:"H1",deliveryIds:["B1"],combinationDigest:null,combine:"keep",omission:null,search:null,
    sources:["a","b"].map((alias,order)=>({alias,role:"source",access:{id:`access-${alias}`,holdId:`hold-${alias}`,recipient,range:{materialId:alias,version:"1",start:0,end:100,coordinate:"bytes"}},representation:null,order,label:alias,originalRole:"user",indivisibleGroup:alias})),
    requirements:[{id:"r",revision:"1",basis:"user",description:"Retain the scoped correction"}],relationships:[],template:{purpose:"aux"} as RepresentationMethodRequest["template"],targetRevision:"target",
    capacity:{limits:[],reservations:[],policy:{id:"test",revision:"1",purpose:"aux",basis:"test",allowEstimatedFit:true,allowUnknown:true},maximumCombinations:2,maximumMeasurements:0},
    bounds:{readBytes:1000,storedBytes:1000,modelCalls:10,repairs:1,levels:4,pageBytes:100,ranges:16}};
}
const job:MethodJob={id:"job",kind:"generate",sources:["a","b"],candidates:[],level:0,repair:0,feedback:null};
const returned=(output:unknown)=>({kind:"succeeded",response:{kind:"structured_generation",output}} as ProviderCallResult);
const output=()=>({kind:"candidate",parts:[{text:"Original method",sources:["a"]},{text:"Later scoped correction",sources:["b"]}],covered:["a","b"],background:[],losses:[],relationships:[],unknowns:[],missing:[]});
const assessment=()=>({kind:"assessment",findings:Object.fromEntries(["source_to_candidate","candidate_to_source","relationships","precision"].map(direction=>[direction,{conclusion:"supported",sources:["a","b"],candidates:["c"],basis:"Actual evidence",unknowns:[]}])),requirements:[{id:"r",conclusion:"supported",basis:"Actual requirement"}],missing:[]});
function candidate():MethodCandidate {
  const r=request(),range={materialId:"c",version:"1",coordinate:"bytes" as const,start:0,end:40};
  return {id:"c",representation:{id:"c",revision:"1"},access:{id:"ca",holdId:"ch",recipient,range},sources:job.sources,losses:[],relationships:[],unknowns:[],generatedBy:job.id,level:0,
    segments:r.sources.map((s,i)=>({id:`c_s${i}`,sources:[s.alias],range:{...range,start:i*20,end:(i+1)*20}}))};
}
describe("representation method contracts and bounded professional planning",()=>{
  it("quotes the complete method duties without treating execution ceilings as predicted costs",()=>{
    const r={...request(),combine:"merge" as const,relationships:[{id:"relation",basis:"contract",sources:["a","b"],description:"joint correction",requiresCommonEvidence:true}]};
    const quote=quoteRepresentationMethod(r);
    expect(quote.phases.map(p=>p.kind)).toEqual(["read","input","generate","check","relation","merge","repair","retain"]);
    expect(quote.minimum).toMatchObject({stages:12,modelCalls:2,readBytes:600});
    expect(quote.costs.modelCalls.maximum).toBeNull();
    expect(quote.costs.elapsedMs.maximum).toBeNull();
    expect(quote.limits.modelCalls).toBe(10);
    expect(quote.handoff).toContain("recipient_combination_judgment");
    expect(quoteRepresentationMethod({...r,bounds:{...r.bounds,modelCalls:1}}).gaps).toContain("known_model_work_exceeds_limit");
    expect(quoteRepresentationMethod({...r,targetRevision:"different"}).id).not.toBe(quote.id);
  });
  it("does not charge a model generation for exact methods or claim known output bytes",()=>{
    const r={...request(),method:"excerpt" as const},quote=quoteRepresentationMethod(r);
    // Source discovery and exact evidence assembly are separate bounded reads.
    expect(quote.minimum).toEqual({stages:3,attempts:3,modelCalls:0,readBytes:400});
    expect(quote.costs.storedBytes.maximum).toBeNull();
    expect(quoteRepresentationMethod({...r,method:"preserve"}).minimum).toEqual({stages:1,attempts:1,modelCalls:0,readBytes:0});
  });
  it("accepts restoration only at an exact valid byte range of the original version",()=>{
    const r=request(),source=r.sources[0]!,restoration={lossId:"loss",sourceAlias:source.alias,range:source.access.range,description:"restore this lost value"};
    expect(()=>validateRepresentationMethodRequest({...r,method:"restore",restorations:[restoration]})).not.toThrow();
    for(const range of [{...restoration.range,coordinate:"lines"},{...restoration.range,start:2,end:1},{...restoration.range,start:0.5},{...restoration.range,end:NaN}])
      expect(()=>validateRepresentationMethodRequest({...r,method:"restore",restorations:[{...restoration,range:range as typeof restoration.range}]})).toThrow("restoration_scope_invalid");
  });
  it("requires every resource dimension instead of treating a missing bound as unlimited",()=>{
    const r=request();const {ranges,...bounds}=r.bounds;void ranges;
    expect(()=>validateRepresentationMethodRequest({...r,bounds:bounds as typeof r.bounds})).toThrow("bound_invalid");
  });
  it("partitions only permitted complete lines at exact UTF-8 byte offsets",()=>{
    const text="\u7532\n\u4e59\nabcdefghijklmnop\n\u4e19\n",bytes=Buffer.from(text);
    const source={...request().sources[0]!,division:{kind:"text_lines" as const,basis:"text contract"},access:{...request().sources[0]!.access,range:{...request().sources[0]!.access.range,start:10,end:10+bytes.length}}};
    const units=methodLineUnits(source,text,4);
    expect(units.map(u=>[u.source.access.range.start,u.source.access.range.end])).toEqual([[10,14],[14,18],[18,35],[35,39]]);
    expect(units.map(u=>bytes.subarray(u.source.access.range.start-10,u.source.access.range.end-10).toString()).join("")).toBe(text);
    expect(methodLineUnits({...source,division:undefined},text,4)).toEqual([]);
    expect(methodLineUnits({...source,access:{...source.access,range:{...source.access.range,end:26}}},"abcdefghijklmnop",4)).toEqual([]);
    expect(()=>methodLineUnits(source,text+"x",4)).toThrow("bytes_mismatch");
    const p=startRepresentationMethod(request()),unitCandidate={...candidate(),sources:[units[0]!.source.alias]};
    expect(methodCoverageGaps({...p,rangeUnits:units,candidates:[unitCandidate],resultIds:[unitCandidate.id]})).toContain("source_not_represented:a");
  });
  it("finds merged candidates for cross-range checks through direct lineage",()=>{
    const p=startRepresentationMethod({...request(),relationships:[{id:"r",sources:["a","b"],basis:"source contract",description:"correction",requiresCommonEvidence:true}]});
    const first=candidate(),merged={...first,id:"merged",sources:[first.id]};
    expect(nextMethodFinalJobs("path",{...p,candidates:[first,merged],resultIds:[merged.id]})[0]?.candidates).toEqual(["merged"]);
  });
  it("derives one body from ordered source-mapped parts without separately generated conflicting text",()=>{
    const value=parseRepresentationMethodOutput(returned(output()),request(),job);
    expect(value).toMatchObject({body:"Original method\n\nLater scoped correction",parts:output().parts});
    expect(()=>parseRepresentationMethodOutput(returned({...output(),body:"different"}),request(),job)).toThrow("fields_invalid");
  });
  it("binds allowed aliases in the schema and reports the exact invalid reference",()=>{
    const format=representationMethodOutputFormat(request(),job);
    expect(format.schema).toMatchObject({properties:{background:{maxItems:0},covered:{items:{enum:["a","b"]}}}});
    expect(()=>parseRepresentationMethodOutput(returned({...output(),background:["[]"]}),request(),job)).toThrowError(expect.objectContaining({code:"representation_output_reference_invalid",details:expect.objectContaining({field:"background",received:["[]"],allowed:[]})}));
  });
  it("does not interpret a partial provider return, tool-shaped output, or invented source as a candidate",()=>{
    expect(()=>parseRepresentationMethodOutput({kind:"failed",failure:{code:"length"}} as ProviderCallResult,request(),job)).toThrow("length");
    expect(()=>parseRepresentationMethodOutput(returned({tool:"Shell",command:"write"}),request(),job)).toThrow("fields_invalid");
    expect(()=>parseRepresentationMethodOutput(returned({...output(),parts:[{text:"invented",sources:["outside"]}]}),request(),job)).toThrow("reference_invalid");
  });
  it("keeps all four independent judgments and does not turn a preservation gap into residual uncertainty",()=>{
    const j={...job,kind:"check" as const,candidates:["c"]};
    const value=parseRepresentationMethodOutput(returned(assessment()),request(),j) as AssessedRepresentation;
    expect(representationAssessmentSupported(value)).toBe(true);
    expect(representationAssessmentSupported({...value,findings:value.findings.map(f=>({...f,unknowns:[{kind:"preservation_gap",source:"a",description:"missing method"}]}))})).toBe(false);
    expect(representationAssessmentSupported({...value,findings:value.findings.map(f=>({...f,unknowns:[{kind:"source",source:"a",description:"originally unknown"}]}))})).toBe(true);
  });
  it("limits partial checks to their claimed direction, never promoting them to whole-combination support",()=>{
    const value=parseRepresentationMethodOutput(returned(assessment()),request(),{...job,kind:"check",candidates:["c"]}) as AssessedRepresentation;
    const partial={...value,findings:value.findings.map(f=>f.direction==="candidate_to_source"?{...f,conclusion:"unknown" as const}:f),requirements:value.requirements.map(r=>({...r,conclusion:"unknown" as const}))};
    expect(representationAssessmentSupported(partial,"source")).toBe(true);
    expect(representationAssessmentSupported(partial)).toBe(false);
  });
  it("splits only declared source units and refuses to call an indivisible group independent",()=>{
    const p=startRepresentationMethod(request());expect(splitMethodJob(p,job)?.map(j=>j.sources)).toEqual([["a"],["b"]]);
    expect(splitMethodJob({...p,request:{...p.request,sources:p.request.sources.map(s=>({...s,indivisibleGroup:"native-pair"}))}},job)).toBeNull();
  });
  it("covers every source in the forward direction and every candidate part in reverse",()=>{
    const p={...startRepresentationMethod(request()),candidates:[candidate()]};
    const checks=distributedMethodChecks(p,{...job,kind:"check",candidates:["c"]})!;
    expect(checks.filter(c=>c.checkScope==="source").flatMap(c=>c.sources)).toEqual(["a","b"]);
    expect(checks.filter(c=>c.checkScope==="candidate").flatMap(c=>c.candidates)).toEqual(["c_s0","c_s1"]);
    expect(methodCoverageGaps({...p,resultIds:["c"]})).toContain("unchecked_candidate:c");
    expect(distributedMethodChecks(p,checks[0]!)).toBeNull();
  });
  it("retains explicit cross-range duties even after a partial check passes",()=>{
    const p=startRepresentationMethod({...request(),relationships:[{id:"relation",basis:"known correction",description:"b corrects a",sources:["a","b"],requiresCommonEvidence:true}]});
    const partial={id:"x",jobId:"x",candidateIds:["c"],sourceAliases:["a","b"],findings:[],requirements:[],supported:true,rawResultId:"raw",judgmentIds:["j"],scope:"source" as const};
    expect(remainingMethodRelations({...p,assessments:[partial]})).toHaveLength(1);
    expect(remainingMethodRelations({...p,assessments:[{...partial,scope:"both"}]})).toHaveLength(0);
  });
  it("does not reset tried conditions merely by changing a stage name or repair counter",()=>{
    expect(methodJobKey(job)).toBe(methodJobKey({...job,id:"renamed",repair:1}));
    expect(methodJobKey(job)).not.toBe(methodJobKey({...job,feedback:"precise changed evidence"}));
  });
  it("requires actual prepared input rather than a digest alone for combination checking",()=>{
    const r=request();expect(()=>validateRepresentationMethodRequest({...r,method:"check_combination",combinationDigest:"hash",sources:[r.sources[0]!,{...r.sources[1]!,role:"candidate"}]})).toThrow("combination_evidence_required");
  });
  it("keeps current purpose, source versions, requirements and exact combination in reuse conditions",async()=>{
    const r=request(),j={...job,kind:"check" as const,candidates:["c"]};
    const sources=[...r.sources,{...r.sources[0]!,alias:"c",role:"candidate" as const,representation:{id:"c",revision:"1"}}];
    const conditions=methodAssessmentConditions(r,j,sources);
    const normalized=parseRepresentationMethodOutput(returned(assessment()),r,j);
    const judgment={id:"prior",kind:"semantic",conclusion:"supported",methodRevision:"bidirectional:1",dependencies:{conditions,stage:"original",acceptance:"accepted",rawResult:"raw"},subjects:[{id:"c",revision:"1"}],basis:"Original accepted findings"} as RepresentationJudgment;
    const catalog:RepresentationCatalogPort={command:async()=>judgment};
    const activities={command:async()=>({status:"accepted",result:{id:"raw"},receipt:{id:"accepted",progress:{method:{assessments:[{...normalized,scope:"both",supported:true,judgmentIds:["prior"],rawResultId:"raw"}]}}}})} as ActivityHandoffPort;
    expect(await findMethodAssessmentReuse(catalog,activities,{...r,reuseJudgments:["prior"]},j,sources,new AbortController().signal)).toMatchObject({judgmentId:"prior"});
    expect(await findMethodAssessmentReuse(catalog,activities,{...r,reuseJudgments:["prior"],objective:"different"},j,sources,new AbortController().signal)).toBeNull();
    expect(await findMethodAssessmentReuse(catalog,{command:async()=>null},{...r,reuseJudgments:["prior"]},j,sources,new AbortController().signal)).toBeNull();
    expect(methodAssessmentConditions({...r,combinationDigest:"new exact input"},j,sources)).not.toBe(conditions);
  });
});
