import {afterEach,describe,expect,it} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {join,resolve,dirname,basename} from "node:path";
import {tmpdir} from "node:os";
import {createNativeToolTurnInteraction,createModelCallRef,type ProviderRequest,type ModelMessage} from "@agent-anything/model-interaction";
import {composeModelInput,declareModelResultTextSlot,modelInputValueDigest as digest,organizeOriginalInput,type ModelInputSectionCandidate} from "@agent-anything/model-interaction/input";
import {OllamaProvider} from "@agent-anything/provider-integrations/ollama";
import {SourceMaterialPublicationWork,planOriginalInputPublications,validateOriginalInputSources,prepareOriginalInputSelection,
  originalInputAccountScopes,validateOriginalInputAccountScope,supplyOriginalInputAccountMethod,originalInputAccountDemand,resupplyOriginalInputMethod,
  originalInputResultTextScopes,validateOriginalInputResultTextScope,supplyOriginalInputResultTextMethod,originalInputResultTextDemand,
  originalInputRepresentationDemand,validateOriginalInputRepresentationMembers,originalInputRepresentationPlan,OriginalInputRepresentationReception,originalInputReceptionCombinations,originalInputReceptionExtension,originalInputReceptionTemplate,
  firstContextInputPreparationStage,ContextInputPreparationHandler,recipientContextDeliveryId,type OriginalInputSources,type PreparedContextInput} from "@agent-anything/agent-runtime/context-representation";
import {ActivityHandoffProcessor,ActivityPurposeRegistry,type ActivityHandoffPort,type ActivityPurposeHandler,type ActivityInputNeed,
  type ActivityPathState,type ActivityStageState,type ActivityAttempt} from "@agent-anything/agent-runtime/activity";
import type {MaterialCustodyPort} from "@agent-anything/context/custody";
import {ExecutionDatabase} from "../execution-storage/ExecutionDatabase.js";

const now="2026-10-30T00:00:00.000Z",signal=()=>new AbortController().signal;
const databases:ExecutionDatabase[]=[],directories:string[]=[];
afterEach(()=>{for(const db of databases.splice(0))db.close();for(const directory of directories.splice(0)){
  if(dirname(resolve(directory))!==resolve(tmpdir())||!basename(directory).startsWith("helarc-original-input-"))throw new Error("Unsafe cleanup");
  rmSync(directory,{recursive:true,force:true});
}});
const provider=new OllamaProvider({model:"controlled",baseUrl:"http://127.0.0.1:1",timeoutMs:1000,nativeToolInteraction:{supported:true},think:false,
  runtime:{contextWindowTokens:16384},requestBodyTransportLimit:{maximumBytes:1000000,source:"host_configured",revision:"1"}});
