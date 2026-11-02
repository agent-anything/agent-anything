import {describe,expect,it,vi} from "vitest";
import type {ProviderCallResult} from "@agent-anything/model-interaction";
import type {RepresentationCatalogPort,RepresentationJudgment} from "@agent-anything/context/representation";
import type {ActivityHandoffPort} from "../../activity/ActivityHandoff.js";
import {startRepresentationMethod,validateRepresentationMethodRequest,type RepresentationMethodRequest,type MethodJob,type MethodCandidate,type MethodAssessment} from "./RepresentationMethod.js";
import {parseRepresentationMethodOutput,representationMethodOutputFormat,representationAssessmentSupported,type AssessedRepresentation} from "./RepresentationMethodOutput.js";
import {splitMethodJob,distributedMethodChecks,methodCoverageGaps,remainingMethodRelations,methodJobKey,nextMethodFinalJobs} from "./RepresentationMethodPlanning.js";
import {methodAssessmentConditions,findMethodAssessmentReuse,methodInputSources} from "./RepresentationMethodReuse.js";
import {qualifiedMethodSources} from "./QualifiedMethodSources.js";
import {methodCombinationEvidence} from "./MethodCombinationEvidence.js";
import type {MaterialCustodyPort} from "@agent-anything/context/custody";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {methodTextUnits} from "./RepresentationMethodRanges.js";
import {createRepresentationMethodInput} from "./RepresentationMethodInput.js";
import {methodPreservationSupport,methodSupportCovers,qualifiedMethodRelation} from "./MethodPreservationSupport.js";
import {quoteRepresentationMethod} from "./RepresentationMethodQuotation.js";
import {RepresentationMethodPath,type RepresentationMethodDependencies} from "./RepresentationMethodPath.js";
import {REPRESENTATION_METHOD_PURPOSE} from "./RepresentationMethod.js";
import type {ActivityPurposeHandler} from "../../activity/ActivityHandoffProcessor.js";
import type {ActivityPathState,ActivityStageState} from "../../activity/ActivityHandoff.js";
import {contextStageObservation} from "../ContextStageObservation.js";

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

it("retains per-stage method measurements when model input contains no cumulative method state",async()=>{
  const before={...startRepresentationMethod(request()),current:job,readBytes:90,storedBytes:40},after={...before,storedBytes:65,candidates:[candidate()]};
  const handler=new RepresentationMethodPath({} as RepresentationMethodDependencies);
  const interpretation=handler as unknown as {interpretStage:ActivityPurposeHandler["interpret"]};
  vi.spyOn(interpretation,"interpretStage").mockResolvedValue({progress:{method:after},next:[]});
  const purpose={contract:REPRESENTATION_METHOD_PURPOSE,digest:modelInputValueDigest(REPRESENTATION_METHOD_PURPOSE)};
  const path={intent:{id:"path",runId:"run",purpose},progress:{method:before}} as ActivityPathState;
  const stage={request:{id:"model-stage",pathId:"path",stageKind:"model",input:{kind:"prepared_context_input"}},result:{id:"raw"}} as ActivityStageState;
  const result=await handler.interpret(path,stage,new AbortController().signal,{id:"accepted"});
  expect(result.progress).toMatchObject({methodObservation:{resourcesDelta:{readBytes:0,storedBytes:25},generated:[candidate().representation]}});
  const accepted={...stage,receipt:{progress:result.progress}} as ActivityStageState;
  const observation=contextStageObservation({...path,progress:{method:{...after,readBytes:9999}}},accepted);
  expect(observation.method?.resourcesDelta).toEqual({readBytes:0,storedBytes:25});
  expect(observation.method?.generated).toEqual([candidate().representation]);
});

