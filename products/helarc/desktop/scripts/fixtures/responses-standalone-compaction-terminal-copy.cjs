// Restore only the product delivery of a retained failed Run. No execution host is composed.
const {app}=require("electron"),{DatabaseSync,backup}=require("node:sqlite"),assert=require("node:assert/strict");
const fs=require("node:fs"),os=require("node:os"),{join,resolve}=require("node:path"),{pathToFileURL}=require("node:url");
const [source,threads,root]=process.argv.slice(2);
assert(source&&threads&&/^run_[\w-]+$/.test(root));
const dir=fs.mkdtempSync(join(os.tmpdir(),"helarc-standalone-compaction-terminal-"));
app.setPath("userData",dir);app.disableHardwareAcceleration();app.commandLine.appendSwitch("disable-background-networking");
globalThis.fetch=()=>{throw Error("network not permitted in delivery recovery");};
const load=s=>import(pathToFileURL(join(__dirname,"../../dist/main",s+".js")));
async function main(){
  const execution=join(dir,"execution"),file=join(execution,"execution.sqlite");fs.mkdirSync(execution);
  const original=new DatabaseSync(resolve(source),{readOnly:true});
  try{await backup(original,file);}finally{original.close();}
  fs.copyFileSync(threads,join(dir,"threads.json"),fs.constants.COPYFILE_EXCL);
  const {HelarcExecutionStore}=await load("execution-storage/HelarcExecutionStore"),{HelarcMainController}=await load("HelarcMainController");
  const {FileHelarcThreadStore}=await load("thread/index"),{HelarcInspection}=await load("inspection/HelarcInspection");
  const inspection=await HelarcInspection.create(join(dir,"inspection-settings.json"),join(dir,"inspection"));
  assert(inspection.recorder);const threadsPath=join(dir,"threads.json"),sql=new DatabaseSync(file,{readOnly:true});
  const guardedTables=["execution_commits","action_records","activity_attempts","activity_settlement_receipts","protocol_records","protocol_acceptances","protocol_effects"];
  const unchanged=()=>guardedTables.map(t=>sql.prepare("select count(*) n from "+t).get().n);
  const baseline=unchanged();let request,product,thread;
  try{
    for(const pass of [1,2]){
      const store=await HelarcExecutionStore.open(execution);
      try{
        const controller=new HelarcMainController({threadStore:new FileHelarcThreadStore(threadsPath),executionStore:store,inspection,commandOutputDirectory:join(dir,"output")});
        if(pass===1){
          const item=(await controller.listRecoverableWork()).find(w=>w.id===root);assert.equal(item?.state,"delivery_pending");
          const admission=(await store.listProductRuns()).find(e=>e.admission.rootRunId===root).admission;
          product=admission.productRunId;thread=admission.sessionId;request={id:root,revision:item.revision,intent:"continue"};
          const result=await controller.recoverWork(request);assert(result.ok,result.message);
        }else{
          assert(!(await controller.listRecoverableWork()).some(w=>w.id===root));assert.equal((await controller.recoverWork(request)).ok,false);
        }
        const agg=JSON.parse(fs.readFileSync(threadsPath)).aggregates.find(a=>a.record.thread.id===thread);
        assert.equal(agg.commitLedger.filter(l=>l.kind==="run_terminal"&&l.runId===product).length,1);
        const terminal=agg.record.runs.find(r=>r.id===product).terminal;assert.equal(terminal.host.failure.kind,"input_preparation");
        assert.equal(terminal.host.failure.code,"context_input_unavailable");assert.equal(terminal.product.status,"failed");
        assert.equal(sql.prepare("select delivered from product_admissions where root_run_id=?").get(root).delivered,1);
        assert.deepEqual(unchanged(),baseline);
      }finally{await store.close();}
    }
    const flushed=await inspection.recorder.flush();assert.equal(flushed.native,"settled");const health=inspection.snapshot().health;
    assert.equal(health.rejected,0);assert.equal(health.dropped,0);console.log(JSON.stringify({dir,root,terminalCommits:1,unchanged:guardedTables,health}));
  }finally{sql.close();await inspection.close();}
}
app.whenReady().then(main).then(()=>app.exit(0),e=>{console.error(e);app.exit(1);});
