import {describe,it,expect} from "vitest";
import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {bindModelAgentComposition,OPENAI_RESPONSES} from "@agent-anything/model-interaction/protocol";
import {OPENAI_RESPONSES_ADAPTER} from "@agent-anything/provider-integrations/native";
import type {ActivityHandoffPort,ActivitySnapshot} from "@agent-anything/agent-runtime/activity";
import {SOURCE_MATERIAL_PUBLICATION_PURPOSE,type PublishedSourceMaterial,type SourceMaterialPublicationRequest} from "@agent-anything/agent-runtime/context-representation";
import {HelarcNativeWorkingInput} from "./HelarcNativeWorkingSources.js";
import {planHelarcNativeSourcePublications,helarcNativeSourceBytes} from "./HelarcNativeSourcePublications.js";
import {helarcNativeAccountScopes} from "./HelarcNativeAccountScopes.js";
import {supplyHelarcNativeAccountMethod,supplyHelarcNativeAccountMethods,resupplyHelarcNativeAccountMethod} from "./HelarcNativeAccountMethodSupply.js";
const ref=(id:string)=>({id,revision:"1"}),protocol=OPENAI_RESPONSES;

function published(r:SourceMaterialPublicationRequest):PublishedSourceMaterial {
  const range={...r.intent.version.ref,start:0,end:r.intent.version.bytes!,coordinate:"bytes" as const};
  return {kind:"published_source_material",version:r.intent.version,access:{id:`${r.intent.id}:source-access`,holdId:`${r.intent.id}:consumer-hold`,recipient:r.recipient,range},
    representation:{ref:{id:`${r.intent.id}:original`,revision:range.version},runId:r.recipient.runId,owner:r.intent.owner,form:"original",target:r.target,purpose:r.purpose,
      body:range,inputs:[{role:"source",material:range,representation:null}],declaredCoverage:[range],holds:[],details:[],requirements:[],losses:[],restorations:[],method:null}};
}
function fixture(later=false){
  const w=new HelarcNativeWorkingInput();
  for(const id of ["goal","response","result"]){
    w.append([{role:id==="response"?"assistant":"user",content:id}],{id,originRunId:"original-run",sources:[{source:{owner:"native",kind:"record",...ref(id)},position:""}],
      duties:[id==="goal"?"objective":"continuity"],preservation:{obligations:[{id,requirement:id==="goal"?"exact":"account",basis:"Keep the facts and uncertainty"}],relationships:[]},
      exchangeId:id==="goal"?null:"exchange",protection:[],acceptedBy:{runId:"root",activityId:"accepted",acceptance:ref("accepted")},representations:[]});
  }
  if(later)w.append([{role:"assistant",content:"Independent later evidence"}],{...w.snapshot().groups[1]!,id:"later",exchangeId:null});
  const snapshots=new Map<string,ActivitySnapshot>();
  const activities={command:async(c:any)=>{
    expect(c.kind).toBe("read_snapshot");expect(c.requestIds).toEqual([`${c.pathId}:capture`]);
    return snapshots.get(c.pathId)??{path:null,stages:[],inputNeeds:[]};
  }} as ActivityHandoffPort;
  const recipient={runId:"root",recipient:"agent",purpose:"task"},sources=w.snapshot();
  const input={items:w.items,sources,recipient,target:"config:1",observedAt:"2026-11-16T00:00:00Z",maximumSourceBytes:100000,activities,signal:new AbortController().signal};
  const composition=bindModelAgentComposition({agent:ref("agent"),protocol,configuration:{protocol,configuration:ref("config"),model:"controlled",connectionBinding:ref("connection")},
    adapter:{protocol,implementation:OPENAI_RESPONSES_ADAPTER},task:{purpose:ref("task"),input:{protocol,implementation:ref("task-input")},interpreter:{protocol,implementation:ref("task-decision")}},
    auxiliary:[{purpose:ref("context_representation"),input:{protocol,implementation:ref("method-input")},interpreter:{protocol,implementation:ref("method-result")}}]});
  function accept(plan:Awaited<ReturnType<typeof planHelarcNativeSourcePublications>>[number]){
    const r=plan.request;
    snapshots.set(plan.pathId,{path:{intent:{id:plan.pathId,runId:"root",owner:"material-source",purpose:{contract:SOURCE_MATERIAL_PUBLICATION_PURPOSE,digest:digest(SOURCE_MATERIAL_PUBLICATION_PURPOSE)}},
      progress:published(r),cancelled:false},stages:[{request:{id:`${plan.pathId}:capture`,pathId:plan.pathId,stageKind:"capture",input:r},status:"accepted",receipt:{id:"receipt"}}],inputNeeds:[]} as unknown as ActivitySnapshot);
  }
  async function supplied(){
    (await planHelarcNativeSourcePublications(input)).forEach(accept);
    const publications=await planHelarcNativeSourcePublications(input);
    const scope=helarcNativeAccountScopes({runId:"root",items:w.items,sources,maximum:16,backgroundGroupIds:["goal"]}).scopes[0]!;
    return {items:w.items,sources,scope,publications,sourceRecipient:recipient,target:input.target,authorizationBasis:"authority",composition,backgroundGroupIds:["goal"],
      capacity:{limits:[],reservations:[],policy:{id:"capacity",revision:"1",purpose:"task",basis:"Explicit unknown token capacity",allowUnknown:true,allowEstimatedFit:false},maximumCombinations:4,maximumMeasurements:0},
      bounds:{readBytes:100000,storedBytes:100000,modelCalls:4,repairs:0,levels:2,pageBytes:4096,ranges:16},limits:{maximumStages:64,maximumAttempts:64},addresses:[]};
  }
  return {input,w,accept,snapshots,supplied};
}

