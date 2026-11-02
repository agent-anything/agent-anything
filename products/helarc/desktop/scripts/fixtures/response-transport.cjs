const {app}=require("electron"),assert=require("node:assert/strict"),{join}=require("node:path"),{pathToFileURL}=require("node:url");
const {writeFile}=require("node:fs/promises"),Database=require("better-sqlite3");
const [directory,phase]=process.argv.slice(2);
app.setPath("userData",join(directory,"electron"));app.disableHardwareAcceleration();
let store;
async function main(){
  await app.whenReady();
  const {HelarcExecutionStore}=await import(pathToFileURL(join(__dirname,"../../dist/main/execution-storage/HelarcExecutionStore.js")));
  const {ActivityPurposeRegistry}=await import("@agent-anything/agent-runtime/activity");
  let trips=0;
  store=await HelarcExecutionStore.open(join(directory,"execution"),undefined,undefined,undefined,{record(){},performance(event){
    if(event.kind==="finished"&&event.stage==="storage.host.round_trip"&&event.context.wireKind==="read_content")trips++;
  }});
  const a=command=>store.activityHandoffs.command(command);
  if(phase==="seed"){
    const registry=new ActivityPurposeRegistry();
    const purpose=registry.register({ref:{id:"transport-test",revision:"1"},inputOwner:"test",executionOwner:"test",interpretationOwner:"test",
      acceptanceOwner:"test",recoveryOwner:"test",stageKinds:["retained"],capabilities:[],continuationKinds:[]},{});
    await a({kind:"open_path",intent:{id:"path",runId:"run",owner:"test",purpose,permissionBasis:"isolated-test",resourceScope:"path",
      maximumStages:1,maximumAttempts:1,maximumConcurrent:1,deadlineAt:"2030-01-01T00:00:00Z"}});
    await a({kind:"submit",request:{id:"stage",pathId:"path",stageKind:"retained",input:{text:"original-data ".repeat(20000)},capabilities:[],dependencies:[]}});
  }
  const original=await a({kind:"read_stage",requestId:"stage"});
  const before=trips;
  assert.deepEqual(await a({kind:"read_stage",requestId:"stage"}),original);
  assert.equal(trips,before,"Unchanged response bytes should not cross the Worker again");
  const db=new Database(join(directory,"execution","execution.sqlite"));
  try{
    const saved=db.prepare("SELECT digest FROM activity_stages WHERE id='stage'").get();
    db.prepare("UPDATE activity_stages SET digest='corrupt' WHERE id='stage'").run();
    await assert.rejects(a({kind:"read_stage",requestId:"stage"}),/activity_corrupt/);
    db.prepare("UPDATE activity_stages SET digest=? WHERE id='stage'").run(saved.digest);
    assert.deepEqual(await a({kind:"read_stage",requestId:"stage"}),original);
  }finally{db.close();}
  await writeFile(join(directory,`${phase}.json`),JSON.stringify({generation:store.generation,readTrips:trips,reused:true,corruptionRejected:true,
    stageStatus:original.status,attempts:original.attemptCount}));
  await store.close();store=null;app.exit(0);
}
main().catch(async error=>{console.error(error);await store?.close().catch(()=>{});app.exit(1);});
