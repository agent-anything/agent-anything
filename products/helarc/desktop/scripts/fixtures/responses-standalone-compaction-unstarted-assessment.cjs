// Only an isolated pre-existing SQLite backup is opened; never start a new Run.
const {app}=require("electron"),{DatabaseSync}=require("node:sqlite"),fs=require("node:fs"),assert=require("node:assert/strict");
const {join,resolve,relative,isAbsolute}=require("node:path"),{pathToFileURL}=require("node:url"),{createHash}=require("node:crypto");
const [dir,root,phase]=process.argv.slice(2),profile=join(dir,"profile/Helarc"),file=join(profile,"execution/execution.sqlite");
assert(/^run_[\w-]+$/.test(root)&&["cut","resume","check"].includes(phase)&&fs.existsSync(file));
assert.notEqual(fs.realpathSync.native(profile).toLowerCase(),fs.realpathSync.native(join(process.env.APPDATA,"Helarc")).toLowerCase());
app.setPath("userData",profile);app.disableHardwareAcceleration();app.commandLine.appendSwitch("disable-background-networking");
const load=s=>import(pathToFileURL(resolve(__dirname,"../../dist/main",s+".js")));
const hash=v=>createHash("sha256").update(JSON.stringify(v)).digest("hex");
const read=n=>JSON.parse(fs.readFileSync(join(dir,n+".json")));
const save=(n,v)=>fs.writeFileSync(join(dir,n+".json"),JSON.stringify(v,null,2),{flag:"wx",flush:true});
const sql=new DatabaseSync(file,{readOnly:true}),all=(q,...a)=>sql.prepare(q).all(...a),one=(q,...a)=>sql.prepare(q).get(...a);
let external=0,store,host,services,inspection,query,diagnostics,failure;
const deny=()=>{external++;throw Error("External operation forbidden during offline recovery");};globalThis.fetch=deny;
async function main(){
  const stages=all("select id,path_id,attempt_id from activity_stages where id like ?",root+":native-compact-method:%:stage:4");
  assert.equal(stages.length,1);const {id,path_id:pathId,attempt_id:attempt}=stages[0];
  const current=()=>one("select status,attempt_id,result_id,receipt_id,digest from activity_stages where id=?",id);
  const immutable=()=>({
    actions:all("select record_id,digest from action_records where run_id=? order by sequence",root),
    activities:all("select id,digest from protocol_activities where run_id=? order by id",root),
    protocol:all("select r.id,r.digest from protocol_records r join protocol_activities a on a.id=r.activity_id where a.run_id=? order by r.id,r.revision",root),
    effects:all("select e.id,e.digest from protocol_effects e join protocol_activities a on a.id=e.activity_id where a.run_id=? order by e.id",root),
    usage:all("select s.key,s.revision,s.digest from protocol_evidence_slots s join protocol_evidence_scopes p on p.id=s.scope_id where json_extract(p.value,'$.runId')=? and s.kind='usage' order by s.scope_id,s.key",root),
    compact:one("select digest from protocol_acceptances where activity_id=?",pathId+":native-compact"),
    earlier:all("select id,status,attempt_id,result_id,receipt_id,digest from activity_stages where path_id=? and id<>? order by id",pathId,id),
    attempts:all("select id,digest from activity_attempts where request_id=?",id),
    stageDigest:current().digest,
  });
  const kept=immutable();assert(kept.compact);assert.equal(kept.earlier.length,3);assert(kept.earlier.every(s=>s.status==="accepted"));
  assert(!kept.activities.some(a=>a.id.startsWith(pathId+":compact-assessment:")));
  const beforePhase=current();assert.equal(beforePhase.attempt_id,attempt);
  if(phase==="cut"){assert.equal(beforePhase.status,"dispatched");assert.equal(one("select delivered from product_admissions where root_run_id=?",root).delivered,0);}
  else assert.deepEqual(hash(kept),read("baseline").digest);
  const {HelarcInspection}=await load("inspection/HelarcInspection"),{HelarcExecutionDiagnostics}=await load("diagnostics/HelarcExecutionDiagnostics");
  const {HelarcExecutionStore}=await load("execution-storage/HelarcExecutionStore"),{ElectronSafeStorageCredentialCipher}=await load("provider/ElectronSafeStorageCredentialCipher");
  const {createHelarcActivityHost}=await load("context/HelarcActivityHost"),{createHelarcApplicationServices}=await load("HelarcApplicationServices");
  (await load("provider/ProviderConfigurationService")).ProviderConfigurationService.prototype.withConnection=deny;
  const inspectionRoot=join(dir,"inspection");
  inspection=await HelarcInspection.create(join(dir,"inspection-settings.json"),inspectionRoot);assert(inspection.recorder);
  diagnostics=new HelarcExecutionDiagnostics(join(dir,phase+"-diagnostics.json"),inspection.performanceObserver);
  store=await HelarcExecutionStore.open(join(profile,"execution"),undefined,inspection.evidenceObserver,inspection.fileMaterialObserver,diagnostics,
    new ElectronSafeStorageCredentialCipher(),inspection.contextMaterialObserver,inspection.activityObserver,inspection.contextFoundationObserver,inspection.protocolObserver);
  inspection.protocolObserver.bindContentReader(store.protocolJournal,store.contextSelections);
  const admission=await store.readProductRun(root),head=async()=>(await store.readRunTree(root)).members.find(m=>m.head.state.run.id===root).head;
  const before=await head(),port=store.activityHandoffs,cmd=port.command.bind(port);
  const orig=await cmd({kind:"read_stage",requestId:id}),source=orig.request.input.method.request.execution.request;
  assert.equal(source.assessmentInput,undefined);assert.equal(source.assessmentModelCalls,3);
  const calls=before.state.items.filter(i=>i.payload.kind==="model_call_settlement");assert.equal(calls.length,3);
  if(phase==="cut"){
    assert.equal(before.state.status,"cancelling");assert(before.control.cancellation);
    save("baseline",{digest:hash(kept),source:source.sourceDigest,candidate:orig.request.input.method.compact.candidate.digest,
      originalItems:hash(before.state.items),itemCount:before.state.items.length,cancellation:before.control.cancellation,attempt,
      generation:store.generation,root,id,pathId,product:admission.productRunId});
  }
  const base=read("baseline");
  assert.equal(hash(before.state.items.slice(0,base.itemCount)),base.originalItems);
  // An attempted redo must not touch the original workspace even if a ledger assertion later fails.
  const workspace=fs.realpathSync.native(admission.workspace.primary.rootRef);
  const open=fs.promises.open;
  fs.promises.open=async function(path,...args){
    if(typeof path==="string"){
      const r=relative(workspace,resolve(path));if(!r.startsWith("..")&&!isAbsolute(r))return deny();
    }
    return open.call(this,path,...args);
  };
  require("node:module").syncBuiltinESMExports();
  port.command=async(c,o)=>{
    const v=await cmd(c,o);
    if(c.kind==="pending_scopes")return v.filter(x=>x.runId===root);
    if(c.kind==="save_raw"&&c.result.attemptId===attempt){
      assert.equal(phase,"cut","second raw submission");const after=await cmd({kind:"read_stage",requestId:id});
      assert.equal(after.status,"raw_result");assert.equal(after.result.value.assessmentDisposition.reason,"original_assessment_input_admission_missing");
      assert.equal(after.result.value.assessment,null);assert.equal(external,0);
      save("cut",{pid:process.pid,generation:store.generation,raw:after.result.id,attempt});app.exit(73);return new Promise(()=>{});
    }
    return v;
  };
  const {confirmUnstartedCompactAssessment}=await load("context/HelarcCompactAssessmentFootprint"),{ProviderRegistryClient}=await load("provider/ProviderRegistryClient");
  const registry=await ProviderRegistryClient.open(join(profile,"provider-registry/registry.sqlite"));
  let footprint;
  try{footprint=await confirmUnstartedCompactAssessment(pathId,new AbortController().signal,{
    native:activityId=>store.protocolJournal.command({kind:"state",activityId}),preparation:id=>store.sharedAcceptance.query(id),
    connection:id=>registry.request({kind:"read_pin",id})});}finally{await registry.close();}
  host=createHelarcActivityHost(store,{diagnostics,report:async cycle=>{
    failure??=cycle.runs.flatMap(v=>v.result.failures).concat(cycle.failures)[0]?.error;
  }});
  services=await createHelarcApplicationServices({userDataPath:profile,inspection,executions:store,diagnostics,activityHost:host});
  const controller=services.controller,active=(await controller.listRecoverableWork()).find(w=>w.id===root);
  if(phase==="resume"){
    assert.equal(beforePhase.status,"raw_result");assert(active);
    assert.notEqual(read("cut").pid,process.pid);assert(store.generation>read("cut").generation);
    const request={id:root,revision:active.revision,intent:"continue"};save("original-recovery-request",request);
    const response=await controller.recoverWork(request);assert(response.ok,response.message);
  }
  if(phase==="check"){
    assert(!active);assert.equal((await controller.recoverWork(read("original-recovery-request"))).ok,false);
  }
  const deadline=Date.now()+50000;
  for(;;){
    if(failure)throw failure;
    if(one("select delivered from product_admissions where root_run_id=?",root).delivered===1&&current().status==="accepted")break;
    assert(Date.now()<deadline,JSON.stringify({stage:current().status,run:(await head()).state.status,desktop:controller.getSnapshot().error}));
    await new Promise(r=>setTimeout(r,150));
  }
  assert.notEqual(phase,"cut");
  const done=await cmd({kind:"read_stage",requestId:id}),terminal=await head(),m=done.result.value;
  assert.equal(m.state,"gap");assert.equal(m.assessment,null);assert.equal(m.publication,null);
  assert.equal(done.result.id,read("cut").raw);assert.equal(m.assessmentDisposition.attemptId,attempt);
  assert.equal(m.assessmentDisposition.sourceDigest,base.source);assert.equal(m.assessmentDisposition.candidateDigest,base.candidate);
  assert.deepEqual(m.assessmentDisposition.checkedNativeActivities,footprint);
  assert.equal(terminal.state.status,"cancelled");assert.deepEqual(terminal.control.cancellation,base.cancellation);
  assert.equal(hash(terminal.state.items.slice(0,base.itemCount)),base.originalItems);
  assert.equal(one("select count(*) n from activity_raw_results where attempt_id=?",attempt).n,1);
  assert.equal(one("select count(*) n from activity_processing_receipts where request_id=?",id).n,1);
  assert.equal(one("select count(*) n from activity_handoffs where request_id=? and pending=1",id).n,0);
  const ledger=JSON.parse(fs.readFileSync(join(profile,"threads.json"))).aggregates.find(a=>a.record.thread.id===admission.sessionId).commitLedger;
  const commits=ledger.filter(c=>c.kind==="run_terminal"&&c.runId===admission.productRunId);assert.equal(commits.length,1);
  assert.equal(hash(immutable()),base.digest);
  // A later verification can import the original raw evidence without replaying the work.
  if(phase==="check")inspection.activityObserver.observeStage(await cmd({kind:"read_path",pathId}),done);
  const flushed=await inspection.flushRecording(true);assert.equal(flushed.native,"settled");
  {
    const {InspectionQueryService}=await import("@agent-anything/inspection/query");query=new InspectionQueryService(inspectionRoot);
    const subject=inspection.recorder.ref("assessment-disposition","event",attempt,root,"1");
    const snapshot=await query.query({kind:"get_snapshot",sourceId:subject.sourceId,datasetId:subject.datasetId});
    assert.equal(snapshot.coverage.rejected,0);assert.equal(snapshot.coverage.dropped,0);
    const rows=await query.query({...snapshot.selection,kind:"get_subject",subject});
    const fact=rows.records.find(r=>r.payload.executionKind==="native_assessment_admission");assert(fact);
    assert(fact.links.some(l=>l.from.id===id)&&fact.links.some(l=>l.from.id===done.result.id)&&fact.links.some(l=>l.to.id===m.assessmentDisposition.compactAcceptance.id));
    const evidence=JSON.parse((await query.query({...snapshot.selection,kind:"get_content",contentId:fact.contents[0].id,length:16384})).content.text);
    assert.deepEqual(evidence,m.assessmentDisposition);
    if(phase==="check"&&fs.existsSync(join(dir,"result.json")))assert.equal(current().receipt_id,read("result").processingReceipt);
    const n=phase==="check"?"reopened":"result";
    if(!fs.existsSync(join(dir,n+".json")))save(n,{root,attempt,raw:done.result.id,processingReceipt:current().receipt_id,terminal:terminal.state.status,terminalCommits:commits.length,
      generations:[read("cut").generation,store.generation],external,disposition:evidence,inspector:{...snapshot.selection,rejected:0,dropped:0}});
    else assert.deepEqual(read(n).disposition,evidence);
  }
  assert.equal(external,0);console.log(JSON.stringify({phase,terminal:terminal.state.status,terminalCommits:commits.length,stage:current().status,external}));
}
app.whenReady().then(async()=>{let code=0;try{await main();}catch(e){console.error(e);code=1;}
  finally{await host?.service.close();await services?.close();await query?.close();await inspection?.close();await store?.close();await diagnostics?.flush();sql.close();app.exit(code);}});
