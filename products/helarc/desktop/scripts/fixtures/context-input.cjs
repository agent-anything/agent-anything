const {app}=require("electron");
const assert=require("node:assert/strict");
const {join}=require("node:path");
const {pathToFileURL}=require("node:url");
const {writeFile,readFile}=require("node:fs/promises");
const {createHash}=require("node:crypto");
const [directory,phase,endpoint]=process.argv.slice(2);
app.setPath("userData",join(directory,"electron"));app.disableHardwareAcceleration();
let store,inspection,queries;
async function main(){
  await app.whenReady();
  const load=path=>import(pathToFileURL(join(__dirname,"../../dist/main",path)));
  const {HelarcExecutionStore}=await load("execution-storage/HelarcExecutionStore.js");
  const {bindHelarcContextInputPreparation}=await load("context/HelarcContextInputPreparation.js");
  const {ActivityPurposeRegistry,ActivityHandoffProcessor}=await import("@agent-anything/agent-runtime/activity");
  const {PreparedInputExecution,contextInputAcceptance,validatePreparedContextInput,decideContextPreparation,readContextInputEvidence,recipientContextDeliveryId}=await import("@agent-anything/agent-runtime/context-representation");
  const {OllamaProvider}=await import("@agent-anything/provider-integrations/ollama");
  const {OpenAICompatibleProvider}=await import("@agent-anything/provider-integrations/openai-compatible");
  const {createNativeToolTurnInteraction}=await import("@agent-anything/model-interaction");
  const {composeModelInput,organizeOriginalInput,modelInputValueDigest:digest}=await import("@agent-anything/model-interaction/input");
  const {createSelectedInputDeliveryReceipt,inputNotificationDeliveryId}=await import("@agent-anything/agent-runtime/decision");
  const common={model:process.env.ACTIVITY_LIVE_MODEL??"controlled",timeoutMs:60000,nativeToolInteraction:{supported:true},requestBodyTransportLimit:{maximumBytes:1000000,source:"host_configured",revision:"1"}};
  const provider=process.env.ACTIVITY_OPENAI?new OpenAICompatibleProvider({...common,baseUrl:endpoint+"/v1",apiKey:"local-ollama"}):
    new OllamaProvider({...common,baseUrl:endpoint,think:false,runtime:{contextWindowTokens:16384}});
  if(process.env.ACTIVITY_REMOTE_MEASUREMENT) {
    provider.modelContext={...provider.modelContext,measure:(composition,measuredAt)=>({status:"unknown",unit:"tokens",accuracy:"unknown",estimator:null,reason:"unsupported",measuredCompositionId:composition.id,measuredAt})};
    provider.inputMeasurement={revision:"controlled-count:1",prepare:(_request,encoded)=>({id:`count:${encoded.id}`,methodRevision:"controlled-count:1",encodedInputId:encoded.id,targetRevision:encoded.targetDigest,payload:{body:encoded.body}}),
      send:async(request,signal)=>{const result=await fetch(endpoint+"/measure",{method:"POST",body:JSON.stringify(request),signal});assert(result.ok);return result.json();},
      interpret:(_request,raw,compositionId,measuredAt)=>({status:"measured",amount:raw.tokens,estimator:{id:"controlled-count",revision:"1",unit:"tokens",accuracy:"exact"},uncertainty:{kind:"none"},measuredCompositionId:compositionId,measuredAt})};
  }
  store=await HelarcExecutionStore.open(join(directory,"execution"));
  const c=command=>store.materialCustody.command(command),s=command=>store.contextSelections.command(command),a=command=>store.activityHandoffs.command(command);
  const registry=new ActivityPurposeRegistry(),signal=new AbortController().signal,now=()=>new Date().toISOString();
  const work=bindHelarcContextInputPreparation({store,provider,registry,now,authorize:async path=>{assert.equal(path.intent.permissionBasis,"isolated-host");return {kind:"allowed"};}});
  const purpose=registry.register({ref:{id:"input-verification",revision:"1"},inputOwner:"context-representation",executionOwner:"model-access",interpretationOwner:"parent-agent",
    acceptanceOwner:"parent-agent",recoveryOwner:"parent-agent",stageKinds:["model","input-unavailable"],capabilities:["model-access"],continuationKinds:[]},
    new PreparedInputExecution({provider,selections:store.contextSelections,inputId:()=>"input",now,authorize:async(path,stage)=>{
      assert.equal(stage.request.stageKind,"model","Exact-fit verification must not take the unavailable-input entry");
      assert.equal(path.intent.permissionBasis,"isolated-host");return {kind:"allowed"};},
      interpret:async(_path,stage,_signal,acceptance)=>{assert.equal(stage.result.value.kind,"succeeded",JSON.stringify(stage.result.value));
        const binding=await s({kind:"binding",inputId:"input",checkCurrentControl:false});
        const receipt=createSelectedInputDeliveryReceipt({batch,binding,response:stage.result.value.response,rawResultId:stage.result.id,responseAcceptanceId:acceptance.id});
        assert.equal(receipt.via.presentations.length,1);assert.equal(receipt.via.selection.mapping.length,2);
        return {progress:{delivered:stage.result.id,receipt},next:[],
        participants:[{owner:"context_delivery",kind:"accept",proposal:{inputId:"input",responseId:stage.result.id,detailHolds:["detail"]}}]};}}));
  const processor=new ActivityHandoffProcessor(store.activityHandoffs,registry,store.activityJournal.executor,now);
  const recipient={runId:"parent",recipient:"parent-agent",purpose:"input-verification"};
  const batch={id:"child-contribution-batch",revision:"1",runId:"parent",entries:["child-result","child-terminal"].map((id,index)=>({runId:"parent",sequence:index+1,
    source:{owner:"child-agent",kind:"finding",id,revision:"1",runId:"child"},occurredAt:"2026-10-29T00:00:00.000Z",data:{source:id}}))};
  const deliveryIds=batch.entries.map(entry=>recipientContextDeliveryId(inputNotificationDeliveryId(entry),recipient));
  const bytes=Buffer.from("Child observation: "+"retained evidence. ".repeat(200)+"TARGET: 7391");
  const range={materialId:"child-report",version:"1",coordinate:"bytes",start:0,end:bytes.length};
  const hold=(id,responsibility,basis)=>({id,instanceId:"physical",consumer:recipient,responsibility,range,basis,releaseCondition:"explicit responsibility settlement"});
  const intent={id:"capture",instanceId:"physical",activityId:"child-output",owner:"child-agent",maximumBytes:bytes.length,
    version:{ref:{materialId:range.materialId,version:range.version},origin:{runId:"child",owner:"child-agent",recordId:"child-result",revision:"1",occurredAt:"2026-10-29T00:00:00.000Z"},
      label:"Child result",format:"utf8",mediaType:"text/plain",bytes:bytes.length,digest:`sha256:${createHash("sha256").update(bytes).digest("hex")}`,capture:"complete",limitations:[]}};
  const ref=id=>({owner:"isolated-host",kind:"record",id,revision:"1"});
  const interaction=createNativeToolTurnInteraction([{name:"final_result",description:"Finish this verification with the requested answer.",inputSchema:{type:"object",properties:{response:{type:"string"}},required:["response"],additionalProperties:false}}]);
  const lineage=Object.fromEntries(["instructionBinding","agent","instructions","instructionRelease","instructionResolver","instructionContent","activeContext","contextProjection","projectionManifest","toolSelection","toolExposureContent","toolExposureBasis","toolExposureProof","toolGuidance","controllerControlGuidance","callableDefinitions","protocol","policy"].map(k=>[k,ref(k)]));
  Object.assign(lineage,{instructionModel:{providerId:provider.modelContext.target.providerId,model:provider.modelContext.target.model},instructionBlocks:[],modelQualification:null,interactionHistory:null});
  const composition=composeModelInput({id:"original",providerId:provider.descriptor.id,model:provider.modelContext.target.model,interaction,lineage,composedAt:"2026-10-29T00:00:00.000Z",
    sections:[{id:"objective",source:ref("user-request"),kind:"task",role:"user",necessity:"mandatory",content:{kind:"text",text:"Report the TARGET number supplied by the Child. Do not run any operations."}},
      {id:"child-evidence",source:{...ref("child-result"),runId:"child"},kind:"child_result",role:"user",necessity:"mandatory",content:{kind:"text",text:bytes.toString()},
        provenance:{purpose:"later_outcome",recipientRunId:"parent",author:"child",originRunId:"child",sources:batch.entries.map(entry=>entry.source),
          presenter:ref("child-presentation"),coverage:batch.entries.map(entry=>entry.source.id+"@1"),limitations:[]}}]});
  const template={requestId:composition.id,purpose:recipient.purpose,correlation:{controllerRequestId:"input-demand",branchId:"parent:main"},instructions:composition.instructions,messages:composition.messages,interaction,composition,
    modelContext:{requestedOutput:provider.modelContext.requestedOutput,headroom:{unit:"tokens",amount:0,policy:{id:"controlled",revision:"1"}},assessment:null},continuation:null,metadata:{}};
  const target=provider.encodeInput(template,"buffered").targetDigest;
  const scope={...recipient,id:"scope",continuity:"task-1",owner:"context-representation",target,authorityBasis:"isolated-host"};
  const demand=organizeOriginalInput({demand:{id:"demand",runId:recipient.runId,recipient:recipient.recipient,purpose:recipient.purpose,targetRevision:target,
    historyBoundary:"before-child-2",deliveryIds,dependencies:{source:"1"},maximumCombinations:4,maximumExternalMeasurements:process.env.ACTIVITY_REMOTE_MEASUREMENT?1:0,maximumReadBytes:65536},composition,
    groups:[{id:"objective",owner:"host",revision:"1",sectionIds:["objective"],duties:["objective"],deliveryIds:[]},
      {id:"child",owner:"context-representation",revision:"1",sectionIds:["child-evidence"],duties:["evidence","new_information"],deliveryIds}]});
  const path=id=>({id,runId:recipient.runId,permissionBasis:"isolated-host",resourceScope:id,maximumStages:12,maximumAttempts:12,maximumConcurrent:1,deadlineAt:"2030-01-01T00:00:00.000Z"});
  const evidence=()=>readContextInputEvidence({activities:store.activityHandoffs,pathId:"preparation-path",scope,demandId:demand.id,boundary:demand.historyBoundary},signal);
  const accept=async proposal=>{const value=await store.sharedAcceptance.accept(proposal);assert.equal(value.outcome,"accepted",JSON.stringify(value));return value;};
  const representation={ref:{id:"original-child",revision:"1"},owner:recipient.recipient,runId:recipient.runId,purpose:recipient.purpose,target,form:"original",body:range,
    inputs:[{role:"source",material:range,representation:null}],declaredCoverage:[range],details:[range],holds:["preparation"],requirements:[],losses:[],restorations:[],method:null};
  if(phase==="prepare") {
    await c({kind:"begin",intent});await c({kind:"append",id:"chunk",intentId:"capture",offset:0,bytesBase64:bytes.toString("base64")});await c({kind:"complete",intentId:"capture"});
    await accept({id:"publish",scope:"child",actor:"child-agent",parts:[{owner:"material_custody",kind:"publish",proposal:{intentId:"capture",holds:[hold("preparation","preparation","candidate"),hold("detail","detail","delivery"),...deliveryIds.map((id,index)=>hold(`delivery-hold:${index}`,"delivery",id))],
      grants:[{id:"parent-grant",instanceId:"physical",recipient,range,revision:0,allowed:true,basis:"explicit delegation"}]}}]});
    await accept({id:"publish-delivery",scope:"parent",actor:"parent-agent",parts:batch.entries.map((entry,index)=>({owner:"context_delivery",kind:"publish",
      proposal:{id:deliveryIds[index],sourceRunId:"child",sourceId:entry.source.id,recipient,material:range,instanceId:"physical",holdId:`delivery-hold:${index}`,detailHoldId:"detail"}}))});
    await store.representations.command({kind:"record",record:representation});
    await s({kind:"scope",scope});
    await work.submit(path("preparation-path"),{kind:"context_input_preparation",demand,template,limits:[{id:"transport",targetRevision:target,dimension:"request_bytes",maximum:1000000,source:"controlled transport"}],
      reservations:[],policy:{id:"controlled",revision:"1",purpose:recipient.purpose,basis:"Controlled service and deployed window; no claimed exact tokenization",allowEstimatedFit:true,allowUnknown:true},
      allowExternalMeasurement:Boolean(process.env.ACTIVITY_REMOTE_MEASUREMENT),deliveryMode:"buffered",localMeasurements:[],sharedCapacity:null,materialAccesses:[{id:"preparation-access",holdId:"preparation",recipient,range}]});
    await processor.drain("parent",signal);await processor.drain("parent",signal);
    assert.equal((await a({kind:"read_stage",requestId:"preparation-path:stage:1"})).status,"raw_result");
    assert.equal((await evidence()).kind,"pending","Raw preparation is not accepted input evidence");app.exit(73);return;
  }
  if(phase==="measure") {
    await processor.drain("parent",signal);await processor.drain("parent",signal);await processor.drain("parent",signal);
    const stage=await a({kind:"read_stage",requestId:"preparation-path:stage:2"});assert.equal(stage.status,"raw_result");assert.equal(stage.result.value.kind,"remote_returned");
    assert.equal(stage.request.input.progress.externalMeasurements,1);
    assert.equal((await evidence()).kind,"pending","A saved external count still needs its original interpretation");app.exit(73);return;
  }
  if(phase==="accept-input") {
    await processor.drain("parent",signal);
    const result=await evidence();assert.equal(result.kind,"available");assert.equal(result.current.kind,"prepared");const prepared=result.current.prepared;
    await writeFile(join(directory,"input-evidence.json"),JSON.stringify(result));
    validatePreparedContextInput(prepared);assert.equal(prepared.request.instructions.content.length,0);assert.equal(prepared.request.messages.length,1);
    assert(prepared.encoded.body.includes("TARGET: 7391"));assert.equal(prepared.deliveries.length,2);
    const policyInput={scope,boundary:prepared.demand.historyBoundary,requirementsDigest:"original-requirements:1",
      current:result.current,currentRejectedInputId:null,
      alternatives:[],pressure:[],options:[],inFlight:[],explorationHistory:[],optionalInFlight:0,autoPrepare:true,consumerActive:true};
    const decision=decideContextPreparation(policyInput);assert.equal(decision.foreground.kind,"continue");assert.equal(decision.investment.kind,"none");
    await a({kind:"register_fact_source",source:{id:"policy-inputs",runId:"parent",owner:"context-representation"}});
    await a({kind:"publish_fact",fact:{id:"prepared-for-policy",sourceId:"policy-inputs",ref:{owner:"context-representation",kind:"input",id:prepared.preparationStageId,revision:"1"}}});
    await a({kind:"subscribe_reconsideration",subscription:{id:"policy-recheck",runId:"parent",owner:"context-representation",sources:["policy-inputs"]}});
    const boundary=await a({kind:"read_reconsideration",subscriptionId:"policy-recheck",limit:16});
    const receipt={id:"accept-context-policy",subscriptionId:"policy-recheck",expectedRevision:0,through:boundary.through,factIds:boundary.facts.map(f=>f.id),
      decision:{owner:"context-representation",kind:"decision",id:decision.id,revision:"1"},close:false};
    const participants=[{owner:"context_preparation_policy",kind:"decision",proposal:{input:policyInput,expectedDecisionId:null,expectedControlRevision:0,investment:null}}];
    await a({kind:"accept_reconsideration",receipt,participants});
    assert.equal((await store.contextPolicy.query({kind:"latest",scopeId:scope.id})).decision.id,decision.id);
    await a({kind:"publish_fact",fact:{id:"later-policy-fact",sourceId:"policy-inputs",ref:{owner:"context-representation",kind:"input",id:"later-input",revision:"1"}}});
    await a({kind:"open_path",intent:{...path("model-path"),owner:"parent-agent",purpose}});
    await accept({id:"consumer-input-need",scope:"parent",actor:"parent-agent",parts:[{owner:"activity",kind:"input_need",proposal:{id:"input-need",supplier:"context-representation",
      stage:{id:"model-request",pathId:"model-path",stageKind:"model",capabilities:["model-access"],dependencies:[]},
      unavailableStage:{id:"model-unavailable",pathId:"model-path",stageKind:"input-unavailable",capabilities:[],dependencies:[]}}}]});
    const judgment={id:"combination",owner:"context-representation",runId:recipient.runId,evidenceSources:[],kind:"combination",subjects:[representation.ref],inputs:[range],purpose:recipient.purpose,target,
      methodRevision:"original-exact:1",dependencies:{inputDigest:digest(prepared)},coverage:[range],conclusion:"supported",limitations:["Original identity and known structure, not generated semantic preservation"],basis:"Original Child bytes, source and recipient retained without transformation"};
    await store.representations.command({kind:"judge",judgment});
    const proposal=contextInputAcceptance({id:"accept-input",scope,expectedSelectionId:null,expectedControlRevision:0,
      selection:{id:"selection",representations:[representation.ref],judgmentIds:[judgment.id],holds:[hold("selection-hold","selection","selection")]},retainedSelectionId:null,prepared,judgment,
      inputId:"input",activityId:"model-path",stageRequestId:"model-request",stageKind:"model",capabilities:["model-access"],inputHolds:[hold("input-hold","input","input")],releaseHolds:[]});
    await accept(proposal);await accept(proposal);assert.equal((await a({kind:"read_stage",requestId:"model-request"})).status,"submitted");app.exit(73);return;
  }
  if(phase==="execute") {
    assert.deepEqual(await evidence(),JSON.parse(await readFile(join(directory,"input-evidence.json"),"utf8")),"Restart must use the same accepted evidence and raw result");
    assert.equal((await a({kind:"read_input_need",id:"input-need"})).supplier,"context-representation");
    assert.equal((await store.querySharedAcceptance("accept-context-policy")).outcome,"accepted");
    assert.equal((await store.contextPolicy.query({kind:"latest",scopeId:scope.id})).decision.foreground.kind,"continue");
    assert.deepEqual((await a({kind:"read_reconsideration",subscriptionId:"policy-recheck",limit:16})).facts.map(f=>f.id),["later-policy-fact"]);
    const binding=await s({kind:"binding",inputId:"input",checkCurrentControl:true});validatePreparedContextInput(binding.input.exactInput);
    await processor.drain("parent",signal);await processor.drain("parent",signal);
    const stage=await a({kind:"read_stage",requestId:"model-request"});assert.equal(stage.status,"raw_result");assert.equal(stage.result.value.kind,"succeeded",JSON.stringify(stage.result));
    app.exit(73);return;
  }
  await processor.drain("parent",signal);assert.equal((await a({kind:"read_stage",requestId:"model-request"})).status,"accepted");
  assert.deepEqual(await a({kind:"pending",runId:"parent",after:0,limit:32}),[]);
  const binding=await s({kind:"binding",inputId:"input",checkCurrentControl:true});
  await writeFile(join(directory,"encoded-request.json"),binding.input.exactInput.encoded.body);
  await s({kind:"retire_input",inputId:"input",basis:"response accepted"});await c({kind:"release",holdId:"input-hold",basis:"response accepted"});
  const read=await c({kind:"read",access:{id:"detail",holdId:"detail",recipient,range},offset:0,length:range.end});assert.equal(read.text,bytes.toString());
  const {HelarcInspection}=await load("inspection/HelarcInspection.js");const {InspectionQueryService}=await import("@agent-anything/inspection/query");
  inspection=await HelarcInspection.create(join(directory,"inspection-settings.json"),join(directory,"inspection"));
  await inspection.activityObserver.replay("parent",store.activityHandoffs);await inspection.contextFoundationObserver.replay("parent",store.contextFoundationFacts.bind(store));
  queries=new InspectionQueryService(join(directory,"inspection"));
  const {selection:selected}=await require("./inspection-settlement.cjs").settleInspection(inspection.recorder,queries);
  const records=await queries.query({...selected,kind:"list_records"});
  const all=JSON.stringify(records);assert(all.includes("input"));
  const policy=await store.contextPolicy.query({kind:"latest",scopeId:scope.id});
  const policyRead=await queries.query({...selected,kind:"get_subject",subject:inspection.recorder.ref("context-representation","contribution",policy.decision.id,"parent")});
  assert(policyRead.records.some(record=>record.contents.some(content=>content.availability==="present")),"Policy evidence must be visible in Inspector");
  const policyFlow=await queries.query({...selected,kind:"get_data_flow",subject:inspection.recorder.ref("context-representation","contribution",policy.decision.id,"parent")});
  assert(policyFlow.graph.links.some(link=>link.kind==="observes"&&link.to.id===policy.input.current.evidence.id&&link.to.owner==="activity"));
  const needSubject=inspection.recorder.ref("activity-input","contribution","input-need","parent");
  const latestNeed=await queries.query({...selected,kind:"get_subject",subject:needSubject});
  assert.equal(latestNeed.records[0]?.payload.status,"supplied_submitted");
  const inputNeedRead=await queries.query({...selected,kind:"get_execution",subject:needSubject});
  const originalNeed=inputNeedRead.records.find(record=>record.payload.status==="requested");
  const needContent=originalNeed?.contents.find(content=>content.name==="Original consumer input need and stage constraints");
  assert.equal(needContent?.availability,"present",`Original input need must remain investigable: ${JSON.stringify(inputNeedRead)}`);
  const retainedNeed=await queries.query({...selected,kind:"get_content",contentId:needContent.id});
  assert.deepEqual(JSON.parse(retainedNeed.content.text),await a({kind:"read_input_need",id:"input-need"}));
  await writeFile(join(directory,"verification.json"),JSON.stringify({electron:process.versions.electron,generation:store.generation,providerCalls:1,
    rawPreparationRestored:true,acceptedInputRestored:true,responseRestored:true,detailRetained:true,encodedId:binding.input.exactInput.encoded.id,inspection:inspection.recorder.health()},null,2));
  await queries.close();queries=null;await inspection.close();inspection=null;await store.close();store=null;app.exit(0);
}
main().catch(async error=>{console.error(error);if(queries)await queries.close().catch(()=>{});if(inspection)await inspection.close().catch(()=>{});if(store)await store.close().catch(()=>{});app.exit(1);});
