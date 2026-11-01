const {app,dialog}=require("electron");
const assert=require("node:assert/strict");
const {join}=require("node:path");
const {pathToFileURL}=require("node:url");
const {mkdir,readFile,writeFile}=require("node:fs/promises");
const directory=process.argv[2],workspace=join(directory,"workspace");
const live=Boolean(process.env.HOST_ACTIVITY_LIVE_MODEL),pressure=process.env.HOST_ACTIVITY_PRESSURE==="1";
app.setPath("userData",directory);app.disableHardwareAcceleration();
process.env.LOCALAPPDATA=join(directory,"local");
delete process.env.HELARC_RENDERER_DEV_SERVER_URL;
let completed=false,auditing=false;
const load=path=>import(pathToFileURL(join(__dirname,"../../dist/main",path)));
dialog.showOpenDialog=async()=>({canceled:false,filePaths:[workspace]});
dialog.showErrorBox=(_title,message)=>{fail(new Error(message));};
app.on("browser-window-created",(_event,window)=>{
  if(completed)return;
  window.webContents.once("did-finish-load",async()=>{
    try{
      await mkdir(workspace,{recursive:true});
      const choose=await window.webContents.executeJavaScript('window.helarc.chooseWorkspace({commandId:"fixture-workspace"})');
      assert.equal(choose.status,"handled");
      const prompt=live?"Return READY 9507 using final_result. Do not change files.":"ROOT_CASE: Write once.txt, delegate independent alpha and beta reports, read alpha detail, and summarize.";
      const start=await window.webContents.executeJavaScript(`window.helarc.startRun(${JSON.stringify({commandId:"fixture-start",taskText:prompt,target:{kind:"new_thread"}})})`);
      assert(start.result?.ok,JSON.stringify(start));
      const deadline=Date.now()+150000,submitted=new Set();
      for(;;){
        const snapshot=await window.webContents.executeJavaScript("window.helarc.getSnapshot()");
        for(const pending of snapshot.run?.host.pendingInteractions??[]){
          if(submitted.has(pending.request.id))continue;
          const review=pending.presentation,option=review.decisionOptions?.find(o=>o.kind==="accept"||o.kind==="grantPermissions");assert(option);
          const id=`approval:${review.id}`,payload={submissionId:id,runId:review.runId,requestId:review.id,pendingVersion:pending.request.requestVersion,
            optionId:option.id,grantedPermissions:option.kind==="grantPermissions"&&review.category==="permissions"?review.payload.permissions:null,reason:null};
          const input={commandId:id,runId:review.runId,request:pending.request,submissionId:id,payload};
          const response=await window.webContents.executeJavaScript(`window.helarc.submitInteraction(${JSON.stringify(input)})`);
          assert.equal(response.receipt.status,"handled");submitted.add(pending.request.id);
        }
        if(snapshot.execution==="idle"){assert.equal(snapshot.error,null,JSON.stringify(snapshot.error));completed=true;break;}
        assert(Date.now()<deadline,"Default entry did not settle");await new Promise(r=>setTimeout(r,25));
      }
      // Exercise the actual view detach/attach path without terminating the application.
      const originalThread=(await window.webContents.executeJavaScript("window.helarc.getSnapshot()")).activeThread.id;
      app.removeAllListeners("window-all-closed");
      app.once("browser-window-created",(_e,reopened)=>reopened.webContents.once("did-finish-load",async()=>{
        try{const snapshot=await reopened.webContents.executeJavaScript("window.helarc.getSnapshot()");
          assert.equal(snapshot.activeThread.id,originalThread);assert.equal(snapshot.execution,"idle");app.quit();
        }catch(error){fail(error);}
      }));
      window.once("closed",()=>setImmediate(()=>app.emit("activate")));
      window.close();
    }catch(error){fail(error);}
  });
});
app.on("will-quit",event=>{
  if(auditing)return;event.preventDefault();auditing=true;
  void audit().then(()=>app.exit(0),fail);
});
async function audit(){
  assert(completed,"Default application did not complete");
  const {HelarcExecutionStore}=await load("execution-storage/HelarcExecutionStore.js");
  const {ElectronSafeStorageCredentialCipher}=await load("provider/ElectronSafeStorageCredentialCipher.js");
  const store=await HelarcExecutionStore.open(join(directory,"execution"),undefined,undefined,undefined,undefined,new ElectronSafeStorageCredentialCipher());
  try{
    const runs=await store.listProductRuns();assert.equal(runs.length,1);assert(runs[0].delivered);
    const tree=await store.readRunTree(runs[0].admission.rootRunId);assert.equal(tree.members.length,live?1:3);
    assert(tree.members.every(member=>member.head.state.status==="completed"));
    const root=tree.members.find(member=>member.head.state.run.id===runs[0].admission.rootRunId);
    assert(root.head.state.finalOutput.summary.includes("9507"));
    const effects=tree.members.flatMap(member=>member.head.state.items.filter(item=>item.payload.kind==="observation"&&
      item.payload.observation.payload.kind==="operation"&&item.payload.observation.payload.result.binding.operation.operation.name==="write"));
    assert.equal(effects.length,live?0:1);
    if(!live)assert.equal(await readFile(join(workspace,"once.txt"),"utf8"),pressure?"retained test content; ".repeat(5000):"exactly one accepted effect");
    assert(runs[0].admission.executionBindings.activities,"Default entry used obsolete execution bindings");
    await writeFile(join(directory,"verification.json"),JSON.stringify({electron:process.versions.electron,defaultEntry:true,
      windowReopened:true,originalThreadRetained:true,runs:tree.members.length,writeEffects:effects.length,pressure,provider:live?process.env.HOST_ACTIVITY_LIVE_MODEL:"controlled"},null,2));
  }finally{await store.close();}
}
function fail(error){process.stderr.write(`${error.stack}\n`);app.exit(1);}
void load("main.js").catch(fail);