describe("native source custody and account supply",()=>{
  it("retains exact native groups and original provenance under the admitted recipient",async()=>{
    const f=fixture(),plans=await planHelarcNativeSourcePublications(f.input);
    expect(plans.every(p=>p.state==="new"&&p.request.intent.version.origin.runId==="root")).toBe(true);
    const body=JSON.parse(Buffer.from(plans[1]!.request.bytesBase64,"base64").toString());
    expect(body).toMatchObject({originRunId:"original-run",exchangeId:"exchange",items:[{role:"assistant",content:"response"}]});
    expect(body).not.toHaveProperty("occurrence");expect(plans[0]!.request).not.toHaveProperty("deliveries");
  });
  it("reuses original publication after receipt, time and position change",async()=>{
    const f=fixture(),plans=await planHelarcNativeSourcePublications(f.input);plans.forEach(f.accept);
    const resumed=await planHelarcNativeSourcePublications({...f.input,observedAt:"2026-11-17T00:00:00Z"});
    expect(resumed.map(p=>p.request)).toEqual(plans.map(p=>p.request));expect(resumed.every(p=>p.state==="published")).toBe(true);
    const g=f.input.sources.groups[1]!;
    expect(helarcNativeSourceBytes({...g,protection:["first_delivery"],acceptedBy:null,occurrence:{...g.occurrence,start:0}},f.w.items.slice(1)))
      .toEqual(helarcNativeSourceBytes(g,f.w.items));
  });
  it("keeps source identity but separates a successor's independently owned capture",async()=>{
    const f=fixture(),first=await planHelarcNativeSourcePublications(f.input);
    const next=await planHelarcNativeSourcePublications({...f.input,recipient:{...f.input.recipient,runId:"next-run"},observedAt:"2026-11-17T00:00:00Z"});
    expect(next[0]!.request.intent.version.ref.materialId).not.toBe(first[0]!.request.intent.version.ref.materialId);
    expect(next[0]!.request.bytesBase64).toBe(first[0]!.request.bytesBase64);
    expect(next[0]!.request.intent.version.origin.runId).toBe("next-run");
    expect(next[0]!.group).toEqual(first[0]!.group);
  });
  it("does not accept modified retained bytes or a forged published version",async()=>{
    const f=fixture(),plans=await planHelarcNativeSourcePublications(f.input);plans.forEach(f.accept);
    const snapshot=f.snapshots.get(plans[0]!.pathId)!;
    (snapshot.path!.progress as PublishedSourceMaterial).version={...(snapshot.path!.progress as PublishedSourceMaterial).version,label:"changed"};
    await expect(planHelarcNativeSourcePublications(f.input)).rejects.toThrow("source_publication_evidence_mismatch");
  });
  it("bounds capture before admission and does not fabricate a completed publication",async()=>{
    const f=fixture();await expect(planHelarcNativeSourcePublications({...f.input,maximumSourceBytes:1})).rejects.toThrow("native_source_capture_limit");
    const plans=await planHelarcNativeSourcePublications(f.input);plans.forEach(f.accept);
    const s=f.snapshots.get(plans[0]!.pathId)!;(s.path as any).progress=null;
    expect((await planHelarcNativeSourcePublications(f.input))[0]!.state).toBe("pending");
  });
  it("offers original native method composition, access admissions and an indivisible exchange",async()=>{
    const input=await fixture().supplied(),offer=supplyHelarcNativeAccountMethod(input);
    expect(offer.request.template).toBeUndefined();expect(offer.request.nativeComposition).toEqual(input.composition);
    expect(offer.request.sources.map(s=>[s.role,s.indivisibleGroup])).toEqual([["background","goal"],["source","exchange"],["source","exchange"]]);
    expect(offer.materialAdmissions).toHaveLength(3);expect(offer.request.deliveryIds).toEqual([]);
    expect(offer.option.capability.every(c=>c.conclusion==="unknown")).toBe(true);
    expect(offer.request.requirements).toHaveLength(2);
  });
  it.each(["scope","target","publication","recipient"])("rejects changed %s rather than weakening the source binding",async kind=>{
    const i=await fixture().supplied();
    if(kind==="scope")i.scope={...i.scope,requirements:[]};
    if(kind==="target")i.target="another:1";
    if(kind==="publication")i.publications=i.publications.slice(1);
    if(kind==="recipient")i.sourceRecipient={...i.sourceRecipient,runId:"child"};
    expect(()=>supplyHelarcNativeAccountMethod(i)).toThrow();
  });
  it("reports incomplete new enumeration and restores original scopes independently",async()=>{
    const i=await fixture(true).supplied(),all=supplyHelarcNativeAccountMethods({...i,maximum:16});
    expect(all.offers).toHaveLength(3);expect(all.report.enumeration.complete).toBe(true);
    const bounded=supplyHelarcNativeAccountMethods({...i,maximum:1}),original=all.offers.at(-1)!;
    expect(bounded.report.enumeration).toEqual({complete:false,eligible:3,returned:1});
    expect(bounded.offers.some(o=>o.option.id===original.option.id)).toBe(false);
    expect(resupplyHelarcNativeAccountMethod(i,original.option)).toEqual({kind:"available",supply:original});
    expect(bounded.report.unavailable).toContainEqual({groupId:"goal",reasons:["exact_preservation"]});
  });
  it("does not recreate original work using changed bounds or unavailable custody",async()=>{
    const i=await fixture().supplied(),original=supplyHelarcNativeAccountMethod(i);
    expect(resupplyHelarcNativeAccountMethod({...i,bounds:{...i.bounds,modelCalls:5}},original.option))
      .toEqual({kind:"unavailable",reason:"original_native_method_conditions_changed"});
    expect(resupplyHelarcNativeAccountMethod({...i,publications:i.publications.slice(1)},original.option))
      .toEqual({kind:"unavailable",reason:"original_native_source_unavailable"});
  });
});