const sourceRef=(id:string)=>({id,owner:"test-source",kind:"record",revision:"1"});
function sources(runId="root",extra=false,resultText=false):OriginalInputSources {
  const interaction=createNativeToolTurnInteraction([{name:"Read_exact",description:"Read the requested version",inputSchema:{type:"object",properties:{},additionalProperties:false}}]);
  const lineage=Object.fromEntries(["instructionBinding","agent","instructions","instructionRelease","instructionResolver","instructionContent","activeContext","contextProjection","projectionManifest","toolSelection","toolExposureContent","toolExposureBasis","toolExposureProof","toolGuidance","controllerControlGuidance","callableDefinitions","protocol","policy"].map(k=>[k,sourceRef(k)]));
  Object.assign(lineage,{instructionModel:{providerId:provider.modelContext.target.providerId,model:"controlled"},instructionBlocks:[],modelQualification:null,interactionHistory:null});
  const callRef=createModelCallRef({providerRequestId:"prior-request",controllerRequestId:"prior-controller",turnId:"turn:1",contentBlockOrdinal:1,branchId:"main"});
  const message=(id:string,value:ModelMessage):ModelInputSectionCandidate=>({id,source:sourceRef(id),kind:"history",role:value.role,necessity:"mandatory",content:{kind:"model_message",message:value}});
  const text=(id:string,value:string):ModelInputSectionCandidate=>({id,source:sourceRef(id),kind:"task",role:"user",necessity:"mandatory",content:{kind:"text",text:value}});
  const sections=[...(extra?[text("new-background","New explicitly supplied background.")]:[]),text("task","Check the actual result; do not claim execution without evidence."),
    message("assistant",{role:"assistant",content:[{kind:"text",text:"I will inspect the file."},{kind:"model_tool_call",call:{modelCallRef:callRef,providerCallRef:null,name:"Read_exact",input:{},ordinal:1}}]}),
    message("tool",{role:"tool",content:[{kind:"model_tool_result",result:{modelCallRef:callRef,providerCallRef:null,name:"Read_exact",settlement:"failed",
      presentation:{presenter:{id:"tool",revision:"1"},disposition:"complete",failureCode:null},content:resultText?{summary:"The file was not read; its version is unverified.",details:"The path was absent.",error:"file_missing",effects:"none"}:{error:"file_missing"},sourceRefs:[sourceRef("result")]}}]}),
    text("follow-up","The file was not read. Explain the limitation.")];
  const composition=composeModelInput({id:`original:${extra}`,providerId:provider.descriptor.id,model:"controlled",interaction,sections,
    lineage:lineage as unknown as ProviderRequest["composition"]["lineage"],composedAt:now});
  const request:ProviderRequest={requestId:composition.id,purpose:"task",correlation:{controllerRequestId:`demand:${extra}`,branchId:"main"},instructions:composition.instructions,messages:composition.messages,interaction,composition,
    modelContext:{requestedOutput:provider.modelContext.requestedOutput,headroom:{unit:"tokens",amount:0,policy:{id:"test",revision:"1"}},assessment:null},continuation:null,metadata:{runId}};
  const native=new Set(["assistant","tool"]),visited=new Set<string>();
  const groups=composition.sections.flatMap(section=>{
    if(visited.has(section.id))return [];
    const ids=native.has(section.id)?["assistant","tool"]:[section.id];ids.forEach(id=>visited.add(id));
    const occurrences=ids.map(id=>({position:composition.sections.findIndex(s=>s.id===id),section:composition.sections.find(s=>s.id===id)!}));
    const value=occurrences.find(o=>o.section.id==="tool")?.section.content;
    const declaration=resultText&&value?.kind==="model_message"&&value.message.role==="tool"?{id:"report-slot",owner:sourceRef("result-contract"),sectionId:"tool",
      slot:declareModelResultTextSlot(value.message,callRef.id,["summary"]),requirements:[{id:"report",revision:"1",basis:"Source contract",description:"Preserve unread and unverified status"}]}:null;
    return [{id:`${runId}:source:${ids.join(":")}`,owner:"test-source",revision:digest(occurrences.map(o=>o.section)),occurrences,duties:["continuity" as const],sources:occurrences.map(o=>o.section.source),deliveries:[],
      ...(declaration?{resultTexts:[declaration]}:{})}];
  });
  const basis={owner:"test-source",runId,originalSourceId:`${runId}:original:${extra}`,boundary:`H:${extra}`,request,groups};
  return {id:digest(basis),...basis};
}
function open(directory=mkdtempSync(join(tmpdir(),"helarc-original-input-"))) {
  if(!directories.includes(directory))directories.push(directory);
  const db=new ExecutionDatabase(directory);databases.push(db);
  const activities:ActivityHandoffPort={command:async command=>db.activityHandoffCommand(db.generation,command).activityValue};
  const materials:MaterialCustodyPort={command:async command=>db.materialCustodyCommand(db.generation,command).custodyValue};
  const registry=new ActivityPurposeRegistry<ActivityPurposeHandler>();
  const selections={command:async(command:Parameters<import("@agent-anything/context/selection").ContextSelectionPort["command"]>[0])=>db.selectionCommand(db.generation,command).selectionValue};
  const publication=new SourceMaterialPublicationWork(activities,registry,{materials,selections,authorize:async()=>({kind:"allowed"}),now:()=>now});
  const processor=new ActivityHandoffProcessor(activities,registry,{hostSession:"host",worker:`worker:${db.generation}`,generation:db.generation},()=>now);
  return {directory,db,activities,materials,publication,processor};
}
function accountSources(extra=false,resultText=false):OriginalInputSources {
  const original=sources("root",extra,resultText),sections=original.request.composition.sections.map(s=>["assistant","tool"].includes(s.id)?{...s,
    preservation:{obligations:[{id:"exchange",requirement:"account" as const,basis:"Keep the failed read and do not claim the file exists"}],relationships:[]}}:s);
  sections.push({id:"later-answer",source:sourceRef("later-answer"),kind:"history",role:"assistant",necessity:"mandatory",content:{kind:"text",text:"The file was not read."}});
  const composition=composeModelInput({...original.request.composition,sections});
  const request={...original.request,composition,instructions:composition.instructions,messages:composition.messages};
  const groups=original.groups.map(g=>({...g,occurrences:g.occurrences.map(o=>({...o,section:composition.sections[o.position]!})),
    revision:digest(g.occurrences.map(o=>composition.sections[o.position]))}));
  groups.push({id:"later-answer",owner:"test-source",revision:"1",occurrences:[{position:composition.sections.length-1,section:composition.sections.at(-1)!}],
    duties:["continuity"],sources:[sourceRef("later-answer")],deliveries:[]});
  return {...original,id:`accounts:${extra}`,request,groups};
}
async function prepare(s:OriginalInputSources,f:ReturnType<typeof open>,recipientName="agent") {
  const recipient={runId:s.runId,recipient:recipientName,purpose:s.request.purpose},target=provider.encodeInput!(s.request,"buffered").targetDigest;
  const deliveryLifetime={source:{id:`run-lifetime:${s.runId}`,runId:s.runId,owner:"runtime"},closedFactId:`run-lifetime:${s.runId}:closed`};
  await f.activities.command({kind:"register_fact_source",source:deliveryLifetime.source});
  const plan=()=>planOriginalInputPublications({sources:s,recipient,target,observedAt:now,maximumSourceBytes:1000000,activities:f.activities,signal:signal(),deliveryLifetime});
  for(const p of await plan())if(p.state==="new"){
    const parts=f.publication.prepareSubmission({id:p.pathId,runId:s.runId,permissionBasis:"host",resourceScope:p.pathId,maximumStages:1,maximumAttempts:1,maximumConcurrent:1,deadlineAt:"2030-01-01T00:00:00Z"},p.request);
    expect(f.db.acceptShared(f.db.generation,{id:`${p.pathId}:admission`,scope:s.runId,actor:"material-source",parts}).acceptanceValue.outcome).toBe("accepted");
  }
  for(let i=0;i<4;i++)await f.processor.drain(s.runId,signal());
  const publications=await plan();expect(publications.every(p=>p.published)).toBe(true);
  const demand=organizeOriginalInput({composition:s.request.composition,demand:{id:`demand:${s.id}`,runId:s.runId,recipient:recipientName,purpose:recipient.purpose,targetRevision:target,historyBoundary:s.boundary,
    deliveryIds:s.groups.flatMap(g=>g.deliveries.map(d=>recipientContextDeliveryId(d.id,recipient))),dependencies:{source:s.id},maximumCombinations:4,maximumExternalMeasurements:0,maximumReadBytes:1000000},
    groups:s.groups.map(g=>({id:g.id,owner:g.owner,revision:g.revision,sectionIds:g.occurrences.map(o=>o.section.id),duties:g.duties,deliveryIds:g.deliveries.map(d=>recipientContextDeliveryId(d.id,recipient))}))});
  const request=firstContextInputPreparationStage(`prepare:${s.id}`,{kind:"context_input_preparation",demand,template:s.request,limits:[],reservations:[],
    policy:{id:"test",revision:"1",purpose:recipient.purpose,basis:"Explicit estimated/unknown capacity policy",allowEstimatedFit:true,allowUnknown:true},allowExternalMeasurement:false,
    deliveryMode:"buffered",localMeasurements:[],sharedCapacity:null,materialAccesses:publications.map(p=>p.published!.access)});
  const handler=new ContextInputPreparationHandler({provider,materials:f.materials,authorize:async()=>({kind:"allowed"}),now:()=>now});
  const raw=await handler.execute({} as ActivityPathState,{request} as ActivityStageState,{id:"attempt"} as ActivityAttempt,signal());
  const prepared=(raw.value as {prepared:PreparedContextInput}).prepared;expect(prepared).toBeDefined();
  const scope={...recipient,id:`scope:${s.runId}:${recipientName}`,continuity:"task",owner:"context-representation",target,authorityBasis:"host"};
  const need={id:`need:${s.id}`,supplier:scope.owner,stage:{id:`model:${s.id}`,pathId:`task:${s.runId}`,stageKind:"model",capabilities:["model-request"],dependencies:[]}} as unknown as ActivityInputNeed;
  const input={id:`accept:${s.id}`,sources:s,prepared,publications,scope,need,expectedSelectionId:null,expectedControlRevision:0,
    selectionId:`selection:${s.id}`,inputId:`input:${s.id}`,releaseHolds:[]};
  return {input,plan,select:()=>prepareOriginalInputSelection(input)};
}

