const {app}=require("electron");
const assert=require("node:assert/strict");
const {join}=require("node:path");
const {pathToFileURL}=require("node:url");
const {mkdir,readFile,writeFile}=require("node:fs/promises");
const [directory,phase,endpoint]=process.argv.slice(2);
const cancelled=process.env.HOST_ACTIVITY_CANCEL==="1",hook=process.env.HOST_ACTIVITY_HOOK==="1";
const live=Boolean(process.env.HOST_ACTIVITY_LIVE_MODEL),model=process.env.HOST_ACTIVITY_LIVE_MODEL??"controlled";
const pressure=process.env.HOST_ACTIVITY_PRESSURE==="1",capacityRecovery=process.env.HOST_ACTIVITY_CAPACITY_RECOVERY==="1";
const graceful=process.env.HOST_ACTIVITY_GRACEFUL_CLOSE==="1";
const contextWindowTokens=pressure&&!capacityRecovery?32768:163840;
app.setPath("userData",join(directory,"electron"));app.disableHardwareAcceleration();
let store,host,inspection,active,interrupting=false;
async function main(){
  await app.whenReady();
  const load=path=>import(pathToFileURL(join(__dirname,"../../dist/main",path)));
  const {HelarcExecutionStore}=await load("execution-storage/HelarcExecutionStore.js");
  const {ElectronSafeStorageCredentialCipher}=await load("provider/ElectronSafeStorageCredentialCipher.js");
  const {createHelarcActivityHost}=await load("context/HelarcActivityHost.js");
  const {prepareHelarcHostRun}=await load("run/HelarcHostRunComposition.js");
  const {HelarcHostRunRecovery}=await load("run/HelarcHostRunRecovery.js");
  const {HelarcInspection}=await load("inspection/HelarcInspection.js");
  const {createStaticHostIdentityResolver,createStaticHostWorkspaceResolver}=await import("@agent-anything/host/context");
  const {createHelarcTask}=await import("@agent-anything/helarc/task");
  const {createHelarcProviderProfile,createDefaultHelarcInstructionSettings}=await import("@agent-anything/helarc/configuration");
  const {OllamaProvider}=await import("@agent-anything/provider-integrations/ollama");
  inspection=await HelarcInspection.create(join(directory,"inspection-settings.json"),join(directory,"inspection"));
  store=await HelarcExecutionStore.open(join(directory,"execution"),undefined,inspection.evidenceObserver,inspection.fileMaterialObserver,undefined,
    new ElectronSafeStorageCredentialCipher(),inspection.contextMaterialObserver,inspection.activityObserver,inspection.contextFoundationObserver);
  const failures=[];
  host=createHelarcActivityHost(store,{rediscoveryMs:10,diagnostics:{record:(_stage,_context,error)=>{failures.push(String(error.stack));console.error(error);}}});
  if(phase==="start") {
    const resolve=host.bindings.resolve.bind(host.bindings);
    host.bindings.resolve=async(binding,scope)=>{
      const handler=await resolve(binding,scope);
      if(binding.contract.ref.id!=="task.model-response")return handler;
      return {authorize:handler.authorize.bind(handler),execute:handler.execute.bind(handler),reconcile:handler.reconcile.bind(handler),settle:handler.settle.bind(handler),
        prepareRetry:handler.prepareRetry?.bind(handler),handleLimitation:handler.handleLimitation?.bind(handler),
        interpret:async(path,stage,...args)=>{
          if(stage.request.stageKind==="model") {
            const source=await store.activityHandoffs.command({kind:"read_stage",requestId:`${path.intent.id}:source`});
            if(source.request.input.record.source.iteration===2){
              interrupting=true;
              await writeFile(join(directory,"interrupted.json"),JSON.stringify({runId:path.intent.runId,stageId:stage.request.id,resultId:stage.result.id,
                providerRequestCount:JSON.parse(await readFile(join(directory,"requests.json"),"utf8")).length}));
              if(graceful){
                await host.service.close(100);
                const tree=await store.readRunTree(path.intent.runId);
                assert(tree.members.every(member=>!["failed","completed","cancelled"].includes(member.head.state.status)));
                await inspection.close();await store.close();
              }
              app.exit(73);return new Promise(()=>{});
            }
          }
          return handler.interpret(path,stage,...args);
        }};
    };
  }
  const provider=new OllamaProvider({model,baseUrl:endpoint,timeoutMs:60000,think:false,nativeToolInteraction:{supported:true},
    runtime:{contextWindowTokens},requestBodyTransportLimit:{maximumBytes:8*1024*1024,source:"host_configured",revision:"1"}},undefined,inspection.providerObserver);
  const profile=createHelarcProviderProfile({id:"isolated",providerKind:"ollama",displayName:"Isolated",baseUrl:endpoint,model,timeoutMs:60000,
    ollamaRuntime:{contextWindowTokens},credentialStatus:"empty_allowed"});assert(profile.ok);
  const workspaceRoot=join(directory,"workspace");await mkdir(workspaceRoot,{recursive:true});
  const task=createHelarcTask({taskId:"host-task",prompt:live?"Return READY 9507 as your final answer using final_result. No file changes or shell commands are needed.":
    "ROOT_CASE: Write once.txt, delegate independent alpha and beta reports, read alpha detail, and summarize.",createdAt:"2026-11-01T00:00:00.000Z"});assert(task.ok);
  const interrupted=phase==="recover"?JSON.parse(await readFile(join(directory,"interrupted.json"),"utf8")):null;
  const saved=interrupted?await store.readProductRun(interrupted.runId):undefined;
  const settings=createDefaultHelarcInstructionSettings();
  const instructionSettings=hook?{...settings,stop:settings.stop.map(section=>({...section,enabled:true}))}:settings;
  const application=process.env.HOST_ACTIVITY_APPLICATION==="1";
  let services,prepared,result;
  if(application) {
    const {createHelarcApplicationServices}=await load("HelarcApplicationServices.js");
    const {HelarcExecutionDiagnostics}=await load("diagnostics/HelarcExecutionDiagnostics.js");
    services=await createHelarcApplicationServices({userDataPath:directory,inspection,executions:store,activityHost:host,
      diagnostics:new HelarcExecutionDiagnostics(join(directory,"application-diagnostics.json"))});
    const controller=services.controller;
    controller.configureInstructions(instructionSettings);
    controller.selectWorkspacePath(workspaceRoot);
    if(phase==="recover") {
      const deadline=Date.now()+15000;
      for(;;){const stage=await store.activityHandoffs.command({kind:"read_stage",requestId:interrupted.stageId});
        if(stage.status==="accepted")break;assert(Date.now()<deadline,`Application did not independently restore ${stage.status}`);await new Promise(r=>setTimeout(r,20));}
      assert.equal((JSON.parse(await readFile(join(directory,"requests.json"),"utf8"))).length,interrupted.providerRequestCount);
      assert.equal((await store.readRunTree(saved.rootRunId)).members.length,1);
      const retained=(await controller.listRecoverableWork()).find(w=>w.id===saved.rootRunId);assert(retained);
      const resumed=await controller.recoverWork({id:retained.id,revision:retained.revision,intent:cancelled?"cancel":"continue"});assert(resumed.ok,resumed.message);
    } else {
      const started=await controller.startRun({taskText:task.task.input.prompt,target:{kind:"new_thread"}});
      assert(started.ok,started.error?.message);
    }
    const deadline=Date.now()+150000,approved=new Set();
    for(;;){
      if(interrupting){await new Promise(r=>setTimeout(r,25));continue;}
      const snapshot=controller.getSnapshot();
      for(const pending of snapshot.run?.host.pendingInteractions??[]) {
        if(approved.has(pending.request.id))continue;
        const request=pending.presentation;
        const option=request.decisionOptions?.find(o=>o.kind==="accept"||o.kind==="grantPermissions");
        assert(option,`Unexpected input ${pending.request.protocol.kind}`);
        approved.add(pending.request.id);
        const id=`application-approval:${pending.request.id}`;
        const payload={submissionId:id,runId:request.runId,requestId:request.id,pendingVersion:pending.request.requestVersion,
          optionId:option.id,grantedPermissions:option.kind==="grantPermissions"&&request.category==="permissions"?request.payload.permissions:null,reason:null};
        const receipt=await controller.dispatchHostCommand({version:1,commandId:id,runId:request.runId,kind:"interaction.submit",
          payload:{request:pending.request,submissionId:id,payload}},"interaction.submit");
        assert.equal(receipt.status,"handled");
      }
      if(snapshot.execution==="idle") {
        const entries=await store.listProductRuns();assert.equal(entries.length,1);
        const entry=entries[0];assert(entry.delivered,JSON.stringify({snapshotError:snapshot.error,entry}));
        const tree=await store.readRunTree(entry.admission.rootRunId),root=tree.members.find(m=>m.head.state.run.id===entry.admission.rootRunId);
        prepared={rootRunId:entry.admission.rootRunId};result={runResult:{...root.head.state,cause:root.head.state.settlementCause},product:{output:{safeErrors:snapshot.error?[snapshot.error]:[]}}};break;
      }
      assert(Date.now()<deadline,`Application completion timed out: ${snapshot.status}`);await new Promise(r=>setTimeout(r,25));
    }
  } else {
  const recovery=new HelarcHostRunRecovery({activityHost:host,executionStore:store,inspection,
    commandOutputDirectory:join(directory,"commands"),recoverProvider:async()=>provider});
  if(phase==="recover")host.setRecoveryResolver(id=>recovery.restoreScope(id));
  prepared=phase==="recover"?await recovery.prepare(saved.rootRunId):await prepareHelarcHostRun({activityHost:host,executionStore:store,inspection,recoveryAdmission:saved,
    task:saved?.task??task.task,provider,providerProfile:profile.profile,productRunId:"host-task",sessionId:"host-task",inputItems:[],
    instructionSettings,permissionPreset:"full_access",commandOutputDirectory:join(directory,"commands"),
    workspaceResolver:createStaticHostWorkspaceResolver({primary:{id:"workspace",name:"Workspace",rootRef:workspaceRoot,trustState:"trusted",source:"test",policyRefs:[],metadata:{}},additional:[]}),
    workspaceSelection:{kind:"references",primaryRef:"workspace",additionalRefs:[]},
    identityResolver:createStaticHostIdentityResolver({id:"test",kind:"anonymous",displayName:"Test",metadata:{}}),identitySelection:{kind:"anonymous"}});
  if(phase==="recover") {
    await recovery.restoreScope(interrupted.runId);
    const deadline=Date.now()+15000;
    for(;;){const stage=await store.activityHandoffs.command({kind:"read_stage",requestId:interrupted.stageId});
      if(stage.status==="accepted")break;assert(Date.now()<deadline,`Original response did not resume interpretation: ${stage.status}`);await new Promise(r=>setTimeout(r,20));}
    assert.equal((await store.readRunTree(saved.rootRunId)).members.length,1,"Responsibility recovery must not dispatch task Tools");
    assert.equal((JSON.parse(await readFile(join(directory,"requests.json"),"utf8"))).length,interrupted.providerRequestCount,"Responsibility recovery must not request new model work");
  }
  active=phase!=="recover"?prepared.start():await prepared.recover(cancelled?"cancel":"continue");
  result=await active.result;active=null;
  }
  await writeFile(join(directory,`${phase}-outcome.json`),JSON.stringify({status:result.runResult.status,cause:result.runResult.cause,errors:result.product.output.safeErrors}));
  assert.equal(phase,live?"live":"recover",`Expected interruption before original response interpretation: ${JSON.stringify(result.runResult.cause)}`);
  assert.equal(result.runResult.status,cancelled?"cancelled":"completed",JSON.stringify(result.runResult.cause));
  if(!cancelled)assert(result.runResult.finalOutput.summary.includes("9507"));
  const tree=await store.readRunTree(prepared.rootRunId);assert.equal(tree.members.length,cancelled||live?1:3);
  assert(tree.members.every(m=>m.head.state.status===(cancelled?"cancelled":"completed")));
  if(!live){
    const original=await store.activityHandoffs.command({kind:"read_stage",requestId:interrupted.stageId});assert.equal(original.result.id,interrupted.resultId);
    assert.equal(await readFile(join(workspaceRoot,"once.txt"),"utf8"),pressure?"retained test content; ".repeat(5000):"exactly one accepted effect");
  }
  const actions=tree.members.flatMap(m=>m.head.state.items.filter(i=>i.payload.kind==="observation"&&i.payload.observation.payload.kind==="operation"&&
    i.payload.observation.payload.result.binding.operation.operation.name==="write"));assert.equal(actions.length,live?0:1);
  const until=Date.now()+15000;
  const works=[],inputUsage=[];
  for(const member of tree.members){let after=0;for(;;){const page=await store.activityHandoffs.command({kind:"facts",runId:member.head.state.run.id,after,limit:128});
    for(const fact of page)if(fact.kind==="input_needed"&&!works.includes(fact.details.need.stage.pathId))works.push(fact.details.need.stage.pathId);
    if(page.length<128)break;after=page.at(-1).sequence;}}
  for(const member of tree.members){let after=0;for(;;){const page=await store.contextFoundationFacts(member.head.state.run.id,after,128);
    for(const fact of page)if(fact.kind==="input_usage_accepted")inputUsage.push(fact.details.usage);
    if(page.length<128)break;after=page.at(-1).sequence;}}
  for(const id of works)for(;;){const work=await store.activityHandoffs.command({kind:"read_schedule",workId:id});
    if(work.closed&&work.settlementConfirmed)break;if(Date.now()>until)throw new Error(`Unclosed response work ${id}`);await new Promise(r=>setTimeout(r,20));}
  for(;;){const view=await store.activityHandoffs.command({kind:"read_work_view",scopeId:`helarc-tree:${prepared.rootRunId}`,limit:128});
    if(!view.items.length&&!view.hasMore)break;
    assert(Date.now()<until,`Independent original activities did not settle: ${JSON.stringify(view)}`);await new Promise(r=>setTimeout(r,20));}
  assert(inputUsage.length>=works.length,"Every complete controlled response retains original accepted usage");
  assert.deepEqual(failures,[]);
  await host.service.close();host=null;
  services?.close();
  await inspection.registerExecutionRecording(prepared.rootRunId,true,store);
  const projectionDeadline=Date.now()+20000;let flushed;
  do {flushed=await inspection.recorder.flush();if(flushed.native==="settled"&&flushed.projection==="settled")break;
    assert(Date.now()<projectionDeadline,JSON.stringify(flushed));await new Promise(r=>setTimeout(r,20));}while(true);
  const health=inspection.recorder.health();assert.equal(health.dropped,0);assert.equal(health.rejected,0);
  await inspection.close();inspection=null;
  await store.close();store=null;
  await writeFile(join(directory,"verification.json"),JSON.stringify({electron:process.versions.electron,runs:tree.members.length,
    cancelled,hook,pressure,capacityRecovery,application,graceful,provider:live?model:"controlled",originalResponseReused:live?null:true,independentRecoveryBeforeContinue:live?null:true,
    writeEffects:actions.length,closedResponseWorks:works.length,allIndependentActivitiesSettled:true,acceptedInputUsage:inputUsage.length,
    inspection:{dropped:health.dropped,rejected:health.rejected,flush:flushed}},null,2));
}
main().then(()=>app.exit(0),async error=>{
  console.error(error.stack);if(active){await active.activeRun.cancel({origin:"host",reasonCode:"host_requested",reason:"Verification failed"}).catch(()=>{});}
  await host?.service.close().catch(()=>{});await inspection?.close().catch(()=>{});await store?.close().catch(()=>{});app.exit(1);
});