describe("scoped text refinement and preservation support",()=>{
  it("refines explicit UTF-8 bodies without breaking code points or claiming semantic independence",()=>{
    const text="a\u4e2d\ud83d\ude00b\u4e2d\ud83d\ude00c",bytes=Buffer.from(text),r=request(),s=r.sources[0]!;
    const source={...s,division:{kind:"text_utf8" as const,basis:"declared body"},access:{...s.access,range:{...s.access.range,start:10,end:10+bytes.length}}};
    const units=methodTextUnits(source,text,5),parts=units.map(u=>bytes.subarray(u.source.access.range.start-10,u.source.access.range.end-10));
    expect(units.length).toBeGreaterThan(1);expect(Buffer.concat(parts)).toEqual(bytes);
    expect(parts.every(b=>Buffer.from(b.toString("utf8")).equals(b))).toBe(true);
    expect(units.every(u=>u.originalAlias===source.alias&&!u.source.division)).toBe(true);
    expect(methodTextUnits({...source,division:undefined},text,5)).toEqual([]);
  });
  function graph(){
    const r={...request(),relationships:[{id:"relation",sources:["a","b"],description:"Preserve their relationship",basis:"declared",requiresCommonEvidence:true}]},
      a={...candidate(),id:"left",sources:["a"]},b={...candidate(),id:"right",sources:["b"]},c={...candidate(),id:"merged",sources:["left","right"]};
    const candidates=[a,b,c],assessments=candidates.map((c):MethodAssessment=>({id:`check-${c.id}`,jobId:`job-${c.id}`,candidateIds:[c.id],sourceAliases:c.sources,
      findings:[],requirements:[{id:"r",conclusion:"supported",basis:"actual check"}],supported:true,rawResultId:`raw-${c.id}`,judgmentIds:[`check-${c.id}`],scope:"both"}));
    return {method:{...startRepresentationMethod(r),candidates,assessments},c};
  }
  it("retains every local judgment through a merge before qualifying a relationship check",()=>{
    const {method,c}=graph(),support=methodPreservationSupport(method,[c]);
    expect(support?.assessments.map(a=>a.id)).toEqual(["check-merged","check-left","check-right"]);
    expect(methodSupportCovers(method,support!,["a","b"])).toBe(true);
    const qualified=qualifiedMethodRelation(method,{...job,kind:"relation",candidates:[c.id],feedback:"Preserve their relationship"});
    expect(qualified?.sources).toEqual([c.id]);expect(qualified?.candidates).toEqual([]);
    expect(qualified?.relationshipBasis?.supportingJudgments).toEqual(support!.assessments.map(a=>a.id));
  });
  it.each(["missing","partial","unsupported","cycle"])("does not infer full support from %s evidence",kind=>{
    const {method,c}=graph();
    if(kind==="missing")method.assessments=method.assessments.filter(a=>a.id!=="check-left");
    if(kind==="partial")method.assessments[0]={...method.assessments[0]!,scope:"source"};
    if(kind==="unsupported")method.assessments[0]={...method.assessments[0]!,supported:false};
    if(kind==="cycle") {method.candidates[0]={...method.candidates[0]!,sources:[c.id]};method.assessments[0]={...method.assessments[0]!,sourceAliases:[c.id]};}
    expect(methodPreservationSupport(method,[c])).toBeNull();
  });
  it("rejects gaps and changed material versions even with locally supported candidates",()=>{
    const {method,c}=graph(),support=methodPreservationSupport(method,[c])!;
    expect(methodSupportCovers(method,{...support,coverage:support.coverage.map(s=>s.sourceAlias==="a"?{...s,ranges:[{...s.ranges[0]!,end:50},{...s.ranges[0]!,start:51}]}:s)},["a","b"])).toBe(false);
    expect(methodSupportCovers(method,{...support,coverage:support.coverage.map(s=>({...s,ranges:s.ranges.map(r=>({...r,version:"other"}))}))},["a","b"])).toBe(false);
  });
});

