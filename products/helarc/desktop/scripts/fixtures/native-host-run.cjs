const {app,safeStorage}=require("electron"),assert=require("node:assert/strict");
const {join}=require("node:path"),{pathToFileURL}=require("node:url"),{mkdir,readFile,writeFile}=require("node:fs/promises");
const [directory,phase,endpoint]=process.argv.slice(2);
const fsPromises=require("node:fs/promises"),fs=require("node:fs"),{resolve,dirname,basename}=require("node:path");
const open=fsPromises.open,target=resolve(fs.realpathSync.native(directory),"workspace","once.txt").toLowerCase();
// Observe the real mutation handle, before the effect; do not suppress repeated execution.
fsPromises.open=async function(path,flags,...rest){
  if(typeof path==="string"&&["wx+","r+"].includes(flags)&&basename(path).toLowerCase()==="once.txt"&&
    resolve(fs.realpathSync.native(dirname(path)),basename(path)).toLowerCase()===target)
    fs.appendFileSync(join(directory,"physical-write-attempts.ndjson"),JSON.stringify({phase,pid:process.pid,flags})+"\n");
  return open.call(this,path,flags,...rest);
};
require("node:module").syncBuiltinESMExports();
app.setPath("userData",join(directory,"electron"));app.disableHardwareAcceleration();
let store,provider,service,arrangement,inspection,rejectFailure;
const failed=new Promise((_,reject)=>{rejectFailure=reject;});failed.catch(()=>{});
const checked=work=>Promise.race([work,failed]);
async function main(){
  const load=name=>import(pathToFileURL(join(__dirname,"../../dist/main",name)));
  const {HelarcExecutionStore}=await load("execution-storage/HelarcExecutionStore.js"),{HelarcInspection}=await load("inspection/HelarcInspection.js");
  const {HelarcActivityBindings}=await load("context/HelarcActivityBindings.js"),{HelarcActivityService}=await load("context/HelarcActivityService.js");
  const {createHelarcNativeRunArrangement}=await load("context/HelarcNativeRunActivityComposition.js");
  const {prepareHelarcHostRun}=await load("run/HelarcHostRunComposition.js"),{HelarcHostRunRecovery}=await load("run/HelarcHostRunRecovery.js");
  const {ProviderConnectionRetention}=await load("provider/ProviderConnectionRetention.js");
  const {createHelarcTask}=await import("@agent-anything/helarc/task");
  const h=await import("@agent-anything/helarc/controller"),runtime=await import("@agent-anything/agent-runtime/model-access"),context=await import("@agent-anything/agent-runtime/context-representation");
  const {captureExecutionError}=await load("diagnostics/ExecutionErrorDetails.js");
  inspection=await HelarcInspection.create(join(directory,`inspection-${phase}.json`),join(directory,"inspection"));assert(inspection.recorder);
  const cipher={isEncryptionAvailable:()=>safeStorage.isEncryptionAvailable(),encryptString:s=>safeStorage.encryptString(s).toString("base64"),decryptString:s=>safeStorage.decryptString(Buffer.from(s,"base64"))};
  const diagnostics={record:(event,details,error)=>require("node:fs").appendFileSync(join(directory,`${phase}-diagnostics.ndjson`),
    JSON.stringify({event,details,error:error?captureExecutionError(error):null})+"\n")};
  store=await HelarcExecutionStore.open(join(directory,"execution"),undefined,inspection.evidenceObserver,inspection.fileMaterialObserver,diagnostics,cipher,
    inspection.contextMaterialObserver,inspection.activityObserver,inspection.contextFoundationObserver,inspection.protocolObserver);
  inspection.protocolObserver.bindContentReader(store.protocolJournal);
  provider=await require("./native-task-provider.cjs")(directory,phase==="resume"?"child-response":phase,endpoint,load,"responses");
  const bindings=new HelarcActivityBindings(async runId=>(await store.readRunCommit(`${runId}:commit:0`))?.admission?.lineage.root.id??null);
  let failure;service=new HelarcActivityService({store,purposes:bindings,scopeAvailable:runId=>bindings.available(runId),rediscoveryMs:20,diagnostics,
    purposeIds:[runtime.PROTOCOL_OBSERVATION_PURPOSE,context.REPRESENTATION_METHOD_PURPOSE,context.SOURCE_MATERIAL_PUBLICATION_PURPOSE,
      h.HELARC_NATIVE_INPUT_DEMAND_PURPOSE,h.HELARC_NATIVE_ORIGINAL_INPUT_PURPOSE,h.HELARC_NATIVE_ACCOUNT_RECEPTION_PURPOSE,h.HELARC_NATIVE_RESULT_RECEPTION_PURPOSE].map(p=>p.ref.id),
    reconsideration:(...args)=>bindings.reconsideration(...args),report:async cycle=>{
      const error=cycle.failures[0]?.error??cycle.runs.flatMap(x=>x.result.failures)[0]?.error??cycle.reconsiderations.flatMap(x=>x.result.failures)[0]?.error;
      if(error&&!failure){failure=error;rejectFailure(error);}
    }});
  const retention=new ProviderConnectionRetention(provider.service,{read:async pin=>{
    const admission=await store.readProductRun(pin.owner);return admission?.version===4&&admission.model.connection.pinId===pin.id?"accepted":"unknown";
  }});
  const common={executionStore:store,activityHost:{bindings,service},inspection,connectionRetention:retention,commandOutputDirectory:join(directory,"command-output")};
  let prepared;
  if(phase==="start"){
    const workspacePath=join(directory,"workspace");await mkdir(workspacePath,{recursive:true});
    const workspace={primary:{id:"workspace",name:"workspace",rootRef:workspacePath,trustState:"trusted",source:"fixture",policyRefs:[],metadata:{}},additional:[]};
    const task=createHelarcTask({taskId:"native-host-task",prompt:"HOST_ROOT: Write once.txt with the text ORIGINAL. Then delegate HOST_CHILD to report 7391. Report its answer. No other work.",createdAt:new Date().toISOString()});assert(task.ok);
    arrangement=createHelarcNativeRunArrangement(provider.configuration,{kind:"connection",bindingId:provider.configuration.connectionBindingId,pinId:"product:provider-connection",acceptanceId:"product"},provider.service);
    prepared=await prepareHelarcHostRun({...common,native:arrangement,sessionId:"session",productRunId:"product",task:task.task,inputItems:[],
      permissionPreset:"full_access",workspaceResolver:{resolve:async()=>workspace},workspaceSelection:{kind:"references",primaryRef:"workspace",additionalRefs:[]},
      identityResolver:{resolve:async()=>({id:"user",kind:"anonymous",displayName:"User",metadata:{}})},identitySelection:{kind:"anonymous"}});
    await writeFile(join(directory,"root.json"),JSON.stringify({root:prepared.rootRunId}));
    const commit=store.commitRunTree.bind(store);
    store.commitRunTree=async value=>{
      const receipt=await commit(value);
      if(value.runs.some(run=>run.state.items.some(item=>item.payload.kind==="model_call_settlement"&&/^Write(?:_|$)/.test(item.payload.result.name)&&item.payload.result.settlement==="succeeded"))){
        await writeFile(join(directory,"start.json"),JSON.stringify({pid:process.pid,generation:store.generation,electron:process.versions.electron,checkpoint:value.id}));
        app.exit(73);return new Promise(()=>{});
      }
      return receipt;
    };
    const running=prepared.start(),result=await checked(running.result);
    await writeFile(join(directory,"unexpected-result.json"),JSON.stringify(result,null,2));
    throw failure??new Error(`Expected completed Write checkpoint interruption: ${result.runResult.status}, ${result.runResult.cause?.failure?.failure?.message??"see unexpected-result.json"}`);
  }
  const {root}=JSON.parse(await readFile(join(directory,phase==="followup-resume"?"followup-root.json":"root.json"),"utf8"));
  const admission=await store.readProductRun(root);assert.equal(admission.version,4);assert.equal(Object.hasOwn(admission,"providerProfile"),false);
  if(phase==="followup"){
    const current=await provider.service.get(provider.configuration.id),original=provider.configuration;
    const saved=await provider.service.save({configurationId:current.id,updateId:require("node:crypto").randomUUID(),expectedRevision:current.revision,
      draft:{protocol:original.protocol,baseUrl:original.baseUrl,native:original.native,observation:original.observation,generationLifetimeMs:original.generationLifetimeMs,
        name:"New task configuration",model:original.model},credential:{kind:"keep"}});
    arrangement=createHelarcNativeRunArrangement(saved.configuration,{kind:"connection",bindingId:saved.configuration.connectionBindingId,pinId:"followup:provider-connection",acceptanceId:"followup"},provider.service);
    const workspace={primary:{id:"workspace",name:"workspace",rootRef:join(directory,"workspace"),trustState:"trusted",source:"fixture",policyRefs:[],metadata:{}},additional:[]};
    const task=createHelarcTask({taskId:"followup",prompt:"HOST_FOLLOWUP: Report the prior result without executing the old calls again.",createdAt:new Date().toISOString()});assert(task.ok);
    prepared=await prepareHelarcHostRun({...common,native:arrangement,sessionId:"session",productRunId:"followup",task:task.task,inputItems:[],conversationSourceRunId:root,
      permissionPreset:"full_access",workspaceResolver:{resolve:async()=>workspace},workspaceSelection:{kind:"references",primaryRef:"workspace",additionalRefs:[]},
      identityResolver:{resolve:async()=>({id:"user",kind:"anonymous",displayName:"User",metadata:{}})},identitySelection:{kind:"anonymous"}});
    await writeFile(join(directory,"followup-root.json"),JSON.stringify({root:prepared.rootRunId}));
    const result=await checked(prepared.start().result);if(failure)throw failure;assert.equal(result.runResult.status,"completed",JSON.stringify(result.runResult));
    const tree=await store.readRunTree(prepared.rootRunId);assert.equal(tree.members.length,1);
    const handoff=await store.prepareConversationHandoff(prepared.rootRunId,"session");assert.equal(handoff.seed.kind,"native_evidence");assert.equal(handoff.seed.segments.length,2);
    assert(!tree.members[0].head.state.items.some(i=>i.payload.kind==="model_call_settlement"&&/^Write(?:_|$)/.test(i.payload.result.name)));
    await inspection.protocolObserver.flush();const flushed=await inspection.recorder.flush(true);assert.equal(flushed.native,"settled");
    await service.close();await writeFile(join(directory,"followup.json"),JSON.stringify({pid:process.pid,generation:store.generation,source:root,recipient:prepared.rootRunId,segments:2,result:result.runResult.status,inspection:flushed}));return;
  }
  if(phase==="resume")assert.notEqual((await provider.service.get(provider.configuration.id)).revision,admission.model.configuration.revision);
  const recovery=new HelarcHostRunRecovery({...common,recoverProvider:async()=>{throw new Error("Native recovery must not resolve a legacy Provider");},
    recoverNative:async saved=>{
      const original=await retention.recover(saved.model.connection);assert.equal(original.revision,saved.model.configuration.revision);
      arrangement=createHelarcNativeRunArrangement(saved.model.configuration,saved.model.connection,provider.service);return arrangement;
    }});
  prepared=await recovery.prepare(root);prepared.restoreActivityResponsibilities();
  const result=await checked((await prepared.recover()).result);
  if(failure)throw failure;assert.equal(result.runResult.status,"completed",JSON.stringify(result.runResult));
  assert.equal(await readFile(join(directory,"workspace/once.txt"),"utf8"),"ORIGINAL");
  const tree=await store.readRunTree(root);assert.equal(tree.members.length,phase==="followup-resume"?1:2);
  const writes=tree.members.flatMap(m=>m.head.state.items).filter(i=>i.payload.kind==="model_call_settlement"&&/^Write(?:_|$)/.test(i.payload.result.name));assert.equal(writes.length,phase==="followup-resume"?0:1);
  assert.match(JSON.stringify(result.product),/7391/);
  await inspection.protocolObserver.flush();const flushed=await inspection.recorder.flush(true);assert.equal(flushed.native,"settled");assert.equal(inspection.recorder.health().dropped,0);
  const status=await service.close();assert(status.localExecutionsFinished);
  await writeFile(join(directory,`${phase}.json`),JSON.stringify({pid:process.pid,generation:store.generation,electron:process.versions.electron,runs:tree.members.length,writes:writes.length,
    result:result.runResult.status,inspection:flushed,originalConfiguration:admission.model.configuration.revision},null,2));
}
app.whenReady().then(main).then(async()=>{await arrangement?.close();await inspection?.close();await store?.close();await provider?.close();app.exit(0);}).catch(async error=>{
  await writeFile(join(directory,`failure-${phase}.txt`),error.stack??String(error));try{await service?.close(1000);}catch{}try{await arrangement?.close();}catch{}try{await inspection?.close();}catch{}try{await store?.close();}catch{}try{await provider?.close();}catch{}app.exit(1);
});
