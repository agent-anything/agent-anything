const {app}=require("electron");
const assert=require("node:assert/strict");
const {join}=require("node:path");
const {pathToFileURL}=require("node:url");
const {createHash}=require("node:crypto");
const {writeFile,readFile}=require("node:fs/promises");
const [directory,phase,endpoint]=process.argv.slice(2);
app.setPath("userData",join(directory,"electron"));app.disableHardwareAcceleration();
let store,inspection,queries;
async function main() {
  await app.whenReady();
  const load=path=>import(pathToFileURL(join(__dirname,"../../dist/main",path)));
  const {HelarcExecutionStore}=await load("execution-storage/HelarcExecutionStore.js");
  const {HelarcInspection}=await load("inspection/HelarcInspection.js");
  const {ActivityHandoffInspectionAdapter}=await load("inspection/ActivityHandoffInspectionAdapter.js");
  const {InspectionQueryService}=await import("@agent-anything/inspection/query");
  const {ActivityPurposeRegistry,ActivityHandoffProcessor,activityStageEvidence}=await import("@agent-anything/agent-runtime/activity");
  const {SourceMaterialPublicationWork}=await import("@agent-anything/agent-runtime/context-representation");
  store=await HelarcExecutionStore.open(join(directory,"execution"));
  const a=command=>store.activityHandoffs.command(command),registry=new ActivityPurposeRegistry(),now=()=>new Date().toISOString();
  const authorizations=[];
  const work=new SourceMaterialPublicationWork(store.activityHandoffs,registry,{materials:store.materialCustody,now,authorize:async(path,_stage,_signal,action)=>{
    authorizations.push([path.intent.id,action]);
    if(phase==="stop"&&path.intent.id==="temporary")return {kind:"temporary",code:"await_grant",message:"Grant temporarily unavailable"};
    return {kind:"allowed"};
  }});
  const processor=new ActivityHandoffProcessor(store.activityHandoffs,registry,{hostSession:`fixture:${phase}`,worker:`worker:${store.generation}`,generation:store.generation},now);
  const ids=["expired","denied","captured","temporary"],run=id=>id==="expired"?"root":`child:${id}`;
  const signal=new AbortController().signal;
  const stage=id=>a({kind:"read_stage",requestId:`${id}:capture`});
  const drain=async(id,count=1)=>{for(let i=0;i<count;i++)await processor.drain(run(id),signal);};
  const denial={kind:"denied",code:"source_grant_revoked",message:"Original publication denied",decision:{owner:"permission",id:"original-grant-decision",revision:"2"}};
  if(phase==="seed") {
    const original=await(await fetch(endpoint,{method:"POST",body:JSON.stringify({source:"completed original effect"})})).json();
    const bytes=Buffer.from(JSON.stringify(original)),digest=`sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    await a({kind:"bind_resource_pool",pool:{id:"local",revision:"1",authority:"fixture-host",capacity:1}});
    for(const id of ids) {
      const parts=work.prepareSubmission({id,runId:run(id),permissionBasis:"original-host",resourceScope:id,scheduledWorkId:id,
        maximumStages:1,maximumAttempts:1,maximumConcurrent:1,deadlineAt:id==="expired"?"2000-01-01T00:00:00Z":"2030-01-01T00:00:00Z"},
        {kind:"source_material_publication",bytesBase64:bytes.toString("base64"),purpose:"task",target:"fixed-target",recipient:{runId:run(id),recipient:"recipient",purpose:"task"},
          intent:{id:`${id}:custody`,instanceId:`${id}:instance`,activityId:id,owner:"material-source",maximumBytes:bytes.length,
            version:{ref:{materialId:`${id}:original`,version:digest},origin:{runId:run(id),owner:"fixture-source",recordId:"effect:1",revision:"1",occurredAt:now()},
              label:"Original completed effect",format:"json",mediaType:"application/json",bytes:bytes.length,digest,capture:"complete",limitations:[]}}});
      const accepted=await store.sharedAcceptance.accept({id:`${id}:admission`,scope:run(id),actor:"material-source",parts:[
        {owner:"activity",kind:"scheduling_acceptance",proposal:{kind:"schedule_work",expectedRevision:0,intent:{id:`${id}:schedule`,workId:id,runId:run(id),scopeId:"tree",owner:"material-source",
          reason:"necessary",decisionId:id,policyRevision:"1",delayImpact:"Original input",timing:{kind:"unknown"},resources:[{capability:"material-write",poolId:"local",units:1}]}}},...parts]});
      assert.equal(accepted.outcome,"accepted");
    }
    await drain("captured",2);
    const captured=await stage("captured");assert.equal(captured.status,"raw_result");
    await writeFile(join(directory,"original-capture.json"),JSON.stringify({attempt:captured.attempt,result:captured.result}));
    for(const [id,action] of [["denied","admission"],["captured","interpretation"]]) {
      const s=await stage(id);await a({kind:"record_authorization_restriction",requestId:s.request.id,expectedControlRevision:0,expectedStageEvidence:activityStageEvidence(s),action,refusal:denial});
    }
  } else if(phase==="stop") {
    for(const id of ids)await drain(id);
    for(const id of ids.slice(0,3))assert.equal((await work.result(id)).kind,"source_material_unavailable");
    assert.equal((await stage("captured")).status,"raw_result");
    assert.equal((await store.materialCustody.command({kind:"state",intentId:"captured:custody"})).state,"complete");
    assert.equal((await stage("temporary")).stop,null);
    assert.equal((await stage("temporary")).authorizationRestrictions.admission.kind,"temporary");
    assert.deepEqual(authorizations,[["temporary","admission"]],"Persisted terminal restrictions must not be erased by permissive startup defaults");
  } else {
    const root=join(directory,"inspection");inspection=await HelarcInspection.create(join(directory,"inspection-settings.json"),root);
    const recorder=inspection.recorder,observer=new ActivityHandoffInspectionAdapter(recorder);queries=new InspectionQueryService(root);
    const original=JSON.parse(await readFile(join(directory,"original-capture.json"),"utf8"));
    await drain("captured");await drain("temporary",3);
    assert.equal((await store.materialCustody.command({kind:"state",intentId:"captured:custody"})).state,"deleted");
    assert.equal((await stage("captured")).status,"settled");
    assert.deepEqual((await stage("captured")).result,original.result);assert.deepEqual((await stage("captured")).attempt,original.attempt);
    const published=await work.result("temporary");assert.equal(published.kind,"published_source_material");
    const page=await store.materialCustody.command({kind:"read",access:published.access,offset:0,length:65536});assert.equal(JSON.parse(page.text).call,1);
    for(const id of ids) {
      assert.deepEqual(await a({kind:"pending",runId:run(id),after:0,limit:64}),[]);
      let schedule=await a({kind:"read_schedule",workId:id});
      schedule=await a({kind:"seal_scheduled_paths",workId:id,expectedRevision:schedule.revision,basis:"original membership complete"});
      await a({kind:"close_scheduled_work",workId:id,expectedRevision:schedule.revision,basis:"original responsibilities settled",requireSettled:true});
      const facts=await a({kind:"facts",runId:run(id),after:0,limit:128});
      assert.equal(facts.filter(f=>f.kind==="dispatched").length,["captured","temporary"].includes(id)?1:0);
      assert.equal(facts.filter(f=>f.kind==="professional_stopped").length,id==="temporary"?0:1);
      for(const fact of facts)observer.observe(fact);observer.observeStage(run(id),await stage(id));
    }
    await recorder.flush();const health=recorder.health();assert.equal(health.dropped,0);assert.equal(health.rejected,0);
    const selection=(await queries.query({kind:"get_snapshot",sourceId:recorder.source.sourceId,datasetId:recorder.manifest.datasetId})).selection;
    const records=await queries.query({kind:"list_records",...selection,runId:run("captured"),limit:500});
    assert(records.records.some(r=>r.payload.kind==="execution"&&r.payload.status==="stopped_pending_settlement"));
    assert(records.records.some(r=>r.payload.kind==="execution"&&r.payload.executionKind==="activity_result_settlement"));
    await writeFile(join(directory,"verification.json"),JSON.stringify({electron:process.versions.electron,generation:store.generation,
      originalEffects:1,captures:2,professionalStops:3,originalResponsePreserved:true,allOriginalSchedulesSettled:true,
      inspector:{captured:health.coverage.captured,dropped:health.dropped,rejected:health.rejected},
      recovery:"original restrictions -> professional stop -> independent original capture settlement; temporary authority resumes"},null,2));
  }
  await store.close();store=null;if(inspection)await inspection.close();if(queries)await queries.close();
  app.exit(phase==="finish"?0:73);
}
main().catch(async error=>{console.error(error);if(store)await store.close().catch(()=>{});if(inspection)await inspection.close().catch(()=>{});if(queries)await queries.close().catch(()=>{});app.exit(1);});