describe("representation method authorization",()=>{
  it("quotes the exact combination body once, separate from host transport bindings",()=>{
    const r=request(),body=JSON.stringify({messages:[{role:"user",content:'Keep "exact" values'}]});
    const encoded={id:"encoded-original",mediaType:"application/json",body,endpoint:"https://private-target.invalid",adapterRevision:"host-binding"};
    const input={...r,method:"check_combination",combinationDigest:"combination",template:{purpose:"aux",correlation:{controllerRequestId:"turn",branchId:"branch"},
      composition:{providerId:"provider",model:"model",lineage:{instructionModel:{providerId:"provider",model:"model"}}},
      modelContext:{assessment:null,requestedOutput:{unit:"tokens",maximum:100,source:"host_configured",revision:"1"},headroom:{unit:"tokens",amount:0,policy:{id:"test",revision:"1"}}}},
      combination:{prepared:{encoded,locations:[],deliveries:[]},scope:{target:"target"}}} as unknown as RepresentationMethodRequest;
    const prepared=createRepresentationMethodInput(input,{...job,kind:"combination"},[],"2026-11-01T00:00:00.000Z");
    const sections=prepared.template.composition.sections,metadataSection=sections.find(s=>s.id.endsWith(":combination"))!;
    if(metadataSection.content.kind!=="text")throw new Error("Expected quoted combination metadata");
    const metadata=JSON.parse(metadataSection.content.text),quoted=sections.find(s=>s.id===metadata.encoded.bodySection)!;
    expect(metadata.encoded).toEqual({id:encoded.id,mediaType:encoded.mediaType,bodySection:quoted.id});
    expect(quoted.content).toEqual({kind:"text",text:body});
    expect(sections.filter(s=>s.content.kind==="text"&&s.content.text===body)).toHaveLength(1);
    expect(JSON.stringify(sections)).not.toContain(encoded.endpoint);
    expect(input.combination!.prepared.encoded).toBe(encoded);
    expect(prepared.demand.contributions.every(c=>c.options.every(o=>o.sections.every(s=>s.section.necessity==="mandatory")))).toBe(true);
  });
  it.each(["allowed","temporary","denied"] as const)("preserves %s in exact, preparation, measurement and settlement branches",async kind=>{
    const result=kind==="allowed"?{kind}:kind==="temporary"?{kind,code:"pending",message:"Await authority"}:
      {kind,code:"denied",message:"Authority revoked",decision:{owner:"host",id:"denial",revision:"1"}};
    const authorize=vi.fn<ActivityPurposeHandler["authorize"]>(async()=>result),r=request(),method=startRepresentationMethod(r);
    const materials={command:vi.fn(async(c:{holdId:string})=>({hold:{range:r.sources.find(s=>s.access.holdId===c.holdId)!.access.range}}))};
    const ports={authorize,materials,provider:{descriptor:{id:"provider"},modelContext:{target:{model:"model"}},encodeInput:vi.fn(),inputMeasurement:{revision:"count:1"}}} as unknown as RepresentationMethodDependencies;
    const handler=new RepresentationMethodPath(ports),signal=new AbortController().signal;
    const path={intent:{runId:"run",purpose:{digest:modelInputValueDigest(REPRESENTATION_METHOD_PURPOSE),contract:REPRESENTATION_METHOD_PURPOSE}}} as ActivityPathState;
    const input={method,request:{kind:"context_input_preparation",demand:{runId:"run",purpose:"aux",targetRevision:"target"},
      template:{purpose:"aux",composition:{providerId:"provider",model:"model"}},materialAccesses:[]},progress:{},
      pending:{encoded:{id:"encoded"},remote:{methodRevision:"count:1",encodedInputId:"encoded",targetRevision:"target"}}};
    for(const stageKind of ["read","exact","organize","measure"])for(const action of ["admission","execution","reconciliation","interpretation","settlement"] as const) {
      const stage={request:{stageKind,input}} as ActivityStageState;
      expect(await handler.authorize(path,stage,signal,action)).toBe(result);
      expect(authorize).toHaveBeenLastCalledWith(path,stage,signal,action);
    }
    expect(authorize).toHaveBeenCalledTimes(20);expect(ports.provider.encodeInput).not.toHaveBeenCalled();
    materials.command.mockClear();
    expect(await handler.authorize(path,{request:{stageKind:"model",input}} as ActivityStageState,signal,"settlement")).toBe(result);
    expect(materials.command).not.toHaveBeenCalled();
  });
});

