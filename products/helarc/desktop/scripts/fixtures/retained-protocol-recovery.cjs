const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const {createHash}=require("node:crypto"),{tmpdir}=require("node:os"),{DatabaseSync,backup}=require("node:sqlite");
const {pathToFileURL}=require("node:url"),{app}=require("electron"),{facts}=require("./retained-protocol-facts.cjs");
const [kitPath,kind,mode]=process.argv.slice(2),kit=fs.realpathSync(kitPath);
assert.equal(path.dirname(kit),fs.realpathSync(tmpdir()));
assert(/^helarc-retained-protocols-\w+$/.test(path.basename(kit)));
const manifest=JSON.parse(fs.readFileSync(path.join(kit,"prepared.json"),"utf8"));
assert(manifest.format===1);assert.deepEqual(manifest.cases.map(c=>c.kind),["generic","generate"]);
assert(["generic","generate"].includes(kind)&&["recovery","inspection","open-diagnostic","delivery-and-integrity"].includes(mode));
const original=manifest.cases.find(c=>c.kind===kind),dir=path.join(kit,kind),limits={fetch:0,credentials:0,nativeRebind:0};
const resultPath=path.join(dir,mode+".json"),digest=v=>createHash("sha256").update(v).digest("hex");
const load=f=>import(pathToFileURL(path.join(__dirname,"../../dist/main",f+".js")).href);
const denied=k=>()=>{limits[k]++;throw Error("unexpected "+k);};
globalThis.fetch=denied("fetch");app.disableHardwareAcceleration();app.commandLine.appendSwitch("disable-background-networking");
app.setPath("userData",fs.mkdtempSync(path.join(kit,"electron-")));
const outcome={kind,mode,passed:false,pid:process.pid,limits};
async function execution(){
  const {HelarcExecutionStore}=await load("execution-storage/HelarcExecutionStore");
  const store=await HelarcExecutionStore.open(path.join(dir,"execution"));
  try{
    outcome.worker=store.generation;
    if(kind==="generic"){
      const {HelarcHostRunRecovery}=await load("run/HelarcHostRunRecovery");
      const {HelarcInspection}=await load("inspection/HelarcInspection");
      const inspectionRoot=path.join(dir,"recovery-inspection"),inspection=await HelarcInspection.create(path.join(dir,"settings.json"),inspectionRoot);
      const saved=await store.readProductRun(original.root),head=await store.readRunControl(original.root);
      assert.equal(saved.contextBinding.policy.revision,"8");
      const [entry]=await store.discoverProductWork("undelivered");
      assert.equal(entry.rootRunId,original.root);assert(entry.admitted&&entry.terminal&&!entry.delivered);
      assert.equal(entry.resumeLimitation,null,"terminal delivery does not execute the original policy");
      let originalSelections=0;
      const recovery=new HelarcHostRunRecovery({executionStore:store,inspection,recoverNative:denied("nativeRebind"),
        recoverProvider:async()=>{originalSelections++;throw Error("policy check must precede Provider recovery");}});
      try{
        await assert.rejects(()=>recovery.prepare(original.root),e=>{
          outcome.refusal=e.limitation;return e.code==="context_run_policy_unavailable"&&
            e.limitation.required==="context.normal-preparation@8"&&e.limitation.available==="context.normal-preparation@10";
        });
        await inspection.recorder.flush();
        const {InspectionQueryService}=await import("@agent-anything/inspection/query"),q=new InspectionQueryService(inspectionRoot);
        try{
          const ref=inspection.recorder.ref("runtime","run",original.root,original.root);
          const sel=(await q.query({kind:"get_snapshot",sourceId:ref.sourceId,datasetId:ref.datasetId})).selection;
          const check=(await q.query({kind:"list_records",...sel,runId:original.root,limit:100})).records
            .find(r=>r.payload.name==="execution.recovery.binding_checked");
          assert(check.links.some(l=>l.from.id===head.commitId));
          const content=JSON.parse((await q.query({kind:"get_content",...sel,contentId:check.contents[0].id})).content.text);
          assert.equal(content.bindingId,saved.contextBinding.id);assert.deepEqual(content.limitation,outcome.refusal);
          outcome.inspection={record:check.id,checkpoint:head.commitId,action:content.action};
        }finally{await q.close();}
      }finally{await inspection.close();}
      assert.equal(originalSelections,0);
      const {restoreHelarcTerminalResult}=await load("execution-storage/restoreHelarcTerminalResult");
      const tree=await store.readRunTree(original.root),result=restoreHelarcTerminalResult(saved,tree);
      assert.equal(result.runResult.completedAt,tree.members.find(m=>m.head.state.run.id===original.root).head.state.settlement.completedAt);
      assert.equal(result.runResult.status,"completed");outcome.restored=result.runResult.status;
      const witness=path.join(tmpdir(),original.source,"workspace/executions.txt");
      assert.equal(digest(fs.readFileSync(witness)),original.witness);
      outcome.originalSelections=originalSelections;
    }else{
      const {ActivityPurposeRegistry}=await import("@agent-anything/agent-runtime/activity");
      const {bindHelarcRepresentationMethods}=await load("context/HelarcRepresentationMethods");
      const {OllamaProvider}=await import("@agent-anything/provider-integrations/ollama");
      const provider=new OllamaProvider({model:"unrelated-current-model",baseUrl:"http://127.0.0.1:1",timeoutMs:5000,
        runtime:{contextWindowTokens:32768},nativeToolInteraction:{supported:true},
        requestBodyTransportLimit:{maximumBytes:1000000,source:"host_configured",revision:"1"}},denied("fetch"));
      const work=bindHelarcRepresentationMethods({store,provider,registry:new ActivityPurposeRegistry(),now:()=>new Date().toISOString(),
        authorize:()=>{throw Error("restoring an accepted result must not authorize new work");}});
      const result=await work.result(original.jobs[0].path);
      assert.equal(result.kind,"ready");assert.equal(result.progress.modelCalls,2);
      for(const j of original.jobs){
        const stage=await store.activityHandoffs.command({kind:"read_stage",requestId:j.id});
        assert.equal(stage.status,"accepted");assert.equal(stage.result.id,j.result);assert.equal(stage.receipt.id,j.receipt);
        assert.equal(stage.request.input.request.requestId,j.requestId);
        assert.equal(new URL(stage.request.input.encoded.endpoint).pathname,"/api/generate");
        assert.equal(digest(stage.request.input.encoded.body),j.body);
      }
      outcome.result=result.kind;outcome.originalCalls=result.progress.modelCalls;
    }
  } finally {await store.close();}
}
async function inspect(){
  const {InspectionQueryService}=await import("@agent-anything/inspection/query"),q=new InspectionQueryService(path.join(dir,"inspection"));
  try{
    const {subject,id,watermark,payload}=original.inspection;
    const page=await q.query({kind:"get_subject",sourceId:subject.sourceId,datasetId:subject.datasetId,watermark,subject});
    const record=page.records.find(r=>r.id===id);
    assert(record,"original captured record was not returned");
    assert.deepEqual(record.subject,subject);assert.equal(digest(JSON.stringify(record.payload)),payload);
    outcome.subjectId=subject.id;outcome.recordId=id;
  }catch(e){if(e.message!=="inspection_dataset_unsupported")throw e;outcome.limitation=e.message;}
  finally{await q.close();}
}
async function main(){
  await app.whenReady();
  assert(!fs.existsSync(resultPath),"this prepared evidence cell has already been used");
  try{
    if(mode==="inspection")await inspect();
    else if(mode==="delivery-and-integrity"){
      assert.equal(kind,"generic");
      const {HelarcExecutionStore}=await load("execution-storage/HelarcExecutionStore");
      const {restoreHelarcTerminalResult}=await load("execution-storage/restoreHelarcTerminalResult");
      for(const corrupt of [false,true]){
        const scratch=fs.mkdtempSync(path.join(dir,corrupt?"corrupt-":"delivery-")),dbPath=path.join(scratch,"execution.sqlite");
        const source=new DatabaseSync(path.join(dir,"execution/execution.sqlite"),{readOnly:true});
        try{await backup(source,dbPath);}finally{source.close();}
        if(corrupt){const db=new DatabaseSync(dbPath);try{assert.equal(db.prepare("update product_admissions set digest=? where root_run_id=?").run("wrong-digest",original.root).changes,1);}finally{db.close();}}
        let store=await HelarcExecutionStore.open(scratch);
        try{
          if(corrupt){
            await assert.rejects(()=>store.discoverProductWork("undelivered"),e=>e.code==="execution_records_corrupt");
            await assert.rejects(()=>store.commitProductDelivery(original.root),e=>e.code==="execution_records_corrupt");
            outcome.corruption="execution_records_corrupt";continue;
          }
          const admission=await store.readProductRun(original.root),tree=await store.readRunTree(original.root);
          const originalResult=restoreHelarcTerminalResult(admission,tree);
          assert.equal(originalResult.runResult.status,"completed");
          await store.commitProductDelivery(original.root);await store.close();store=await HelarcExecutionStore.open(scratch);
          assert.deepEqual(await store.discoverProductWork("undelivered"),[]);
          await store.commitProductDelivery(original.root);
          assert.deepEqual(restoreHelarcTerminalResult(admission,await store.readRunTree(original.root)),originalResult);
          outcome.delivery={status:originalResult.runResult.status,generation:store.generation};
        }finally{await store.close();}
        const after=new DatabaseSync(dbPath,{readOnly:true});
        try{const a=facts(after);for(const table of Object.keys(a))if(table!=="product_admissions")assert.deepEqual(a[table],original.rows[table]);
          assert.equal(after.prepare("select delivered from product_admissions where root_run_id=?").get(original.root).delivered,1);
        }finally{after.close();}
      }
    }
    else if(mode==="open-diagnostic"){
      const prior=JSON.parse(fs.readFileSync(path.join(dir,"recovery.json"),"utf8"));
      assert(!prior.passed&&!prior.worker&&prior.error==="execution_storage_failed","only diagnose a recorded open failure");
      const scratch=fs.mkdtempSync(path.join(dir,"open-only-")),source=new DatabaseSync(path.join(dir,"execution/execution.sqlite"),{readOnly:true});
      try{await backup(source,path.join(scratch,"execution.sqlite"));}finally{source.close();}
      const {HelarcExecutionStore}=await load("execution-storage/HelarcExecutionStore");
      const {captureExecutionError}=await load("diagnostics/ExecutionErrorDetails");
      let store;
      try{store=await HelarcExecutionStore.open(scratch);}
      catch(error){outcome.startup=captureExecutionError(error);}
      finally{await store?.close();}
      assert(outcome.startup?.cause,"original Worker cause unavailable");
    }else await execution();
  } finally {
    const db=new DatabaseSync(path.join(dir,"execution/execution.sqlite"),{readOnly:true});
    try{assert.deepEqual(facts(db),original.rows);outcome.historyUnchanged=true;}finally{db.close();}
    assert.deepEqual(limits,{fetch:0,credentials:0,nativeRebind:0});
  }
  outcome.passed=true;
}
main().catch(async e=>{
  outcome.error=e.message;
  const {captureExecutionError}=await load("diagnostics/ExecutionErrorDetails");
  outcome.details=captureExecutionError(e);
  console.error(e.stack);
}).finally(()=>{
  try{fs.writeFileSync(resultPath,JSON.stringify(outcome,null,2),{flag:"wx"});console.log(JSON.stringify(outcome));}
  finally{app.exit(outcome.passed?0:1);}
});
