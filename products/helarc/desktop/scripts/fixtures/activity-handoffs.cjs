const {app} = require("electron");
const assert = require("node:assert/strict");
const {join} = require("node:path");
const {pathToFileURL} = require("node:url");
const {writeFile} = require("node:fs/promises");
const [directory,phase,endpoint] = process.argv.slice(2);
app.setPath("userData",join(directory,"electron")); app.disableHardwareAcceleration();
let store;
async function main() {
  await app.whenReady();
  const {HelarcExecutionStore} = await import(pathToFileURL(join(__dirname,"../../dist/main/execution-storage/HelarcExecutionStore.js")));
  const {ActivityPurposeRegistry,ActivityHandoffProcessor} = await import("@agent-anything/agent-runtime/activity");
  store = await HelarcExecutionStore.open(join(directory,"execution"));
  const port = store.activityHandoffs, signal = new AbortController().signal;
  const registry = new ActivityPurposeRegistry();
  const purpose = registry.register({ref:{id:"fixture-method",revision:"1"},inputOwner:"fixture",executionOwner:"fixture-model",
    interpretationOwner:"fixture-method",acceptanceOwner:"fixture-method",recoveryOwner:"fixture-method",stageKinds:["generate","check"],
    capabilities:["fixture-model"],continuationKinds:["stage_request"]},{
    authorize:async () => {},
    execute:async (_path,stage,attempt) => {
      let value;
      if (stage.request.stageKind === "generate") {
        assert.equal(phase,"save-raw","Saved generation must never execute on recovery");
        value = await (await fetch(endpoint,{method:"POST",body:JSON.stringify(stage.request.input)})).json();
      } else value = {checked:true,source:stage.request.input};
      return {id:`${attempt.id}:result`,attemptId:attempt.id,completeness:"complete",outcome:"returned",value,usage:{calls:1},recordedAt:new Date().toISOString()};
    },
    reconcile:async () => {throw new Error("Complete saved response must be found before reconciliation");},
    interpret:async (_path,stage) => stage.request.stageKind === "generate" ? {
      progress:{generated:stage.result.value},next:[{id:"check",pathId:"path",stageKind:"check",input:stage.result.value,capabilities:[],dependencies:[{requestId:"generate",condition:"accepted"}]}]
    } : {progress:{checked:stage.result.value},next:[]},
  });
  const now = () => new Date().toISOString();
  const processor = new ActivityHandoffProcessor(port,registry,store.activityJournal.executor,now);
  if (phase === "save-raw") {
    await port.command({kind:"open_path",intent:{id:"path",runId:"child",owner:"fixture-method",purpose,permissionBasis:"fixture-local",
      resourceScope:"path",maximumStages:2,maximumAttempts:2,maximumConcurrent:1,deadlineAt:"2030-01-01T00:00:00Z"}});
    const input=process.env.ACTIVITY_LIVE_MODEL ? {model:process.env.ACTIVITY_LIVE_MODEL,stream:false,think:false,messages:[{role:"user",content:"Reply with the single word READY."}]} : {source:"exact frozen source"};
    await port.command({kind:"submit",request:{id:"generate",pathId:"path",stageKind:"generate",input,capabilities:["fixture-model"],dependencies:[]}});
    await processor.drain("child",signal); await processor.drain("child",signal);
    const stage = await port.command({kind:"read_stage",requestId:"generate"});
    assert.equal(stage.status,"raw_result"); assert.equal(typeof stage.result.value.content,"string"); assert(stage.result.value.content.trim().length);
    if (process.env.ACTIVITY_LIVE_MODEL) assert.deepEqual(stage.result.value.request,stage.request.input);
    app.exit(73); return;
  }
  if (phase === "accept-and-expand") {
    await processor.drain("child",signal);
    const path = await port.command({kind:"read_path",pathId:"path"}); assert.equal(path.progressRevision,1);
    assert.equal((await port.command({kind:"pending",runId:"child",after:0,limit:10}))[0].requestId,"check");
    const receipt = await store.querySharedAcceptance("generate:processing-receipt:0"); assert.equal(receipt.outcome,"accepted");
    app.exit(73); return;
  }
  await processor.drain("child",signal); await processor.drain("child",signal); await processor.drain("child",signal);
  const path = await port.command({kind:"read_path",pathId:"path"});
  assert.equal(path.progressRevision,2); assert.equal(path.dispatchedAttempts,2);
  assert.deepEqual(await port.command({kind:"pending",runId:"child",after:0,limit:10}),[]);
  await writeFile(join(directory,"verification.json"),JSON.stringify({electron:process.versions.electron,node:process.versions.node,
    storageGeneration:store.generation,progressRevision:path.progressRevision,externalCalls:1,stages:2,recovery:"raw-result and accepted-progress",pending:0},null,2));
  await store.close(); store = null; app.exit(0);
}
main().catch(async error => {console.error(error); if (store) await store.close().catch(()=>{}); app.exit(1);});