describe("original input selection",()=>{
  it("keeps original notification bytes stable while binding different recipients and purposes",async()=>{
    const original=sources(),last=original.groups.at(-1)!,section=last.occurrences[0]!.section;
    const declaration={id:"original-notification",sequence:1,digest:"notification-digest",sectionId:section.id,source:section.source};
    const addressed={...original,id:"addressed",groups:original.groups.map(g=>g===last?{...g,deliveries:[declaration]}:g)};
    const f=open(),a=await prepare(addressed,f),b=await prepare(addressed,f,"other-agent"),
      c=await prepare({...addressed,id:"other-purpose",request:{...addressed.request,purpose:"stop"}},f);
    const captures=[a,b,c].map(value=>value.input.publications.at(-1)!);
    expect(new Set(captures.map(value=>value.request.deliveries![0]!.id)).size).toBe(3);
    expect(captures.map(value=>value.request.bytesBase64)).toEqual([captures[0]!.request.bytesBase64,captures[0]!.request.bytesBase64,captures[0]!.request.bytesBase64]);
    expect(addressed.groups.at(-1)!.deliveries).toEqual([declaration]);
    for(const value of [a,b,c])expect(value.select().acceptance.parts.find(part=>part.owner==="context_delivery")?.proposal)
      .toMatchObject({deliveryIds:[recipientContextDeliveryId(declaration.id,value.input.scope)]});
    f.db.close();const restored=open(f.directory),again=await prepare(addressed,restored,"other-agent");
    expect(again.input.publications).toEqual(b.input.publications);
  });
  it("binds pending delivery to its declared source before original input selection and reuses it after reopen",async()=>{
    const original=sources(),last=original.groups.at(-1)!,section=last.occurrences[0]!.section;
    const declaration={id:"notification-delivery",sequence:1,digest:"original-notification-digest",sectionId:section.id,source:section.source};
    const addressed:OriginalInputSources={...original,id:"addressed-sources",groups:original.groups.map(group=>group===last?{...group,deliveries:[declaration]}:group)};
    const f=open(),prepared=await prepare(addressed,f),publication=prepared.input.publications.at(-1)!;
    const deliveryId=recipientContextDeliveryId(declaration.id,prepared.input.scope);
    expect(publication.request.deliveries).toEqual([{id:deliveryId,sourceId:declaration.source.id}]);
    const pending=()=>f.db.selectionCommand(f.db.generation,{kind:"pending_deliveries",recipient:prepared.input.scope,after:0,through:null,limit:10}).selectionValue;
    expect(pending()).toMatchObject({entries:[{selectedInputId:null,delivery:{id:deliveryId,sourceId:declaration.source.id,
      material:publication.published!.access.range,recipient:{runId:"root",recipient:"agent",purpose:"task"}}}]});
    expect(prepared.input.prepared.deliveries.map(delivery=>delivery.id)).toEqual([deliveryId]);
    expect(prepared.select().acceptance.parts.find(part=>part.owner==="context_delivery")?.proposal).toMatchObject({deliveryIds:[deliveryId]});
    expect(()=>validateOriginalInputSources({...addressed,groups:addressed.groups.map(group=>group.id!==last.id?group:{...group,
      deliveries:[{...declaration,source:sourceRef("not-in-the-original-section")} ]})})).toThrow("source_delivery_invalid");
    expect(()=>prepareOriginalInputSelection({...prepared.input,publications:prepared.input.publications.map(p=>p!==publication?p:{...p,
      request:{...p.request,deliveries:[{id:declaration.id,sourceId:"other-notification"}]}})})).toThrow("publication_mismatch");
    f.db.close();const restored=open(f.directory),again=await prepare(addressed,restored);
    expect(again.input.publications).toEqual(prepared.input.publications);
    expect(restored.db.contextFoundationFacts("root",0,256).contextFacts.filter(fact=>fact.owner==="context_delivery").map(fact=>fact.kind)).toEqual(["published"]);
  });
  it.each([false,true])("revalidates original method supply independently of new enumeration (result body: %s)",async resultText=>{
    const original=resultText?sources("root",false,true):accountSources(),f=open(),first=await prepare(original,f);
    const parameters=(p:typeof first)=>({sources:p.input.sources,publications:p.input.publications,sourceRecipient:{runId:"root",recipient:"agent",purpose:"task"},
      target:p.input.scope.target,authorizationBasis:"host",addresses:["current-pressure"],
      capacity:{limits:[],reservations:[],policy:{id:"test",revision:"1",purpose:"task",basis:"estimated",allowEstimatedFit:true,allowUnknown:true},maximumCombinations:4,maximumMeasurements:0},
      bounds:{readBytes:1000000,storedBytes:1000000,modelCalls:8,repairs:1,levels:2,pageBytes:65536,ranges:64},limits:{maximumStages:128,maximumAttempts:128}});
    const backgrounds=["root:source:task"],scopeOptions={sources:original,maximum:1,backgroundGroupIds:backgrounds};
    const offer=resultText?supplyOriginalInputResultTextMethod({...parameters(first),scope:originalInputResultTextScopes(scopeOptions).scopes[0]!}):
      supplyOriginalInputAccountMethod({...parameters(first),scope:originalInputAccountScopes(scopeOptions).scopes[0]!});
    const at=original.request.composition.sections.findIndex(s=>s.id==="follow-up");
    const note:ModelInputSectionCandidate={id:"later-history",source:sourceRef("later-history"),kind:"history",role:"assistant",necessity:"mandatory",
      content:{kind:"text",text:"A later investigation did not change the original failed result."},
      preservation:{obligations:[{id:"later",requirement:"account",basis:"Keep this later finding"}],relationships:[]}};
    const sections=[...original.request.composition.sections.slice(0,at),note,...original.request.composition.sections.slice(at)];
    const composition=composeModelInput({...original.request.composition,sections});
    const laterSources={...original,id:"later-sources",boundary:"later-boundary",request:{...original.request,composition,messages:composition.messages,instructions:composition.instructions},
      groups:[...original.groups.map(g=>({...g,occurrences:g.occurrences.map(o=>({...o,position:o.position>=at?o.position+1:o.position}))})),
        {id:"later-history",owner:"test-source",revision:"1",occurrences:[{position:at,section:composition.sections[at]!}],duties:["continuity" as const],sources:[note.source],deliveries:[]}]};
    if(!resultText)expect(originalInputAccountScopes({...scopeOptions,sources:laterSources}).scopes.map(s=>s.id)).not.toContain(offer.scope.id);
    f.db.close();const reopened=open(f.directory),later=await prepare(laterSources,reopened),args=parameters(later);
    expect(resupplyOriginalInputMethod(args,JSON.parse(JSON.stringify(offer.option)))).toEqual({kind:"available",supply:offer});
    expect(resupplyOriginalInputMethod({...args,authorizationBasis:"different-authority"},offer.option)).toMatchObject({kind:"unavailable",reason:"original_method_binding_changed"});
    expect(resupplyOriginalInputMethod({...args,target:"different-target"},offer.option).kind).toBe("unavailable");
    expect(resupplyOriginalInputMethod(args,{...offer.option,request:{...offer.request,recipient:{...offer.request.recipient,runId:"another-child"}}}).kind).toBe("unavailable");
    expect(resupplyOriginalInputMethod(args,{...offer.option,request:{...offer.request,objective:"Different preservation objective"}})).toMatchObject({kind:"unavailable",reason:"original_method_binding_changed"});
    expect(resupplyOriginalInputMethod(args,{...offer.option,request:{...offer.request,sources:offer.request.sources.map(s=>({...s,access:{...s.access,range:{...s.access.range,version:"stale"}}}))}}).kind).toBe("unavailable");
    expect(resupplyOriginalInputMethod(args,{...offer.option,request:{...offer.request,sources:offer.request.sources.map(s=>({...s,indivisibleGroup:"removed"}))}})).toMatchObject({kind:"unavailable",reason:"original_method_source_unavailable"});
  });
  it("checks actual ordered text, calls, failed results and full catalog without a semantic model call",async()=>{
    const f=await prepare(sources(),open()),selected=f.select();
    expect(selected.judgment.conclusion).toBe("supported");expect(selected.judgment.limitations[0]).toContain("source truth");
    expect(selected.judgment.subjects).toHaveLength(3);expect(selected.judgment.dependencies.originalSource).toBe(f.input.sources.originalSourceId);
    expect(f.input.prepared.request.messages).toEqual(f.input.sources.request.messages);
    expect(f.input.prepared.request.interaction).toEqual(f.input.sources.request.interaction);
    expect(f.input.prepared.encoded.body).toContain("file_missing");
    expect(selected.acceptance.parts.map(p=>p.kind)).toEqual(["scope","judge","holds","selection_input","select","stage_submission"]);
    expect(prepareOriginalInputSelection(JSON.parse(JSON.stringify(f.input)))).toEqual(selected);
  });
  it("reuses captured source versions on reopen and at changed positions in a later actual request",async()=>{
    const db=open(),first=await prepare(sources(),db),judgment=first.select().judgment;db.db.close();
    const restored=open(db.directory),again=await prepare(sources(),restored);
    expect(again.select().judgment).toEqual(judgment);
    const later=await prepare(sources("root",true),restored);
    expect(later.select().judgment.id).not.toBe(judgment.id);
    for(const prior of first.input.publications){
      const reused=later.input.publications.find(p=>p.group.id===prior.group.id)!;
      expect(reused.request).toEqual(prior.request);expect(reused.published).toEqual(prior.published);
      expect(reused.group.occurrences[0]!.position).toBe(prior.group.occurrences[0]!.position+1);
      expect(await restored.activities.command({kind:"read_path",pathId:reused.pathId})).toMatchObject({dispatchedAttempts:1,progressRevision:1});
    }
  });
  it("rejects missing, duplicate or relocated occurrences and split native groups",()=>{
    const s=sources();
    expect(()=>validateOriginalInputSources({...s,groups:s.groups.slice(1)})).toThrow("coverage_missing");
    expect(()=>validateOriginalInputSources({...s,groups:[...s.groups,s.groups[0]!]})).toThrow("group_invalid");
    expect(()=>validateOriginalInputSources({...s,groups:s.groups.map((g,i)=>i?g:{...g,occurrences:g.occurrences.map(o=>({...o,position:o.position+1}))})})).toThrow("occurrence_invalid");
    const native=s.groups.find(g=>g.occurrences.length===2)!;
    expect(()=>validateOriginalInputSources({...s,groups:s.groups.flatMap(g=>g!==native?[g]:g.occurrences.map((o,i)=>({...g,id:`split:${i}`,occurrences:[o]})))})).toThrow("native_group_split");
  });
  it("rejects changed target, directory, user content or request purpose rather than certifying a transformation",async()=>{
    const f=await prepare(sources(),open());
    for(const request of [
      {...f.input.sources.request,purpose:"auxiliary"},
      {...f.input.sources.request,metadata:{...f.input.sources.request.metadata,injected:true}},
      {...f.input.sources.request,continuation:{providerId:"other",id:"session",metadata:{}}},
    ])expect(()=>prepareOriginalInputSelection({...f.input,sources:{...f.input.sources,request:request as ProviderRequest}})).toThrow();
    expect(()=>prepareOriginalInputSelection({...f.input,scope:{...f.input.scope,target:"different"}})).toThrow("combination_changed");
    const changed=sources("root",true);expect(()=>prepareOriginalInputSelection({...f.input,sources:changed})).toThrow("combination_changed");
    const interaction=createNativeToolTurnInteraction([{name:"Changed_tool",description:"Changed",inputSchema:{type:"object",properties:{}}}]);
    expect(()=>prepareOriginalInputSelection({...f.input,sources:{...f.input.sources,request:{...f.input.sources.request,interaction,
      composition:{...f.input.sources.request.composition,interaction}}}})).toThrow("combination_changed");
  });
  it("rejects pending, changed, missing or duplicated source publications",async()=>{
    const f=await prepare(sources(),open()),p=f.input.publications[0]!;
    for(const publication of [{...p,state:"pending" as const,published:null},{...p,published:{...p.published!,representation:{...p.published!.representation,form:"summary" as const}}},
      {...p,published:{...p.published!,version:{...p.published!.version,digest:"changed"}}}])
      expect(()=>prepareOriginalInputSelection({...f.input,publications:[publication,...f.input.publications.slice(1)]})).toThrow();
    expect(()=>prepareOriginalInputSelection({...f.input,publications:f.input.publications.slice(1)})).toThrow("coverage_missing");
    expect(()=>prepareOriginalInputSelection({...f.input,publications:f.input.publications.map(()=>p)})).toThrow("coverage_missing");
  });
  it("separates Root, Child and auxiliary recipients even when bytes are identical",async()=>{
    const db=open(),root=await prepare(sources(),db),child=await prepare(sources("child"),db),aux=await prepare(sources(),db,"helper");
    expect(root.select().judgment.id).not.toBe(child.select().judgment.id);
    expect(root.select().judgment.id).not.toBe(aux.select().judgment.id);
    expect(()=>prepareOriginalInputSelection({...child.input,publications:root.input.publications})).toThrow();
    expect(()=>prepareOriginalInputSelection({...aux.input,publications:root.input.publications})).toThrow("publication_mismatch");
    expect(()=>prepareOriginalInputSelection({...root.input,need:{...root.input.need,supplier:"other-owner"}})).toThrow("combination_changed");
  });
  it("does not drop declared deliveries or relabel source duties",async()=>{
    const f=await prepare(sources(),open());
    const changed={...f.input.sources,groups:f.input.sources.groups.map((g,i)=>i?g:{...g,duties:["objective" as const]})};
    expect(()=>prepareOriginalInputSelection({...f.input,sources:changed})).toThrow("contribution_changed");
    const missing={...f.input.sources,groups:f.input.sources.groups.map((g,i)=>i?g:{...g,deliveries:[{id:"new-delivery",sequence:1,digest:"original",sectionId:g.occurrences[0]!.section.id,source:g.occurrences[0]!.section.source}]})};
    expect(()=>prepareOriginalInputSelection({...f.input,sources:missing})).toThrow("contribution_changed");
  });
});

