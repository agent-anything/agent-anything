// One authorized tool-roundtrip attempt against its initialized, non-default test binding.
const {app}=require("electron"),assert=require("node:assert/strict"),fs=require("node:fs"),fsp=require("node:fs/promises");
const {join,resolve}=require("node:path"),{pathToFileURL}=require("node:url"),{randomUUID}=require("node:crypto");
const {toolRoundtripGuard,digest}=require("./responses-tool-roundtrip-dispatch.cjs");
const [rootDir,authorization]=process.argv.slice(2),settleOnly=authorization==="--settle-original";
const {openCase,openLive,originalForRun}=require("./responses-case-environment.cjs");
const fixture=settleOnly?openCase("tool-roundtrip",rootDir):openLive("tool-roundtrip",rootDir,authorization);
const {attempt:directory,profile,target}=fixture,{id,revision}=target;
const workspace=join(directory,"workspace"),output=join(workspace,"answer.txt"),deadline=Date.now()+300000;
const record=r=>fs.appendFileSync(join(directory,"attempt.ndjson"),JSON.stringify({at:new Date().toISOString(),...r})+"\n");
const save=(name,data)=>fs.writeFileSync(join(directory,name+".json"),JSON.stringify(data,null,2));
if(!settleOnly){fs.mkdirSync(directory);fs.mkdirSync(workspace);} // Never restart a charged attempt.
app.setPath("userData",profile);app.disableHardwareAcceleration();app.commandLine.appendSwitch("disable-background-networking");
let expectedMarker=null;
const guard=toolRoundtripGuard(target,globalThis.fetch,record,deadline,item=>expectedMarker!==null&&JSON.stringify(item).includes(expectedMarker));
globalThis.fetch=guard.fetch;
let writes=0;
const open=fsp.open;
fsp.open=async function(path,flags,...args){
  if(typeof path==="string" && resolve(path).toLowerCase()===resolve(output).toLowerCase() && ["wx+","r+"].includes(flags)){
    record({kind:"physical-write-attempt",flags,ordinal:++writes});
  }
  return open.call(this,path,flags,...args);
};
require("node:module").syncBuiltinESMExports();
const load=name=>import(pathToFileURL(join(__dirname,"../../dist/main",name)));
let services,inspection,store,host,diagnostics,query,root,stage="preflight";
async function drainOriginal(){
  const until=Date.now()+45000;
  do{
    const entry=(await store.listProductRuns()).find(e=>e.admission.rootRunId===root);
    if(entry?.delivered && services.controller.getSnapshot().execution==="idle")return;
    await new Promise(r=>setTimeout(r,200));
  }while(Date.now()<until);
  throw Error("original_delivery_unconfirmed");
}
async function main(){
  // A different executable instance must not fence the user's running Worker.
  assert(app.requestSingleInstanceLock(),"profile already owned");
  const {DatabaseSync}=require("node:sqlite");
  const db=new DatabaseSync(join(profile,"execution","execution.sqlite"),{readOnly:true});
  try{
    const active=db.prepare("SELECT root_run_id FROM product_admissions WHERE delivered=0").all();
    if(settleOnly){
      root=JSON.parse(fs.readFileSync(join(directory,"attempt.ndjson"),"utf8").split("\n").find(line=>line.includes('"kind":"admitted"'))).root;
      assert(active.every(x=>x.root_run_id===root));assert.deepEqual(JSON.parse(fs.readFileSync(join(directory,"case.json"))).target,target);
    }else assert.equal(active.length,0,"tool-roundtrip may not take over other active work");
  }finally{db.close();}
  const {HelarcInspection}=await load("inspection/HelarcInspection.js"),{HelarcExecutionDiagnostics}=await load("diagnostics/HelarcExecutionDiagnostics.js");
  const {HelarcExecutionStore}=await load("execution-storage/HelarcExecutionStore.js"),{ElectronSafeStorageCredentialCipher}=await load("provider/ElectronSafeStorageCredentialCipher.js");
  const {createHelarcActivityHost}=await load("context/HelarcActivityHost.js"),{createHelarcApplicationServices}=await load("HelarcApplicationServices.js");
  const inspectionRoot=join(directory,"inspection");
  inspection=await HelarcInspection.create(join(directory,"inspection-settings.json"),inspectionRoot);assert(inspection.recorder);
  diagnostics=new HelarcExecutionDiagnostics(join(directory,"diagnostics.json"),inspection.performanceObserver);
  store=await HelarcExecutionStore.open(join(profile,"execution"),undefined,inspection.evidenceObserver,inspection.fileMaterialObserver,diagnostics,
    new ElectronSafeStorageCredentialCipher(),inspection.contextMaterialObserver,inspection.activityObserver,inspection.contextFoundationObserver,inspection.protocolObserver);
  inspection.protocolObserver.bindContentReader(store.protocolJournal,store.contextSelections);
  host=createHelarcActivityHost(store,{diagnostics});
  services=await createHelarcApplicationServices({userDataPath:profile,inspection,diagnostics,executions:store,activityHost:host,
    nativeExecutionEligibility:c=>({available:guard.eligible(c),reason:guard.eligible(c)?null:"outside_tool_roundtrip_target"})});
  const api=services.providerConfigurations,listing=await api.list();assert(listing.ok);
  const candidate=await originalForRun(fixture,api);
  if(settleOnly){
    stage="offline-settlement";
    const tree=await store.readRunTree(root),state=tree.members.find(m=>m.head.state.run.id===root).head.state;
    assert(state.items.some(i=>i.payload.kind==="cancellation_transition"&&i.payload.transition==="requested"),"no original cancellation basis");
    const opened=state.items.find(i=>i.payload.kind==="pending_transition"&&i.payload.transition==="opened");
    const expected=JSON.parse(fs.readFileSync(join(directory,"case.json"))).expected;
    require("./responses-tool-roundtrip-approval.cjs").toolWriteCall(state.items,opened.payload.pending.interaction.request,root,output,expected);
    const work=(await services.controller.listRecoverableWork()).find(w=>w.id===root);
    if(work){const receipt=await services.controller.recoverWork({id:root,revision:work.revision,intent:"cancel"});assert(receipt.ok,"cancel recovery not accepted");}
    await drainOriginal();
    const after=(await store.readRunTree(root)).members.find(m=>m.head.state.run.id===root).head.state;
    assert.equal(after.status,"cancelled");assert(!fs.existsSync(output));
    save("cancel-settlement",{root,before:state.status,after:after.status,delivered:true,counts:guard.counts,outputExists:false,
      settlements:after.items.filter(i=>i.payload.kind==="model_call_settlement").map(i=>({name:i.payload.result.name,status:i.payload.result.settlement}))});
    return;
  }
  const previous=new Set((await store.listProductRuns()).map(e=>e.admission.rootRunId));
  assert(guard.eligible(candidate));assert(!candidate.isDefault);
  const settings=Object.fromEntries(Object.entries(await services.instructionSettingsStore.load()).map(([k,v])=>[k,v.filter(x=>x.enabled).length]));
  assert(Object.values(settings).every(n=>n===0),"optional instructions must be disabled");
  const nonce="tool-roundtrip-"+randomUUID(),source=join(workspace,"source.txt");
  expectedMarker=nonce;
  fs.writeFileSync(source,nonce+"\n",{flag:"wx"});
  const prompt=`Read the single value from ${source} using the file read tool. Use the file write tool to create ${output} with that same value. Report the value in your final reply. No other files, commands or delegated work.`;
  save("case",{target,deadline:new Date(deadline).toISOString(),workspace,prompt,expected:nonce,settings,electron:process.versions.electron,
    sqliteWorker:store.generation,baselineDefault:listing.value.defaultSelection,limits:{attempts:1,generate:4,count:4,bytesPerDispatch:131072}});
  services.controller.selectWorkspacePath(workspace);guard.arm(candidate);stage="start";
  const started=await services.startProtocolRun({taskText:prompt,target:{kind:"new_thread"}},{id,revision});
  assert(started.ok,"tool-roundtrip admission failed: "+started.error?.code);stage="run";
  const approved=new Set();
  for(;;){
    const snap=services.controller.getSnapshot(),entries=(await store.listProductRuns()).filter(e=>!previous.has(e.admission.rootRunId));
    if(entries.length){assert.equal(entries.length,1);if(!root){root=entries[0].admission.rootRunId;record({kind:"admitted",root});}}
    if(snap.execution==="idle"){save("terminal",{status:snap.status,display:snap.run?.display?.status,error:snap.error?.code});break;}
    for(const p of snap.run?.host.pendingInteractions??[]){
      if(approved.has(p.request.id))continue;
      const r=p.presentation,tree=await store.readRunTree(root);
      const option=require("./responses-tool-roundtrip-approval.cjs").toolApproval(p,tree.members.find(m=>m.head.state.run.id===root).head.state.items,root,output,nonce);
      const commandId="tool-roundtrip-approval:"+p.request.id;
      const receipt=await services.controller.dispatchHostCommand({version:1,commandId,runId:root,kind:"interaction.submit",payload:{
        request:p.request,submissionId:commandId,payload:{submissionId:commandId,runId:root,requestId:r.id,pendingVersion:p.request.requestVersion,
          optionId:option.id,grantedPermissions:null,reason:null}}},"interaction.submit");
      assert.equal(receipt.status,"handled");approved.add(p.request.id);record({kind:"scoped-write-approval",request:p.request.id,root});
    }
    assert(Date.now()<deadline,"tool-roundtrip time budget exhausted");
    await new Promise(r=>setTimeout(r,250));
  }
  stage="evidence";assert(root);
  await drainOriginal();
  const visible=services.controller.getSnapshot().run?.product.result?.output?.agentSummary;
  const tree=await store.readRunTree(root),head=tree.members.find(m=>m.head.state.run.id===root).head;
  const rec=inspection.recorder.ref("runtime","run",root,root);
  await host.service.close();host=null;await services.close();services=null;
  const flushed=await inspection.flushRecording(true),{InspectionQueryService}=await import("@agent-anything/inspection/query");
  query=new InspectionQueryService(inspectionRoot);const snap=await query.query({kind:"get_snapshot",sourceId:rec.sourceId,datasetId:rec.datasetId});
  const page=await query.query({...snap.selection,kind:"list_native_interactions",runId:root,limit:100});
  const summary=head.state.finalOutput?.summary,outputValue=fs.existsSync(output)?fs.readFileSync(output,"utf8").trim():null;
  const evidence={root,state:head.state.status,final:summary,correctFile:outputValue===nonce,correctReport:summary?.includes(nonce)??false,
    visible,correctVisible:visible?.includes(nonce)??false,writes,counts:guard.counts,settlements:head.state.items.filter(i=>i.payload.kind==="model_call_settlement").map(i=>({
      name:i.payload.result.name,call:i.payload.result.providerCallRef?.id,settlement:i.payload.result.settlement})),
    inspector:{selection:snap.selection,entries:page.records.length,rejected:snap.coverage.rejected,dropped:snap.coverage.dropped,flush:flushed.native}};
  save("evidence",evidence);
  assert(evidence.correctFile && evidence.correctReport && writes===1 && head.state.status==="completed","tool-roundtrip independent result mismatch");
  assert(page.records.length && !snap.coverage.rejected && !snap.coverage.dropped && flushed.native==="settled","tool-roundtrip recording incomplete");
}
app.whenReady().then(async()=>{
  let code=0;
  try{await main();}catch(e){
    code=1;record({kind:"verification-stopped",stage,name:e.name,code:e.code??null,
      reason:e instanceof assert.AssertionError?e.message.split("\n")[0].slice(0,150):undefined});
    if(!settleOnly && root && services && services.controller.getSnapshot().execution!=="idle"){
      guard.stop();await services.controller.dispatchHostCommand({version:1,commandId:"tool-roundtrip-stop:"+root,runId:root,kind:"run.cancel",
        payload:{reason:"tool-roundtrip verifier stopped"}},"run.cancel").catch(()=>{});
      await drainOriginal().catch(()=>record({kind:"original-delivery-unconfirmed"}));
    }
  }finally{
    guard.stop();try{await query?.close();await host?.service.close();await services?.close();await inspection?.close();
      await store?.close();await diagnostics?.flush();}catch{code=1;record({kind:"cleanup-incomplete"});}
    console.log("tool-roundtrip evidence:",directory,"dispatch counts",guard.counts);app.exit(code);
  }
});
