// One charged attempt. Only an accepted standalone joint return permits the recovery entry.
const {app}=require("electron"),assert=require("node:assert/strict"),fs=require("node:fs"),fsp=require("node:fs/promises");
const {join,resolve,dirname,basename}=require("node:path"),{randomBytes}=require("node:crypto"),{pathToFileURL}=require("node:url");
const {digest}=require("./responses-tool-roundtrip-dispatch.cjs");
const [rootDir,authorization,phase]=process.argv.slice(2);assert(["seed","recover"].includes(phase));
const {openLive,originalForRun}=require("./responses-case-environment.cjs"),fixture=openLive("standalone-compaction",rootDir,authorization);
const {attempt:directory,profile,target}=fixture,workspace=join(directory,"workspace"),output=join(workspace,"receipt.txt");
const files=["calibration.txt","bench.txt"].map(f=>join(workspace,f));
const get=n=>JSON.parse(fs.readFileSync(join(directory,n+".json"),"utf8"));
const save=(n,v)=>fs.writeFileSync(join(directory,n+".json"),JSON.stringify(v,null,2),{flush:true,flag:"wx"});
if(phase==="seed"){fs.mkdirSync(directory);fs.mkdirSync(workspace);}
else {assert(fs.existsSync(join(directory,"cut.json"))&&!fs.existsSync(join(directory,"recovery-start.json")));assert.deepEqual(get("case").target,target);}
const deadline=phase==="seed"?Date.now()+600000:get("case").deadline;
const record=r=>fs.appendFileSync(join(directory,"attempt.ndjson"),JSON.stringify({at:new Date().toISOString(),...r})+"\n",{flush:true});
app.setPath("userData",profile);app.disableHardwareAcceleration();app.commandLine.appendSwitch("disable-background-networking");
const guard=require("./responses-standalone-compaction-dispatch.cjs").guard({directory,phase,target,deadline,files,receipt:output},globalThis.fetch,record);
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
  assert(app.requestSingleInstanceLock(),"profile already owned");
  const {DatabaseSync}=require("node:sqlite"),dbPath=join(profile,"execution","execution.sqlite");
  if(fs.existsSync(dbPath)){
    const db=new DatabaseSync(dbPath,{readOnly:true});
    try{const active=db.prepare("SELECT root_run_id FROM product_admissions WHERE delivered=0").all();
      if(phase==="seed")assert.equal(active.length,0,"other work is active");
      else{root=get("cut").root;assert.deepEqual(active.map(r=>r.root_run_id),[root]);save("recovery-start",{root,pid:process.pid});}
    }finally{db.close();}
  }else assert(phase==="seed"&&!fs.existsSync(dirname(dbPath)),"expected original execution store");
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
    nativeExecutionEligibility:c=>({available:guard.eligible(c),reason:guard.eligible(c)?null:"outside_standalone_compaction_target"})});
  const api=services.providerConfigurations,listing=await api.list();assert(listing.ok);

  const previous=new Set((await store.listProductRuns()).map(e=>e.admission.rootRunId));
  const candidate=await originalForRun(fixture,api);assert(guard.eligible(candidate)&&!candidate.capacityDeclaration,"original target or window changed");
  assert(!listing.value.defaultSelection);
  const settings=Object.fromEntries(Object.entries(await services.instructionSettingsStore.load()).map(([k,v])=>[k,v.filter(x=>x.enabled).length]));
  assert(Object.values(settings).every(n=>n===0),"optional instructions enabled");
  if(phase==="seed"){
    const token=()=>randomBytes(4).toString("hex").toUpperCase(),truth={old:"K-"+token(),current:"K-"+token(),condition:"M-"+token()};
    const rows=label=>Array.from({length:180},(_,i)=>label+" sample "+String(i+1).padStart(3,"0")+" | channel "+(i%13)+" | raw "+token()+"-"+token()+" | ambient "+(18+i%12)+" C | nominal").join("\n");
    fs.writeFileSync(files[0],["Calibration record for rig North.","Draft calibration identifier for rig North: "+truth.old+".",
      "Signed correction: the draft identifier is withdrawn. The replacement identifier is "+truth.current+"; it applies only in mode "+truth.condition+".",
      "Raw readings follow; their serials are not identifiers.",rows("north")].join("\n"),{flag:"wx"});
    fs.writeFileSync(files[1],["Bench notes. None of these readings changes the signed calibration record.",rows("bench")].join("\n"),{flag:"wx"});
    const prompt="Review the two synthetic calibration ledgers, in order. First use Write to create "+output+" containing only REVIEWED; it marks that the review is open. Then use Read on "+files[0]+", and after that on "+files[1]+". Do not modify or reread either source, run commands or delegate. In your final reply give the current calibration identifier for rig North and the exact operating mode in which it applies; do not report the withdrawn identifier. No need to reproduce the samples.";
    save("case",{target,settings,deadline,truth,prompt,limits:{perGeneration:16384,generate:10,count:10,compact:1,bytesPerDispatch:262144},pid:process.pid,electron:process.versions.electron,worker:store.generation});
    const accept=store.sharedAcceptance.accept.bind(store.sharedAcceptance);
    store.sharedAcceptance.accept=async p=>{
      const receipt=await accept(p),input=p.parts.find(s=>s.owner==="context_selection"&&s.kind==="selection_input")?.proposal.input;
      if(receipt.outcome==="accepted"&&input&&p.parts.some(s=>s.owner==="context_input_supply"&&s.kind==="native_input_return")){
        const bytes=Buffer.from(input.exactInput.wire.body),native=JSON.parse(bytes);
        const adopted=native.input?.some(i=>i.type==="compaction");
        record({kind:"accepted-input",root:p.scope,id:input.id,digest:digest(bytes),adopted:!!adopted});
        if(adopted){assert(root===p.scope&&guard.counts.compact===1,"unexpected compaction origin");
          fs.writeFileSync(join(directory,"accepted.wire"),bytes,{flag:"wx",flush:true});
          save("cut",{root,pid:process.pid,worker:store.generation,acceptance:p.id,id:input.id,bytes:bytes.length,digest:digest(bytes),counts:guard.counts});
          app.exit(73);return new Promise(()=>{});
        }
      }
      return receipt;
    };
    services.controller.selectWorkspacePath(workspace);guard.arm(candidate);stage="start";
    const started=await services.startProtocolRun({taskText:prompt,target:{kind:"new_thread"},maxInputTokensPerGeneration:16384},{id:target.id,revision:target.revision});
    assert(started.ok,"admission: "+started.error?.code);
  }else{
    guard.arm(candidate);stage="recover";
    const work=(await services.controller.listRecoverableWork()).find(w=>w.id===root);assert(work);
    const receipt=await services.controller.recoverWork({id:root,revision:work.revision,intent:"continue"});assert(receipt.ok,"recover not accepted");
  }
  stage="run";const approved=new Set();
  for(;;){
    const snap=services.controller.getSnapshot();
    if(!root){const entries=(await store.listProductRuns()).filter(e=>!previous.has(e.admission.rootRunId));if(entries.length){assert.equal(entries.length,1);root=entries[0].admission.rootRunId;record({kind:"admitted",root});}}
    if(snap.execution==="idle"){save("terminal",{status:snap.status,display:snap.run?.display?.status,error:snap.error?.code,message:snap.error?.message??null});break;}
    for(const p of snap.run?.host.pendingInteractions??[]){
      if(approved.has(p.request.id))continue;
      const r=p.presentation,tree=await store.readRunTree(root);
      const option=require("./responses-tool-roundtrip-approval.cjs").toolApproval(p,tree.members.find(m=>m.head.state.run.id===root).head.state.items,root,output,"REVIEWED");
      const commandId="standalone-compaction-approval:"+p.request.id;
      const receipt=await services.controller.dispatchHostCommand({version:1,commandId,runId:root,kind:"interaction.submit",payload:{
        request:p.request,submissionId:commandId,payload:{submissionId:commandId,runId:root,requestId:r.id,pendingVersion:p.request.requestVersion,
          optionId:option.id,grantedPermissions:null,reason:null}}},"interaction.submit");
      assert.equal(receipt.status,"handled");approved.add(p.request.id);record({kind:"scoped-write-approval",request:p.request.id,root});
    }

    assert(Date.now()<deadline,"deadline exceeded");await new Promise(r=>setTimeout(r,250));
  }
  stage="evidence";assert(root);await drainOriginal();
  const head=(await store.readRunTree(root)).members.find(m=>m.head.state.run.id===root).head;
  const rec=inspection.recorder.ref("runtime","run",root,root);
  const flush=await inspection.flushRecording(true),{InspectionQueryService}=await import("@agent-anything/inspection/query");
  query=new InspectionQueryService(inspectionRoot);
  const snap=await query.query({kind:"get_snapshot",sourceId:rec.sourceId,datasetId:rec.datasetId});
  const page=await query.query({...snap.selection,kind:"list_native_interactions",runId:root,limit:100});
  const log=fs.readFileSync(join(directory,"attempt.ndjson"),"utf8").trim().split("\n").map(s=>JSON.parse(s));
  const truth=get("case").truth,summary=head.state.finalOutput?.summary??"",correct=summary.includes(truth.current)&&summary.includes(truth.condition)&&!summary.includes(truth.old);
  const writesTotal=log.filter(r=>r.kind==="physical-write-attempt").length;
  const settlements=head.state.items.filter(i=>i.payload.kind==="model_call_settlement").map(i=>({call:i.payload.result.providerCallRef?.id,name:i.payload.result.name,status:i.payload.result.settlement}));
  let absenceOfLeak=null;
  if(phase==="recover"){
    const wire=JSON.parse(fs.readFileSync(join(directory,"accepted.wire"),"utf8")),last=wire.input.map(i=>i.type).lastIndexOf("compaction");
    const plain=JSON.stringify({...wire,input:wire.input.filter(i=>i.type!=="compaction")});
    absenceOfLeak=last>=0&&[truth.current,truth.condition].every(s=>!plain.includes(s))&&
      !log.slice(log.findIndex(r=>r.phase==="recover"&&r.kind==="dispatch")).some(r=>r.kind==="local-call"&&/^Read/.test(r.name));
  }
  save("evidence",{phase,root,summary,correct,state:head.state.status,counts:guard.counts,writesTotal,settlements,absenceOfLeak,
    inspector:{selection:snap.selection,entries:page.records.length,rejected:snap.coverage.rejected,dropped:snap.coverage.dropped,flush:flush.native}});
  assert(head.state.status==="completed","task did not complete; no positive standalone-compaction result");
  if(phase==="recover")assert(correct&&absenceOfLeak&&writesTotal===1&&fs.readFileSync(output,"utf8").trim()==="REVIEWED"&&
    guard.counts.compact===1&&page.records.length&&!snap.coverage.rejected&&!snap.coverage.dropped&&flush.native==="settled","standalone-compaction evidence incomplete");
}
app.whenReady().then(async()=>{
  let code=0;
  try{await main();}catch(e){
    code=1;record({kind:"verification-stopped",stage,name:e.name,reason:e.message?.split("\n")[0].slice(0,200)});
    if(root&&services&&services.controller.getSnapshot().execution!=="idle"){
      guard.stop();await services.controller.dispatchHostCommand({version:1,commandId:"standalone-compaction-stop:"+root,runId:root,kind:"run.cancel",
        payload:{reason:"standalone-compaction verifier stopped"}},"run.cancel").catch(()=>{});
      await drainOriginal().catch(()=>record({kind:"original-delivery-unconfirmed"}));
    }
  }finally{
    guard.stop();try{await query?.close();await host?.service.close();await services?.close();await inspection?.close();await store?.close();await diagnostics?.flush();}catch{code=1;record({kind:"cleanup-incomplete"});}
    console.log("standalone-compaction",phase,directory,guard.counts);app.exit(code);
  }
});
