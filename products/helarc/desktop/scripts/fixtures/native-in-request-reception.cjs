const {app}=require("electron"),assert=require("node:assert/strict");
const {join}=require("node:path"),{pathToFileURL}=require("node:url"),{writeFile,readFile}=require("node:fs/promises");
const {createHash}=require("node:crypto");
const [directory,phase]=process.argv.slice(2),at="2026-11-17T00:00:00.000Z";
app.setPath("userData",join(directory,"electron"));app.disableHardwareAcceleration();
let store,service,wake,recorder;
async function main(){
  const load=path=>import(pathToFileURL(join(__dirname,"../../dist/main",path)));
  const {HelarcExecutionStore}=await load("execution-storage/HelarcExecutionStore.js");
  const {HelarcActivityService}=await load("context/HelarcActivityService.js");
  const {helarcNativeInputRecords}=await load("inspection/HelarcNativeInputInspectionProjection.js");
  const {ActivityHandoffInspectionAdapter}=await load("inspection/ActivityHandoffInspectionAdapter.js");
  const {InspectionRecorder}=await import("@agent-anything/inspection/recording"),{InspectionQueryService}=await import("@agent-anything/inspection/query");
  const h=await import("@agent-anything/helarc/controller"),config=await import("@agent-anything/helarc/configuration");
  const m=await import("@agent-anything/model-interaction/protocol"),runtime=await import("@agent-anything/agent-runtime/model-access");
  const {modelInputValueDigest:digest}=await import("@agent-anything/model-interaction/input");
  const {ActivityPurposeRegistry,ActivityChangeWait}=await import("@agent-anything/agent-runtime/activity");
  const {inputSupplyRegistration,inputSupplyResponsibility}=await import("@agent-anything/agent-runtime/context-representation");
  recorder=await InspectionRecorder.create({root:join(directory,"inspection"),application:"in-request-component",name:phase,
    policy:{revision:"1",enabled:true,definition:true,agent:true,provider:true,execution:true}});
  store=await HelarcExecutionStore.open(join(directory,"execution"),undefined,undefined,undefined,undefined,undefined,undefined,new ActivityHandoffInspectionAdapter(recorder));
  const a=c=>store.activityHandoffs.command(c),ref=id=>({id,revision:"1"}),owner="context-representation";
  const scope={id:"task-input",runId:"root",recipient:"task",purpose:"task",owner,continuity:"original",target:"configuration:1",authorityBasis:"authority"};
  const recipient={runId:scope.runId,recipient:scope.recipient,purpose:scope.purpose};
  const composition=m.bindModelAgentComposition({agent:ref("agent"),protocol:m.OPENAI_RESPONSES,
    configuration:{configuration:ref("configuration"),protocol:m.OPENAI_RESPONSES,model:"gpt-5.3-codex",connectionBinding:ref("connection")},
    adapter:{implementation:ref("openai.responses.adapter"),protocol:m.OPENAI_RESPONSES},task:{purpose:ref("task"),
      input:{implementation:ref(owner),protocol:m.OPENAI_RESPONSES},interpreter:{implementation:h.HELARC_NATIVE_TASK_INTERPRETER,protocol:m.OPENAI_RESPONSES}},auxiliary:[]});
  const activity=runtime.bindProtocolModelActivity({composition,scope:{runId:"root",activityId:"task-model",recipientId:"task",purpose:ref("task"),compositionDigest:composition.digest},
    conditions:{input:ref("task-input"),authority:ref("authority"),resources:ref("resources"),control:ref("control")}});
  const registry=new ActivityPurposeRegistry(),ports={activities:store.activityHandoffs,materials:store.materialCustody,representations:store.representations,
    authorize:async path=>{assert.equal(path.intent.permissionBasis,scope.authorityBasis);return {kind:"allowed"};},now:()=>at};
  const demand=new h.HelarcNativeInputDemandWork({...ports,selections:store.contextSelections},registry),original=new h.HelarcNativeOriginalInputWork(ports,registry);
  const receiver=new h.HelarcResponsesInRequestReceptionWork({...ports,original},registry);
  const accept=async p=>{let r;try{r=await store.sharedAcceptance.accept(p);}catch(cause){throw new Error(`Fixture acceptance ${p.id} failed: ${cause.message}`,{cause});}
    assert.equal(r.outcome,"accepted",JSON.stringify(r));return r;};
  const intent=id=>({id,runId:"root",permissionBasis:"authority",resourceScope:id,maximumStages:3,maximumAttempts:3,maximumConcurrent:1,deadlineAt:"2030-01-01T00:00:00.000Z"});
  const schedule=(id,paths)=>({id:`${id}:schedule`,workId:id,runId:"root",scopeId:"tree",owner,allowedPathIds:paths,decisionId:id,
    policyRevision:"component-fixture:1",reason:"necessary",delayImpact:"Component reception boundary, not formal CRM policy acceptance",
    resources:[{poolId:"local",capability:"material-read",units:1}],timing:{kind:"unknown"}});
  await a({kind:"bind_resource_pool",pool:{id:"local",capacity:1,revision:"1",authority:"fixture"}});
  const signal=AbortSignal.timeout(30000);let failure;
  service=new HelarcActivityService({store,purposes:registry,purposeIds:[demand,original,receiver].map(w=>w.purpose.contract.ref.id),rediscoveryMs:10,
    reconsideration:(id,sub)=>sub.id==="receiver:reception"?receiver:null,report:async cycle=>{
      failure??=cycle.failures[0]?.error??cycle.runs.flatMap(r=>r.result.failures)[0]?.error??cycle.reconsiderations.flatMap(r=>r.result.failures)[0]?.error;
    }});
  wake=new ActivityChangeWait({subscribe:listener=>store.onActivityChange(listener)},signal);
  const until=async check=>{for(;;){signal.throwIfAborted();if(failure)throw failure;service.assertAvailable();
    const version=wake.version,value=await check();if(value)return value;service.wake();await wake.wait(version,100);}};
  let demanded=await a({kind:"read_path",pathId:"demand"});
  if(!demanded){
    assert.equal(phase,"receive");
    const items=[{role:"user",content:"Preserve option blue, its original reason, and the unresolved size decision."}],body={model:"gpt-5.3-codex",input:items,store:false};
    const working=new h.HelarcNativeWorkingInput();working.append(items,{id:"objective",originRunId:"root",
      sources:[{source:{owner:"user",kind:"message",...ref("task")},position:""}],duties:["objective"],
      preservation:{obligations:[{id:"task",requirement:"account",basis:"Keep the original objective, reason and pending choice"}],relationships:[]},
      exchangeId:null,protection:["first_delivery"],acceptedBy:null,representations:[]});
    const use={enabled:true,target:"original-target",transport:"http",continuity:"replay",background:false,
      policy:config.defaultHelarcInRequestCompactionPolicy({protocol:"openai.responses",model:body.model,target:"original-target",officialEndpoint:true})};
    const inputNeed={kind:"native_input_need",revision:"1",needId:"demand:need",scope,consumer:{activityId:activity.scope.activityId,protocol:m.OPENAI_RESPONSES,compositionDigest:composition.digest}};
    const prepared={format:"helarc.native-prepared-task.v1",binding:{scope:activity.scope,protocol:m.OPENAI_RESPONSES},previous:null,sourceDigest:"original-boundary",
      wire:{body:JSON.stringify(body),digest:digest(body)},workingSources:working.snapshot(),results:[],delivery:[]};
    const plan={revision:"1",activity,prepared,inputNeed,capacity:{limits:[],reservations:[],maximumCombinations:8,maximumMeasurements:0,
      policy:{id:"capacity",revision:"1",purpose:"task",basis:"Controlled component case accepts unknown tokens without claiming measured fit",allowUnknown:true,allowEstimatedFit:true}},
      supplyConditions:{responsesInRequest:use}};
    await accept({id:"demand:open",scope:"root",actor:owner,parts:demand.prepareSubmission(intent("demand"),plan)});
  }
  demanded=await until(async()=>{const r=await demand.result("demand");return r.kind==="needed"||r.kind==="ready"?r:null;});
  const plan=demanded.plan,inputNeed=plan.inputNeed;
  const inputSupply={needId:inputNeed.needId,runId:"root",owner,consumerPathId:"demand",
    source:{stageId:demanded.source.request.id,requestDigest:digest(demanded.source.request)},configuration:ref("configuration")};
  const supplySchedule=schedule("source-work",["original"]);
  if(!await a({kind:"read_path",pathId:"original"})){
    const bytes=Buffer.from(JSON.stringify(JSON.parse(plan.prepared.wire.body).input)),range={materialId:"history",version:"1",coordinate:"bytes",start:0,end:bytes.length};
    const capture={id:"capture",instanceId:"history",activityId:"source",owner,maximumBytes:bytes.length,version:{ref:{materialId:"history",version:"1"},
      origin:{runId:"root",owner,recordId:"source",revision:"1",occurredAt:at},label:"original input",format:"json",mediaType:"application/json",bytes:bytes.length,
      digest:`sha256:${createHash("sha256").update(bytes).digest("hex")}`,capture:"complete",limitations:[]}};
    await store.materialCustody.command({kind:"begin",intent:capture});
    await store.materialCustody.command({kind:"append",id:"chunk",intentId:capture.id,offset:0,bytesBase64:bytes.toString("base64")});
    await store.materialCustody.command({kind:"complete",intentId:capture.id});
    const hold={id:"history-hold",instanceId:"history",consumer:recipient,responsibility:"preparation",range,basis:"original-source",releaseCondition:"Explicit source release"};
    const ownerRecipient={...recipient,recipient:owner},ownerHold={...hold,id:"history-owner-hold",consumer:ownerRecipient};
    const record={ref:ref("history"),runId:"root",owner,purpose:"task",target:scope.target,form:"original",body:range,
      inputs:[{role:"source",material:range,representation:null}],declaredCoverage:[range],details:[range],holds:[ownerHold.id],requirements:[],losses:[],restorations:[],method:null};
    await accept({id:"history:publish",scope:"root",actor:owner,parts:[{owner:"material_custody",kind:"publish",proposal:{intentId:capture.id,holds:[hold,ownerHold],
      grants:[{id:"history-grant",instanceId:"history",recipient,range,revision:0,allowed:true,basis:"authority"},
        {id:"history-owner-grant",instanceId:"history",recipient:ownerRecipient,range,revision:0,allowed:true,basis:"authority"}]}},{owner:"representation",kind:"record",proposal:record}]});
    const opening=original.prepareSubmission({...intent("original"),scheduledWorkId:supplySchedule.workId},{revision:"1",inputSupply,scope,history:{record,hold},
      inputId:"original-input",selectionId:"original-selection",maximumReadBytes:1024*1024,continuity:{kind:"responses",policy:"native_replay",previous:null,
        conditions:{basis:"original",authorized:true,disclosureRevision:"authority",remoteStorage:false,targetSupport:"established",predecessor:"unavailable",reestablish:false,policyChange:false}}});
    await accept({id:"original:open",scope:"root",actor:owner,parts:[{owner:"activity",kind:"scheduling_acceptance",proposal:{kind:"schedule_work",expectedRevision:0,intent:supplySchedule}},
      ...opening,inputSupplyRegistration({binding:inputSupply,scheduling:supplySchedule,expectedRevision:0,expectedConsumerControlRevision:0,
        responsibilities:[inputSupplyResponsibility("input_preparation",opening[0].proposal)]})]});
  }
  const retained=await until(async()=>{const r=await original.result("original");return r.kind==="prepared"?r:null;});
  if(!await receiver.readPlan("receiver")){
    const reception={revision:"1",originalInputPathId:"original",inputId:"arranged-input",selectionId:"arranged-selection",inputNeed,inputSupply,
      use:plan.supplyConditions.responsesInRequest,capacity:plan.capacity,binding:{revision:"2",pathId:"receiver",workId:"receiver-work",scope,
        boundary:retained.value.selected.manifest.selection.boundary,requirementsDigest:digest(h.helarcNativeInputRequirements(retained.value.selected.workingSources.groups)),
        members:[],sourceInput:retained.value.readiness}};
    const opening=receiver.prepareSubmission({...intent("receiver"),scheduledWorkId:"receiver-work"},reception);
    await accept({id:"receiver:open",scope:"root",actor:owner,parts:[{owner:"activity",kind:"scheduling_acceptance",proposal:{kind:"schedule_work",expectedRevision:0,intent:schedule("receiver-work",["receiver"])}},
      ...opening,inputSupplyRegistration({binding:inputSupply,scheduling:supplySchedule,expectedRevision:1,expectedConsumerControlRevision:0,
        responsibilities:[inputSupplyResponsibility("method_reception",opening[0].proposal)]})]});
  }
  const result=await until(async()=>{const r=await receiver.result("receiver");if(r.kind==="gap")assert.fail(JSON.stringify(r.outcome));return r.kind==="checked"?r:null;});
  const stage=await a({kind:"read_stage",requestId:"receiver:stage:1"});assert.equal(stage.attemptCount,1);assert.equal(retained.stage.attemptCount,1);
  const projected=[...helarcNativeInputRecords({ref:(owner,kind,id,runId,revision=null)=>({owner,kind,id,runId,revision})},result.path,stage)];
  assert(projected.some(r=>r.payload.executionKind==="method_use_admission"));
  const evidence={phase,pid:process.pid,generation:store.generation,electron:process.versions.electron,receptionReceipt:stage.receipt.id,
    originalReceipt:retained.stage.receipt.id,attempts:stage.attemptCount,projectedRecords:projected.length,scope:"component-input-reception-only",
    originalUseDigest:digest(result.plan.use),inspectionSubject:recorder.ref("activity","contribution",stage.request.id,"root")};
  if(phase==="receive"){
    const closure=await recorder.flush(true);assert.equal(closure.native,"settled");assert.equal(closure.unpersisted,0);assert.equal(recorder.health().dropped,0);
    await writeFile(join(directory,"receive.json"),JSON.stringify(evidence));app.exit(73);await new Promise(()=>{});
  }
  assert.equal(phase,"adopt");
  const before=JSON.parse(await readFile(join(directory,"receive.json"),"utf8"));
  assert.equal(digest(result.plan.use),before.originalUseDigest);assert.deepEqual(result.plan.use,plan.supplyConditions.responsesInRequest);
  const queries=new InspectionQueryService(join(directory,"inspection"));let storedRecords=0;
  try{
    const subject=before.inspectionSubject,snapshot=await queries.query({kind:"get_snapshot",sourceId:subject.sourceId,datasetId:subject.datasetId});assert(snapshot.selection);
    const records=[];let after;
    do{const page=await queries.query({...snapshot.selection,kind:"list_records",subject,limit:100,...after?{after}:{}});
      records.push(...page.records);after=page.next;
    }while(after);
    const reception=records.find(r=>r.payload.executionKind==="in_request_input_reception"&&r.payload.status==="input_checked");assert(reception);
    const descriptor=reception.contents.find(c=>c.name==="Original method-use policy and reception (not dispatch or conversion)");assert.equal(descriptor?.availability,"present");
    let text="",offset=0;
    for(;;){const page=await queries.query({...snapshot.selection,kind:"get_content",contentId:descriptor.id,offset,length:65536});assert(page.content);
      text+=page.content.text;if(page.content.nextOffset===null)break;offset=page.content.nextOffset;
    }
    const content=JSON.parse(text);assert.equal(digest(content.originalUse),before.originalUseDigest);assert.equal(content.actualConversionObserved,false);assert(content.agreement);
    assert(reception.links.some(link=>link.from.id==="original:stage:1"));assert(reception.links.some(link=>link.kind==="produces"&&link.to.id==="arranged-input"));
    storedRecords=records.length;
  }finally{await queries.close();}
  const adoption=await receiver.prepareAdoption("receiver",{id:"adoption",need:demanded.need,expectedSelectionId:null,expectedControlRevision:0},signal);
  const receipt=await accept(adoption);assert.deepEqual(await accept(adoption),receipt);
  await until(async()=>{const r=await demand.result("demand");return r.kind==="ready"?r:null;});
  const selected=await store.contextSelections.command({kind:"binding",inputId:"arranged-input",checkCurrentControl:true});
  assert.deepEqual(selected.input.exactInput,result.value.selected);
  assert.deepEqual(JSON.parse(selected.input.exactInput.wire.body).context_management,[{type:"compaction",compact_threshold:200000}]);
  assert.equal(JSON.parse(retained.value.selected.wire.body).context_management,undefined);
  assert.equal(await store.protocolJournal.command({kind:"state",activityId:"task-model"}),null,"Receiving and adopting do not generate a response");
  await a({kind:"cancel",pathId:"receiver",expectedControlRevision:result.path.controlRevision});
  await assert.rejects(()=>receiver.prepareAdoption("receiver",{id:"late-adoption",need:demanded.need,expectedSelectionId:"arranged-selection",expectedControlRevision:0},signal),/unconfirmed/);
  await store.materialCustody.command({kind:"describe",holdId:"history-hold",recipient});
  const closure=await recorder.flush(true);assert.equal(closure.native,"settled");assert.equal(closure.unpersisted,0);assert.equal(recorder.health().dropped,0);
  await writeFile(join(directory,"adopt.json"),JSON.stringify({...evidence,storedRecords,inspectionReadAfterRestart:true,
    originalPolicyRestored:true,duplicateAcceptanceReused:true,cancelledAdoptionRejected:true,sourceRetained:true}));
}
app.whenReady().then(main).then(async()=>{wake?.close();await service?.close();await store?.close();app.exit(0);}).catch(async error=>{
  await writeFile(join(directory,`${phase}-failure.txt`),String(error.stack??error));wake?.close();
  try{await service?.close(1000);}catch{}try{await recorder?.flush(true);}catch{}try{await store?.close();}catch{}app.exit(1);
});
