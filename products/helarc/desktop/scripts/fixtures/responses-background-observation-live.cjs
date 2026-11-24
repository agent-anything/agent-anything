// Run once in a new evidence directory, with the exact non-default configuration from this isolated case.
const {app}=require("electron"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const {pathToFileURL}=require("node:url"),{randomUUID}=require("node:crypto"),{backgroundObservationGuard,eligible}=require("./responses-background-observation-dispatch.cjs");
const [rootDir,authorization]=process.argv.slice(2),{openLive,originalForRun}=require("./responses-case-environment.cjs");
const fixture=openLive("background-observation",rootDir,authorization),{attempt:dir,profile,target}=fixture,{id,revision}=target;
fs.mkdirSync(dir);const workspace=path.join(dir,"workspace");fs.mkdirSync(workspace);
const save=(n,v)=>fs.writeFileSync(path.join(dir,n+".json"),JSON.stringify(v,null,2));
const record=row=>fs.appendFileSync(path.join(dir,"attempt.ndjson"),JSON.stringify({at:new Date().toISOString(),...row})+"\n");
const deadline=Date.now()+240000,guard=backgroundObservationGuard(target,globalThis.fetch,record,deadline);
globalThis.fetch=guard.fetch;app.setPath("userData",profile);app.disableHardwareAcceleration();app.commandLine.appendSwitch("disable-background-networking");
const load=name=>import(pathToFileURL(path.join(__dirname,"../../dist/main",name))),pause=()=>new Promise(r=>setTimeout(r,300));
let inspection,diagnostics,store,host,services,query,root;
async function run(){
  assert(app.requestSingleInstanceLock(),"profile is already in use");
  const db=new(require("node:sqlite").DatabaseSync)(path.join(profile,"execution/execution.sqlite"),{readOnly:true});
  try{assert.equal(db.prepare("select count(*) as n from product_admissions where delivered=0").get().n,0);}finally{db.close();}
  const {HelarcInspection}=await load("inspection/HelarcInspection.js"),{HelarcExecutionDiagnostics}=await load("diagnostics/HelarcExecutionDiagnostics.js");
  const {HelarcExecutionStore}=await load("execution-storage/HelarcExecutionStore.js"),{ElectronSafeStorageCredentialCipher}=await load("provider/ElectronSafeStorageCredentialCipher.js");
  const {createHelarcActivityHost}=await load("context/HelarcActivityHost.js"),{createHelarcApplicationServices}=await load("HelarcApplicationServices.js");
  const inspectionRoot=path.join(dir,"inspection");
  inspection=await HelarcInspection.create(path.join(dir,"inspection-settings.json"),inspectionRoot);assert(inspection.recorder);
  diagnostics=new HelarcExecutionDiagnostics(path.join(dir,"diagnostics.json"),inspection.performanceObserver);
  store=await HelarcExecutionStore.open(path.join(profile,"execution"),undefined,inspection.evidenceObserver,inspection.fileMaterialObserver,diagnostics,
    new ElectronSafeStorageCredentialCipher(),inspection.contextMaterialObserver,inspection.activityObserver,inspection.contextFoundationObserver,inspection.protocolObserver);
  inspection.protocolObserver.bindContentReader(store.protocolJournal,store.contextSelections);host=createHelarcActivityHost(store,{diagnostics});
  services=await createHelarcApplicationServices({userDataPath:profile,inspection,diagnostics,executions:store,activityHost:host,
    nativeExecutionEligibility:c=>({available:eligible(c,target),reason:eligible(c,target)?null:"outside_background_observation_target"})});
  const listing=await services.providerConfigurations.list();assert(listing.ok);
  const cfg=await originalForRun(fixture,services.providerConfigurations);assert(eligible(cfg,target) && cfg.name==="Responses-background-observation");
  const settings=Object.fromEntries(Object.entries(await services.instructionSettingsStore.load()).map(([k,v])=>[k,v.filter(i=>i.enabled).length]));
  assert(Object.values(settings).every(n=>n===0));assert(!listing.value.defaultSelection);
  const marker="background-observation-"+randomUUID().slice(0,8);
  const prompt="Acknowledge receipt of "+marker+" in one sentence using final_result now. No tools, files, commands, delegation or other work.";
  save("case",{target,prompt,marker,settings,deadline,limits:{create:1,count:1,retrieve:10,cancel:0},electron:process.versions.electron,worker:store.generation});
  const prior=new Set((await store.listProductRuns()).map(e=>e.admission.rootRunId));
  services.controller.selectWorkspacePath(workspace);guard.arm(cfg);
  const started=await services.startProtocolRun({taskText:prompt,target:{kind:"new_thread"}},{id,revision});assert(started.ok);
  while(true){
    const snap=services.controller.getSnapshot(),entries=(await store.listProductRuns()).filter(e=>!prior.has(e.admission.rootRunId));
    if(entries.length){assert.equal(entries.length,1);if(!root){root=entries[0].admission.rootRunId;record({kind:"admitted",root});}
      if(snap.execution==="idle"&&entries[0].delivered)break;}
    assert(!(snap.run?.host.pendingInteractions??[]).length,"unexpected host interaction");
    assert(Date.now()<deadline,"background-observation deadline exhausted");await pause();
  }
  const tree=await store.readRunTree(root);assert.equal(tree.members.length,1);const state=tree.members[0].head.state;
  const ref=inspection.recorder.ref("runtime","run",root,root),visible=services.controller.getSnapshot().run?.product.result?.output?.agentSummary;
  await host.service.close();host=null;await services.close();services=null;
  const flushed=await inspection.flushRecording(true),{InspectionQueryService}=await import("@agent-anything/inspection/query");
  query=new InspectionQueryService(inspectionRoot);const snap=await query.query({kind:"get_snapshot",sourceId:ref.sourceId,datasetId:ref.datasetId});
  save("evidence",{root,status:state.status,final:state.finalOutput?.summary,visible,counts:guard.counts,delivered:true,selection:snap.selection,
    settlements:state.items.filter(i=>i.payload.kind==="model_call_settlement").map(i=>({name:i.payload.result.name,status:i.payload.result.settlement})),
    flush:flushed.native,dropped:snap.coverage.dropped,rejected:snap.coverage.rejected});
  assert.equal(state.status,"completed");assert(visible?.includes(marker));assert.equal(visible,state.finalOutput?.summary);
  assert.equal(flushed.native,"settled");assert.equal(snap.coverage.dropped+snap.coverage.rejected,0);
}
app.whenReady().then(async()=>{
  let code=0;try{await run();}catch(e){code=1;record({kind:"verification-stopped",root,reason:String(e.code??e.message).slice(0,180)});}
  finally{guard.stop();for(const close of [()=>query?.close(),()=>host?.service.close(),()=>services?.close(),()=>inspection?.close(),()=>store?.close(),()=>diagnostics?.flush()]){
    try{await close();}catch{code=1;record({kind:"cleanup-incomplete"});}}
    console.log("background-observation evidence:",dir,guard.counts);app.exit(code);}
});
