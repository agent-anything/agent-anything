// A single fresh, explicitly authorized stored-response attempt. Never edits Provider Settings.
const {app}=require("electron"), assert=require("node:assert/strict"), fs=require("node:fs");
const {join}=require("node:path"), {pathToFileURL}=require("node:url"), {randomUUID}=require("node:crypto");
const {eligible,guard}=require("./responses-stored-continuation-dispatch.cjs");
const [rootDir,authorization]=process.argv.slice(2),{openLive,originalForRun}=require("./responses-case-environment.cjs");
const fixture=openLive("stored-continuation",rootDir,authorization),{attempt:directory,profile,target}=fixture,{id,revision}=target;
const workspace=join(directory,"workspace");
fs.mkdirSync(directory);fs.mkdirSync(workspace);
const record=r=>fs.appendFileSync(join(directory,"attempt.ndjson"),JSON.stringify({at:new Date().toISOString(),...r})+"\n");
const save=(name,v)=>fs.writeFileSync(join(directory,name+".json"),JSON.stringify(v,null,2));
const deadline=Date.now()+300000, network=guard(target,globalThis.fetch,record,deadline);
globalThis.fetch=network.fetch;app.setPath("userData",profile);app.disableHardwareAcceleration();app.commandLine.appendSwitch("disable-background-networking");
const load=name=>import(pathToFileURL(join(__dirname,"../../dist/main",name)));
const pause=()=>new Promise(r=>setTimeout(r,250));
let inspection,diagnostics,store,host,services,query,root;
async function delivered(){
  const until=Date.now()+45000;
  do{const e=(await store.listProductRuns()).find(e=>e.admission.rootRunId===root);
    if(e?.delivered && services.controller.getSnapshot().execution==="idle") return;
    await pause();}while(Date.now()<until);
  throw Error("original_delivery_unconfirmed");
}
async function run(){
  assert(app.requestSingleInstanceLock(),"profile already owned");
  const {DatabaseSync}=require("node:sqlite"), db=new DatabaseSync(join(profile,"execution/execution.sqlite"),{readOnly:true});
  try{assert.equal(db.prepare("select count(*) as n from product_admissions where delivered=0").get().n,0);}finally{db.close();}
  const {HelarcInspection}=await load("inspection/HelarcInspection.js"), {HelarcExecutionDiagnostics}=await load("diagnostics/HelarcExecutionDiagnostics.js");
  const {HelarcExecutionStore}=await load("execution-storage/HelarcExecutionStore.js"), {ElectronSafeStorageCredentialCipher}=await load("provider/ElectronSafeStorageCredentialCipher.js");
  const {createHelarcApplicationServices}=await load("HelarcApplicationServices.js"), {createHelarcActivityHost}=await load("context/HelarcActivityHost.js");
  const inspectionRoot=join(directory,"inspection");
  inspection=await HelarcInspection.create(join(directory,"inspection-settings.json"),inspectionRoot);assert(inspection.recorder);
  diagnostics=new HelarcExecutionDiagnostics(join(directory,"diagnostics.json"),inspection.performanceObserver);
  store=await HelarcExecutionStore.open(join(profile,"execution"),undefined,inspection.evidenceObserver,inspection.fileMaterialObserver,diagnostics,
    new ElectronSafeStorageCredentialCipher(),inspection.contextMaterialObserver,inspection.activityObserver,inspection.contextFoundationObserver,inspection.protocolObserver);
  inspection.protocolObserver.bindContentReader(store.protocolJournal,store.contextSelections);host=createHelarcActivityHost(store,{diagnostics});
  services=await createHelarcApplicationServices({userDataPath:profile,inspection,diagnostics,executions:store,activityHost:host,
    nativeExecutionEligibility:c=>({available:eligible(c,target),reason:eligible(c,target)?null:"outside_stored_continuation_target"})});
  const listing=await services.providerConfigurations.list();assert(listing.ok);
  const config=await originalForRun(fixture,services.providerConfigurations);assert(eligible(config,target));
  const settings=Object.fromEntries(Object.entries(await services.instructionSettingsStore.load()).map(([k,v])=>[k,v.filter(i=>i.enabled).length]));
  assert(Object.values(settings).every(n=>n===0));
  const first="index.txt",second="item-"+randomUUID()+".txt",value="stored-continuation-"+randomUUID();
  fs.writeFileSync(join(workspace,first),second+"\n",{flag:"wx"});fs.writeFileSync(join(workspace,second),value+"\n",{flag:"wx"});
  const prompt="Use the Read tool to read index.txt in the workspace. Its single line is the name of another file next to it. Read that file, then report its single value in your final reply. Only read these two files; do not list files, run commands, delegate, or modify anything.";
  save("case",{target,first,second,value,prompt,settings,electron:process.versions.electron,worker:store.generation,
    defaultSelection:listing.value.defaultSelection,deadline:new Date(deadline).toISOString(),maximum:{generate:4,count:4,requestBytes:131072}});
  const existing=new Set((await store.listProductRuns()).map(e=>e.admission.rootRunId));
  services.controller.selectWorkspacePath(workspace);network.arm(config);
  const start=await services.startProtocolRun({taskText:prompt,target:{kind:"new_thread"}},{id,revision});assert(start.ok);
  while(true){
    const snap=services.controller.getSnapshot(),fresh=(await store.listProductRuns()).filter(e=>!existing.has(e.admission.rootRunId));
    if(fresh.length){assert.equal(fresh.length,1);if(!root){root=fresh[0].admission.rootRunId;record({kind:"admitted",root});}}
    if(snap.execution==="idle")break;
    assert(!(snap.run?.host.pendingInteractions??[]).length,"unplanned interaction; no extra access granted");
    assert(Date.now()<deadline,"stored-continuation time budget exhausted");await pause();
  }
  assert(root);await delivered();
  const state=(await store.readRunTree(root)).members.find(m=>m.head.state.run.id===root).head.state;
  const visible=services.controller.getSnapshot().run?.product.result?.output?.agentSummary;
  const rec=inspection.recorder.ref("runtime","run",root,root);
  await host.service.close();host=null;await services.close();services=null;
  const flush=await inspection.flushRecording(true), {InspectionQueryService}=await import("@agent-anything/inspection/query");
  query=new InspectionQueryService(inspectionRoot);
  const snap=await query.query({kind:"get_snapshot",sourceId:rec.sourceId,datasetId:rec.datasetId});
  const evidence={root,status:state.status,visible,final:state.finalOutput?.summary,counts:network.counts,delivered:true,
    settlements:state.items.filter(i=>i.payload.kind==="model_call_settlement").map(i=>({name:i.payload.result.name,
      call:i.payload.result.providerCallRef?.id,status:i.payload.result.settlement})),
    selection:snap.selection,flush:flush.native,dropped:snap.coverage.dropped,rejected:snap.coverage.rejected};
  save("evidence",evidence);
  assert.equal(state.status,"completed");assert(visible?.includes(value));assert.equal(visible,evidence.final);
  assert.equal(flush.native,"settled");assert.equal(evidence.dropped,0);assert.equal(evidence.rejected,0);
}
app.whenReady().then(async()=>{
  let code=0;
  try{await run();}catch(err){code=1;record({kind:"stopped",reason:String(err.code??err.message).slice(0,170)});
    network.stop();
    if(root && services && services.controller.getSnapshot().execution!=="idle")try{
      await services.controller.dispatchHostCommand({version:1,commandId:"stored-continuation-stop:"+root,runId:root,kind:"run.cancel",payload:{reason:"stored-continuation verifier stopped"}},"run.cancel");
      await delivered();
    }catch{record({kind:"original-delivery-unconfirmed"});}
  }finally{network.stop();
    for(const close of [()=>query?.close(),()=>host?.service.close(),()=>services?.close(),()=>inspection?.close(),()=>store?.close(),()=>diagnostics?.flush()]){
      try{await close();}catch{code=1;record({kind:"cleanup-incomplete"});}
    }
    console.log("stored-continuation:",directory,"dispatch counts",network.counts);app.exit(code);
  }
});