describe("qualified source evidence for a new recipient combination",()=>{
  function fixture(discovered=false,tag="") {
    const r=request(),c={...candidate(),id:`c${tag}`,representation:{id:`c${tag}`,revision:"1"},relationships:discovered?[{id:"discovered",basis:"model",sources:job.sources,description:"Reported relation",requiresCommonEvidence:true}]:[]},checkJob={...job,id:"check",kind:"check" as const,candidates:[c.id]};
    const local:MethodAssessment={id:`judgment${tag}`,jobId:checkJob.id,candidateIds:[c.id],sourceAliases:job.sources,
      findings:[],requirements:[{id:"r",conclusion:"supported",basis:"original evidence"}],supported:true,rawResultId:`raw${tag}`,judgmentIds:[`judgment${tag}`],scope:"both"};
    const method={...startRepresentationMethod(r),state:"ready" as const,candidates:[c],assessments:[local],resultIds:[c.id]};
    const prior={...structuredClone(method),state:"working" as const,current:checkJob,assessments:[]};
    const judgment={id:`judgment${tag}`,runId:r.recipient.runId,evidenceSources:[],kind:"semantic",conclusion:"supported",methodRevision:"bidirectional:1",subjects:[c.representation],
      dependencies:{stage:`stage${tag}`,rawResult:`raw${tag}`,acceptance:"accepted",conditions:methodAssessmentConditions(r,checkJob,methodInputSources(prior,checkJob))}};
    const stage={request:{pathId:`producer${tag}`,input:{method:prior}},status:"accepted",result:{id:`raw${tag}`},
      receipt:{id:"accepted",progress:{method:structuredClone(method)}}};
    const read=()=>qualifiedMethodSources({producerPathId:`producer${tag}`,method,candidates:method.candidates,
      representations:{command:async()=>judgment} as unknown as RepresentationCatalogPort,
      activities:{command:async()=>stage} as unknown as ActivityHandoffPort,signal:new AbortController().signal});
    return {method,judgment,stage,read};
  }
  it.each([true,false])("combines attributable local evidence without equating same-named requirements (second qualified: %s)",async secondQualified=>{
    const first=fixture(true),second=fixture(true,"2"),fixtures=[first,second];
    if(!secondQualified)second.method.assessments=[];
    const combined=await methodCombinationEvidence({producers:fixtures.map(f=>({pathId:f.stage.request.pathId,method:f.method,candidates:f.method.candidates})),qualified:true,
      representations:{command:async(c:{kind:string;id:string})=>c.kind==="read"?{holds:[]}:fixtures.find(f=>f.judgment.id===c.id)!.judgment} as unknown as RepresentationCatalogPort,
      activities:{command:async(c:{requestId:string})=>fixtures.find(f=>f.judgment.dependencies.stage===c.requestId)!.stage} as unknown as ActivityHandoffPort,
      materials:{} as MaterialCustodyPort,signal:new AbortController().signal});
    expect(combined.inheritedChecks).toHaveLength(secondQualified?2:1);
    expect(combined.requirements.map(r=>r.id)).toEqual(["producer_0:r","producer_1:r"]);
    expect(combined.inheritedChecks[0]!.requirementBindings).toEqual([{originalId:"r",combinedId:"producer_0:r"}]);
    expect(combined.sources.every(s=>/^[a-zA-Z0-9_-]{1,64}$/.test(s.alias))).toBe(true);
    expect(combined.sources.map(s=>s.order)).toEqual(combined.sources.map((_,i)=>i));
    expect(combined.producerEvidence.map(p=>p.pathId)).toEqual(["producer","producer2"]);
    expect(combined.relationships.map(r=>r.id)).toEqual(["producer_0:discovered","producer_1:discovered"]);
    for(const relation of combined.relationships)expect(relation.sources.every(a=>combined.sources.some(s=>s.alias===a))).toBe(true);
    expect(combined.sources.filter(s=>s.role==="source")).toHaveLength(secondQualified?2:3);
    expect(combined.producerEvidence[1]!.requestDigest).toBe(modelInputValueDigest(second.method.request));
  });
  it("carries restoration obligations into a later raw-evidence combination instead of silently dropping them",async()=>{
    const f=fixture(),r=f.method.request,restoration={lossId:"precision",sourceAlias:"a",range:r.sources[0]!.access.range,description:"Exact flag"};
    f.method.request={...r,method:"restore",restorations:[restoration]};
    const combined=await methodCombinationEvidence({producers:[{pathId:"producer",method:f.method,candidates:f.method.candidates}],qualified:false,
      representations:{command:async()=>({holds:[]})} as unknown as RepresentationCatalogPort,activities:{} as ActivityHandoffPort,
      materials:{} as MaterialCustodyPort,signal:new AbortController().signal});
    expect(combined.requirements.map(r=>r.id)).toEqual(["r","restore:precision"]);
    expect(combined.producerEvidence[0]!.requirements[1]).toEqual({originalId:"restore:precision",combinedId:"restore:precision"});
  });
  it("inherits an accepted exact local judgment while keeping its scope distinct from the new check",async()=>{
    const f=fixture(),result=await f.read();
    expect(result?.sources.map(s=>[s.alias,s.originalRole])).toEqual([["qualified_0","qualified_representation"]]);
    expect(result?.inheritedChecks).toMatchObject({producerPathId:"producer",assessments:[{rawResultId:"raw",judgmentIds:["judgment"]}],
      sourceRanges:f.method.request.sources.map(s=>s.access.range),candidates:[{qualifiedSource:"qualified_0"}]});
    expect(result?.sources.some(s=>s.access.range.materialId==="a")).toBe(false);
  });
  it("carries discovered relationships with the qualified evidence instead of only copying declared constraints",async()=>{
    const f=fixture(true),result=await f.read();
    expect(result?.relationships).toEqual([{...f.method.candidates[0]!.relationships[0],sources:["qualified_0"]}]);
    expect(result?.inheritedChecks?.relationships).toEqual(f.method.candidates[0]!.relationships);
  });
  it.each([true,false])("follows the actual model dispatch's original preparation binding (valid: %s)",async valid=>{
    const f=fixture(),prior=f.stage.request.input.method;
    const dispatch={...f.stage,request:{pathId:"producer",stageKind:"model",input:{kind:"prepared_context_input",preparationStageId:"prepared",
      demand:{dependencies:{scope:valid?modelInputValueDigest({request:prior.request,job:prior.current}):"changed"}}}}};
    const prepared={status:"accepted",request:{pathId:"producer",input:{method:prior}}};
    const result=await qualifiedMethodSources({producerPathId:"producer",method:f.method,candidates:f.method.candidates,
      representations:{command:async()=>f.judgment} as unknown as RepresentationCatalogPort,
      activities:{command:async(c:{requestId:string})=>c.requestId==="prepared"?prepared:dispatch} as unknown as ActivityHandoffPort,signal:new AbortController().signal});
    expect(!!result).toBe(valid);
  });
  it.each(["range","requirement","producer","acceptance","raw","conditions","scope","subject","unknown"])("does not inherit changed or incomplete %s evidence",async kind=>{
    const f=fixture();
    if(kind==="range")Object.assign(f.method.candidates[0]!.access.range,{version:"2"});
    if(kind==="requirement")Object.assign(f.method.request,{objective:"Changed purpose"});
    if(kind==="producer")f.stage.request.pathId="sibling";
    if(kind==="acceptance")f.stage.receipt.id="other";
    if(kind==="raw")f.stage.result.id="other";
    if(kind==="conditions")f.judgment.dependencies.conditions="other";
    if(kind==="scope")Object.assign(f.method.assessments[0]!,{scope:"source"});
    if(kind==="subject")f.judgment.subjects=[{id:"different",revision:"1"}];
    if(kind==="unknown")f.judgment.conclusion="unknown";
    expect(await f.read()).toBeNull();
  });
});
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
    const units=methodTextUnits(source,text,4);
    expect(units.map(u=>[u.source.access.range.start,u.source.access.range.end])).toEqual([[10,14],[14,18],[18,35],[35,39]]);
    expect(units.map(u=>bytes.subarray(u.source.access.range.start-10,u.source.access.range.end-10).toString()).join("")).toBe(text);
    expect(methodTextUnits({...source,division:undefined},text,4)).toEqual([]);
    expect(methodTextUnits({...source,access:{...source.access,range:{...source.access.range,end:26}}},"abcdefghijklmnop",4)).toEqual([]);
    expect(()=>methodTextUnits(source,text+"x",4)).toThrow("bytes_mismatch");
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
    const judgment={id:"prior",runId:r.recipient.runId,evidenceSources:[],kind:"semantic",conclusion:"supported",methodRevision:"bidirectional:1",dependencies:{conditions,stage:"original",acceptance:"accepted",rawResult:"raw"},subjects:[{id:"c",revision:"1"}],basis:"Original accepted findings"} as RepresentationJudgment;
    const catalog:RepresentationCatalogPort={command:async()=>judgment};
    const activities={command:async()=>({status:"accepted",result:{id:"raw"},receipt:{id:"accepted",progress:{method:{assessments:[{...normalized,scope:"both",supported:true,judgmentIds:["prior"],rawResultId:"raw"}]}}}})} as ActivityHandoffPort;
    expect(await findMethodAssessmentReuse(catalog,activities,{...r,reuseJudgments:["prior"]},j,sources,new AbortController().signal)).toMatchObject({judgmentId:"prior"});
    expect(await findMethodAssessmentReuse(catalog,activities,{...r,reuseJudgments:["prior"],objective:"different"},j,sources,new AbortController().signal)).toBeNull();
    expect(await findMethodAssessmentReuse(catalog,{command:async()=>null},{...r,reuseJudgments:["prior"]},j,sources,new AbortController().signal)).toBeNull();
    expect(methodAssessmentConditions({...r,combinationDigest:"new exact input"},j,sources)).not.toBe(conditions);
  });
});
