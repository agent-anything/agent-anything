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
  const {bindHelarcRepresentationMethods}=await load("context/HelarcRepresentationMethods.js");
  const {ActivityPurposeRegistry}=await import("@agent-anything/agent-runtime/activity");
  const {bindHelarcContextExecution}=await load("context/HelarcContextExecution.js");
  const {OllamaProvider}=await import("@agent-anything/provider-integrations/ollama");
  const {OpenAICompatibleProvider}=await import("@agent-anything/provider-integrations/openai-compatible");
  const {composeModelInput,modelInputValueDigest:digest}=await import("@agent-anything/model-interaction/input");
  const providerOptions={model:process.env.ACTIVITY_LIVE_MODEL??"controlled",timeoutMs:120000,nativeToolInteraction:{supported:true},requestBodyTransportLimit:{maximumBytes:1000000,source:"host_configured",revision:"1"}};
  const provider=process.env.ACTIVITY_OPENAI?new OpenAICompatibleProvider({...providerOptions,baseUrl:endpoint+"/v1",apiKey:"local"}):new OllamaProvider({...providerOptions,baseUrl:endpoint,think:false,runtime:{contextWindowTokens:32768}});
  store=await HelarcExecutionStore.open(join(directory,"execution"));
  if(phase==="inspect") {
    const path=await store.activityHandoffs.command({kind:"read_path",pathId:"method-path"});
    const progress=path.progress.method,pending=await store.activityHandoffs.command({kind:"pending",runId:"parent",after:0,limit:256});
    const stage=await store.activityHandoffs.command({kind:"read_stage",requestId:progress.gap?.stageId??pending.find(p=>p.pathId==="method-path").requestId});
    await writeFile(join(directory,"failure-evidence.json"),JSON.stringify({gap:progress.gap,raw:stage.result,input:stage.request.input},null,2));
    await store.close();store=null;app.exit(0);return;
  }
  const registry=new ActivityPurposeRegistry(),signal=new AbortController().signal,now=()=>new Date().toISOString();
  const work=bindHelarcRepresentationMethods({store,provider,registry,now,authorize:async path=>assert.equal(path.intent.permissionBasis,"isolated-method-permission")});
  const execution=bindHelarcContextExecution({store,registry,now,purposeIds:["context.representation-method","context.input-preparation","parent-after-method"]});
  const processor=execution.processor;
  const recipient={runId:"parent",recipient:"context-representation",purpose:"context-method-verification"};
  const c=command=>store.materialCustody.command(command),a=command=>store.activityHandoffs.command(command);
  const accept=async proposal=>{const value=await store.sharedAcceptance.accept(proposal);assert.equal(value.outcome,"accepted",JSON.stringify(value));};
  const reference={owner:"fixture",kind:"method",id:"evidence",revision:"1"};
  const lineage={auxiliary:{purpose:"context_generation",method:reference,basis:reference},instructionBinding:null,agent:null,instructions:null,instructionRelease:null,instructionResolver:null,instructionContent:null,instructionModel:{providerId:provider.modelContext.target.providerId,model:provider.modelContext.target.model},instructionBlocks:[],activeContext:null,contextProjection:null,projectionManifest:null,toolSelection:null,toolExposureContent:null,toolExposureBasis:null,toolExposureProof:null,toolGuidance:null,controllerControlGuidance:null,callableDefinitions:null,modelQualification:null,interactionHistory:null,protocol:reference,policy:reference};
  const composition=composeModelInput({id:"template",providerId:provider.descriptor.id,model:provider.modelContext.target.model,interaction:{kind:"text_generation"},lineage,composedAt:"2026-10-29T00:00:00.000Z",sections:[{id:"template",source:reference,kind:"task",role:"user",necessity:"mandatory",content:{kind:"text",text:"auxiliary template"}}]});
  const template={requestId:"template",purpose:recipient.purpose,correlation:{controllerRequestId:"method",branchId:"parent:method"},instructions:composition.instructions,messages:composition.messages,interaction:composition.interaction,composition,
    modelContext:{requestedOutput:provider.modelContext.requestedOutput,headroom:{unit:"tokens",amount:0,policy:{id:"fixture",revision:"1"}},assessment:null},continuation:null,metadata:{}};
  const target=provider.encodeInput(template,"buffered").targetDigest;
  if(phase==="start") {
    const sources=[];
    const texts=process.env.ACTIVITY_LAYERED?["User agreement: radius 3 for images 2 through 10, preserve alpha. TARGET: 7391.","User correction: from image 6 use radius 5, preserve alpha. Image 5 used radius 3. Child B has not verified the version.","Read-only inspection; no changes made. ".repeat(500),"Read-only inspection; no changes made. ".repeat(500)]:["User agreement: For subsequent images use method A: radius 3, preserve the alpha channel. Applies to images 2 through 10. TARGET: 7391. "+"Inspection detail; no changes were made. ".repeat(30),
      "User correction: Starting with image 6, change only radius to 5. Preserve alpha throughout. Image 5 used radius 3. Child B has not verified the output version; this remains unknown. "+"Additional read-only observation. ".repeat(30)];
    if(process.env.ACTIVITY_DISTRIBUTED)for(let i=0;i<texts.length;i++)texts[i]+=" Independent retained observations; no changes. ".repeat(150);
    if(process.env.ACTIVITY_LINES){texts.splice(2);texts[0]+="\nRead-only independent inspection: no changes.\n".repeat(800);}
    if(process.env.ACTIVITY_SIMPLE)texts.splice(0,texts.length,"User decision: use port 7431 for staging.","User correction: use port 7542 for staging instead of 7431. The old port is superseded, not a second current choice.");
    for(let i=0;i<texts.length;i++) {
      const bytes=Buffer.from(texts[i]),range={materialId:`child-${i}`,version:"1",start:0,end:bytes.length,coordinate:"bytes"},instanceId=`source-${i}`;
      await c({kind:"begin",intent:{id:`capture-${i}`,instanceId,activityId:`child-output-${i}`,owner:`child-${i}`,maximumBytes:bytes.length,version:{ref:{materialId:range.materialId,version:"1"},origin:{runId:`child-${i}`,owner:`child-${i}`,recordId:`report-${i}`,revision:"1",occurredAt:"2026-10-29T00:00:00.000Z"},label:`Original child report ${i}`,format:"utf8",mediaType:"text/plain",bytes:bytes.length,digest:`sha256:${createHash("sha256").update(bytes).digest("hex")}`,capture:"complete",limitations:[]}}});
      await c({kind:"append",id:`append-${i}`,intentId:`capture-${i}`,offset:0,bytesBase64:bytes.toString("base64")});await c({kind:"complete",intentId:`capture-${i}`});
      const hold={id:`source-hold-${i}`,instanceId,consumer:recipient,responsibility:"preparation",range,basis:"method-path",releaseCondition:"explicit method handoff"};
      const parent={runId:"parent",recipient:"parent-agent",purpose:"task"},delivery={...hold,id:`parent-hold-${i}`,consumer:parent,responsibility:"delivery",basis:`delivery-${i}`};
      await accept({id:`publish-${i}`,scope:`child-${i}`,actor:`child-${i}`,parts:[{owner:"material_custody",kind:"publish",proposal:{intentId:`capture-${i}`,holds:[hold,delivery],grants:[{id:`grant-${i}`,instanceId,recipient,range,revision:0,allowed:true,basis:"delegated method"},{id:`parent-grant-${i}`,instanceId,recipient:parent,range,revision:0,allowed:true,basis:"child report"}]}}]});
      await accept({id:`delivery-publish-${i}`,scope:"parent",actor:"parent-agent",parts:[{owner:"context_delivery",kind:"publish",proposal:{id:`delivery-${i}`,sourceRunId:`child-${i}`,sourceId:`report-${i}`,recipient:parent,material:range,instanceId,holdId:delivery.id,detailHoldId:null}}]});
      sources.push({alias:`s${i}`,role:"source",access:{id:`access-${i}`,holdId:hold.id,recipient,range},representation:null,order:i,label:`Child ${i} report`,originalRole:"child_result",indivisibleGroup:`child-result-${i}`});
    }
    const request={kind:"representation_method",method:"summarize",methodRevision:"1",recipient,objective:"Preserve the continuing image-processing agreement, its precise method and later scoped correction for subsequent work. Retain the unknown version claim and TARGET value. Do not execute the underlying task.",sources,
      requirements:[{id:"agreement",revision:"1",basis:"user agreement and scoped correction",description:"Keep radius 3 before image 6, radius 5 from image 6, preserve alpha, and distinguish unverified version information."}],relationships:[{id:"scoped-correction",sources:["s0","s1"],basis:"explicit source relationship",description:"The later correction changes radius only from image 6 onward.",requiresCommonEvidence:true}],sourceBoundary:"both-child-reports-v1",deliveryIds:["delivery-0","delivery-1"],combinationDigest:null,combine:"keep",omission:null,search:null,template,targetRevision:target,
      capacity:{limits:process.env.ACTIVITY_LAYERED?[{id:"layered-fixture-transport",targetRevision:target,dimension:"request_bytes",maximum:36000,source:"controlled exact encoded byte bound: whole source exceeds it, single source plus checker fits"}]:[],reservations:[],policy:{id:"fixture",revision:"1",purpose:recipient.purpose,basis:"bounded fixture in a deployed 32k target; tokenization unavailable is explicit",allowEstimatedFit:true,allowUnknown:true},maximumCombinations:4,maximumMeasurements:0},bounds:{readBytes:1000000,storedBytes:1000000,modelCalls:process.env.ACTIVITY_LAYERED?24:6,repairs:1,levels:8,pageBytes:1024,ranges:64}};
    if(process.env.ACTIVITY_LAYERED)request.combine="merge";
    request.deliveryIds=sources.map((_,i)=>`delivery-${i}`);
    if(process.env.ACTIVITY_LINES){request.sources[0].division={kind:"text_lines",basis:"contract permits complete log lines as access units; not independent semantics"};request.relationships=[];}
    if(process.env.ACTIVITY_SIMPLE){request.objective="Retain the current staging port and its correction history.";request.requirements=[{id:"port",revision:"1",basis:"user correction",description:"7542 is current; 7431 is superseded."}];request.relationships=[{id:"correction",sources:["s0","s1"],basis:"explicit correction",description:"Later source replaces the earlier port; do not present two current ports.",requiresCommonEvidence:true}];}
    if(process.env.ACTIVITY_DISTRIBUTED){request.relationships=[];request.capacity.limits=[{id:"distributed-check-fixture",targetRevision:target,dimension:"request_bytes",maximum:24000,source:"controlled exact encoded byte bound: generation fits but whole check does not"}];request.bounds.modelCalls=12;}
    await writeFile(join(directory,"request.json"),JSON.stringify(request));
    const intent={id:"method-path",runId:"parent",permissionBasis:"isolated-method-permission",resourceScope:"method-resource",maximumStages:process.env.ACTIVITY_LAYERED?256:128,maximumAttempts:process.env.ACTIVITY_LAYERED?256:128,maximumConcurrent:1,deadlineAt:"2030-01-01T00:00:00.000Z"};
    if(process.env.ACTIVITY_NORMAL_POLICY)await require("./normal-context-policy.cjs").acceptNormalPreparation({store,provider,registry,work,processor,signal,now,request,texts,intent});
    else await work.submit(intent,request);
    // Leave one durable original page un-interpreted; later processes must not recreate the report.
    await processor.drain("parent",signal);await processor.drain("parent",signal);app.exit(73);return;
  }
  if(process.env.ACTIVITY_NORMAL_POLICY) {
    assert.equal((await store.querySharedAcceptance("normal-policy-accept")).outcome,"accepted");
    const original=(await store.contextPolicy.investments({scopeId:"normal-policy-scope",afterWorkId:null,limit:64}))[0];
    assert.equal(original.decision.foreground.kind,"continue");assert.equal(original.investment.pathId,"method-path");
    assert.equal((await a({kind:"read_path",pathId:"method-path"})).intent.scheduledWorkId,original.investment.workId);
  }
  if(phase==="generated"||phase==="checked") {
    for(let i=0;i<300;i++) {
      const result=await work.result("method-path");
      if(result.kind==="gap")throw new Error(JSON.stringify(result.progress.gap));
      const pending=await a({kind:"pending",runId:"parent",after:0,limit:256});
      for(const item of pending) {
        const stage=await a({kind:"read_stage",requestId:item.requestId});
        if(stage.request.stageKind==="model"&&stage.status==="raw_result") {
          const path=await a({kind:"read_path",pathId:"method-path"}),kind=path.progress.method.current.kind;
          if(phase==="generated"&&kind==="generate"||phase==="checked"&&kind==="check") {app.exit(73);return;}
        }
      }
      if(result.kind==="ready")throw new Error("Reached method end before expected interruption");
      await processor.drain("parent",signal);
    }
    throw new Error("Method exceeded fixture iteration bound");
  }
  for(let i=0;i<300;i++) {
    const result=await work.result("method-path");
    if(result.kind==="gap")throw new Error(JSON.stringify(result.progress.gap));
    if(result.kind==="ready")break;
    await processor.drain("parent",signal);
  }
  const result=await work.result("method-path");assert.equal(result.kind,"ready",JSON.stringify(result));
  if(process.env.ACTIVITY_NORMAL_POLICY)await require("./normal-context-policy.cjs").verifyNormalReconsideration({store,work,signal});
  if(!process.env.ACTIVITY_LIVE_MODEL&&!process.env.ACTIVITY_LAYERED&&!process.env.ACTIVITY_DISTRIBUTED){assert.equal(result.progress.modelCalls,2);assert.equal(result.progress.candidates.length,1);assert.equal(result.progress.assessments.length,1);}
  const candidate=result.progress.candidates.find(c=>result.progress.resultIds.includes(c.id));assert(candidate);const page=await c({kind:"read",access:candidate.access,offset:0,length:candidate.access.range.end});
  const revision=process.env.ACTIVITY_NORMAL_REVISION?await require("./normal-context-revision.cjs").verifyRevision({store,work,processor,signal}):null;
  if(process.env.ACTIVITY_SIMPLE)assert(page.text.includes("7542")&&page.text.includes("7431"),page.text);
  else assert(page.text.includes("3")&&page.text.includes("5")&&page.text.toLowerCase().includes("alpha"),page.text);
  const sources=JSON.parse(await readFile(join(directory,"request.json"),"utf8")).sources;
  for(const source of sources)assert(await c({kind:"describe",holdId:source.access.holdId,recipient}));
  let adoption=null;
  if(process.env.ACTIVITY_ADOPTION)adoption=await require("./representation-adoption.cjs").verifyAdoption({app,store,provider,registry,work,processor,signal,now,directory,phase,candidate,body:page.text,target,template,lineage});
  const contracts=process.env.ACTIVITY_CONTRACTS?await require("./representation-contracts.cjs").verifyContracts({store,work,processor,signal,now,request:JSON.parse(await readFile(join(directory,"request.json"),"utf8")),initial:result.progress}):null;
  await work.releaseInputs("method-path");await work.releaseInputs("method-path");
  if(process.env.ACTIVITY_NORMAL_POLICY&&process.env.ACTIVITY_ADOPTION)await require("./normal-context-policy.cjs").closeNormalPreparation({store,work,signal});
  const {HelarcInspection}=await load("inspection/HelarcInspection.js");const {InspectionQueryService}=await import("@agent-anything/inspection/query");
  inspection=await HelarcInspection.create(join(directory,"inspection-settings.json"),join(directory,"inspection"));
  await inspection.activityObserver.replay("parent",store.activityHandoffs);await inspection.contextFoundationObserver.replay("parent",store.contextFoundationFacts.bind(store));
  queries=new InspectionQueryService(join(directory,"inspection"));
  const inspectionSettlement=await require("./inspection-settlement.cjs").settleInspection(inspection.recorder,queries);
  const selection=inspectionSettlement.selection;
  const checkStage=await a({kind:"read_stage",requestId:result.progress.assessments[0].rawResultId.replace(/:attempt:1:raw$/,"" )});
  assert(checkStage?.result);
  const rawSubject=inspection.recorder.ref("activity","contribution",checkStage.result.id,"parent");
  const rawRead=await queries.query({...selection,kind:"get_subject",subject:rawSubject});assert(rawRead.records.length>0,"Raw result has a visible object, not a dangling relation");
  const rawContent=rawRead.records.flatMap(r=>r.contents).find(c=>c.name==="Original result and measured usage");assert(rawContent?.availability==="present");
  const rawPage=await queries.query({...selection,kind:"get_content",contentId:rawContent.id,length:65536});assert(rawPage.content.text.includes(checkStage.result.id));
  const requestSubject=inspection.recorder.ref("model-interaction","request",checkStage.request.input.request.requestId,"parent");
  const actualRequest=await queries.query({...selection,kind:"get_subject",subject:requestSubject});assert(actualRequest.records.some(r=>r.payload.kind==="request"));
  if(process.env.ACTIVITY_NORMAL_POLICY) {
    const decision=await store.contextPolicy.query({kind:"latest",scopeId:"normal-policy-scope"});
    const visible=await queries.query({...selection,kind:"get_subject",subject:inspection.recorder.ref("context-representation","contribution",decision.decision.id,"parent")});
    assert(visible.records.some(r=>r.contents.some(c=>c.name==="Context policy decision and evidence")),"The policy owner used by scheduling and reconsideration must resolve to a recorded decision");
  }
  await queries.close();queries=null;
  const timing={localMs:0,providerMs:0,preDispatchMs:0,interpretationMs:0,rawStages:0,unmeasuredRawStages:0};
  for(let after=0;;) {
    const facts=await a({kind:"facts",runId:"parent",after,limit:256});
    for(const fact of facts.filter(f=>f.kind==="raw_saved")) {
      const usage=fact.details.usage;timing.rawStages++;
      if(!usage)timing.unmeasuredRawStages++;
      else {timing.localMs+=usage.localMs??0;timing.providerMs+=usage.providerElapsedMs??0;timing.preDispatchMs+=usage.preDispatchMs??0;}
      const stage=await a({kind:"read_stage",requestId:fact.requestId});timing.interpretationMs+=stage.receipt?.interpretationMs??0;
    }
    if(facts.length<256)break;after=facts.at(-1).sequence;
  }
  await writeFile(join(directory,"verification.json"),JSON.stringify({electron:process.versions.electron,generation:store.generation,modelCalls:result.progress.modelCalls,totalProviderCalls:result.progress.modelCalls+(adoption?.additionalProviderCalls??0)+(contracts?.additionalProviderCalls??0)+(revision?.additionalProviderCalls??0),adoption,contracts,revision,candidates:result.progress.candidates.length,assessments:result.progress.assessments.length,checkGroups:result.progress.checkGroups.length,sourceReads:result.progress.pages.length,readBytes:result.progress.readBytes,storedBytes:result.progress.storedBytes,body:page.text,timing,inspectionSettlement,inspection:inspection.recorder.health()},null,2));
  execution.close();await inspection.close();inspection=null;await store.close();store=null;app.exit(0);
}
main().catch(async error=>{console.error(error);if(store){try{console.error("Pending at failure",JSON.stringify(await store.activityHandoffs.command({kind:"pending",runId:"parent",after:0,limit:256})));}catch{}}
  if(queries)await queries.close().catch(()=>{});if(inspection)await inspection.close().catch(()=>{});if(store)await store.close().catch(()=>{});app.exit(1);});
