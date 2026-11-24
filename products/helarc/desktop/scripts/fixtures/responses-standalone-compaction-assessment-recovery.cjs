// Offline recovery of an existing cancelled standalone assessment. Only copy mode opens the source databases.
const {app}=require("electron"),{DatabaseSync,backup}=require("node:sqlite"),assert=require("node:assert/strict");
const fs=require("node:fs"),{join,resolve}=require("node:path"),{pathToFileURL}=require("node:url");
const [dir,root,mode,fixtureRoot]=process.argv.slice(2);assert(dir&&/^run_[\w-]+$/.test(root)&&["copy","cut","resume","inspect"].includes(mode));
const profile=join(resolve(dir),"profile");
const source=mode==="copy"?require("./responses-case-environment.cjs").openCase("standalone-compaction",fixtureRoot).profile:null;
if(source)assert(!profile.toLowerCase().startsWith(resolve(source).toLowerCase()));
if(mode==="copy")fs.mkdirSync(dir);fs.mkdirSync(profile,{recursive:true});
app.setPath("userData",profile);app.disableHardwareAcceleration();app.commandLine.appendSwitch("disable-background-networking");
let forbidden=0;const denied=()=>{forbidden++;throw Error("Offline recovery attempted an external operation");};globalThis.fetch=denied;
const load=s=>import(pathToFileURL(join(__dirname,"../../dist/main",s+".js")));
async function snapshot(name){
  const db=new DatabaseSync(join(source,name),{readOnly:true});
  try{fs.mkdirSync(join(profile,name,".."),{recursive:true});await backup(db,join(profile,name));}finally{db.close();}
}
let store,registry,host,inspection,arrangement,query,sql;
async function main(){
  if(mode==="copy"){
    await snapshot("execution/execution.sqlite");await snapshot("provider-registry/registry.sqlite");
    fs.copyFileSync(join(source,"Local State"),join(profile,"Local State"));
    console.log("Isolated SQLite backups:",profile);return;
  }
  const inspectionRoot=join(dir,"inspection"),file=join(profile,"execution/execution.sqlite");
  sql=new DatabaseSync(file,{readOnly:true});
  const rows=sql.prepare("select id,attempt_id from activity_stages where id like ?").all(root+":native-compact-method:%:stage:4");
  assert.equal(rows.length,1);const {id,attempt_id:attempt}=rows[0],method=id.slice(0,-8),oracle=method+":compact-assessment:oracle",compact=method+":native-compact";
  const count=(s,...args)=>sql.prepare("select count(*) n from "+s).get(...args).n;
  const prior=()=>({
    product:sql.prepare("select delivered,digest from product_admissions where root_run_id=?").get(root),
    completed:sql.prepare("select id,result_id,receipt_id,status from activity_stages where path_id=? and id<>? order by id").all(method,id),
    operations:sql.prepare("select id,digest from protocol_records where activity_id in (select id from protocol_activities where run_id=?) and (id like '%:intent' or id like '%:dispatch') order by id").all(root),
    effects:sql.prepare("select id,digest from protocol_effects where activity_id in (select id from protocol_activities where run_id=?) order by id").all(root),
    activities:count("protocol_activities where run_id=?",root),
    usage:sql.prepare("select s.key,s.revision,s.digest from protocol_evidence_slots s join protocol_evidence_scopes p on p.id=s.scope_id where json_extract(p.value,'$.runId')=? and s.kind='usage' order by s.scope_id,s.key").all(root),
    compactAcceptance:sql.prepare("select digest from protocol_acceptances where activity_id=?").get(compact)
  });
  const before=prior(),baseline=join(dir,"baseline.json");
  if(mode==="cut"){assert.equal(before.product.delivered,1);assert(before.compactAcceptance);fs.writeFileSync(baseline,JSON.stringify(before),{flag:"wx"});}
  else assert.equal(JSON.stringify(before),fs.readFileSync(baseline,"utf8"));
  const {HelarcInspection}=await load("inspection/HelarcInspection");
  inspection=await HelarcInspection.create(join(dir,"inspection-settings.json"),inspectionRoot);assert(inspection.recorder);
  const {HelarcExecutionStore}=await load("execution-storage/HelarcExecutionStore"),{ElectronSafeStorageCredentialCipher}=await load("provider/ElectronSafeStorageCredentialCipher");
  const cipher=new ElectronSafeStorageCredentialCipher();
  store=await HelarcExecutionStore.open(join(profile,"execution"),undefined,inspection.evidenceObserver,inspection.fileMaterialObserver,undefined,cipher,
    inspection.contextMaterialObserver,inspection.activityObserver,inspection.contextFoundationObserver,inspection.protocolObserver);
  inspection.protocolObserver.bindContentReader(store.protocolJournal,store.contextSelections);
  const {ProviderRegistryClient}=await load("provider/ProviderRegistryClient"),{ProviderConfigurationService}=await load("provider/ProviderConfigurationService");
  registry=await ProviderRegistryClient.open(join(profile,"provider-registry/registry.sqlite"));
  const providers=new ProviderConfigurationService(registry,new Proxy({},{get:()=>denied}),cipher);
  const {createHelarcActivityHost}=await load("context/HelarcActivityHost"),{HelarcHostRunRecovery}=await load("run/HelarcHostRunRecovery"),
    {createHelarcNativeRunArrangement}=await load("context/HelarcNativeRunActivityComposition");
  const port=store.activityHandoffs,command=port.command.bind(port);
  const stage=()=>command({kind:"read_stage",requestId:id});
  const original=await stage();assert.equal(original.attempt.id,attempt);assert.equal(original.status,mode==="cut"?"dispatched":mode==="resume"?"raw_result":"settled");
  const cutFile=join(dir,"cut.json");
  assert.equal(original.attemptCount,1);
  port.command=async(c,options)=>{
    const v=await command(c,options);
    if(c.kind==="pending_scopes")return v.filter(x=>x.runId===root);
    if(c.kind==="save_raw"&&c.result.attemptId===attempt){
      assert.equal(mode,"cut");const s=await stage();assert.equal(s.status,"raw_result");assert(!s.settlement);
      assert.equal(forbidden,0);
      fs.writeFileSync(cutFile,JSON.stringify({pid:process.pid,generation:store.generation,raw:s.result.id,attempt}),{flag:"wx",flush:true});
      console.log("standalone-compaction cut after durable raw:",s.result.id);app.exit(73);return new Promise(()=>{});
    }
    return v;
  };
  let fail=null;
  if(mode!=="inspect"){host=createHelarcActivityHost(store,{report:async cycle=>{
    fail??=cycle.runs.flatMap(v=>v.result.failures).concat(cycle.failures)[0]?.error;
  }});
  const recovery=new HelarcHostRunRecovery({executionStore:store,activityHost:host,recoverNative:async saved=>{
    return arrangement=createHelarcNativeRunArrangement(saved.model.configuration,saved.model.connection,providers);
  }});
  host.setRecoveryResolver(id=>recovery.restoreScope(id));host.service.wake();}
  const until=Date.now()+45000;let done;
  do{if(fail)throw fail;done=await stage();if(done.status==="settled")break;await new Promise(r=>setTimeout(r,150));}while(Date.now()<until);
  assert.equal(done.status,"settled");assert.notEqual(mode,"cut");
  const cut=JSON.parse(fs.readFileSync(cutFile));assert.notEqual(cut.pid,process.pid);assert(store.generation>cut.generation);
  assert.equal(done.attempt.id,cut.attempt);assert.equal(done.result.id,cut.raw);assert.equal(done.settlement.resultId,cut.raw);
  assert.equal(count("activity_attempts where request_id=?",id),1);assert.equal(count("activity_raw_results where attempt_id=?",attempt),1);
  assert.equal(count("activity_settlement_receipts where request_id=?",id),1);assert.equal(count("activity_handoffs where request_id=? and pending=1",id),0);
  assert.equal(JSON.stringify(prior()),JSON.stringify(before));
  const entry=done.result.value.interruption.find(e=>e.activityId===oracle),lim=entry.disposition.limitation;
  assert.equal(lim.kind,"protocol_observation_unavailable");assert.equal(lim.reason,"native_connect_timeout");
  const state=()=>store.protocolJournal.command({kind:"state",activityId:oracle});
  assert((await state()).accepted);assert.equal(count("protocol_acceptances where activity_id=?",oracle),1);
  const acceptance=await store.protocolJournal.command({kind:"acceptance",activityId:oracle});
  const {readProtocolContent}=await import("@agent-anything/agent-runtime/model-access");
  const oracleResult=JSON.parse((await readProtocolContent(store.protocolJournal,acceptance.result,oracle,33554432)).toString());
  assert.equal(oracleResult.assessment.outcome,"unavailable");assert.equal(oracleResult.assessment.value,null);
  const m=done.request.input.method,sourceMaterial=m.request.execution.request,steps=[];
  const {assessHelarcResponsesCompactByProbe}=await import("@agent-anything/helarc/controller");
  const findings=await assessHelarcResponsesCompactByProbe({source:sourceMaterial,outcome:m.compact,execute:async(name)=>{
    steps.push(name);assert.equal(name,"oracle");return oracleResult;
  }});
  assert.deepEqual(steps,["oracle"]);assert.equal(findings.length,sourceMaterial.duties.length);
  assert(findings.length&&findings.every(f=>f.conclusion==="unknown"&&f.evidence.includes(lim.basis.digest)));
  const observer=new (await load("provider/HelarcResponsesPurposeObserver")).HelarcResponsesPurposeObserver(store,providers);
  try{const current=await state();if(!current.retentionReleased)assert(await observer.retire(current));}finally{await observer.close();}
  const pin=await providers.readPin(oracle+":connection");assert(pin);
  const retention=new (await load("provider/ProviderConnectionRetention")).ProviderConnectionRetention(providers,
    (await load("provider/HelarcConnectionCustodyEvidence")).helarcConnectionCustodyEvidence(store));
  if(pin.state!=="released")await retention.reconcile(pin);assert.equal((await providers.readPin(pin.id)).state,"released");
  const st=await state();assert(st.retentionReleased);assert.equal(st.cancelled,false);
  if(mode==="inspect")inspection.activityObserver.observeStage(await command({kind:"read_path",pathId:method}),done);
  // Recover evidence from the original owner even when this recording starts after the interruption.
  let cursor=0;
  for(;;){const facts=await store.protocolJournal.command({kind:"facts",runId:root,after:cursor,limit:64});if(!facts.length)break;
    for(const f of facts)if(f.activityId===oracle)inspection.protocolObserver.observe(f,"import");
    cursor=facts.at(-1).sequence;
  }
  const flushed=await inspection.flushRecording();assert.equal(flushed.native,"settled");
  const {InspectionQueryService}=await import("@agent-anything/inspection/query");query=new InspectionQueryService(inspectionRoot);
  const r=inspection.recorder,subject=r.ref("assessment-disposition","event",oracle,root,String(lim.basis.revision)),
    snap=await query.query({kind:"get_snapshot",sourceId:subject.sourceId,datasetId:subject.datasetId});
  assert.equal(snap.coverage.rejected,0);assert.equal(snap.coverage.dropped,0);
  const result=await query.query({...snap.selection,kind:"get_subject",subject}),b=lim.basis;
  const found=result.records.find(row=>row.payload.executionKind==="native_assessment_observation"&&row.payload.code===lim.reason);
  assert(found?.links.some(l=>l.to.id===b.scopeId+":"+b.kind+":"+b.key&&String(l.to.revision)===String(b.revision)));
  const sr=await query.query({...snap.selection,kind:"get_subject",subject:r.ref("shared_acceptance","contribution",done.settlement.id,root)});
  assert(sr.records.some(v=>v.links.some(l=>l.to.id===done.result.id)));
  assert.equal(forbidden,0);
  const evidence={root,attempt,raw:done.result.id,settlement:done.settlement.id,cutGeneration:cut.generation,resumeGeneration:store.generation,
    reason:lim.reason,basis:b,remoteResult:"unknown",quality:findings.map(f=>f.conclusion),newDispatches:0,settlements:1,pin:"released",
    inspector:{...snap.selection,rejected:snap.coverage.rejected,dropped:snap.coverage.dropped}};
  fs.writeFileSync(join(dir,"result.json"),JSON.stringify(evidence,null,2),{flag:"wx"});console.log(JSON.stringify(evidence));
}
app.whenReady().then(async()=>{let code=0;try{await main();}catch(e){console.error(e);code=1;}
  finally{await host?.service.close();await arrangement?.close();await query?.close();await inspection?.close();await store?.close();await registry?.close();sql?.close();app.exit(code);}});