describe("source-declared first result representation",()=>{
  it("retains declared companion closure even for independently supplied result scopes",()=>{
    const original=sources("root",false,true);
    const related=(missing=false):OriginalInputSources=>{
      const composition=composeModelInput({...original.request.composition,sections:original.request.composition.sections.map(section=>
        section.id!=="tool"?section:{...section,preservation:{obligations:section.preservation?.obligations??[{id:"report",requirement:"account",basis:"Keep original result facts"}],relationships:[{kind:"requires",source:sourceRef(missing?"missing":"task")}]}})});
      return {...original,request:{...original.request,composition,messages:composition.messages,instructions:composition.instructions},
        groups:original.groups.map(group=>({...group,revision:digest(group.occurrences.map(o=>composition.sections[o.position])),
          occurrences:group.occurrences.map(o=>({...o,section:composition.sections[o.position]!}))}))};
    };
    const source=related(),scope=originalInputResultTextScopes({sources:source,maximum:16,backgroundGroupIds:[]}).scopes[0]!;
    expect(scope.groups.map(group=>group.role)).toEqual(["background","source"]);
    expect(()=>validateOriginalInputResultTextScope(source,{...scope,groups:scope.groups.filter(group=>group.role==="source")})).toThrow("companion_missing");
    const unavailable=originalInputResultTextScopes({sources:related(true),maximum:16,backgroundGroupIds:[]});
    expect(unavailable.scopes).toHaveLength(0);expect(unavailable.exclusions[0]!.reasons).toContain("declared_companion_unavailable");
  });
  it("requires a declaration and retains active native group protection against historical replacement",()=>{
    expect(originalInputResultTextScopes({sources:sources(),maximum:16,backgroundGroupIds:[]}).scopes).toEqual([]);
    const original=sources("root",false,true),result=originalInputResultTextScopes({sources:original,maximum:16,backgroundGroupIds:["root:source:task"]});
    expect(result.scopes).toHaveLength(1);expect(result.scopes[0]!.groups.map(g=>g.role)).toEqual(["background","source"]);
    expect(originalInputAccountScopes({sources:original,maximum:16,backgroundGroupIds:[]}).scopes).toEqual([]);
    const scope=result.scopes[0]!;
    expect(()=>validateOriginalInputResultTextScope(original,scope)).not.toThrow();
    expect(()=>validateOriginalInputResultTextScope(original,{...scope,declaration:{...scope.declaration,slot:{...scope.declaration.slot,contentPath:["error"]}}})).toThrow();
    expect(()=>validateOriginalInputResultTextScope(original,{...scope,requirements:[]})).toThrow("scope_changed");
  });
  it("supplies and materializes the declared result text without replacing the original exchange",async()=>{
    const original=sources("root",false,true),f=await prepare(original,open());
    const scope=originalInputResultTextScopes({sources:original,maximum:16,backgroundGroupIds:["root:source:task"]}).scopes[0]!;
    const offer=supplyOriginalInputResultTextMethod({sources:original,scope,publications:f.input.publications,
      sourceRecipient:{runId:"root",recipient:"agent",purpose:"task"},target:f.input.scope.target,authorizationBasis:"host",addresses:["capacity"],
      capacity:{limits:[],reservations:[],policy:{id:"test",revision:"1",purpose:"task",basis:"actual",allowEstimatedFit:true,allowUnknown:true},maximumCombinations:4,maximumMeasurements:0},
      bounds:{readBytes:1000000,storedBytes:1000000,modelCalls:8,repairs:1,levels:2,pageBytes:65536,ranges:64},limits:{maximumStages:128,maximumAttempts:128}});
    expect(offer.kind).toBe("result_text");expect(offer.request.objective).toContain("not a historical account");
    const candidate={id:"candidate",representation:{id:"short-report",revision:"1"},access:{id:"candidate",holdId:"producer-hold",recipient:offer.request.recipient,
      range:{materialId:"short-report",version:"1",start:0,end:50,coordinate:"bytes" as const}},sources:[offer.request.sources.find(s=>s.role==="source")!.alias],
      losses:[],relationships:[],unknowns:[],generatedBy:"generate",level:0,segments:[]};
    const progress={kind:"representation_method_progress",request:offer.request,state:"ready",resultIds:[candidate.id],candidates:[candidate],
      assessments:[{id:"check",supported:true,scope:"both",candidateIds:[candidate.id]}]} as unknown as import("@agent-anything/agent-runtime/context-representation").RepresentationMethodProgress;
    const access={...candidate.access,holdId:"parent-hold",recipient:{runId:"root",recipient:"agent",purpose:"task"}};
    const basis={id:"result-input",sources:original,original:f.input.prepared.demand,supply:offer,progress,access};
    const demand=originalInputResultTextDemand(basis),sections=demand.contributions.flatMap(c=>c.options[0]!.sections);
    expect(sections.map(o=>o.section.id)).toEqual(original.request.composition.sections.map(s=>s.id));
    const changed=sections.find(o=>o.section.id==="tool")!.section;
    expect(changed.role).toBe("tool");expect(changed.content).toMatchObject({kind:"retained_result_text",replacements:[{slot:scope.declaration.slot,access}]});
    expect(sections.find(o=>o.section.id==="assistant")!.section).toEqual(original.request.composition.sections.find(s=>s.id==="assistant"));
    expect(demand.contributions.find(c=>c.id==="root:source:assistant:tool")!.options[0]!.resultTextBindings).toHaveLength(1);
    expect(()=>originalInputResultTextDemand({...basis,progress:{...progress,state:"working"}})).toThrow("binding_invalid");
    expect(()=>originalInputResultTextDemand({...basis,access:{...access,recipient:{...access.recipient,runId:"sibling"}}})).toThrow("binding_invalid");
  });
});

