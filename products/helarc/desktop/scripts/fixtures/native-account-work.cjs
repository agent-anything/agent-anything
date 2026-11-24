const assert=require("node:assert/strict"),{writeFile,readFile}=require("node:fs/promises"),{join}=require("node:path"),{pathToFileURL}=require("node:url");

module.exports=async function({app,store,executionPorts,composition,protocolName,phase,directory,h,digest,ref,multiple=false,normalPolicy=false,keep=false,resultBody=false}){
  if(phase==="after-closure"){
    const before=JSON.parse(await readFile(join(directory,"verification.json"),"utf8"));
    const pathId=keep?before.originalPreparation.pathId:before.combination.reception.pathId;
    const selection=await store.contextSelections.command({kind:"binding",inputId:before.combination.readiness.inputId,checkCurrentControl:true});
    assert.equal(selection.input.exactInput.kind,"helarc_native_input");
    assert.equal((await store.activityHandoffs.command({kind:"read_schedule",workId:keep?"original-supply-work":pathId+":work"})).settlementConfirmed,true);
    assert.equal((await store.activityHandoffs.command({kind:"read_reconsideration_state",subscriptionId:keep?"original-native-input-demand:need:supply":pathId+":reception"})).closed,true);
    const original=await store.activityHandoffs.command({kind:"read_stage",requestId:pathId+":stage:1"});
    assert.equal(original.receipt.id,keep?before.originalPreparation.receipt:before.combination.reception.realizationReceipt);
    assert.equal(selection.input.exactInput.wire.body,keep?before.originalPreparation.body:original.result.value.selected.wire.body);
    const demand=await store.activityHandoffs.command({kind:"read_stage",requestId:"original-native-input-demand:stage:1"});
    assert.equal(demand.receipt.id,keep?before.originalPreparation.originalDemandReceipt:before.combination.reception.originalDemandReceipt);
    assert.equal((await store.inputSupplies.query({kind:"exit",needId:"original-native-input-demand:need"})).status,"closed");
    for(const work of before.productionLifetime?.scopeExitSettledProducers??[]){
      assert.equal((await store.activityHandoffs.command({kind:"read_schedule",workId:work.workId})).settlementConfirmed,true);
      assert.equal((await store.activityHandoffs.command({kind:"read_reconsideration_state",subscriptionId:work.pathId+":production-lifecycle"})).closed,true);
    }
    for(const retained of before.sourceReceipts??[]){
      const source=await store.activityHandoffs.command({kind:"read_stage",requestId:retained.stageId});
      assert.equal(source.attemptCount,1);assert.deepEqual({stageId:source.request.id,receipt:source.receipt.id,result:source.result.id,attempt:source.attempt.id},retained);
    }
    await writeFile(join(directory,"verification.json"),JSON.stringify({...before,closureRecoveredGeneration:store.generation},null,2));return;
  }
  const {ActivityPurposeRegistry,ActivityHandoffProcessor}=await import("@agent-anything/agent-runtime/activity");
  const {RepresentationMethodWork,SourceMaterialPublicationWork}=await import("@agent-anything/agent-runtime/context-representation");
  const registry=new ActivityPurposeRegistry(),signal=new AbortController().signal,now=()=>new Date().toISOString();
  const authorize=async path=>{assert.equal(path.intent.permissionBasis,"original-disclosure");return {kind:"allowed"};};
  const factories=await import("@agent-anything/helarc/composition");
  const factory=protocolName==="responses"?factories.createHelarcResponsesStructuredPurposes:
    protocolName==="deepseek"?factories.createHelarcDeepSeekStructuredPurposes:factories.createHelarcOllamaStructuredPurposes;
  const purposes=factory({execution:executionPorts,selections:store.contextSelections,methodPurpose:ref("context_representation"),composition:async()=>composition,
    conditions:async source=>({input:source.source,authority:ref("original-disclosure"),resources:ref("bounded-method"),control:ref("active")}),
    retainTransport:async request=>request},protocolName==="responses"?{stream:false,store:false}:
      protocolName==="deepseek"?{stream:false,thinking:{type:"disabled"}}:{stream:false,think:false});
  const publications=new SourceMaterialPublicationWork(store.activityHandoffs,registry,{materials:store.materialCustody,authorize,now});
  if(normalPolicy)await store.activityHandoffs.command({kind:"register_fact_source",source:{id:"fixture-lifetime:root",runId:"root",owner:"fixture-scope"}});
  const methods=new RepresentationMethodWork({nativeModel:purposes.methodParticipant,activities:store.activityHandoffs,
    materials:store.materialCustody,representations:store.representations,selections:store.contextSelections,authorize,now,
    ...(normalPolicy?{productionLifetime:{scope:runId=>({source:{id:`fixture-lifetime:${runId}`,runId,owner:"fixture-scope"},closedFactId:`fixture-lifetime:${runId}:closed`}),responsibilities:store.inputSupplies}}:{})},registry);
  const processor=new ActivityHandoffProcessor(store.activityHandoffs,registry,store.activityJournal.executor,now);
  const a=c=>store.activityHandoffs.command(c),accept=async p=>{
    const r=await store.sharedAcceptance.accept(p);assert.equal(r.outcome,"accepted",JSON.stringify(r));return r;
  };
  const w=new h.HelarcNativeWorkingInput();let originalResult=null;
  if(resultBody){
    const {createNativeModelCallRef}=await import("@agent-anything/model-interaction");
    const scope={runId:"root",recipientId:"agent",activityId:"prior-task",purpose:composition.composition.task.purpose,compositionDigest:composition.digest};
    const source={scope,protocol:composition.composition.protocol,interpretation:composition.composition.adapter.implementation,operationId:"prior-create",record:ref("prior-response"),
      position:{format:"json-pointer",value:"/output/0"},nativeIdentity:{kind:"function_call",id:"read-code"}};
    originalResult={modelCallRef:createNativeModelCallRef({providerRequestId:"prior-request",controllerRequestId:"prior-decision",branchId:"root",contentBlockOrdinal:0,
      nativeSource:source,purposeAcceptance:ref("prior-acceptance")}),providerCallRef:protocolName==="ollama"?null:{providerId:protocolName,id:"read-code"},name:"Read",
      settlement:"succeeded",presentation:{presenter:ref("agent-runtime.observation"),disposition:"complete",failureCode:null},sourceRefs:[{owner:"child",kind:"result",...ref("original-child-report")}],
      content:{kind:"descendant_run",childRunId:"child",status:"succeeded",output:{summary:"Verification code 7391 is unconfirmed. "+"Read-only measurements; no effects. ".repeat(150),
        status:"completed",effect_status:"none",uncertainty:["unconfirmed"],artifact_refs:[]}}};
  }
  for(const [id,content]of [["goal","Report the verification code and its uncertainty."],["response","Read-only investigation requested; no effects."],
    ["result","Verification code 7391 is unconfirmed. "+"Read-only measurements; no effects. ".repeat(150)],
    ...(multiple?[["later","Verification code 7391 is unconfirmed. "+"A later independent review found no further evidence. ".repeat(150)]]:[])]){
    const items=protocolName==="responses"?(id==="response"?[{type:"function_call",call_id:"read-code",name:"Read",arguments:'{"path":"report"}'}]:
      id==="result"?[{type:"function_call_output",call_id:"read-code",output:content}]:[{role:id==="later"?"assistant":"user",content}]):
      id==="response"?[{role:"assistant",content,tool_calls:[{id:"read-code",type:"function",function:{name:"Read",arguments:protocolName==="ollama"?{path:"report"}:'{"path":"report"}'}}]}]:
      id==="result"?[{role:"tool",...(protocolName==="ollama"?{tool_name:"Read"}:{tool_call_id:"read-code"}),content}]:[{role:id==="later"?"assistant":"user",content}];
    if(resultBody&&id==="result")items[0][protocolName==="responses"?"output":"content"]=JSON.stringify({settlement:originalResult.settlement,result:originalResult.content});
    w.append(items,{id,originRunId:"root",sources:[{source:{owner:"original-native-task",kind:"record",...ref(id)},position:""}],
      duties:[id==="goal"?"objective":"continuity"],preservation:{obligations:[{id,requirement:id==="goal"?"exact":"account",
        basis:"Retain verification code 7391, its unconfirmed status, original Call association and absence of effects."}],relationships:[]},
      exchangeId:id==="goal"||id==="later"?null:"original-exchange",protection:resultBody&&id!=="goal"?["active_exchange","first_delivery"]:[],
      acceptedBy:resultBody?null:{runId:"root",activityId:"original",acceptance:ref("accepted")},representations:[]});
  }
  const recipient={runId:"root",recipient:"agent",purpose:"task"},target="original:1",sources=w.snapshot();
  const intent=id=>({id,runId:"root",permissionBasis:"original-disclosure",resourceScope:id,maximumStages:128,maximumAttempts:128,maximumConcurrent:1,deadlineAt:"2030-01-01T00:00:00Z"});
  const resources=["material-read","material-write","model-access","model-measurement"].map(capability=>({poolId:capability,capability,units:1}));
  for(const resource of resources)await a({kind:"bind_resource_pool",pool:{id:resource.poolId,revision:"1",authority:"original-disclosure",capacity:1}});
  const schedule=(workId,paths)=>({id:`${workId}:schedule`,workId,runId:"root",scopeId:"tree",owner:"context-representation",...(paths?{allowedPathIds:paths}:{}),
    decisionId:`${workId}:controlled-investment`,policyRevision:"1",reason:"necessary",delayImpact:"The controlled consumer needs an accepted input",timing:{kind:"unknown"},resources});
  const conditions={capacity:{limits:[],reservations:[],policy:{id:"fixture",revision:"1",purpose:"task",basis:"Native body measured; token capacity explicitly unknown",allowUnknown:true,allowEstimatedFit:false},
    maximumCombinations:4,maximumMeasurements:0},bounds:{readBytes:1000000,storedBytes:100000,modelCalls:6,repairs:1,levels:3,pageBytes:4096,ranges:16},limits:{maximumStages:128,maximumAttempts:128}};
  if(normalPolicy)return require("./native-account-policy.cjs")({app,store,registry,processor,methods,phase,protocolName,composition,signal,now,authorize,intent,accept,
    h,publications,originalItems:w.items,originalSources:sources,schedule,resources,directory,supply:{request:conditions,option:{limits:conditions.limits}},keep,originalResult});
  const plan=()=>h.planHelarcNativeSourcePublications({items:w.items,sources,recipient,target,observedAt:now(),maximumSourceBytes:100000,
    activities:store.activityHandoffs,signal});
  for(const p of await plan())if(p.state==="new")await accept({id:`${p.pathId}:start`,scope:"root",actor:"material-source",parts:publications.prepareSubmission(intent(p.pathId),p.request)});
  let published;
  for(let n=0;n<8;n++){
    published=await plan();if(published.every(p=>p.state==="published"))break;
    const cycle=await processor.drain("root",signal);assert.equal(cycle.failures.length,0,JSON.stringify(cycle.failures));
  }
  assert(published.every(p=>p.state==="published"),JSON.stringify(published.map(p=>({id:p.pathId,state:p.state}))));
  const receipts=[];
  for(const p of published){const s=await a({kind:"read_stage",requestId:`${p.pathId}:capture`});receipts.push({pathId:p.pathId,receipt:s.receipt.id,attempt:s.attempt.id,result:s.result.id});}
  if(phase==="observation"||(keep&&phase==="readiness"))await writeFile(join(directory,"source-receipts.json"),JSON.stringify(receipts));
  else assert.deepEqual(receipts,JSON.parse(await readFile(join(directory,"source-receipts.json"),"utf8")),"Source capture cannot repeat after restart");
  const scopes=h.helarcNativeAccountScopes({runId:"root",items:w.items,sources,maximum:16,backgroundGroupIds:["goal"]}).scopes;
  const scope=multiple?scopes.find(s=>s.groups.filter(g=>g.role==="source").length===2):scopes[0];
  const supply=h.supplyHelarcNativeAccountMethod({items:w.items,sources,scope,publications:published,sourceRecipient:recipient,target,authorizationBasis:"original-disclosure",composition,
    backgroundGroupIds:["goal"],...conditions,addresses:[]});
  assert(!supply.request.template);assert.equal(supply.request.nativeComposition.digest,composition.digest);
  const id=supply.consumerId;
  if(!await a({kind:"read_path",pathId:id}))await accept({id:`${id}:start`,scope:"root",actor:"context-representation",parts:[
    {owner:"activity",kind:"scheduling_acceptance",proposal:{kind:"schedule_work",intent:schedule(`${id}:work`,[id]),expectedRevision:0}},
    ...supply.materialAdmissions.map(proposal=>({owner:"material_custody",kind:"admit_access",proposal})),...methods.prepareSubmission({...intent(id),scheduledWorkId:`${id}:work`},supply.request)]});
  if(phase==="purpose"){
    const original=store.sharedAcceptance.accept.bind(store.sharedAcceptance);
    store.sharedAcceptance.accept=async p=>{const r=await original(p);
      if(r.outcome==="accepted"&&p.parts.some(x=>x.owner==="protocol_execution"&&x.kind==="purpose")){app.exit(73);await new Promise(()=>{});}return r;};
  }
  let result;
  for(let n=0;n<128;n++){
    result=await methods.result(id);if(result.kind==="gap")throw new Error(JSON.stringify(result.progress.gap));if(result.kind==="ready")break;
    const cycle=await processor.drain("root",signal);assert.equal(cycle.failures.length,0,JSON.stringify(cycle.failures));
  }
  assert.equal(result.kind,"ready");assert.equal(result.progress.modelCalls,4);assert.deepEqual(result.progress.request,supply.request);
  assert.deepEqual(result.progress.assessments.map(x=>x.supported),[false,true]);
  const producers=[{supply,result}];
  if(multiple){
    const second=h.supplyHelarcNativeAccountMethod({items:w.items,sources,scope:scopes.find(s=>s.groups.filter(g=>g.role==="source").map(g=>g.id).join() === "later"),
      publications:published,sourceRecipient:recipient,target,authorizationBasis:"original-disclosure",composition,backgroundGroupIds:["goal"],
      capacity:supply.request.capacity,bounds:supply.request.bounds,limits:supply.option.limits,addresses:[]});
    const secondId=second.consumerId;
    if(!await a({kind:"read_path",pathId:secondId}))await accept({id:`${secondId}:start`,scope:"root",actor:"context-representation",parts:[
      {owner:"activity",kind:"scheduling_acceptance",proposal:{kind:"schedule_work",intent:schedule(`${secondId}:work`,[secondId]),expectedRevision:0}},
      ...second.materialAdmissions.map(proposal=>({owner:"material_custody",kind:"admit_access",proposal})),
      ...methods.prepareSubmission({...intent(secondId),scheduledWorkId:`${secondId}:work`},second.request)]});
    let secondResult;
    for(let n=0;n<128;n++){
      secondResult=await methods.result(secondId);if(secondResult.kind==="ready")break;
      if(secondResult.kind==="gap")throw new Error(JSON.stringify(secondResult.progress.gap));
      assert.deepEqual((await processor.drain("root",signal)).failures,[]);
    }
    assert.equal(secondResult.kind,"ready");assert.equal(secondResult.progress.modelCalls,2);
    producers.push({supply:second,result:secondResult});
  }
  if(phase==="ready"){app.exit(73);await new Promise(()=>{});}
  const combination=await require("./native-combination-check.cjs")({app,store,registry,processor,methods,producers,published,phase,protocolName,composition,signal,now,authorize,intent,accept,
    h,publications,originalItems:w.items,originalSources:sources,schedule});
  assert.equal(phase,"verify");
  const candidate=result.progress.candidates.find(c=>result.progress.resultIds.includes(c.id));
  const page=await store.materialCustody.command({kind:"read",access:candidate.access,offset:candidate.access.range.start,length:candidate.access.range.end-candidate.access.range.start});
  assert(page.text.includes("7391")&&page.text.includes("unconfirmed"));
  const original=published.find(p=>p.group.id==="result").published.access;
  const retained=await store.materialCustody.command({kind:"read",access:original,offset:0,length:original.range.end});
  assert.equal(JSON.parse(retained.text).items[0][protocolName==="responses"?"output":"content"].includes("7391"),true);
  const facts=await store.protocolJournal.command({kind:"facts",runId:"root",after:0,limit:128});
  assert.equal(facts.filter(f=>f.kind==="purpose_accepted").length,multiple?7:5);
  const load=path=>import(pathToFileURL(join(__dirname,"../../dist/main",path)));
  const {HelarcInspection}=await load("inspection/HelarcInspection.js");
  const inspection=await HelarcInspection.create(join(directory,"inspection-settings.json"),join(directory,"inspection"));
  const {InspectionQueryService}=await import("@agent-anything/inspection/query"),queries=new InspectionQueryService(join(directory,"inspection"));
  let health;
  try{
    await inspection.activityObserver.replay("root",store.activityHandoffs);await inspection.contextFoundationObserver.replay("root",store.contextFoundationFacts.bind(store));
    await require("./inspection-settlement.cjs").settleInspection(inspection.recorder,queries);
    health=inspection.recorder.health();assert.equal(health.dropped,0);assert.equal(health.rejected,0);
  }finally{await queries.close();await inspection.close();}
  await writeFile(join(directory,"verification.json"),JSON.stringify({protocol:protocolName,generation:store.generation,sourceCaptures:receipts.length,
    originalSourceReceiptsRestored:true,modelCalls:multiple?7:5,accepted:facts.filter(f=>f.kind==="purpose_accepted").length,
    failedChecks:1,acceptedChecks:multiple?3:2,originalSourceRetained:true,
    originalNativeComposition:true,syntheticGenericRequests:0,combination,inspection:health},null,2));
};
