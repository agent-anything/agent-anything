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
    authorize:async()=>{},
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
  if(phase==="seed-and-dispatch"){
    await port.command({kind:"bind_resource_pool",pool:{id:"shared-model",revision:"1",authority:"fixture-host",capacity:1}});
    await seed("task","root","task");await seed("preparation","root","opportunity");await seed("child-task","child","task");
    assert.deepEqual((await port.command({kind:"scheduling_candidates",limit:10})).map(c=>c.workId),["task","child-task","preparation"]);
    await port.command({kind:"register_fact_source",source:{id:"input-source",runId:"root",owner:"input"}});
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
    const original=await port.command({kind:"read_stage",requestId:"task:stage:1"});
    assert.equal((await port.command({kind:"resource_allowance",pathId:"task:path"})).reserved.calls,1);
    const replay=await port.command({kind:"dispatch",attempt:original.attempt,expectedControlRevision:0});assert.equal(replay.granted,false);
    assert.deepEqual((await port.command({kind:"scheduling_candidates",limit:10})).map(c=>c.workId),["child-task"]);
    await processor.scan("root",signal);await processor.settled();
    assert.equal((await port.command({kind:"read_stage",requestId:"preparation:stage:1"})).attempt,null);
    await processor.scan("child",signal);await processor.settled();await processor.scan("root",signal);await processor.settled();
    assert.equal((await port.command({kind:"read_stage",requestId:"preparation:stage:1"})).status,"raw_result");
    await port.command({kind:"publish_fact",fact:{id:"f2",sourceId:"input-source",ref:{owner:"input",kind:"delivery",id:"f2",revision:"1"}}});
    const prior=JSON.parse(await require("node:fs/promises").readFile(join(directory,"boundary.json"),"utf8"));
    const receipt={id:"accept-boundary",subscriptionId:"watch",expectedRevision:0,through:prior.through,factIds:["f1"],decision:{owner:"crm",kind:"policy",id:"keep",revision:"1"},close:false};
    const parts=[{owner:"activity",kind:"scheduling_acceptance",proposal:{kind:"schedule_work",intent:schedule("next","root","opportunity"),expectedRevision:0}},
      {owner:"activity",kind:"path_opening",proposal:path("next","root")},{owner:"activity",kind:"stage_submission",proposal:stage("next")}];
    await port.command({kind:"accept_reconsideration",receipt,participants:parts});
    // Simulate loss of the acknowledgement: the next process queries this exact acceptance.
    app.exit(73);return;
  }
  assert.equal((await store.querySharedAcceptance("accept-boundary")).outcome,"accepted");
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
  for(const [owner,id,run] of [["activity-scheduling","preparation","root"],["activity-scheduling","preparation:schedule","root"],["activity-resource","shared-model",null],["activity-publication","f1","root"],["activity",original.result.id,"root"]]) {
    const subject=inspection.recorder.ref(owner,"contribution",id,run);
    const read=await queries.query({...selection,kind:"get_subject",subject});assert(read.records.length>0,`No object for ${owner}/${id}`);
    assert(read.records.some(record=>record.contents.some(content=>content.availability==="present")),`Missing content for ${id}`);
  }
  await queries.close();queries=null;await inspection.close();inspection=null;
  await writeFile(join(directory,"verification.json"),JSON.stringify({electron:process.versions.electron,sqliteWorkerGeneration:store.generation,externalCalls:5,dispatches,remainingFact:"f2",acknowledgement:"queried original acceptance",originalDigest:modelInputValueDigest(original.result.value),inspection:health},null,2));
  await store.close();store=null;app.exit(0);
}
main().catch(async error=>{console.error(error);if(queries)await queries.close().catch(()=>{});if(inspection)await inspection.close().catch(()=>{});if(store)await store.close().catch(()=>{});app.exit(1);});
