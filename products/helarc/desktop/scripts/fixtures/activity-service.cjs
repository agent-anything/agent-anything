const {app}=require("electron");
const assert=require("node:assert/strict");
const {join}=require("node:path");
const {pathToFileURL}=require("node:url");
const {writeFile}=require("node:fs/promises");
const [directory,phase,endpoint]=process.argv.slice(2);
app.setPath("userData",join(directory,"electron"));app.disableHardwareAcceleration();
let store,service;
async function main() {
  await app.whenReady();
  const load=path=>import(pathToFileURL(join(__dirname,"../../dist/main",path)));
  const {HelarcExecutionStore}=await load("execution-storage/HelarcExecutionStore.js");
  const {HelarcActivityService}=await load("context/HelarcActivityService.js");
  const {ActivityPurposeRegistry}=await import("@agent-anything/agent-runtime/activity");
  const registry=new ActivityPurposeRegistry();
  store=await HelarcExecutionStore.open(join(directory,"execution"));
  const port=store.activityHandoffs;
  const purpose=registry.register({ref:{id:"fixture-service",revision:"1"},inputOwner:"fixture",executionOwner:"fixture",
    interpretationOwner:"fixture",acceptanceOwner:"fixture",recoveryOwner:"fixture",stageKinds:["call"],capabilities:[],continuationKinds:[]},{
    authorize:async(_path,_stage,_signal,action)=>{
      if(phase!=="save-raw")assert.equal(action,"settlement","Recovery must not require task dispatch authorization");
      return {kind:"allowed"};
    },
    execute:async(_path,stage,attempt,signal)=>{
      assert.equal(phase,"save-raw");
      const value=await (await fetch(endpoint,{method:"POST",body:JSON.stringify(stage.request.input),signal})).json();
      return {id:`${attempt.id}:raw`,attemptId:attempt.id,completeness:"complete",outcome:"returned",value,usage:{calls:1},recordedAt:new Date().toISOString()};
    },
    reconcile:async()=>{throw new Error("A complete original response must not be re-executed or reconciled");},
    interpret:async()=>{
      assert.equal(phase,"save-raw");
      // Terminate the real Electron and its Worker after persistence, before acceptance.
      app.exit(73);return new Promise(()=>{});
    },
    settle:async(_path,stage)=>({disposition:{kind:"retained_original",resultId:stage.result.id}}),
  });
  if(phase==="save-raw") {
    await port.command({kind:"open_path",intent:{id:"path",runId:"root",owner:"fixture",purpose,permissionBasis:"fixture",
      resourceScope:"fixture",maximumStages:1,maximumAttempts:1,maximumConcurrent:1,deadlineAt:"2030-01-01T00:00:00Z"}});
    await port.command({kind:"submit",request:{id:"call",pathId:"path",stageKind:"call",input:{source:"unchanged original"},capabilities:[],dependencies:[]}});
  } else if(phase==="accept-and-expand") {
    const stage=await port.command({kind:"read_stage",requestId:"call"});
    assert.equal(stage.status,"raw_result");assert.equal(stage.result.value.call,1);
    await port.command({kind:"cancel",pathId:"path",expectedControlRevision:0});
  }
  service=new HelarcActivityService({store,purposes:registry,purposeIds:[purpose.contract.ref.id],rediscoveryMs:10,
    diagnostics:{record:(_stage,_context,error)=>{console.error(error);app.exit(1);}},
    report:async cycle=>{
      assert.deepEqual(cycle.failures,[]);
      for(const run of cycle.runs)assert.deepEqual(run.result.failures,[]);
      if(phase==="save-raw")return;
      const stage=await port.command({kind:"read_stage",requestId:"call"});
      if(stage.status!=="settled")return;
      assert.equal(stage.result.value.call,1);
      assert.equal(stage.settlement.disposition.resultId,stage.result.id);
      const path=await port.command({kind:"read_path",pathId:"path"});
      assert.equal(path.progressRevision,0);assert.equal(path.dispatchedAttempts,1);assert(path.cancelled);
      assert.deepEqual(await port.command({kind:"pending",runId:"root",after:0,limit:16}),[]);
      const accepted=await store.querySharedAcceptance(stage.settlement.id);assert.equal(accepted.outcome,"accepted");
      if(phase==="accept-and-expand"){app.exit(73);return;}
      const facts=await port.command({kind:"facts",runId:"root",after:0,limit:64});
      assert.equal(facts.filter(f=>f.kind==="dispatched").length,1);
      assert.equal(facts.filter(f=>f.kind==="settled").length,1);
      await writeFile(join(directory,"verification.json"),JSON.stringify({electron:process.versions.electron,node:process.versions.node,
        storageGeneration:store.generation,externalCalls:1,progressRevision:0,pending:0,
        recovery:"original raw response -> cancelled consumer -> independent settlement",hostService:true},null,2));
      // Exit outside the report callback so shutdown never waits on its own pump.
      setImmediate(async()=>{await service.close();await store.close();store=null;app.exit(0);});
    }});
}
main().catch(async error=>{console.error(error);if(service)await service.close(100);if(store)await store.close().catch(()=>{});app.exit(1);});
