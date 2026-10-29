import {describe,expect,it} from "vitest";
import {OllamaProvider} from "@agent-anything/provider-integrations/ollama";
import {createNativeToolTurnInteraction,type ProviderRequest} from "@agent-anything/model-interaction";
import {composeModelInput,organizeOriginalInput} from "@agent-anything/model-interaction/input";
import {ContextInputPreparationHandler,firstContextInputPreparationStage,decideContextPreparation,contextPreparationApplicabilityKey,
  quoteRepresentationMethod,contextEmpiricalRange,timingSupportsPreparation,contextPreparationAdmissionKey,
  type ContextPreparationPolicyInput,type ContextPreparationOption,type ContextPolicyEvidence,type PreparedContextInput,
  type ContextComparableObservation,type RepresentationMethodRequest} from "@agent-anything/agent-runtime/context-representation";
import type {ActivityPathState,ActivityStageState,ActivityAttempt} from "@agent-anything/agent-runtime/activity";

const ref=(id:string):ContextPolicyEvidence=>({id,owner:"test-owner",revision:"1",kind:"fact"});
async function fixture():Promise<ContextPreparationPolicyInput> {
  const provider=new OllamaProvider({model:"controlled",baseUrl:"http://127.0.0.1:1",timeoutMs:1000,nativeToolInteraction:{supported:true},think:false,runtime:{contextWindowTokens:16384},requestBodyTransportLimit:{maximumBytes:1000000,source:"host_configured",revision:"1"}});
  const source=(id:string)=>({id,owner:"test-owner",kind:"record",revision:"1"});
  const interaction=createNativeToolTurnInteraction([{name:"final_result",description:"Finish",inputSchema:{type:"object",properties:{},additionalProperties:false}}]);
  const lineage=Object.fromEntries(["instructionBinding","agent","instructions","instructionRelease","instructionResolver","instructionContent","activeContext","contextProjection","projectionManifest","toolSelection","toolExposureContent","toolExposureBasis","toolExposureProof","toolGuidance","controllerControlGuidance","callableDefinitions","protocol","policy"].map(k=>[k,source(k)]));
  Object.assign(lineage,{instructionModel:{providerId:provider.modelContext.target.providerId,model:"controlled"},instructionBlocks:[],modelQualification:null,interactionHistory:null});
  const composition=composeModelInput({id:"original",providerId:provider.descriptor.id,model:"controlled",interaction,lineage:lineage as unknown as ProviderRequest["composition"]["lineage"],composedAt:"2026-10-29T00:00:00.000Z",
    sections:[{id:"task",kind:"task",source:source("task"),role:"user",necessity:"mandatory",content:{kind:"text",text:"Preserve the original requirements."}}]});
  const template:ProviderRequest={requestId:composition.id,purpose:"task",correlation:{controllerRequestId:"demand",branchId:"main"},instructions:composition.instructions,messages:composition.messages,interaction,composition,
    modelContext:{requestedOutput:provider.modelContext.requestedOutput,headroom:{unit:"tokens",amount:0,policy:{id:"test",revision:"1"}},assessment:null},continuation:null,metadata:{}};
  const target=provider.encodeInput!(template,"buffered").targetDigest;
  const demand=organizeOriginalInput({demand:{id:"demand",runId:"root",recipient:"agent",purpose:"task",targetRevision:target,historyBoundary:"H",deliveryIds:[],dependencies:{source:"1"},maximumCombinations:4,maximumExternalMeasurements:0,maximumReadBytes:65536},composition,
    groups:[{id:"task",owner:"test-owner",revision:"1",sectionIds:["task"],duties:["objective"],deliveryIds:[]}]});
  const request=firstContextInputPreparationStage("prepare",{kind:"context_input_preparation",demand,template,limits:[],reservations:[],policy:{id:"test",revision:"1",purpose:"task",basis:"unknown capacity may be attempted without a contrary hard finding",allowEstimatedFit:true,allowUnknown:true},allowExternalMeasurement:false,deliveryMode:"buffered",localMeasurements:[],sharedCapacity:null,materialAccesses:[]});
  const handler=new ContextInputPreparationHandler({provider,materials:{command:async()=>{throw new Error("No material reads expected");}},authorize:async()=>{},now:()=>"2026-10-29T00:00:00.000Z"});
  const raw=await handler.execute({} as ActivityPathState,{request} as ActivityStageState,{id:"attempt"} as ActivityAttempt,new AbortController().signal);
  const prepared=(raw.value as {kind:string;prepared:PreparedContextInput}).prepared;expect(prepared).toBeDefined();
  return {scope:{id:"scope",runId:"root",recipient:"agent",purpose:"task",continuity:"main",owner:"context-representation",target,authorityBasis:"host"},boundary:"H",requirementsDigest:"requirements:1",
    current:{kind:"prepared",prepared,evidence:ref("current")},currentRejectedInputId:null,alternatives:[],pressure:[],options:[],inFlight:[],explorationHistory:[],optionalInFlight:0,autoPrepare:true,consumerActive:true};
}
function option(input:ContextPreparationPolicyInput):ContextPreparationOption {
  if(input.current.kind!=="prepared")throw new Error("fixture needs template");
  const recipient={runId:"root",recipient:"context-representation",purpose:"auxiliary"},request:RepresentationMethodRequest={kind:"representation_method",method:"summarize",methodRevision:"1",recipient,objective:"Preserve the actual agreement",sourceBoundary:"H",deliveryIds:[],combinationDigest:null,combine:"keep",omission:null,search:null,
    sources:[{alias:"source",role:"source",access:{id:"access",holdId:"hold",recipient,range:{materialId:"source",version:"1",start:0,end:100,coordinate:"bytes"}},representation:null,order:0,label:"original",originalRole:"user",indivisibleGroup:"source"}],requirements:[],relationships:[],
    template:{...input.current.prepared.request,purpose:recipient.purpose},targetRevision:input.scope.target,
    capacity:{limits:[],reservations:[],policy:{id:"test",revision:"1",purpose:recipient.purpose,basis:"test",allowEstimatedFit:true,allowUnknown:true},maximumCombinations:32,maximumMeasurements:8},bounds:{readBytes:65536,storedBytes:65536,modelCalls:32,repairs:1,levels:4,pageBytes:65536,ranges:64}};
  return {id:"method",request,stableScope:ref("scope-closed"),addresses:["pressure","current"],entries:quoteRepresentationMethod(request).phases.map(p=>({phase:p.kind,state:"unknown",evidence:ref(`entry:${p.kind}`)})),limits:{maximumStages:2048,maximumAttempts:4096},capability:[],comparisons:[]};
}
describe("normal context policy with actual T03 input preparation",()=>{
  it("keeps a lawful input with unknown capacity, without manufacturing a compaction request",async()=>{
    const input=await fixture(),result=decideContextPreparation(input);
    expect(result.foreground).toMatchObject({kind:"continue",adoption:"keep"});
    expect(result.investment).toEqual({kind:"none",reason:"no_current_gap_or_supported_opportunity"});
  });
  it("proposes opportunity work before obstruction without making the foreground wait",async()=>{
    const input=await fixture(),proposal=option(input);
    const request={...input,options:[proposal],pressure:[{kind:"growth_scenario" as const,evidence:ref("pressure"),timing:null}]};
    const result=decideContextPreparation(request);
    expect(result.foreground.kind).toBe("continue");
    expect(result.investment).toMatchObject({kind:"propose",reason:"opportunity",explorationKey:expect.any(String)});
    if(result.investment.kind!=="propose")throw new Error("Expected proposal");
    const again=decideContextPreparation({...request,explorationHistory:[{key:result.investment.explorationKey!,decisionId:result.id}]});
    expect(again.investment.kind).toBe("defer");
    expect(again.excluded[0]?.reasons).toContain("same_opportunity_exploration_already_attempted");
  });
  it("requires complete method entry evidence and does not treat a known blocked check as residual uncertainty",async()=>{
    const input=await fixture(),proposal=option(input);
    const result=decideContextPreparation({...input,currentRejectedInputId:(input.current as Extract<typeof input.current,{kind:"prepared"}>).prepared.encoded.id,
      options:[{...proposal,entries:proposal.entries.map(e=>e.phase==="check"?{...e,state:"blocked"}:e)}]});
    expect(result.foreground.kind).toBe("limited");expect(result.excluded[0]?.reasons).toContain("entry_blocked:check");
  });
  it("uses only an actual accepted producer as a foreground dependency and keeps its original identity",async()=>{
    const input=await fixture(),key=contextPreparationApplicabilityKey(input);
    const inFlight=[{workId:"original",pathId:"path",applicabilityKey:key,producerState:"active" as const,evidence:ref("accepted-producer")}];
    expect(decideContextPreparation({...input,inFlight}).foreground.kind).toBe("continue");
    if(input.current.kind!=="prepared")throw new Error("fixture");
    const result=decideContextPreparation({...input,currentRejectedInputId:input.current.prepared.encoded.id,inFlight});
    expect(result.foreground).toEqual({kind:"needs_result",workId:"original",pathId:"path"});
    expect(decideContextPreparation({...input,currentRejectedInputId:input.current.prepared.encoded.id,inFlight:inFlight.map(w=>({...w,producerState:"unknown"}))}).foreground.kind).toBe("limited");
    expect(contextPreparationApplicabilityKey({...input,scope:{...input.scope,runId:"child"}})).not.toBe(key);
  });
  it("does not turn a weak-model observation into a prohibition, but requires an explicit response to the limitation",async()=>{
    const input=await fixture(),proposal=option(input),evidence={duty:"generation" as const,conclusion:"limited" as const,targetRevision:input.scope.target,methodRevision:"1",evidence:ref("limited-generation"),response:null};
    const basis={...input,pressure:[{kind:"growth_scenario" as const,evidence:ref("pressure"),timing:null}],options:[{...proposal,capability:[evidence]}]};
    expect(decideContextPreparation(basis).investment.kind).toBe("defer");
    expect(decideContextPreparation({...basis,options:[{...proposal,capability:[{...evidence,response:ref("preserve-original-and-check")}]}]}).investment.kind).toBe("propose");
    expect(decideContextPreparation({...basis,autoPrepare:false}).investment).toMatchObject({kind:"none",reason:"automatic_preparation_disabled"});
    const mismatched=decideContextPreparation({...basis,options:[{...proposal,capability:[{...evidence,targetRevision:"other-model-settings"}]}]});
    expect(mismatched.investment).toMatchObject({kind:"propose",uncertainty:expect.arrayContaining(["capability_unknown:generation"])});
  });
  it("does not regenerate a ready result or pretend its readiness adopted the recipient input",async()=>{
    const input=await fixture(),work={workId:"original",pathId:"path",applicabilityKey:contextPreparationApplicabilityKey(input),producerState:"ready" as const,evidence:ref("ready-result")};
    const result=decideContextPreparation({...input,inFlight:[work]});
    expect(result.foreground).toMatchObject({kind:"continue",adoption:"keep"});
    expect(result.investment).toMatchObject({kind:"defer",reason:"retained_result_requires_recipient_input_organization"});
    expect(decideContextPreparation({...input,consumerActive:false}).foreground).toEqual({kind:"limited",reason:"no_active_consumer"});
  });
  it("requires an explicit original-work revision after failure and never restarts an unknown producer",async()=>{
    const input=await fixture(),proposal=option(input),work={workId:"original",pathId:"failed-path",applicabilityKey:contextPreparationApplicabilityKey(input),producerState:"failed" as const,evidence:ref("failure")};
    const basis={...input,inFlight:[work],options:[proposal],pressure:[{kind:"growth_scenario" as const,evidence:ref("pressure"),timing:null}]};
    expect(decideContextPreparation(basis).investment).toMatchObject({kind:"defer",reason:"original_path_requires_bounded_revision"});
    const replaces={workId:work.workId,pathId:work.pathId,evidence:ref("revised-source-division")};
    expect(decideContextPreparation({...basis,options:[{...proposal,replaces}]}).investment).toMatchObject({kind:"propose",replaces});
    expect(decideContextPreparation({...basis,inFlight:[{...work,producerState:"unknown"}],options:[{...proposal,replaces}]}).investment)
      .toMatchObject({kind:"defer",reason:"original_producer_outcome_unknown"});
  });
  it("does not promote an untested successor to a demonstrated gap",async()=>{
    const input=await fixture(),proposal=option(input);
    expect(decideContextPreparation({...input,options:[proposal],pressure:[{kind:"successor_gap",evidence:ref("pressure"),
      input:{reason:"bounded search incomplete",demandId:"future",targetRevision:input.scope.target,information:[],capacity:[],untested:true,responsibility:"request_owner"}}]}).investment.kind).toBe("none");
  });
  it("does not retry a rejected arrangement until its relevant conditions change",async()=>{
    const input=await fixture(),proposal=option(input);
    const basis={...input,options:[proposal],pressure:[{kind:"growth_scenario" as const,evidence:ref("pressure"),timing:null}],
      admissionLimitations:[{optionId:proposal.id,conditionsDigest:contextPreparationAdmissionKey(input,proposal),acceptanceId:"rejected",code:"activity_schedule_resource_unavailable"}]};
    expect(decideContextPreparation(basis).investment.kind).toBe("defer");
    expect(decideContextPreparation({...basis,options:[{...proposal,admissionConditions:[ref("changed-host-pool")]}]}).investment.kind).toBe("propose");
    expect(decideContextPreparation({...basis,admissionResponse:"rejected"}).investment).toMatchObject({kind:"defer",reason:"admission_rejected:activity_schedule_resource_unavailable"});
  });
  it("does not add future pressure to current occupancy or compare queue-free time as a complete path",()=>{
    const timing={preparation:{minimum:10,maximum:20},pressure:{minimum:30,maximum:40},evidence:[ref("actual-path")],includesQueue:true,arrangement:"critical_path" as const};
    expect(timingSupportsPreparation(timing)).toBe("later");
    expect(timingSupportsPreparation({...timing,preparation:{minimum:10,maximum:35}})).toBe("now");
    expect(timingSupportsPreparation({...timing,includesQueue:false})).toBe("unknown");
  });
  it("does not call a one-dimensional saving a net improvement",async()=>{
    const input=await fixture(),proposal=option(input);
    const saving={dimension:"billed_tokens" as const,basis:ref("cost-sample"),coverage:"remaining_path_and_use" as const,baseline:{minimum:200,maximum:300},alternative:{minimum:50,maximum:100}};
    const pressure={kind:"optional_improvement" as const,evidence:ref("pressure"),comparisons:[saving]};
    expect(decideContextPreparation({...input,options:[{...proposal,comparisons:[saving]}],pressure:[pressure]}).investment.kind).toBe("none");
    const comparisons=(["external_calls","billed_tokens","elapsed_ms","retained_bytes","detail_accesses"] as const).map(d=>({...saving,dimension:d}));
    expect(decideContextPreparation({...input,options:[{...proposal,comparisons}],pressure:[{...pressure,comparisons}]}).investment).toMatchObject({kind:"propose",reason:"optional"});
    expect(decideContextPreparation({...input,options:[{...proposal,comparisons}],pressure:[{...pressure,comparisons:comparisons.map(c=>c.dimension==="elapsed_ms"?{...c,alternative:{minimum:0,maximum:null}}:c)}]}).investment.kind).toBe("none");
  });
  it("retains negative growth and failed samples without promoting them to successful path estimates",()=>{
    const samples:ContextComparableObservation[]=[100,120,90,130].map((value,sequence)=>({evidence:ref(`s${sequence}`),sequence,targetRevision:"target",settingsRevision:"settings",purpose:"task",measurementRevision:"exact",representationContinuity:"original",dimension:"input_size",unit:"tokens",completeness:"complete",outcome:"returned",value}));
    expect(contextEmpiricalRange(samples,samples[0]!,true)).toMatchObject({kind:"empirical_range",minimum:-30,maximum:40});
    const path=samples.map((s,i)=>({...s,dimension:"path_ms" as const,outcome:i===0?"failed" as const:s.outcome}));
    expect(contextEmpiricalRange(path,path[0]!)).toMatchObject({kind:"empirical_range",excluded:[{reason:"incomplete_or_unsuccessful_observation"}]});
    expect(contextEmpiricalRange(samples.slice(0,3),samples[0]!,true).kind).toBe("insufficient");
  });
});
