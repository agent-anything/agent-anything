const {app}=require("electron"),assert=require("node:assert/strict");
const {join}=require("node:path"),{pathToFileURL}=require("node:url"),{writeFile}=require("node:fs/promises");
const [directory,phase,endpoint]=process.argv.slice(2);
app.setPath("userData",join(directory,"electron"));app.disableHardwareAcceleration();
let store,provider,transport,service;
async function main(){
  const load=p=>import(pathToFileURL(join(__dirname,"../../dist/main",p)));
  const model=await import("@agent-anything/model-interaction/protocol"),runtime=await import("@agent-anything/agent-runtime/model-access");
  const {ActivityPurposeRegistry,ActivityChangeWait}=await import("@agent-anything/agent-runtime/activity");
  const native=await import("@agent-anything/provider-integrations/native"),{modelInputValueDigest:digest}=await import("@agent-anything/model-interaction/input");
  const {HelarcExecutionStore}=await load("execution-storage/HelarcExecutionStore.js");
  const {HelarcChatPurposeObserver}=await load("provider/HelarcChatPurposeObserver.js");
  const {HelarcNativeObservation}=await load("context/HelarcNativeObservation.js"),{HelarcActivityService}=await load("context/HelarcActivityService.js");
  store=await HelarcExecutionStore.open(join(directory,"execution"));
  provider=await require("./native-task-provider.cjs")(directory,phase,endpoint,load,"deepseek-transport");
  transport=new HelarcChatPurposeObserver(store,provider.service);
  const cfg=provider.configuration,protocol=model.DEEPSEEK_CHAT_COMPLETIONS,ref=id=>({id,revision:"1"}),participant=id=>({implementation:ref(id),protocol});
  const composition=model.bindModelAgentComposition({agent:ref("agent"),protocol,
    configuration:{configuration:{id:cfg.id,revision:cfg.revision},model:cfg.model,protocol,connectionBinding:ref(cfg.connectionBindingId)},
    adapter:{implementation:native.DEEPSEEK_CHAT_ADAPTER,protocol},task:{purpose:ref("task"),input:participant("input"),interpreter:participant("interpreter")},auxiliary:[]});
  const registry=new ActivityPurposeRegistry(),journal=store.protocolJournal,acceptance=store.sharedAcceptance;
  const accept=async(id,actor,parts)=>{const r=await acceptance.accept({id,scope:"root",actor,parts});assert.equal(r.outcome,"accepted",JSON.stringify(r));};
  const state=id=>journal.command({kind:"state",activityId:id});
  const requests=new Map(),failures=[];let physical=0,maximumPhysical=0,entered=0;
  const host={assertAvailable:()=>{if(failures.length)throw failures[0];service.assertAvailable();},wake:()=>service.wake(),
    subscribe:(listener,interest)=>store.onActivityChange(listener,interest)};
  const arrangement=s=>({identity:{id:`${s.activity.scope.activityId}:work`,runId:"root",permissionBasis:"test-authority",resourceScope:`${s.activity.scope.activityId}:work`,
    scheduledWorkId:`${s.activity.scope.activityId}:work`,maximumStages:1,maximumAttempts:1,maximumConcurrent:1,deadlineAt:"2030-01-01T00:00:00Z"},
    schedule:{id:`${s.activity.scope.activityId}:schedule`,workId:`${s.activity.scope.activityId}:work`,runId:"root",scopeId:"tree",owner:"model-access",reason:"task",
      decisionId:s.activity.scope.activityId,policyRevision:"1",delayImpact:"Original task waits for native observation",timing:{kind:"unknown"},resources:[{poolId:"model",capability:"model-request",units:1}]}});
  const scheduled=new HelarcNativeObservation({store,registry,host,rediscoveryMs:20,settlementWaitMs:3000,now:()=>new Date().toISOString(),
    arrange:async s=>arrangement(s),authorize:async path=>{assert.equal(path.intent.permissionBasis,"test-authority");return {kind:"allowed"};},
    observe:async(s,request,_mode,signal)=>{entered++;physical++;maximumPhysical=Math.max(physical,maximumPhysical);
      try{return await transport.observe(s,request,signal,async()=>{assert.equal(physical,1);});}finally{physical--;}
    },interrupt:(s,request)=>transport.interrupt(s,request,`${s.activity.scope.activityId}:cancel-disposition`)});
  await store.activityHandoffs.command({kind:"bind_resource_pool",pool:{id:"model",revision:"1",authority:"test-authority",capacity:1}});
  const start=()=>service=new HelarcActivityService({store,purposes:registry,purposeIds:[runtime.PROTOCOL_OBSERVATION_PURPOSE.ref.id],rediscoveryMs:10,
    reconsideration:()=>scheduled.work.lifecycle,report:async cycle=>{failures.push(...cycle.runs.flatMap(r=>r.result.failures.map(f=>f.error)),
      ...cycle.failures.map(f=>f.error),...cycle.reconsiderations.flatMap(r=>r.result.failures.map(f=>f.error)));}});
  async function prepare(id){
    let s=await state(id);
    if(!s){
      const scope={runId:"root",activityId:id,recipientId:"agent",purpose:ref("task"),compositionDigest:composition.digest};
      const activity=runtime.bindProtocolModelActivity({composition,scope,conditions:{input:ref(id),authority:ref("test-authority"),resources:ref("model"),control:ref("active")}});
      const wire=native.prepareDeepSeekChat({model:cfg.model,messages:[{role:"user",content:id}],tools:[],purpose:scope.purpose,stream:false});
      const request=await transport.prepare(activity,{format:"helarc.native-prepared-task.v1",binding:{scope,operationId:`${id}:create`,record:ref(`${id}:response`),requestId:id},
        wire:{body:wire.encoded,digest:wire.digest},sourceDigest:id,delivery:[],results:[]},cfg);
      const input=await runtime.retainProtocolContent(journal,`${id}:input`,id,Buffer.from(JSON.stringify(request)));
      await accept(`${id}:prepare`,"execution-coordinator",[{owner:"protocol_execution",kind:"prepare",proposal:{activity,input}}]);s=await state(id);
    }
    if(s.fence.generation!==store.generation||!s.fence.epoch){
      await accept(`${id}:claim:${store.generation}:${s.fence.epoch}`,native.DEEPSEEK_CHAT_ADAPTER.id,[{owner:"protocol_execution",kind:"claim",proposal:{activityId:id,expectedEpoch:s.fence.epoch}}]);s=await state(id);
    }
    const request=JSON.parse((await runtime.readProtocolContent(journal,s.input,id,33554432)).toString());requests.set(id,request);return s;
  }
  const context=signal=>({cancellation:{signal},retry:{deadlineAt:new Date(Date.now()+20000).toISOString()}});
  async function cancel(id){
    let s=await state(id);
    if(!s.cancelled){await accept(`${id}:cancel`,"execution-coordinator",[{owner:"protocol_execution",kind:"control",proposal:{activityId:id,expectedRevision:s.fence.controlRevision,cancelled:true}}]);s=await state(id);}
    return scheduled.observe(s,requests.get(id),"interrupt",context(new AbortController().signal));
  }
  async function closed(id){
    const wake=new ActivityChangeWait(host,AbortSignal.timeout(5000));
    try{for(;;){const version=wake.version;host.assertAvailable();
      const result=await store.activityHandoffs.command({kind:"read_schedule",workId:`${id}:work`});
      if(result?.settlementConfirmed)return result;await wake.wait(version,20);
    }}finally{wake.close();}
  }
  if(phase==="seed"){
    const queued=await prepare("queued"),a=arrangement(queued);
    await accept("queued:work:submission","model-access",scheduled.work.prepareSubmission(a.identity,queued,a.schedule));
    // Cancel before the Host can reserve or dispatch this work.
    await store.activityHandoffs.command({kind:"cancel",pathId:a.identity.id,expectedControlRevision:0});start();
    await cancel("queued");await closed("queued");assert.equal(entered,0);
    const running=await prepare("running"),controller=new AbortController();
    const waiting=scheduled.observe(running,requests.get("running"),"execute",context(controller.signal)).then(()=>({resolved:true}),error=>({error}));
    const deadline=Date.now()+5000;
    while(!(await (await fetch(`${endpoint}/received`)).json()).running){assert(Date.now()<deadline,"Peer must receive the one original POST");await new Promise(r=>setTimeout(r,10));}
    controller.abort(new Error("user cancelled"));await cancel("running");assert((await waiting).error);await closed("running");
    assert.equal(physical,0);assert.equal(entered,1);
    const later=await prepare("later"),record=await scheduled.observe(later,requests.get("later"),"execute",context(new AbortController().signal));
    assert(record);await closed("later");assert.equal(physical,0);assert.equal(entered,2);assert.equal(maximumPhysical,1);
  }else{
    start();
    for(const id of ["queued","running"]){await prepare(id);await cancel(id);await closed(id);}
    const later=await prepare("later"),record=await scheduled.observe(later,requests.get("later"),"recover",context(new AbortController().signal));
    assert(record);assert.equal(entered,0,"Restart must read the accepted handoff, never re-enter physical observation");
  }
  for(const id of ["queued","running"]){
    const s=await state(id),record=await journal.command({kind:"record",activityId:id,ref:ref(`${id}:cancel-disposition`)});
    const disposition=JSON.parse((await runtime.readProtocolContent(journal,record.content,id,65536)).toString());
    assert.equal(disposition.remote,id==="queued"?"not_dispatched":"unknown");assert.equal(s.cancelled,true);
    assert.equal(await journal.command({kind:"acceptance",activityId:id}),null);
  }
  const stages=await Promise.all(["queued","running","later"].map(id=>store.activityHandoffs.command({kind:"read_stage",requestId:`${id}:work:observe`})));
  await writeFile(join(directory,`${phase}.json`),JSON.stringify({phase,generation:store.generation,entered,maximumPhysical,
    attempts:stages.map(s=>s.attemptCount),states:stages.map(s=>s.status),failures:failures.length}));
  assert.equal(failures.length,0);
}
app.whenReady().then(main).then(async()=>{await service?.close();await transport?.close();await provider?.close();await store?.close();app.exit(0);}).catch(async error=>{
  await writeFile(join(directory,`failure-${phase}.txt`),require("node:util").inspect(error,{depth:8}));try{await service?.close(1000);await transport?.close();await provider?.close();await store?.close();}finally{app.exit(1);}
});
