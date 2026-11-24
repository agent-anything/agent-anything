const {app}=require("electron"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const {pathToFileURL}=require("node:url"),{randomUUID}=require("node:crypto"),{delegatedMaterialGuard,delegatedDateGuard,digest}=require("./responses-tool-roundtrip-dispatch.cjs");
const [rootDir,authorization,mode]=process.argv.slice(2),dateOnly=mode==="--date-only";assert(!mode||dateOnly);
const {openLive,originalForRun}=require("./responses-case-environment.cjs"),fixture=openLive("delegated-material",rootDir,authorization);
const {profile,target,attempt:previousDir}=fixture,dir=dateOnly?path.join(fixture.root,"date-followup"):previousDir,workspace=path.join(dir,"workspace");
fs.mkdirSync(dir);if(!dateOnly)fs.mkdirSync(workspace);
const save=(file,v)=>fs.writeFileSync(path.join(dir,file+".json"),JSON.stringify(v,null,2));
const record=r=>fs.appendFileSync(path.join(dir,"attempt.ndjson"),JSON.stringify({at:new Date().toISOString(),...r})+"\n");
const deadline=Date.now()+360000,answer="LAB-"+randomUUID().slice(0,8),privateTag="COVER-"+randomUUID().slice(0,8);
const original=dateOnly?JSON.parse(fs.readFileSync(path.join(previousDir,"wire-audit.json"),"utf8")):null;
const expectedDate=original?.caveat.original, reportRef=original?.firstHandoff.ref;
const guard=dateOnly?delegatedDateGuard(target,globalThis.fetch,record,deadline,i=>JSON.stringify(i).includes(expectedDate),()=>reportRef):
  delegatedMaterialGuard(target,globalThis.fetch,record,deadline,i=>JSON.stringify(i).includes(answer));
globalThis.fetch=guard.fetch;
app.setPath("userData",profile);app.disableHardwareAcceleration();app.commandLine.appendSwitch("disable-background-networking");
const load=x=>import(pathToFileURL(path.join(__dirname,"../../dist/main",x)));
const pause=()=>new Promise(resolve=>setTimeout(resolve,300));
let root,store,services,host,inspection,diagnostics,query;
async function delivered(){
  const until=Date.now()+60000;
  do{if((await store.listProductRuns()).some(e=>e.admission.rootRunId===root && e.delivered) &&
    services.controller.getSnapshot().execution==="idle")return;await pause();}while(Date.now()<until);
  throw Error("original delivery unconfirmed");
}
async function run(){
  assert(app.requestSingleInstanceLock(),"Desktop profile is in use");
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
  services=await createHelarcApplicationServices({userDataPath:profile,executions:store,activityHost:host,inspection,diagnostics,
    nativeExecutionEligibility:c=>({available:guard.eligible(c),reason:guard.eligible(c)?null:"outside_delegated_material_target"})});
  const listing=await services.providerConfigurations.list();assert(listing.ok);
  const config=await originalForRun(fixture,services.providerConfigurations);assert(guard.eligible(config) && !config.isDefault && !listing.value.defaultSelection);
  const settings=Object.fromEntries(Object.entries(await services.instructionSettingsStore.load()).map(([k,v])=>[k,v.filter(i=>i.enabled).length]));
  assert(Object.values(settings).every(n=>n===0));
  let prompt,runTarget;
  if(dateOnly){
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(previousDir,"case.json"))).target,target);
    assert.equal(original.root,JSON.parse(fs.readFileSync(path.join(previousDir,"evidence.json"))).root);assert(reportRef && expectedDate);
    const old=(await store.listProductRuns()).find(r=>r.admission.rootRunId===original.root);
    assert(old?.delivered && old.admission.model.configuration.revision===target.revision);
    const threadId=old.admission.sessionId, handoff=await store.prepareConversationHandoff(original.root,threadId);
    assert(handoff.seed.sourceRunId===original.root && handoff.materialRefs.some(r=>r.id===reportRef.id&&r.revision===reportRef.revision),
      "original report is not eligible for this conversation handoff");
    assert((await services.controller.openThread(threadId)).ok);
    prompt="Was the calibration date independently verified? Check the opening of the previously delivered R1 report using ContextMaterialRead (offset 0, length 256), then answer in one sentence citing the relevant wording. Do not delegate, open workspace files or repeat earlier work. Original report reference: "+JSON.stringify(reportRef);
    runTarget={kind:"existing_thread",threadId};
    save("case",{target,settings,runTarget,sourceRunId:original.root,reportRef,prompt,maximum:{generate:2,count:2},electron:process.versions.electron,worker:store.generation});
  }else{
  const file="calibration-records.txt",uncertainty="Calibration date has not been independently verified.";
  const lines=["Synthetic calibration archive; revision R1.",uncertainty];
  for(let n=1;n<=160;n++)lines.push("Record "+String(n).padStart(3,"0")+" | Station A | Simulated reading within reference range. This record is synthetic; no independent field measurement was performed.");
  lines.push("DETAIL_CODE",answer,"End of archive.");const source=lines.join("\n");
  assert(source.length>16000);fs.writeFileSync(path.join(workspace,file),source,{flag:"wx"});
  const assignment="Read calibration-records.txt and return its complete revision R1 archive as your report, including all numbered rows, DETAIL_CODE and the following value, and the verification caveat. It is a read-only audit; do not write files or start commands.";
  prompt="Delegate the following assignment to exactly one child agent: "+assignment+
    " As parent, do not open the workspace file yourself. Verify the value following DETAIL_CODE against the actual delivered report, not a reference or search hit alone. Use the retained detail if the report is not inline. In your short final answer report the exact value and what remains unverified. Parent-only cover label "+privateTag+" must not be delegated. Do not modify anything.";
  save("case",{target,workspace,file,answer,privateTag,assignment,prompt,uncertainty,sourceDigest:digest(source),sourceBytes:Buffer.byteLength(source),
    markerOffset:Buffer.byteLength(source.slice(0,source.indexOf("DETAIL_CODE"))),inlineLimit:16000,settings,deadline,electron:process.versions.electron,worker:store.generation});
  services.controller.selectWorkspacePath(workspace);runTarget={kind:"new_thread"};
  }
  const prior=new Set((await store.listProductRuns()).map(r=>r.admission.rootRunId));
  guard.arm(config);const start=await services.startProtocolRun({taskText:prompt,target:runTarget},{id:target.id,revision:target.revision});assert(start.ok);
  for(;;){
    const snapshot=services.controller.getSnapshot(),fresh=(await store.listProductRuns()).filter(r=>!prior.has(r.admission.rootRunId));
    if(fresh.length){assert.equal(fresh.length,1);if(!root){root=fresh[0].admission.rootRunId;record({kind:"admitted",root});}}
    if(snapshot.execution==="idle")break;
    assert(!(snapshot.run?.host.pendingInteractions??[]).length,"unexpected interaction; test grants no permissions");
    assert(Date.now()<deadline,"delegated-material time budget exhausted");await pause();
  }
  await delivered();
  const tree=await store.readRunTree(root);
  if(dateOnly){
    const admitted=(await store.listProductRuns()).find(r=>r.admission.rootRunId===root).admission;
    const h=admitted.conversationHandoff;
    save("handoff",{session:admitted.sessionId,sourceRunId:h?.seed.sourceRunId,recipient:h?.recipientAgent,
      originalReportAdmitted:h?.materialRefs.some(r=>r.id===reportRef.id && r.revision===reportRef.revision),memberCount:tree.members.length});
  }
  const members=tree.members.map(m=>{const s=m.head.state;return {id:s.run.id,status:s.status,summary:s.finalOutput?.summary,
    refs:s.finalOutput?.materialRefs??[],calls:s.items.filter(i=>i.payload.kind==="model_call_settlement").map(i=>({name:i.payload.result.name,
      call:i.payload.result.providerCallRef?.id,status:i.payload.result.settlement,child:i.payload.result.content?.childRunId??null}))};});
  const ref=inspection.recorder.ref("runtime","run",root,root),visible=services.controller.getSnapshot().run?.product.result?.output?.agentSummary;
  await host.service.close();host=null;await services.close();services=null;
  const flushed=await inspection.flushRecording(true),{InspectionQueryService}=await import("@agent-anything/inspection/query");
  query=new InspectionQueryService(inspectionRoot);
  const snap=await query.query({kind:"get_snapshot",sourceId:ref.sourceId,datasetId:ref.datasetId});
  save("evidence",{root,members,visible,counts:guard.counts,delivered:true,selection:snap.selection,flush:flushed.native,dropped:snap.coverage.dropped,rejected:snap.coverage.rejected});
  assert.equal(flushed.native,"settled");assert.equal(snap.coverage.dropped+snap.coverage.rejected,0);
}
app.whenReady().then(async()=>{
  let code=0;
  try{await run();}catch(err){code=1;record({kind:"stopped",reason:String(err.code??err.message).slice(0,180)});guard.stop();
    if(root && services && services.controller.getSnapshot().execution!=="idle")try{
      await services.controller.dispatchHostCommand({version:1,commandId:"delegated-material-stop:"+root,runId:root,kind:"run.cancel",payload:{reason:"delegated-material verification stopped"}},"run.cancel");await delivered();
    }catch{record({kind:"original-delivery-unconfirmed"});}
  }finally{guard.stop();for(const f of [()=>query?.close(),()=>host?.service.close(),()=>services?.close(),()=>inspection?.close(),()=>store?.close(),()=>diagnostics?.flush()]){
    try{await f();}catch{code=1;record({kind:"cleanup-incomplete"});}}
    console.log("delegated-material:",dir,"dispatches",guard.counts);app.exit(code);}
});
