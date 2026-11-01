const {app}=require("electron");
const assert=require("node:assert/strict");
const {join}=require("node:path");
const {pathToFileURL}=require("node:url");
const {writeFile}=require("node:fs/promises");
const [directory,phase,endpoint]=process.argv.slice(2);
app.setPath("userData",join(directory,"electron"));app.disableHardwareAcceleration();
let store,inspection,queries;
async function main(){
  await app.whenReady();
  const {HelarcExecutionStore}=await import(pathToFileURL(join(__dirname,"../../dist/main/execution-storage/HelarcExecutionStore.js")));
  const {ActivityPurposeRegistry,ActivityHandoffProcessor,activityFactSourceId}=await import("@agent-anything/agent-runtime/activity");
  const {modelInputValueDigest}=await import("@agent-anything/model-interaction/input");
  store=await HelarcExecutionStore.open(join(directory,"execution"));
  if(phase==="timeout-probe") {
    // The parent deliberately times out after SQLite is open and this request is in flight.
    await fetch(endpoint,{method:"POST",body:JSON.stringify({probe:true})});
    throw new Error("The controlled timeout request must not return normally");
  }
  const port=store.activityHandoffs,now=()=>new Date().toISOString(),signal=new AbortController().signal,registry=new ActivityPurposeRegistry();
  const purpose=registry.register({ref:{id:"scheduled-method",revision:"1"},inputOwner:"method",executionOwner:"provider",interpretationOwner:"method",acceptanceOwner:"method",recoveryOwner:"method",stageKinds:["model"],capabilities:["model"],continuationKinds:[]},{
    authorize:async()=>({kind:"allowed"}),
    execute:async(path,stage,attempt)=>{
      await store.activityHandoffs.command({kind:"reserve_resources",reservation:{id:`${stage.request.id}:call-claim`,pathId:path.intent.id,requestId:stage.request.id,amounts:{calls:1}},expectedControlRevision:path.controlRevision});
      const value=await(await fetch(endpoint,{method:"POST",body:JSON.stringify({work:path.intent.scheduledWorkId,stage:stage.request.id}),signal:AbortSignal.timeout(10000)})).json();
      return {id:`${attempt.id}:raw`,attemptId:attempt.id,completeness:"complete",outcome:"returned",value,usage:{calls:1},recordedAt:now()};
    },
    reconcile:async()=>{throw new Error("Confirmed response must not execute again");},
    interpret:async(_path,stage)=>({progress:{original:stage.result.value},next:[]})
  });
  const {bindHelarcContextExecution}=await import(pathToFileURL(join(__dirname,"../../dist/main/context/HelarcContextExecution.js")));
  const execution=bindHelarcContextExecution({store,registry,now,purposeIds:["scheduled-method"]}),processor=execution.processor;
  const schedule=(work,runId,reason)=>({id:`${work}:schedule`,workId:work,runId,scopeId:runId,owner:"crm",delegatedPathOwners:["method"],decisionId:`${work}:decision`,policyRevision:"fair.v1",reason,delayImpact:"explicit next-input opportunity",timing:{kind:"unknown"},resources:[{poolId:"shared-model",capability:"model",units:1}]});
  const path=(work,runId)=>({id:`${work}:path`,runId,owner:"method",purpose,scheduledWorkId:work,permissionBasis:"fixture",resourceScope:work,resourceLimits:{calls:2},maximumStages:2,maximumAttempts:2,maximumConcurrent:1,deadlineAt:"2030-01-01T00:00:00Z"});
  const stage=(work,n=1)=>({id:`${work}:stage:${n}`,pathId:`${work}:path`,stageKind:"model",input:{work,n},capabilities:["model"],dependencies:[]});
  async function seed(work,runId,reason){await port.command({kind:"schedule_work",intent:schedule(work,runId,reason),expectedRevision:0});await port.command({kind:"open_path",intent:path(work,runId)});await port.command({kind:"submit",request:stage(work)});await port.command({kind:"admit",requestId:stage(work).id,expectedControlRevision:0});}
  if(phase==="verify-closure") {
    for(const work of ["task","preparation","child-task","next"]) {
      const original=await port.command({kind:"read_schedule",workId:work});
      assert(original.closed&&original.pathsSealed&&original.settlementConfirmed);
      const page=await port.command({kind:"scheduled_paths",workId:work,expectedRevision:original.revision,afterId:null,limit:1});
      assert.deepEqual(page.paths.map(p=>p.id),[`${work}:path`]);assert.equal(page.nextAfterId,null);
      await port.command({kind:"close_scheduled_work",workId:work,expectedRevision:original.revision,basis:"recovery-verification",requireSettled:true});
      await port.command({kind:"submit",request:stage(work)});
      await assert.rejects(port.command({kind:"submit",request:stage(work,99)}),/path_binding_invalid/);
      assert.equal((await port.command({kind:"read_stage",requestId:stage(work).id})).status,"accepted");
    }
    assert.deepEqual(await port.command({kind:"pending",runId:"root",after:0,limit:256}),[]);
    assert.deepEqual(await port.command({kind:"scheduling_candidates",limit:256}),[]);
    await store.close();store=null;app.exit(0);return;
  }
  if(phase==="seed-and-dispatch"){
    await port.command({kind:"bind_resource_pool",pool:{id:"shared-model",revision:"1",authority:"fixture-host",capacity:1}});
    await seed("task","root","task");await seed("preparation","root","opportunity");await seed("child-task","child","task");
    assert.deepEqual((await port.command({kind:"scheduling_candidates",limit:10})).map(c=>c.workId),["task","child-task","preparation"]);
    for(const work of ["task","preparation"])await port.command({kind:"seal_scheduled_paths",workId:work,expectedRevision:1,basis:"original-scope-frozen"});
    await port.command({kind:"register_fact_source",source:{id:"input-source",runId:"root",owner:"input"}});
    await port.command({kind:"register_fact_source",source:{id:"retained-result-source",runId:"root",owner:"method"}});
    await port.command({kind:"publish_fact",fact:{id:"retained-before-observation",sourceId:"retained-result-source",ref:{owner:"method",kind:"result",id:"retained-result",revision:"1"}}});
    await port.command({kind:"publish_fact",fact:{id:"f1",sourceId:"input-source",ref:{owner:"input",kind:"delivery",id:"f1",revision:"1"}}});
    await port.command({kind:"subscribe_reconsideration",subscription:{id:"watch",runId:"root",owner:"crm",sources:["input-source"]}});
    const snapshot=await port.command({kind:"read_reconsideration",subscriptionId:"watch",limit:10});
    await writeFile(join(directory,"boundary.json"),JSON.stringify(snapshot));
    await processor.scan("root",signal);await processor.settled();
    assert.equal((await port.command({kind:"read_stage",requestId:"task:stage:1"})).status,"raw_result");
    await port.command({kind:"submit",request:stage("task",2)});await port.command({kind:"admit",requestId:stage("task",2).id,expectedControlRevision:0});
    app.exit(73);return;
  }
  if(phase==="continue-round"){
    const sealed=await port.command({kind:"read_schedule",workId:"preparation"});assert(sealed.pathsSealed&&!sealed.closed);
    await assert.rejects(port.command({kind:"open_path",intent:{...path("preparation","root"),id:"foreign-late-path"}}),/paths_sealed/);
    await assert.rejects(port.command({kind:"close_scheduled_work",workId:"preparation",expectedRevision:sealed.revision,basis:"not-yet-settled",requireSettled:true}),/responsibility_unsettled/);
    const original=await port.command({kind:"read_stage",requestId:"task:stage:1"});
    assert.equal((await port.command({kind:"resource_allowance",pathId:"task:path"})).reserved.calls,1);
    const replay=await port.command({kind:"dispatch",attempt:original.attempt,expectedControlRevision:0});assert.equal(replay.granted,false);
    assert.deepEqual((await port.command({kind:"scheduling_candidates",limit:10})).map(c=>c.workId),["child-task"]);
    await processor.scan("root",signal);await processor.settled();
    assert.equal((await port.command({kind:"read_stage",requestId:"preparation:stage:1"})).attempt,null);
    await processor.scan("child",signal);await processor.settled();await processor.scan("root",signal);await processor.settled();
    assert.equal((await port.command({kind:"read_stage",requestId:"preparation:stage:1"})).status,"raw_result");
    const serviceClosed=await port.command({kind:"close_scheduled_work",workId:"preparation",expectedRevision:sealed.revision,basis:"stop-future-service-retain-original-response"});
    assert(serviceClosed.closed&&!serviceClosed.settlementConfirmed);
    await assert.rejects(port.command({kind:"close_scheduled_work",workId:"preparation",expectedRevision:serviceClosed.revision,basis:"raw-is-not-settlement",requireSettled:true}),/responsibility_unsettled/);
    await port.command({kind:"publish_fact",fact:{id:"f2",sourceId:"input-source",ref:{owner:"input",kind:"delivery",id:"f2",revision:"1"}}});
    const prior=JSON.parse(await require("node:fs/promises").readFile(join(directory,"boundary.json"),"utf8"));
    const receipt={id:"accept-boundary",subscriptionId:"watch",expectedRevision:0,through:prior.through,factIds:["f1"],decision:{owner:"crm",kind:"policy",id:"keep",revision:"1"},close:false,
      observeSources:["input-source","retained-result-source",activityFactSourceId("progress","next:path"),activityFactSourceId("control","next:path")]};
    const parts=[{owner:"activity",kind:"scheduling_acceptance",proposal:{kind:"schedule_work",intent:schedule("next","root","opportunity"),expectedRevision:0}},
      {owner:"activity",kind:"path_opening",proposal:path("next","root")},{owner:"activity",kind:"stage_submission",proposal:stage("next")}];
    await assert.rejects(port.command({kind:"accept_reconsideration",receipt:{...receipt,id:"reject-cross-run-observation",observeSources:[...receipt.observeSources,activityFactSourceId("progress","child-task:path")]},participants:parts}),/source_scope_invalid/);
    assert.equal(await port.command({kind:"read_path",pathId:"next:path"}),null,"Rejected observation cannot leave its new producer behind");
    await port.command({kind:"accept_reconsideration",receipt,participants:parts});
    // Simulate loss of the acknowledgement: the next process queries this exact acceptance.
    app.exit(73);return;
  }
  assert.equal((await store.querySharedAcceptance("accept-boundary")).outcome,"accepted");
  const older=await port.command({kind:"read_reconsideration",subscriptionId:"watch",limit:1});
  assert.deepEqual(older.facts.map(f=>f.id),["retained-before-observation"]);assert(older.through<older.state.consumedThrough);assert(older.more);
  const consumeOlder={id:"accept-earlier-source",subscriptionId:"watch",expectedRevision:older.state.revision,through:older.through,factIds:older.facts.map(f=>f.id),decision:{owner:"crm",kind:"policy",id:"earlier-result-consumed",revision:"1"},close:false};
  await port.command({kind:"accept_reconsideration",receipt:consumeOlder});await port.command({kind:"accept_reconsideration",receipt:consumeOlder});
  assert.deepEqual((await port.command({kind:"read_reconsideration",subscriptionId:"watch",limit:10})).facts.map(f=>f.id),["f2"]);
  assert.equal((await port.command({kind:"read_stage",requestId:"next:stage:1"})).status,"submitted");
  const source=activityFactSourceId("progress","task:path");
  await port.command({kind:"subscribe_reconsideration",subscription:{id:"method-progress",runId:"root",owner:"crm",sources:[source]}});
  assert.equal((await port.command({kind:"read_reconsideration",subscriptionId:"method-progress",limit:10})).facts.length,1);
  const original=await port.command({kind:"read_stage",requestId:"task:stage:1"});assert.equal(original.result.value.work,"task");
  // Only remaining accepted stages are dispatched; earlier three effects stay original.
  const stop=new AbortController();
  await execution.pump.run({signal:stop.signal,scopes:()=>[{runId:"root",signal},{runId:"child",signal}],rediscoveryMs:25,report:async cycle=>{
    if(cycle.failures.length)throw cycle.failures[0].error;
    const states=[];for(const [work,n] of [["task",1],["task",2],["preparation",1],["child-task",1],["next",1]])states.push(await port.command({kind:"read_stage",requestId:stage(work,n).id}));
    if(states.every(state=>state.status==="accepted"))stop.abort();
  }});
  await processor.settled();execution.close();
  assert.equal((await port.command({kind:"resource_allowance",pathId:"task:path"})).reserved.calls,2);
  for(const [work,n] of [["task",1],["task",2],["preparation",1],["child-task",1],["next",1]])assert.equal((await port.command({kind:"read_stage",requestId:stage(work,n).id})).status,"accepted");
  for(const workId of ["task","preparation","child-task","next"]) {
    let work=await port.command({kind:"read_schedule",workId});
    if(!work.pathsSealed)work=await port.command({kind:"seal_scheduled_paths",workId,expectedRevision:work.revision,basis:"all-original-results-accepted"});
    await port.command({kind:"close_scheduled_work",workId,expectedRevision:work.revision,basis:"all-original-results-accepted",requireSettled:true});
  }
  const facts=await port.command({kind:"facts",runId:"root",after:0,limit:256});
  const dispatches=facts.filter(f=>f.kind==="dispatched").map(f=>({request:f.requestId,round:f.details.scheduling.round,work:f.details.scheduling.workId}));
  assert(dispatches.every(d=>d.round>0));assert.equal(new Set(dispatches.map(d=>d.request)).size,4);
  const {HelarcInspection}=await import(pathToFileURL(join(__dirname,"../../dist/main/inspection/HelarcInspection.js")));
  const {InspectionQueryService}=await import("@agent-anything/inspection/query");
  inspection=await HelarcInspection.create(join(directory,"inspection-settings.json"),join(directory,"inspection"));
  for(const run of ["root","child"])await inspection.activityObserver.replay(run,port);
  await inspection.recorder.flush();
  const health=inspection.recorder.health();assert.equal(health.rejected,0);assert.equal(health.dropped,0);
  queries=new InspectionQueryService(join(directory,"inspection"));
  const selection=(await queries.query({kind:"get_snapshot",sourceId:inspection.recorder.source.sourceId,datasetId:inspection.recorder.manifest.datasetId})).selection;
  const decisionFlow=await queries.query({...selection,kind:"get_data_flow",subject:inspection.recorder.ref("crm","contribution","keep","root","1")});
  assert(decisionFlow.graph.links.some(link=>link.kind==="observes"&&link.to.id==="retained-result-source"),"Inspector must link the accepted decision to its durable observation source");
  const closure=await queries.query({...selection,kind:"get_subject",subject:inspection.recorder.ref("activity-scheduling","contribution","preparation","root")});
  assert.equal(closure.records[0].payload.status,"closed");
  const scopeFacts=facts.filter(f=>["scheduling_paths_sealed","scheduling_closed"].includes(f.kind));
  assert.equal(scopeFacts.filter(f=>f.kind==="scheduling_closed"&&f.details.settlementChecked===true).length,3);
  assert.deepEqual(scopeFacts.filter(f=>f.kind==="scheduling_closed"&&f.pathId==="preparation").map(f=>f.details.settlementChecked),[false,true]);
  for(const [owner,id,run] of [["activity-scheduling","preparation","root"],["activity-scheduling","preparation:schedule","root"],["activity-resource","shared-model",null],["activity-publication","f1","root"],["activity",original.result.id,"root"]]) {
    const subject=inspection.recorder.ref(owner,"contribution",id,run);
    const read=await queries.query({...selection,kind:"get_subject",subject});assert(read.records.length>0,`No object for ${owner}/${id}`);
    assert(read.records.some(record=>record.contents.some(content=>content.availability==="present")),`Missing content for ${id}`);
  }
  await queries.close();queries=null;await inspection.close();inspection=null;
  await writeFile(join(directory,"verification.json"),JSON.stringify({electron:process.versions.electron,sqliteWorkerGeneration:store.generation,externalCalls:5,dispatches,
    schedulingClosure:"sealed original membership; original successors and responses retained; strict settled closure",scopeFacts,
    remainingFact:"f2",acknowledgement:"queried original acceptance",originalDigest:modelInputValueDigest(original.result.value),inspection:health},null,2));
  await store.close();store=null;app.exit(0);
}
main().catch(async error=>{console.error(error);if(queries)await queries.close().catch(()=>{});if(inspection)await inspection.close().catch(()=>{});if(store)await store.close().catch(()=>{});app.exit(1);});
