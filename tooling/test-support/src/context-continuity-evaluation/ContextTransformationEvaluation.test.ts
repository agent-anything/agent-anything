import {describe, expect, it, vi} from "vitest";
import {snapshotProviderRequest, type ProviderRequest} from "@agent-anything/model-interaction";
import {createExactModelWorkingView, createOwnerModelWorkingView, modelInputFromSections, applyModelInputAccounts, type ModelInputSection} from "@agent-anything/model-interaction/input";
import {createContextTransformationBasis, renderContextAccount} from "@agent-anything/model-interaction/context";
import {CONTEXT_TRANSFORMATION_CRITERIA, runContextTransformationTrial, type ContextTransformationTrialPlan,
  type ContextTransformationEvidence, type ContextTransformationTrialEnvironment} from "./ContextTransformationEvaluation.js";

const ref = {owner:"fixture",kind:"source",id:"binding",revision:"1"};
const record = {id:"capture",revision:"1"};
function request(text = "Option 1 retains edges. Option 3 crops them."): ProviderRequest {
  const sections: ModelInputSection[] = [{id:"source",source:{...ref,id:"source",runId:"root"},role:"assistant",kind:"history",necessity:"mandatory",
    content:{kind:"text",text},provenance:{purpose:"history",recipientRunId:"root",author:"assistant",presenter:ref,
      retainedPresentation:ref,sources:[ref],coverage:["source"],limitations:[]},
    preservation:{obligations:[{id:"meaning",requirement:"account",basis:"Retain the applicable method and alternatives."}],relationships:[]}}];
  const projected=modelInputFromSections(sections), interaction={kind:"text_generation" as const};
  return snapshotProviderRequest({requestId:"before",purpose:"working",correlation:{controllerRequestId:"controller",branchId:"main"},
    ...projected,interaction,continuation:null,metadata:{},modelContext:{requestedOutput:{unit:"tokens",maximum:null,source:"unspecified",revision:"1"},
      headroom:{unit:"tokens",amount:0,policy:{id:"none",revision:"1"}},assessment:null},
    composition:{id:"before",providerId:"fixture",model:"fixture",...projected,interaction,sections,
      workingView:createExactModelWorkingView({sections,recipientRunId:"root",boundary:"request"}),composedAt:"2026-10-23T00:00:00.000Z",
      lineage:{instructionBinding:ref,agent:ref,instructions:ref,instructionRelease:ref,instructionResolver:ref,instructionContent:ref,
        instructionModel:{providerId:"fixture",model:"fixture"},instructionBlocks:[],activeContext:null,contextProjection:null,projectionManifest:null,
        toolSelection:null,toolExposureContent:null,toolExposureBasis:null,toolExposureProof:null,toolGuidance:null,controllerControlGuidance:null,
        callableDefinitions:null,modelQualification:null,interactionHistory:ref,protocol:ref,policy:ref}}});
}
function transformed(before: ProviderRequest, text: string) {
  const basis=createContextTransformationBasis(before,before.composition.sections.map(section=>section.id),"root");
  const account=renderContextAccount(basis,{entries:[{text,sources:basis.sources.map(section=>section.id)}],limitations:[],omittedDetails:[]},ref,"independent-basis");
  const sections=applyModelInputAccounts(before.composition.sections,[account],"root"), projected=modelInputFromSections(sections);
  return snapshotProviderRequest({...before,requestId:"after",...projected,composition:{...before.composition,id:"after",...projected,sections,
    workingView:createOwnerModelWorkingView({sections,recipientRunId:"root",boundary:"request",forms:[],accounts:[...(before.composition.workingView.accounts??[]),account]})}});
}
function evidence(request:ProviderRequest):ContextTransformationEvidence {return {request,capturedRequest:record,captureComplete:true,attempts:[],outcomes:null};}
function plan(source=request()):ContextTransformationTrialPlan {return {ref:{id:"trial",revision:"1"},caseRef:{id:"case",revision:"1"},targetSnapshot:record,environment:record,
  mode:"evidence_audit",replicateKey:"fixed-1",armOrder:["retained","transformed"],source:evidence(source),candidate:evidence(transformed(source,"1 retains edges; 3 crops them.")),
  oracle:{ref:{id:"oracle",revision:"1"},expectedFacts:["1 retains edges"],permissibleOutcomes:["retain edges"]},heldOutFollowUps:["Use option 1 now."],timeoutMs:1000};}
const judge = async () => CONTEXT_TRANSFORMATION_CRITERIA.map(criterion=>({criterion,verdict:"adequate" as const,reason:"Independent fixture expectation.",evidence:[record]}));