describe("source-owned representation combination",()=>{
  async function setup() {
    const base=accountSources(false,true),prior:ModelInputSectionCandidate={id:"earlier",source:sourceRef("earlier"),kind:"history",role:"assistant",necessity:"mandatory",
      content:{kind:"text",text:"Earlier investigation remained inconclusive."},preservation:{obligations:[{id:"prior",requirement:"account",basis:"Keep the uncertainty"}],relationships:[]}};
    const composition=composeModelInput({...base.request.composition,sections:[base.request.composition.sections[0]!,prior,...base.request.composition.sections.slice(1)]});
    const original:OriginalInputSources={...base,id:"joint-original",request:{...base.request,composition,messages:composition.messages,instructions:composition.instructions},
      groups:[...base.groups.map(g=>{
        const occurrences=g.occurrences.map(o=>({...o,position:o.position===0?0:o.position+1}));
        const tool=occurrences.find(o=>o.section.id==="tool")?.section.content;
        return {...g,occurrences,...(tool?.kind==="model_message"&&tool.message.role==="tool"?{resultTexts:[...g.resultTexts!,{...g.resultTexts![0]!,id:"details-slot",
          slot:declareModelResultTextSlot(tool.message,g.resultTexts![0]!.slot.callId,["details"])}]}:{})};
      }),{id:"earlier",owner:"test-source",revision:"1",occurrences:[{position:1,section:composition.sections[1]!}],duties:["continuity"],sources:[prior.source],deliveries:[]}]};
    const f=await prepare(original,open()),parameters={sources:original,publications:f.input.publications,sourceRecipient:{runId:"root",recipient:"agent",purpose:"task"},
      target:f.input.scope.target,authorizationBasis:"host",addresses:["capacity"],
      capacity:{limits:[],reservations:[],policy:{id:"test",revision:"1",purpose:"task",basis:"actual",allowEstimatedFit:true,allowUnknown:true},maximumCombinations:4,maximumMeasurements:0},
      bounds:{readBytes:1000000,storedBytes:1000000,modelCalls:8,repairs:1,levels:2,pageBytes:65536,ranges:64},limits:{maximumStages:128,maximumAttempts:128}};
    const scopes={sources:original,maximum:16,backgroundGroupIds:["root:source:task"]};
    const results=originalInputResultTextScopes(scopes).scopes.map(scope=>supplyOriginalInputResultTextMethod({...parameters,scope}));
    const accounts=originalInputAccountScopes(scopes).scopes.map(scope=>supplyOriginalInputAccountMethod({...parameters,scope}));
    const account=accounts.find(a=>a.scope.groups.filter(g=>g.role==="source").map(g=>g.id).join() === "earlier")!;
    expect(results).toHaveLength(2);expect(account).toBeDefined();
    const member=(supply:typeof account|typeof results[number],index:number)=>{
      const id=`producer-${index}`,candidate={id:`candidate-${index}`,representation:{id:`representation-${index}`,revision:"1"},
        access:{id:`access-${index}`,holdId:`hold-${index}`,recipient:supply.request.recipient,range:{materialId:`material-${index}`,version:"1",start:0,end:50,coordinate:"bytes" as const}},
        sources:supply.request.sources.filter(s=>s.role==="source").map(s=>s.alias),losses:[],relationships:[],unknowns:[],generatedBy:"generate",level:0,segments:[]};
      const progress={kind:"representation_method_progress",request:supply.request,state:"ready",resultIds:[candidate.id],candidates:[candidate],
        assessments:[{id:`assessment-${index}`,supported:true,scope:"both",candidateIds:[candidate.id]}]} as unknown as import("@agent-anything/agent-runtime/context-representation").RepresentationMethodProgress;
      return {pathId:id,supply,progress,access:{...candidate.access,holdId:`receiving-${index}`,recipient:{runId:"root",recipient:"agent",purpose:"task"}}};
    };
    return {f,original,parameters,member,accounts,members:[...results.map(member),member(account,2)]};
  }
  it("joins disjoint positions and an independent account against one original, preserving order and unselected content",async()=>{
    const {f,original,members}=await setup(),basis={id:"joined",sources:original,original:f.input.prepared.demand,members};
    const demand=originalInputRepresentationDemand(basis),sections=demand.contributions.flatMap(c=>c.options[0]!.sections).sort((a,b)=>a.position-b.position);
    expect(originalInputRepresentationDemand({...basis,members:[...members].reverse()})).toEqual(demand);
    expect(sections.map(s=>s.position)).toEqual([0,1,2,3,4,5]);
    expect(sections.filter(s=>s.section.kind==="historical_account")).toHaveLength(1);
    const tool=sections.find(s=>s.section.id==="tool")!.section.content;
    expect(tool).toMatchObject({kind:"retained_result_text",replacements:[{slot:{contentPath:["summary"]}},{slot:{contentPath:["details"]}}]});
    expect(sections.find(s=>s.section.id==="assistant")!.section).toEqual(original.request.composition.sections.find(s=>s.id==="assistant"));
    expect(demand.contributions.find(c=>c.id==="root:source:assistant:tool")!.options[0]!.resultTextBindings).toHaveLength(2);
    expect(demand.dependencies).toMatchObject({"representationProducer:0":"producer-0","representationProducer:1":"producer-1","representationProducer:2":"producer-2"});
    expect(demand.deliveryIds).toEqual(f.input.prepared.demand.deliveryIds);
  });
  it("enumerates only legal placements with explicit bounded coverage, independent of caller order",async()=>{
    const {original,members,accounts,member}=await setup();
    const basis={sources:original,members,maximum:16,maximumInspections:256};
    const all=originalInputReceptionCombinations(basis);
    expect(all.complete).toBe(true);expect(all.combinations).toHaveLength(7);expect(all.combinations[0]).toEqual(members);
    expect(originalInputReceptionCombinations({...basis,members:[...members].reverse()})).toEqual(all);
    const bounded=originalInputReceptionCombinations({...basis,maximum:1});
    expect(bounded.complete).toBe(false);expect(bounded.combinations).toEqual([members]);
    const stopped=originalInputReceptionCombinations({...basis,maximumInspections:1});
    expect(stopped.examined).toBe(1);expect(stopped.complete).toBe(false);expect(stopped.combinations).toEqual([]);
    const overlap=member(accounts.find(a=>a.scope.groups.some(g=>g.role==="source"&&g.id==="root:source:assistant:tool"))!,3);
    const conflicts=originalInputReceptionCombinations({...basis,members:[...members,overlap]});
    expect(conflicts.complete).toBe(true);expect(conflicts.conflicts).toBeGreaterThan(0);
    for(const combination of conflicts.combinations)expect(()=>validateOriginalInputRepresentationMembers(original,combination)).not.toThrow();
    const template=originalInputReceptionTemplate(original);
    expect(template.interaction.kind).toBe("text_generation");expect(template.composition.lineage.agent).toBeNull();
    expect(template.requestId).not.toBe(members[0]!.supply.request.template.requestId);
  });
  it("rejects duplicate identity, duplicate placement, account/body overlap, and changed source or progress",async()=>{
    const {f,original,members,accounts,member}=await setup();
    expect(()=>validateOriginalInputRepresentationMembers(original,[members[0]!,members[0]!])).toThrow("members_invalid");
    expect(()=>validateOriginalInputRepresentationMembers(original,[members[0]!,{...members[0]!,pathId:"duplicate"}])).toThrow("placements_overlap");
    const overlap=member(accounts.find(a=>a.scope.groups.some(g=>g.role==="source"&&g.id==="root:source:assistant:tool"))!,3);
    for(const values of [[overlap,members[0]!],[members[0]!,overlap]])expect(()=>validateOriginalInputRepresentationMembers(original,values)).toThrow("placements_overlap");
    const basis={id:"joined",sources:original,original:f.input.prepared.demand,members};
    expect(()=>originalInputRepresentationDemand({...basis,members:[{...members[0]!,progress:{...members[0]!.progress,state:"working"}}]})).toThrow("binding_invalid");
    expect(()=>originalInputRepresentationDemand({...basis,original:{...basis.original,historyBoundary:"changed"}})).toThrow("binding_invalid");
    expect(()=>originalInputRepresentationDemand({...basis,members:[{...members[0]!,access:{...members[0]!.access,recipient:{runId:"sibling",recipient:"agent",purpose:"task"}}}]})).toThrow("binding_invalid");
  });
  it("offers a new placement only against a real capacity gap and compatible retained members",async()=>{
    const {f,original,members,accounts,member}=await setup();
    const inputGap={kind:"gap" as const,evidence:{owner:"activity",kind:"fact" as const,id:"original-stage",revision:"2"},
      gap:{reason:"capacity",demandId:"recipient",targetRevision:f.input.scope.target,information:[],
        capacity:[{...f.input.prepared.capacity,allowed:false}],untested:false,responsibility:"request_owner" as const}};
    const basis={sources:original,proposed:members[1]!,receptions:[{optionId:"receiver",members:[members[0]!],inputGap}]};
    expect(originalInputReceptionExtension(basis)).toEqual({optionId:"receiver",evidence:inputGap.evidence});
    expect(originalInputReceptionExtension({...basis,proposed:members[0]!})).toBeUndefined();
    const overlap=member(accounts.find(a=>a.scope.groups.some(g=>g.role==="source"&&g.id==="root:source:assistant:tool"))!,3);
    expect(originalInputReceptionExtension({...basis,proposed:overlap})).toBeUndefined();
    expect(originalInputReceptionExtension({...basis,receptions:[{...basis.receptions[0]!,inputGap:{...inputGap,gap:{...inputGap.gap,capacity:[]}}}]})).toBeUndefined();
  });
  it("freezes all producers and recipient check template, and accounts for aggregate reading stages",async()=>{
    const {f,original,members,parameters}=await setup(),materials={command:async(command:{kind:string;holdId:string})=>({hold:{instanceId:command.holdId}})} as unknown as MaterialCustodyPort;
    const preparation={kind:"context_input_preparation" as const,demand:f.input.prepared.demand,template:original.request,limits:[],reservations:[],policy:parameters.capacity.policy,
      allowExternalMeasurement:false,deliveryMode:"buffered" as const,localMeasurements:[],sharedCapacity:null,materialAccesses:[]};
    const basis={sources:original,members,scope:f.input.scope,preparation,checkTemplate:members[0]!.supply.request.template};
    const reception=new OriginalInputRepresentationReception({} as never);
    expect(reception.id(basis)).toBe(reception.id({...basis,members:[...members].reverse()}));
    expect(reception.id(basis)).not.toBe(reception.id({...basis,members:members.slice(0,1)}));
    const args={...basis,intent:{id:reception.id(basis),runId:"root",permissionBasis:"host",resourceScope:"receiving",maximumStages:128,maximumAttempts:128,maximumConcurrent:1,deadlineAt:"2030-01-01T00:00:00Z"},
      checkCapacity:parameters.capacity,checkBounds:parameters.bounds,materials,signal:signal()};
    const plan=await originalInputRepresentationPlan(args);
    expect(plan.producers.map(p=>p.pathId)).toEqual(members.map(m=>m.pathId));expect(plan.materialAdmissions).toHaveLength(3);
    expect(plan.check.template).toEqual(basis.checkTemplate);
    expect(await originalInputRepresentationPlan({...args,members:[...members].reverse()})).toEqual(plan);
    await expect(originalInputRepresentationPlan({...args,checkBounds:{...parameters.bounds,pageBytes:1}})).rejects.toThrow("known_work_exceeds_delegation");
    await expect(originalInputRepresentationPlan({...args,checkBounds:{...parameters.bounds,readBytes:100}})).rejects.toThrow("read_budget_exceeded");
  });
});

