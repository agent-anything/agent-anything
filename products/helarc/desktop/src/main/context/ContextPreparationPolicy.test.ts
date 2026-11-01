import {describe,expect,it,vi} from "vitest";
import {OllamaProvider} from "@agent-anything/provider-integrations/ollama";
import {createNativeToolTurnInteraction,type ProviderRequest} from "@agent-anything/model-interaction";
import {composeModelInput,organizeOriginalInput,modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {ContextInputPreparationHandler,firstContextInputPreparationStage,decideContextPreparation,contextPreparationApplicabilityKey,contextPreparationWorkKey,
  quoteRepresentationMethod,contextEmpiricalRange,timingSupportsPreparation,contextPreparationAdmissionKey,contextReceptionAdmissionKey,contextPreparationAdoption,contextPreparationReconsideration,observeContextPreparationInput,
  type ContextPreparationPolicyInput,type ContextPreparationOption,type ContextPolicyEvidence,type PreparedContextInput,
  type ContextComparableObservation,type RepresentationMethodRequest} from "@agent-anything/agent-runtime/context-representation";
import type {ActivityPathState,ActivityStageState,ActivityAttempt,ActivityReconsiderationSnapshot,SharedAcceptanceProposal} from "@agent-anything/agent-runtime/activity";
import {prepareModelInputRecovery,readModelInputRejections,readCurrentModelInputNeed} from "@agent-anything/agent-runtime/model-access";
import type {ActivityInputNeed,ActivityHandoffPort} from "@agent-anything/agent-runtime/activity";

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
  const handler=new ContextInputPreparationHandler({provider,materials:{command:async()=>{throw new Error("No material reads expected");}},authorize:async()=>({kind:"allowed"}),now:()=>"2026-10-29T00:00:00.000Z"});
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
function receiver(proposal:ContextPreparationOption,workId:string,pathId:string) {
  return {id:"receiver",members:[{workId,pathId,requestDigest:modelInputValueDigest(proposal.request)}],addresses:proposal.addresses,comparisons:[],evidence:ref("receiver-option")};
}
describe("normal context policy with actual T03 input preparation",()=>{
  it("keeps a Provider refusal separate from quality and numeric capacity, and extends a different legal scope",async()=>{
    const input=await fixture();if(input.current.kind!=="prepared")throw new Error("fixture");
    const prepared=input.current.prepared,rejection={stageId:"refused-stage",targetRevision:prepared.encoded.targetDigest,bodyDigest:prepared.encoded.bodyDigest,evidence:ref("provider-refusal")};
    const first=option(input),work={workId:"original",pathId:"producer",preparationKey:contextPreparationWorkKey(input.scope,first.request),producerState:"ready" as const,evidence:ref("ready")};
    const received=receiver(first,work.workId,work.pathId),checked={optionId:received.id,pathId:received.id,workId:"receiver-work",state:"checked" as const,reason:null,evidence:ref("checked"),providerRejection:rejection};
    const second={...first,id:"second",request:{...first.request,objective:"Another independent source"},extendsReception:{optionId:received.id,evidence:rejection.evidence}};
    const basis={...input,rejectedInputs:[rejection],options:[first,second],inFlight:[work],receptionOptions:[received],inputReceptions:[checked],alternatives:[{input:input.current,comparisons:[]}]};
    const decision=decideContextPreparation(basis);expect(decision.foreground.kind).toBe("limited");
    expect(decision.investment).toMatchObject({kind:"propose",optionId:second.id,reason:"necessary"});
    expect(prepared.capacity.allowed).toBe(true);expect(checked.state).toBe("checked");
    expect(()=>decideContextPreparation({...basis,rejectedInputs:[]})).toThrow("reception_rejection_invalid");
    expect(()=>decideContextPreparation({...basis,rejectedInputs:[{...rejection,targetRevision:"other"}]})).toThrow("input_rejection_invalid");
  });
  it("restores only an accepted original input-recovery chain and rejects changed ancestry",async()=>{
    const input=await fixture();if(input.current.kind!=="prepared")throw new Error("fixture");
    const path={intent:{id:"task",maximumStages:8,maximumAttempts:8,deadlineAt:"2030-01-01T00:00:00Z",purpose:{contract:{inputOwner:"context-representation",acceptanceOwner:"task-decision"}}},
      cancelled:false,resourceUse:{admittedStages:2,dispatchedAttempts:2}} as ActivityPathState;
    const need:ActivityInputNeed={id:"initial",supplier:"context-representation",stage:{id:"task:model",pathId:"task",stageKind:"model",capabilities:["model-request"],dependencies:[]},
      unavailableStage:{id:"task:unavailable",pathId:"task",stageKind:"input-unavailable",capabilities:[],dependencies:[]}};
    const stage={request:{...need.stage,input:input.current.prepared},status:"raw_result",result:{id:"raw",outcome:"returned",completeness:"complete",
      value:{kind:"failed",failure:{category:"invalid_request",code:"provider_context_window_exceeded",message:"Too long",metadata:{}}}}} as ActivityStageState;
    const needs=new Map([[need.id,need]]),stages=new Map([[stage.request.id,stage]]);
    const activities:ActivityHandoffPort={command:async c=>{
      if(c.kind==="read_input_need")return structuredClone(needs.get(c.id)??null);
      if(c.kind==="read_stage_input_need")return [...needs.values()].find(n=>n.stage.id===c.requestId)??null;
      if(c.kind==="read_stage")return structuredClone(stages.get(c.requestId)??null);
      throw new Error("Recovery may only query accepted facts");
    }};
    const basis={activities,path,stage,sourceStageId:"task:source",acceptanceId:"accepted",now:"2026-11-01T00:00:00Z"};
    const recovery=await prepareModelInputRecovery(basis);expect(recovery).not.toBeNull();
    expect(recovery!.participants).toContainEqual({owner:"context_delivery",kind:"release_selection",proposal:{inputId:"task:model:input",basis:"provider_input_rejected"}});
    Object.assign(stage,{status:"accepted",receipt:{id:"accepted",owner:"task-decision",requestId:stage.request.id,resultId:"raw",progress:recovery!.progress}});
    await expect(readCurrentModelInputNeed(activities,path,need.id,basis.sourceStageId)).rejects.toThrow("successor_missing");
    const next=recovery!.progress.nextNeed;needs.set(next.id,next);
    expect(await readCurrentModelInputNeed(activities,path,need.id,basis.sourceStageId)).toEqual(next);
    expect(await readModelInputRejections(activities,path,next,basis.sourceStageId)).toEqual([recovery!.progress.rejected]);
    for(const changed of [{...next,supplier:"other"},{...next,stage:{...next.stage,pathId:"other"}},{...next,origin:{...next.origin!,receiptId:"wrong"}}])
      await expect(readModelInputRejections(activities,path,changed,basis.sourceStageId)).rejects.toThrow();
    await expect(readModelInputRejections(activities,path,next,"other:source")).rejects.toThrow("receipt_changed");
    expect(await prepareModelInputRecovery({...basis,path:{...path,cancelled:true}})).toBeNull();
    expect(await prepareModelInputRecovery({...basis,path:{...path,resourceUse:{...path.resourceUse,admittedStages:8}}})).toBeNull();
    expect(await prepareModelInputRecovery({...basis,now:path.intent.deadlineAt})).toBeNull();
    expect(await prepareModelInputRecovery({...basis,stage:{...stage,result:{...stage.result!,outcome:"unknown"}}})).toBeNull();
  });
  it("extends a proven recipient capacity gap with a new independent source, without retrying accepted work",async()=>{
    const input=await fixture();if(input.current.kind!=="prepared")throw new Error("fixture");
    const first=option(input),gap={kind:"gap" as const,evidence:ref("current"),gap:{reason:"capacity",demandId:"recipient",targetRevision:input.scope.target,
      information:[],capacity:[{...input.current.prepared.capacity,allowed:false}],untested:false,responsibility:"request_owner" as const}};
    const work={workId:"original",pathId:"producer",preparationKey:contextPreparationWorkKey(input.scope,first.request),producerState:"ready" as const,evidence:ref("ready")};
    const received=receiver(first,work.workId,work.pathId),inputGap={...gap,evidence:ref("actual-recipient-gap")};
    const failed={optionId:received.id,pathId:received.id,workId:"receiver-work",state:"unavailable" as const,reason:"consumer_closed",evidence:ref("closed"),inputGap};
    const second={...first,id:"second",request:{...first.request,objective:"Different source"},extendsReception:{optionId:received.id,evidence:inputGap.evidence}};
    const basis={...input,current:gap,options:[first,second],inFlight:[work],receptionOptions:[received],inputReceptions:[failed]};
    const decision=decideContextPreparation(basis);
    expect(decision.investment).toMatchObject({kind:"propose",optionId:second.id,reason:"necessary"});
    expect(decision.evidence).toContainEqual(inputGap.evidence);
    expect(decision.excluded).toContainEqual({optionId:first.id,reasons:expect.arrayContaining(["original_work_already_accepted"])});
    expect(decideContextPreparation({...basis,options:[first]}).investment).toMatchObject({kind:"defer",reason:"input_reception_requires_bounded_revision"});
    expect(()=>decideContextPreparation({...basis,inputReceptions:[{...failed,inputGap:{...inputGap,gap:{...inputGap.gap,capacity:[]}}}]})).toThrow("extension_invalid");
    const accepted={workId:"second-work",pathId:"second-producer",preparationKey:contextPreparationWorkKey(input.scope,second.request),producerState:"active" as const,evidence:ref("accepted")};
    const {extendsReception:_extension,...originalSecond}=second;
    expect(decideContextPreparation({...basis,options:[first],reuseOptions:[{...accepted,option:originalSecond}],inFlight:[work,accepted]}).investment)
      .toMatchObject({kind:"reuse",pathId:accepted.pathId});
    expect(decideContextPreparation({...basis,autoPrepare:false}).investment).toMatchObject({kind:"none",reason:"automatic_preparation_disabled"});
    expect(decideContextPreparation({...basis,alternatives:[{input:input.current,comparisons:[]}],options:[first]}).foreground).toMatchObject({kind:"continue",adoption:"propose"});
  });
  it("requires an explicit complete reception option and does not select only its first ready member",async()=>{
    const input=await fixture(),a=option(input),b={...a,id:"method-b",request:{...a.request,objective:"Independent scope B"}};
    const work=(o:ContextPreparationOption,id:string)=>({workId:`work-${id}`,pathId:id,preparationKey:contextPreparationWorkKey(input.scope,o.request),producerState:"ready" as const,evidence:ref(id)});
    const first=work(a,"a"),second=work(b,"b"),joint={...receiver(a,first.workId,first.pathId),members:[...receiver(a,first.workId,first.pathId).members,...receiver(b,second.workId,second.pathId).members]};
    const basis={...input,options:[a,b],inFlight:[first,second],pressure:[{kind:"growth_scenario" as const,evidence:ref("pressure"),timing:null}]};
    expect(decideContextPreparation(basis).investment.kind).toBe("defer");
    const chosen=decideContextPreparation({...basis,receptionOptions:[joint]});
    expect(chosen.investment).toEqual({kind:"prepare_input",optionId:joint.id,reason:"opportunity"});
    expect(chosen.evidence).toEqual(expect.arrayContaining([first.evidence,second.evidence,joint.evidence]));
    expect(decideContextPreparation({...basis,receptionOptions:[joint],inFlight:[first,{...second,producerState:"active"}]}).investment)
      .toMatchObject({kind:"reuse",pathId:second.pathId});
    expect(()=>decideContextPreparation({...basis,receptionOptions:[{...joint,members:[joint.members[0]!,{...joint.members[1]!,requestDigest:"changed"}]}]})).toThrow("reception_binding_invalid");
    const restored={optionId:joint.id,pathId:joint.id,workId:"receiving",state:"active" as const,reason:null,evidence:ref("receiving")};
    expect(decideContextPreparation({...basis,receptionOptions:[joint],inputReceptions:[restored],autoPrepare:false,
      receptionSupplyReport:{complete:false,examined:1,conflicts:0,returned:[],restored:[joint.id]}}).investment)
      .toMatchObject({kind:"reuse_input",pathId:joint.id});
    const failed={...restored,state:"unavailable" as const};
    expect(decideContextPreparation({...basis,receptionOptions:[joint,{...receiver(a,first.workId,first.pathId),id:"other-combination"}],inputReceptions:[failed]}).investment)
      .toMatchObject({kind:"prepare_input",optionId:"other-combination"});
  });
  it("can adopt a checked input and independently propose new justified work without repeating its producer",async()=>{
    const current=await fixture(),original=option(current),next={...original,id:"next-scope",request:{...original.request,objective:"Independent next scope"}};
    const path={workId:"original-work",pathId:"original",preparationKey:contextPreparationWorkKey(current.scope,original.request),producerState:"ready" as const,evidence:ref("ready")};
    const received=receiver(original,path.workId,path.pathId);
    if(current.current.kind!=="prepared")throw new Error("Expected prepared input");
    const input={...current,current:{kind:"gap" as const,evidence:ref("gap"),gap:{reason:"capacity",targetRevision:current.scope.target,demandId:"original",
      information:[],capacity:[],untested:false,responsibility:"request_owner" as const}},
      alternatives:[{input:current.current,comparisons:[]}],
      options:[original,next],inFlight:[path],receptionOptions:[received],
      inputReceptions:[{optionId:received.id,pathId:received.id,workId:"reception-work",state:"checked" as const,reason:null,evidence:ref("checked")}],
      pressure:[{kind:"growth_scenario" as const,evidence:ref("pressure"),timing:null}]};
    const selected=decideContextPreparation(input);
    expect(selected.foreground).toMatchObject({kind:"continue",adoption:"propose",preparedInputId:current.current.prepared.encoded.id});
    expect(selected.investment).toMatchObject({kind:"propose",optionId:next.id});
    expect(selected.excluded).toContainEqual({optionId:original.id,reasons:["original_work_already_accepted"]});
    expect(decideContextPreparation({...input,options:[original]}).investment).toEqual({kind:"none",reason:"qualified_recipient_input_available"});
    expect(decideContextPreparation({...input,autoPrepare:false}).foreground).toMatchObject({kind:"continue",adoption:"propose"});
  });
  it("reuses revalidated original work outside new opportunity enumeration without proposing it again",async()=>{
    const input=await fixture(),proposal=option(input),work={workId:"original",pathId:"original-path",
      preparationKey:contextPreparationWorkKey(input.scope,proposal.request),producerState:"ready" as const,evidence:ref("original-ready")};
    const reuse={workId:work.workId,pathId:work.pathId,option:proposal};
    const receiving=receiver(proposal,work.workId,work.pathId);
    const basis={...input,options:[],reuseOptions:[reuse],inFlight:[work],receptionOptions:[receiving],pressure:[{kind:"growth_scenario" as const,evidence:ref("pressure"),timing:null}]};
    expect(decideContextPreparation(basis).investment).toEqual({kind:"prepare_input",optionId:receiving.id,reason:"opportunity"});
    expect(decideContextPreparation({...basis,inFlight:[{...work,producerState:"active"}]}).investment).toMatchObject({kind:"reuse",workId:work.workId});
    expect(decideContextPreparation({...basis,inFlight:[{...work,producerState:"unknown"}]}).investment).toMatchObject({kind:"defer",reason:"original_producer_outcome_unknown"});
    expect(decideContextPreparation({...basis,inFlight:[{...work,producerState:"failed"}]}).investment).toMatchObject({kind:"defer",reason:"original_path_requires_bounded_revision"});
    expect(decideContextPreparation({...basis,pressure:[]}).investment.kind).toBe("defer");
    const limited={optionId:receiving.id,conditionsDigest:contextReceptionAdmissionKey(basis,receiving),acceptanceId:"refused",code:"activity_schedule_resource_unavailable"};
    expect(decideContextPreparation({...basis,admissionLimitations:[limited]}).excluded).toContainEqual({optionId:receiving.id,reasons:[`admission_rejected:${limited.code}`]});
    expect(()=>decideContextPreparation({...basis,inFlight:[]})).toThrow("reception_binding_invalid");
    expect(()=>decideContextPreparation({...basis,reuseOptions:[reuse,reuse]})).toThrow("reuse_ambiguous");
    expect(()=>decideContextPreparation({...basis,reuseOptions:[{...reuse,pathId:"another-path"}]})).toThrow("reuse_binding_invalid");
    expect(()=>decideContextPreparation({...basis,reuseOptions:[{...reuse,option:{...proposal,request:{...proposal.request,sourceBoundary:"changed"}}}]})).toThrow("reception_binding_invalid");
  });
  it("uses declared transformable extent only to order comparable exploration of a known capacity gap",async()=>{
    const input=await fixture();if(input.current.kind!=="prepared")throw new Error("Expected prepared input");
    const small={...option(input),id:"a-small",addresses:["gap"],sourceExtent:{utf8Bytes:10,evidence:ref("small-source")}};
    const large={...small,id:"z-large",sourceExtent:{utf8Bytes:10000,evidence:ref("large-source")}};
    const gap:ContextPreparationPolicyInput["current"]={kind:"gap",evidence:ref("gap"),gap:{reason:"capacity",demandId:"demand",targetRevision:input.scope.target,
      information:[],capacity:[{...input.current.prepared.capacity,allowed:false}],untested:false,responsibility:"request_owner"}};
    const selected=decideContextPreparation({...input,current:gap,options:[small,large]});
    expect(selected.investment).toMatchObject({kind:"propose",optionId:"z-large"});
    expect(selected.foreground.kind).toBe("limited");
    expect(selected.limitations).toContain("transformable_source_extent_is_not_predicted_savings_or_fit");
    expect(selected.evidence).toContainEqual(small.sourceExtent.evidence);
    expect(selected.evidence).toContainEqual(large.sourceExtent.evidence);
    expect(decideContextPreparation({...input,current:{...gap,gap:{...gap.gap,capacity:[]}},options:[small,large]}).investment)
      .toMatchObject({kind:"propose",optionId:"a-small"});
    const {sourceExtent:_unknown,...unmeasured}=large;
    expect(decideContextPreparation({...input,current:gap,options:[small,unmeasured]}).investment)
      .toMatchObject({kind:"propose",optionId:"a-small"});
    expect(()=>decideContextPreparation({...input,options:[{...small,sourceExtent:{...small.sourceExtent,utf8Bytes:-1}}]})).toThrow("source_extent_invalid");
  });
  it("accepts current encoded observations but rejects another recipient or stale input",async()=>{
    const input=await fixture();if(input.current.kind!=="prepared")throw new Error("Expected prepared input");
    const {report}=observeContextPreparationInput({scope:input.scope,settingsRevision:"fixed",sequence:1,observedAt:"2026-10-30T00:00:00Z",
      representationContinuity:"original",prepared:input.current.prepared,evidence:input.current.evidence,previous:null});
    expect(decideContextPreparation({...input,observationReport:report}).foreground.kind).toBe("continue");
    expect(()=>decideContextPreparation({...input,observationReport:{...report,window:{...report.window,scope:{...input.scope,runId:"child"}}}})).toThrow("observation_scope_invalid");
    expect(()=>decideContextPreparation({...input,observationReport:{...report,window:{...report.window,inputs:report.window.inputs.map(i=>({...i,inputId:"another-input"}))}}})).toThrow("observation_scope_invalid");
  });
  function supplyFixture(input:ContextPreparationPolicyInput) {
    const methods={prepareSubmission:vi.fn(()=>[{owner:"activity",kind:"path_opening",proposal:{}},{owner:"activity",kind:"stage_submission",proposal:{}}] as const),
      describe:vi.fn(async()=>{throw new Error("No original producer expected");}),prepareClosure:vi.fn(async()=>[])};
    const execution=()=>({path:{id:"background",runId:"root",permissionBasis:"host",resourceScope:"background",maximumStages:2048,maximumAttempts:4096,maximumConcurrent:1,deadlineAt:"2030-01-01T00:00:00Z"},
      workId:"background-work",schedulingScopeId:"tree",resources:[{poolId:"model",capability:"model-access",units:1}],timing:{kind:"unknown" as const}});
    const checked=vi.fn(async(id:string):Promise<SharedAcceptanceProposal>=>{
      if(input.current.kind!=="prepared")throw new Error("No checked input");
      return {id,scope:input.scope.runId,actor:input.scope.owner,parts:[{owner:"context_selection",kind:"selection_input",proposal:{scopeId:input.scope.id,input:{stageRequestId:"consumer:model",activityId:"consumer",exactInput:input.current.prepared}}}]};
    });
    const snapshot:ActivityReconsiderationSnapshot={state:{closed:false,revision:0,consumedThrough:0,observedSources:["input"],subscription:{id:"input-watch",runId:"root",owner:input.scope.owner,sources:["input"],binding:{kind:"input_need",id:"need"}}},
      through:1,more:false,facts:[{id:"source-accepted",sequence:1,sourceId:"input",ref:{owner:"context-representation",kind:"source",id:"source",revision:"1"}}]};
    const command=vi.fn(async(value:{kind:string;id?:string})=>{
      if(value.kind!=="read_input_need"||value.id!=="need")throw new Error("No original scheduling lookup expected");
      return {id:"need",supplier:input.scope.owner,stage:{id:"consumer:model",pathId:"consumer",stageKind:"model",capabilities:[],dependencies:[]},
        unavailableStage:{id:"consumer:unavailable",pathId:"consumer",stageKind:"input-unavailable",capabilities:[],dependencies:[]}};
    });
    const make=()=>contextPreparationReconsideration({activities:{command},
      decisions:{query:vi.fn(async()=>null),investments:vi.fn(async()=>[])},methods,
      resolve:async()=>({policy:input,expectedControlRevision:0,execution,prepareInputAcceptance:checked})});
    return {methods,execution,checked,snapshot,command,make};
  }
  it("jointly accepts the usable current input and independent opportunity work",async()=>{
    const current=await fixture(),input={...current,options:[option(current)],pressure:[{kind:"growth_scenario" as const,evidence:ref("pressure"),timing:null}]};
    const f=supplyFixture(input),proposal=await f.make().prepare(f.snapshot,new AbortController().signal);
    expect(proposal.close).toBe(true);expect(proposal.acceptanceId).toBeTruthy();expect(f.checked).toHaveBeenCalledOnce();
    expect(f.checked.mock.calls[0]![0]).toBe(proposal.acceptanceId);
    expect(proposal.participants.filter(p=>p.kind==="scheduling_acceptance")).toHaveLength(1);
    expect(proposal.participants.find(p=>p.kind==="scheduling_acceptance")?.proposal).toMatchObject({intent:{runId:"root",scopeId:"tree"}});
    expect(proposal.participants.filter(p=>p.kind==="selection_input")).toHaveLength(1);
    expect(proposal.participants.find(p=>p.owner==="context_preparation_policy")?.proposal).toMatchObject({investment:{workId:"background-work",pathId:"background"}});
    expect(f.methods.prepareSubmission).toHaveBeenCalledOnce();
    expect(proposal.observeSources).toEqual(["activity-source:control:background","activity-source:progress:background","input"]);
  });
  it("retains a rejected background arrangement and reproposes only the independently usable input",async()=>{
    const current=await fixture(),input={...current,options:[option(current)],pressure:[{kind:"growth_scenario" as const,evidence:ref("pressure"),timing:null}]};
    const f=supplyFixture(input),proposal=await f.make().prepare(f.snapshot,new AbortController().signal);
    const receipt={id:proposal.acceptanceId!,digest:"original",sequence:1,scope:input.scope.runId,outcome:"rejected" as const,rejection:{owner:"activity",code:"activity_schedule_resource_unavailable"}};
    const revised=await proposal.rejected!(receipt);
    expect(revised).not.toBeNull();expect(revised!.acceptanceId).not.toBe(proposal.acceptanceId);expect(revised!.close).toBe(true);
    expect(revised!.participants.some(p=>p.kind==="scheduling_acceptance")).toBe(false);
    expect(revised!.observeSources).toEqual(["input"]);
    expect(revised!.participants.filter(p=>p.kind==="selection_input")).toHaveLength(1);
    expect(revised!.participants.find(p=>p.owner==="context_preparation_policy")?.proposal).toMatchObject({investment:null,input:{admissionResponse:receipt.id,
      admissionLimitations:[{acceptanceId:receipt.id,code:receipt.rejection.code}]}});
    expect(f.methods.prepareSubmission).toHaveBeenCalledOnce();
    expect(await proposal.rejected!({...receipt,rejection:{...receipt.rejection,code:"activity_control_changed"}})).toBeNull();
  });
  it("records reception admission refusal against the resupplied original option, not new opportunities",async()=>{
    const current=await fixture(),originalOption=option(current),pressure={kind:"growth_scenario" as const,evidence:ref("pressure"),timing:null};
    const originalInput={...current,options:[originalOption],pressure:[pressure]},original={input:originalInput,
      decision:decideContextPreparation(originalInput),acceptanceId:"original-acceptance",investment:{workId:"original",pathId:"producer",schedulingScopeId:"tree"}};
    expect(original.decision.investment.kind).toBe("propose");
    const policy={...current,options:[],reuseOptions:[{workId:"original",pathId:"producer",option:originalOption}],receptionOptions:[receiver(originalOption,"original","producer")],pressure:[pressure]},f=supplyFixture(policy);
    const reception=vi.fn(async()=>({participants:[],observeSources:["recipient-progress"]}));
    const handler=contextPreparationReconsideration({activities:{command:f.command},
      decisions:{query:async()=>null,investments:async()=>[original]},
      methods:{...f.methods,describe:async()=>({state:"ready",revision:1,quotation:quoteRepresentationMethod(originalOption.request),
        confirmed:{candidates:["original-candidate"],assessments:["original-assessment"]},remainingJobs:[],limitations:[],
        used:{stages:2,attempts:2,readBytes:100,storedBytes:50,modelCalls:2},
        remaining:{stages:2046,attempts:4094,readBytes:65436,storedBytes:65486,modelCalls:30},
        allowance:{limits:{readBytes:65536,storedBytes:65536,modelCalls:32},reserved:{readBytes:100,storedBytes:50,modelCalls:2}}})},
      resolve:async()=>({policy,expectedControlRevision:0,execution:f.execution,prepareInputAcceptance:f.checked,prepareInputReception:reception})});
    const proposal=await handler.prepare(f.snapshot,new AbortController().signal);
    expect(reception).toHaveBeenCalledOnce();expect(f.methods.prepareSubmission).not.toHaveBeenCalled();
    const receipt={id:proposal.acceptanceId!,digest:"original",sequence:1,scope:current.scope.runId,outcome:"rejected" as const,
      rejection:{owner:"activity",code:"activity_schedule_resource_unavailable"}};
    const revised=await proposal.rejected!(receipt);expect(revised).not.toBeNull();expect(revised!.close).toBe(true);
    expect(revised!.participants.find(p=>p.owner==="context_preparation_policy")?.proposal).toMatchObject({investment:null,input:{options:[],
      admissionLimitations:[{optionId:"receiver",acceptanceId:receipt.id,code:receipt.rejection.code}]}});
    expect(reception).toHaveBeenCalledOnce();expect(f.methods.prepareSubmission).not.toHaveBeenCalled();
  });
  it("does not call the input owner or close supply when there is no usable input",async()=>{
    const input=await fixture();if(input.current.kind!=="prepared")throw new Error("fixture");
    const f=supplyFixture({...input,currentRejectedInputId:input.current.prepared.encoded.id});
    const proposal=await f.make().prepare(f.snapshot,new AbortController().signal);
    expect(f.checked).not.toHaveBeenCalled();expect(proposal.close).toBe(false);
    expect(proposal.participants.some(p=>p.kind==="selection_input")).toBe(false);
  });
  it("does not use input adoption to close an unrelated long-lived subscription",async()=>{
    const f=supplyFixture(await fixture());delete (f.snapshot.state.subscription as {binding?:unknown}).binding;
    await expect(f.make().prepare(f.snapshot,new AbortController().signal)).rejects.toThrow("context_policy_input_supply_subscription_required");
    expect(f.checked).not.toHaveBeenCalled();
  });
  it("cannot close one input need after supplying a different consumer stage",async()=>{
    const f=supplyFixture(await fixture());
    f.command.mockResolvedValue({id:"need",supplier:"context-representation",stage:{id:"different:model",pathId:"different",stageKind:"model",capabilities:[],dependencies:[]},
      unavailableStage:{id:"different:unavailable",pathId:"different",stageKind:"input-unavailable",capabilities:[],dependencies:[]}});
    await expect(f.make().prepare(f.snapshot,new AbortController().signal)).rejects.toThrow("context_policy_input_need_mismatch");
  });
  it("still rejects an input that differs from the evaluated combination while investing",async()=>{
    const original=await fixture(),input={...original,options:[option(original)],pressure:[{kind:"growth_scenario" as const,evidence:ref("pressure"),timing:null}]};
    const f=supplyFixture(input),checked=await f.checked("acceptance");
    const part=checked.parts[0]!.proposal as {input:{exactInput:PreparedContextInput}};
    part.input.exactInput={...part.input.exactInput,deliveries:[{id:"unseen",position:"unknown"}]};
    expect(()=>contextPreparationAdoption({policy:{id:checked.id,input,expectedDecisionId:null,expectedControlRevision:0,reconsideration:null,execution:f.execution(),methods:f.methods},checkedInput:checked}))
      .toThrow("context_adoption_input_not_evaluated");
  });
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
    const input=await fixture(),key=contextPreparationApplicabilityKey(input);Object.assign(input,{options:[option(input)]});
    const inFlight=[{workId:"original",pathId:"path",preparationKey:contextPreparationWorkKey(input.scope,input.options[0]!.request),producerState:"active" as const,evidence:ref("accepted-producer")}];
    expect(decideContextPreparation({...input,inFlight}).foreground.kind).toBe("continue");
    if(input.current.kind!=="prepared")throw new Error("fixture");
    const result=decideContextPreparation({...input,currentRejectedInputId:input.current.prepared.encoded.id,inFlight});
    expect(result.foreground).toEqual({kind:"needs_result",workId:"original",pathId:"path"});
    expect(decideContextPreparation({...input,currentRejectedInputId:input.current.prepared.encoded.id,inFlight:inFlight.map(w=>({...w,producerState:"unknown"}))}).foreground).toEqual({kind:"needs_result",workId:"original",pathId:"path"});
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
    const input=await fixture();Object.assign(input,{options:[option(input)]});
    const work={workId:"original",pathId:"path",preparationKey:contextPreparationWorkKey(input.scope,input.options[0]!.request),producerState:"ready" as const,evidence:ref("ready-result")};
    const result=decideContextPreparation({...input,inFlight:[work]});
    expect(result.foreground).toMatchObject({kind:"continue",adoption:"keep"});
    expect(result.investment).toMatchObject({kind:"defer",reason:"retained_result_requires_recipient_input_organization"});
    expect(decideContextPreparation({...input,consumerActive:false}).foreground).toEqual({kind:"limited",reason:"no_active_consumer"});
  });
  it("separates necessary or opportunity input reception from repeating the original generation",async()=>{
    const input=await fixture(),proposal=option(input);
    const work={workId:"original",pathId:"path",preparationKey:contextPreparationWorkKey(input.scope,proposal.request),producerState:"ready" as const,evidence:ref("ready")};
    const basis={...input,options:[proposal],inFlight:[work],receptionOptions:[receiver(proposal,work.workId,work.pathId)]};
    const gap={kind:"gap" as const,gap:{reason:"hard input limit",demandId:"demand",targetRevision:input.scope.target,information:[],capacity:[],untested:false,responsibility:"request_owner" as const},evidence:ref("gap")};
    expect(decideContextPreparation({...basis,current:gap}).investment).toEqual({kind:"prepare_input",optionId:"receiver",reason:"necessary"});
    const opportunity=decideContextPreparation({...basis,pressure:[{kind:"growth_scenario",evidence:ref("pressure"),timing:null}]});
    expect(opportunity.foreground).toMatchObject({kind:"continue",adoption:"keep"});
    expect(opportunity.investment).toMatchObject({kind:"prepare_input",reason:"opportunity"});
    expect(decideContextPreparation({...basis,current:gap,autoPrepare:false}).investment).toEqual({kind:"none",reason:"automatic_preparation_disabled"});
    expect(decideContextPreparation({...basis,current:gap,alternatives:[{input:input.current,comparisons:[]}]}).investment)
      .toEqual({kind:"none",reason:"qualified_recipient_input_available"});
  });
  it("waits for the accepted recipient work, not its already finished producer",async()=>{
    const input=await fixture(),proposal=option(input);
    const work={workId:"original",pathId:"producer",preparationKey:contextPreparationWorkKey(input.scope,proposal.request),producerState:"ready" as const,evidence:ref("ready")};
    const reception={optionId:"receiver",workId:"receiver-work",pathId:"receiver",state:"active" as const,reason:null,evidence:ref("receiving")};
    const basis={...input,options:[proposal],inFlight:[work],receptionOptions:[receiver(proposal,work.workId,work.pathId)],inputReceptions:[reception]};
    const available=decideContextPreparation(basis);
    expect(available.foreground).toMatchObject({kind:"continue",adoption:"keep"});
    expect(available.investment).toEqual({kind:"reuse_input",workId:"receiver-work",pathId:"receiver",requiredService:null});
    const gap={kind:"gap" as const,gap:{reason:"capacity",demandId:"demand",targetRevision:input.scope.target,information:[],capacity:[],untested:false,responsibility:"request_owner" as const},evidence:ref("gap")};
    const required=decideContextPreparation({...basis,current:gap});
    expect(required.foreground).toEqual({kind:"needs_result",workId:"receiver-work",pathId:"receiver"});
    expect(required.investment).toMatchObject({kind:"reuse_input",requiredService:"necessary"});
    for(const state of ["unavailable","unknown"] as const) {
      const limited=decideContextPreparation({...basis,current:gap,inputReceptions:[{...reception,state,reason:"original outcome"}]});
      expect(limited.investment.kind).toBe("defer");expect(limited.foreground.kind).toBe(state==="unknown"?"needs_result":"limited");
      expect(limited.evidence).toContainEqual(reception.evidence);
    }
    expect(()=>decideContextPreparation({...basis,inputReceptions:[reception,reception]})).toThrow("reception_ambiguous");
    expect(()=>decideContextPreparation({...basis,inputReceptions:[{...reception,optionId:"unrelated"}]})).toThrow("reception_binding_invalid");
  });
  it("requires an explicit original-work revision after failure and never restarts an unknown producer",async()=>{
    const input=await fixture(),proposal=option(input),work={workId:"original",pathId:"failed-path",preparationKey:contextPreparationWorkKey(input.scope,proposal.request),producerState:"failed" as const,evidence:ref("failure")};
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
  it("keeps original preparation across later input boundaries and does not reset exploration by fresh fact IDs",async()=>{
    const input=await fixture(),proposal=option(input),pressure={kind:"growth_scenario" as const,evidence:ref("pressure"),timing:null};
    const original=decideContextPreparation({...input,options:[proposal],pressure:[pressure]});
    if(original.investment.kind!=="propose")throw new Error("Expected investment");
    const later={...input,boundary:"H2",options:[{...proposal,addresses:["fresh-pressure"]}],pressure:[{...pressure,evidence:ref("fresh-pressure")}]};
    const work={workId:"original",pathId:"path",preparationKey:contextPreparationWorkKey(input.scope,proposal.request),producerState:"active" as const,evidence:ref("producer")};
    expect(decideContextPreparation({...later,inFlight:[work]}).investment).toMatchObject({kind:"reuse",workId:"original"});
    const retried=decideContextPreparation({...later,explorationHistory:[{key:original.investment.explorationKey!,decisionId:original.id}]});
    expect(retried.excluded[0]?.reasons).toContain("same_opportunity_exploration_already_attempted");
    expect(contextPreparationAdmissionKey(input,proposal)).toBe(contextPreparationAdmissionKey(later,later.options[0]!));
    expect(contextPreparationWorkKey({...input.scope,runId:"child"},proposal.request)).not.toBe(work.preparationKey);
    expect(contextPreparationWorkKey(input.scope,{...proposal.request,sourceBoundary:"changed-source"})).not.toBe(work.preparationKey);
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
    expect(contextEmpiricalRange(samples.map((s,i)=>i===1?{...s,measurementRevision:"different"}:s),samples[0]!,true).kind).toBe("insufficient");
  });
});