describe("Context transformation evaluation",()=>{
  it("audits actual source lineage but does not turn structural validity into semantic approval",async()=>{
    const report=await runContextTransformationTrial(plan());
    expect(report.structural.every(check=>check.passed===true)).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.exclusions).toContain("independent_semantic_assessment_unavailable");
    expect(report.captures).toHaveLength(1);
    const repeated=plan(transformed(request(),"1 retains edges; 3 crops them."));
    expect((await runContextTransformationTrial(repeated,{judge})).structural.find(check=>check.check==="source_bound_representation")?.passed).toBe(true);
  });
  it("keeps negative and unknown independent findings even when production accepted a candidate",async()=>{
    const report=await runContextTransformationTrial(plan(),{judge:async()=> (await judge()).map((value,index)=>({...value,
      verdict:index===0?"inadequate" as const:index===1?"unknown" as const:value.verdict}))});
    expect(report.findings.slice(0,2).map(value=>value.verdict)).toEqual(["inadequate","unknown"]);
    expect(report.exclusions).toEqual([]);
  });
  it("does not pass future queries to generation and closes both isolated arms",async()=>{
    const p={...plan(),mode:"continued_execution" as const}, closed:string[]=[], calls:string[]=[];
    const report=await runContextTransformationTrial(p,{judge,open:async arm=>({
      prepare:async(source)=>{calls.push(`${arm}:prepare`); expect(JSON.stringify(source)).not.toContain("Use option 1 now"); return p.candidate!;},
      continue:async(source,queries)=>{calls.push(`${arm}:continue`);expect(queries).toEqual(p.heldOutFollowUps);return evidence(source);},
      close:async()=>{closed.push(arm);return true;}})});
    expect(calls).toEqual(["retained:continue","transformed:prepare","transformed:continue"]);
    expect(closed.sort()).toEqual(["retained","transformed"]);
    expect(report.exclusions).toEqual([]);
  });
  it("bounds timeout, cancels the adapter, closes it and permits a clean subsequent trial",async()=>{
    let aborted=false; const close=vi.fn(async()=>true);
    const environment:ContextTransformationTrialEnvironment={prepare:async()=>new Promise(()=>{}),
      continue:async(_,__,signal)=>new Promise((_,reject)=>signal.addEventListener("abort",()=>{aborted=true;reject(signal.reason);},{once:true})),close};
    const report=await runContextTransformationTrial({...plan(),mode:"continued_execution",timeoutMs:30},{open:async()=>environment});
    expect(report.exclusions).toContain("context_trial_timeout");expect(aborted).toBe(true);expect(close).toHaveBeenCalledOnce();
    expect((await runContextTransformationTrial(plan(),{judge})).exclusions).toEqual([]);
  });
  it("deduplicates physical attempts and does not add inclusive cache usage twice",async()=>{
    const p=plan(), attempt={id:"attempt",purpose:"context_generation",usage:{inputTokens:100,outputTokens:10,totalTokens:110,costUnits:null,
      metadata:{cachedInputTokens:80}},durationMs:50};
    const report=await runContextTransformationTrial({...p,candidate:{...p.candidate!,attempts:[attempt,attempt]}},{judge});
    expect(report.costs[1]).toMatchObject({attempts:1,inputTokens:100,outputTokens:10,requestDurationMs:50});
    const invalid=await runContextTransformationTrial({...p,candidate:{...p.candidate!,attempts:[attempt,{...attempt,durationMs:80}]}},{judge});
    expect(invalid.exclusions).toContain("transformed:attempt_accounting_invalid");
  });
  it.each([
    ["options","Option 1 retains edges; initial choice was 3; user later chose 1."],
    ["long output","Command exited 1. Output frontier 9000, immutable material M1 remains readable; absence of later output is unknown."],
    ["bug list","A is fixed and tested; B is changed but untested; C remains open."],
    ["continuing method","Images 2-5 use method M1; user amended to M2 for images 6-10; earlier results stay M1."],
    ["child report","Child reported a successful build; Parent has not independently verified it; source is Child result C1."],
  ])("retains independent expectations for %s instead of grading against the generated account",async(_,text)=>{
    const p=plan(request(text));
    const result=await runContextTransformationTrial({...p,oracle:{...p.oracle,expectedFacts:text}},
      {judge:async input=>{expect(input.oracle.expectedFacts).toBe(text);expect(JSON.stringify(input.candidate.request)).not.toBe(JSON.stringify(input.source.request));return judge();}});
    expect(result.exclusions).toEqual([]);
  });
});