describe("original account method supply",()=>{
  function withSections(change:(section:ModelInputSectionCandidate)=>ModelInputSectionCandidate):OriginalInputSources {
    const original=accountSources(),composition=composeModelInput({...original.request.composition,sections:original.request.composition.sections.map(change)});
    return {...original,request:{...original.request,composition,instructions:composition.instructions,messages:composition.messages},
      groups:original.groups.map(g=>({...g,revision:digest(g.occurrences.map(o=>composition.sections[o.position])),
        occurrences:g.occurrences.map(o=>({...o,section:composition.sections[o.position]!}))}))};
  }
  it("reports bounded enumeration without invalidating an independently legal scope",()=>{
    const original=withSections(s=>s.id!=="later-answer"?s:{...s,preservation:{obligations:[{id:"answer",requirement:"account",basis:"Keep the actual conclusion"}],relationships:[]}});
    const complete=originalInputAccountScopes({sources:original,maximum:16,backgroundGroupIds:[]});
    const bounded=originalInputAccountScopes({sources:original,maximum:1,backgroundGroupIds:[]});
    expect(complete.scopes).toHaveLength(2);expect(bounded.enumeration).toEqual({complete:false,eligible:2,returned:1});
    expect(()=>validateOriginalInputAccountScope(original,complete.scopes[1]!)).not.toThrow();
  });
  it("keeps protected declared companions as background and refuses missing transitive companions",()=>{
    const related=withSections(s=>s.id!=="tool"?s:{...s,preservation:{...s.preservation!,relationships:[{kind:"requires",source:sourceRef("task")}]}});
    const scope=originalInputAccountScopes({sources:related,maximum:16,backgroundGroupIds:[]}).scopes[0]!;
    expect(scope.groups.map(g=>({id:g.id,role:g.role}))).toEqual([{id:"root:source:task",role:"background"},{id:"root:source:assistant:tool",role:"source"}]);
    expect(scope.relationships).toHaveLength(1);expect(scope.requirements).toHaveLength(2);
    expect(()=>validateOriginalInputAccountScope(related,{...scope,groups:scope.groups.filter(g=>g.role==="source")})).toThrow("companion_missing");
    const missing=withSections(s=>!["tool","task"].includes(s.id)?s:{...s,preservation:{obligations:s.preservation?.obligations??[{id:"exact",requirement:"exact",basis:"Keep the original task"}],relationships:[{kind:"requires",source:sourceRef(s.id==="tool"?"task":"missing")}]}});
    expect(originalInputAccountScopes({sources:missing,maximum:16,backgroundGroupIds:[]}).scopes).toEqual([]);
  });
  it("offers only declared, closed historical scopes and keeps missing relations explicit",()=>{
    const original=accountSources(),catalog=originalInputAccountScopes({sources:original,maximum:16,backgroundGroupIds:[]});
    expect(catalog.scopes).toHaveLength(1);expect(catalog.enumeration.complete).toBe(true);
    expect(catalog.scopes[0]!.groups.map(g=>g.id)).toEqual(["root:source:assistant:tool"]);
    expect(catalog.exclusions.some(e=>e.groupId==="root:source:task"&&e.reasons.includes("exact_preservation"))).toBe(true);
    expect(originalInputAccountScopes({sources:sources(),maximum:16,backgroundGroupIds:[]}).scopes).toEqual([]);
    const scope=catalog.scopes[0]!;
    expect(()=>validateOriginalInputAccountScope(original,{...scope,requirements:[]})).toThrow("scope_invalid");
    expect(()=>validateOriginalInputAccountScope(sources("child"),scope)).toThrow("scope_changed");
    const section=original.request.composition.sections.find(s=>s.id==="tool")!;
    const changedSection={...section,preservation:{...section.preservation!,relationships:[{kind:"requires" as const,source:sourceRef("missing")}]}};
    const composition=composeModelInput({...original.request.composition,sections:original.request.composition.sections.map(s=>s.id==="tool"?changedSection:s)});
    const changed={...original,request:{...original.request,composition,instructions:composition.instructions,messages:composition.messages},
      groups:original.groups.map(g=>({...g,occurrences:g.occurrences.map(o=>o.section.id==="tool"?{...o,section:composition.sections[o.position]!}:o)}))};
    const blocked=originalInputAccountScopes({sources:changed,maximum:16,backgroundGroupIds:[]});
    expect(blocked.scopes).toEqual([]);expect(blocked.exclusions.some(e=>e.reasons.includes("declared_companion_unavailable"))).toBe(true);
  });
  it("uses the same frozen method request after reopen and input relocation without copying the task catalog",async()=>{
    const f=open(),prepared=await prepare(accountSources(),f);
    const offer=(p:typeof prepared)=>{
      const scope=originalInputAccountScopes({sources:p.input.sources,maximum:16,backgroundGroupIds:["root:source:task"]}).scopes[0]!;
      return supplyOriginalInputAccountMethod({sources:p.input.sources,scope,publications:p.input.publications,
        sourceRecipient:{runId:"root",recipient:"agent",purpose:"task"},target:p.input.scope.target,authorizationBasis:"host",addresses:["pressure"],
        capacity:{limits:[],reservations:[],policy:{id:"test",revision:"1",purpose:"task",basis:"estimated",allowEstimatedFit:true,allowUnknown:true},maximumCombinations:4,maximumMeasurements:0},
        bounds:{readBytes:1000000,storedBytes:1000000,modelCalls:8,repairs:1,levels:2,pageBytes:65536,ranges:64},limits:{maximumStages:128,maximumAttempts:128}});
    };
    const first=offer(prepared);expect(first.request.template.messages).toHaveLength(1);expect(first.request.template.interaction.kind).toBe("text_generation");
    expect(JSON.stringify(first.request.template.messages)).not.toContain("file_missing");
    expect(first.request.recipient.purpose).toBe("context_representation");expect(first.option.capability.every(c=>c.conclusion==="unknown")).toBe(true);
    expect(first.request.sources.map(s=>s.role)).toEqual(["background","source"]);
    expect(first.request.requirements).toHaveLength(2);expect(first.materialAdmissions).toHaveLength(2);
    f.db.close();const reopened=open(f.directory),later=offer(await prepare(accountSources(true),reopened));
    expect(later).toEqual(first);
    const demand=prepared.input.prepared.demand,source=first.request.sources.find(s=>s.role==="source")!;
    const candidate={id:"candidate",representation:{id:"derived",revision:"1"},access:{id:"candidate-access",holdId:"method-hold",recipient:first.request.recipient,
      range:{materialId:"derived",version:"1",start:0,end:50,coordinate:"bytes" as const}},sources:[source.alias],losses:[],relationships:[],unknowns:[],generatedBy:"generate",level:0,segments:[]};
    const progress={kind:"representation_method_progress",request:first.request,state:"ready",resultIds:[candidate.id],candidates:[candidate],
      assessments:[{id:"assessment",supported:true,scope:"both",candidateIds:[candidate.id]}]} as unknown as import("@agent-anything/agent-runtime/context-representation").RepresentationMethodProgress;
    const access={...candidate.access,holdId:"recipient-hold",recipient:{runId:"root",recipient:"agent",purpose:"task"}};
    const composed=originalInputAccountDemand({id:"derived-input",sources:prepared.input.sources,original:demand,supply:first,progress,access});
    expect(composed.contributions.flatMap(c=>c.options[0]!.sections).map(s=>s.section.id)).toEqual(["task","derived-input:account","follow-up","later-answer"]);
    expect(composed.contributions[0]).toEqual(demand.contributions[0]);expect(composed.deliveryIds).toEqual(demand.deliveryIds);
    expect(()=>originalInputAccountDemand({id:"bad",sources:prepared.input.sources,original:demand,supply:first,progress:{...progress,state:"working"},access})).toThrow("binding_invalid");
    expect(()=>originalInputAccountDemand({id:"bad",sources:prepared.input.sources,original:demand,supply:first,progress,access:{...access,recipient:{...access.recipient,runId:"child"}}})).toThrow("binding_invalid");
  });
});
