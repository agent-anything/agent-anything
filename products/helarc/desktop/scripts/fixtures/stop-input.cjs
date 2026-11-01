const {app}=require("electron"),assert=require("node:assert/strict"),{join}=require("node:path"),{pathToFileURL}=require("node:url");
const {readFile,writeFile}=require("node:fs/promises");
const [directory,phase,endpoint]=process.argv.slice(2),large=!!process.env.ACTIVITY_STOP_LONG;
const cancelled=!!process.env.ACTIVITY_STOP_CANCEL;
const retrying=!!process.env.ACTIVITY_STOP_RETRY;
const inputRejection=!!process.env.ACTIVITY_STOP_REJECTION;
app.setPath("userData",join(directory,"electron"));app.disableHardwareAcceleration();
let store,service,inspection,queries;
async function main(){
  await app.whenReady();const load=path=>import(pathToFileURL(join(__dirname,"../../dist/main",path)));
  const {HelarcExecutionStore}=await load("execution-storage/HelarcExecutionStore.js"),{HelarcActivityService}=await load("context/HelarcActivityService.js");
  const {createHelarcStopPreparation}=await load("context/HelarcStopPreparation.js"),{bindHelarcMethodInputSupply}=await load("context/HelarcMethodInputSupply.js");
  const {bindHelarcContextSettings}=await load("context/HelarcContextRunBinding.js");
  const {createHelarcProviderProfile,createDefaultHelarcContextSettings}=await import("@agent-anything/helarc/configuration");
  const {OllamaProvider}=await import("@agent-anything/provider-integrations/ollama");
  const provider=new OllamaProvider({model:"controlled",baseUrl:endpoint,timeoutMs:60000,think:false,runtime:{contextWindowTokens:32768},
    nativeToolInteraction:{supported:true},requestBodyTransportLimit:{maximumBytes:inputRejection?500000:65000,source:"host_configured",revision:"1"}});
  const profile=createHelarcProviderProfile({id:"isolated",providerKind:"ollama",displayName:"Isolated",baseUrl:endpoint,model:"controlled",timeoutMs:60000,
    ollamaRuntime:{contextWindowTokens:32768},credentialStatus:"empty_allowed"});assert(profile.ok);
  const context=bindHelarcContextSettings(createDefaultHelarcContextSettings(),profile.profile);
  const {ActivityPurposeRegistry}=await import("@agent-anything/agent-runtime/activity"),runtime=await import("@agent-anything/agent-runtime/context-representation");
  const stop=await import("@agent-anything/helarc/task-fulfillment");
  let event;
  if(phase==="start") {
    const built=await require("./task-input-source.cjs")(provider),{createAgentStopEvent}=await import("@agent-anything/agent-hooks/events");
    const source={...built.source,interaction:{...built.source.interaction,messages:[{role:"assistant",content:[{kind:"text",
      text:"TARGET: 7391. The version is unverified; no files changed.\n"+"Read-only investigation found no changes.\n".repeat(large?1900:1)}]}]}};
    event=createAgentStopEvent({sequence:1,runKind:"root",controllerInput:source,output:{summary:"TARGET: 7391; version unverified."},emittedAt:new Date().toISOString()});
    await writeFile(join(directory,"event.json"),JSON.stringify(event));
  } else event=JSON.parse(await readFile(join(directory,"event.json"),"utf8"));
  const pathId=`${event.ref.id}:stop-work`;
  store=await HelarcExecutionStore.open(join(directory,"execution"));const a=c=>store.activityHandoffs.command(c),now=()=>new Date().toISOString(),registry=new ActivityPurposeRegistry();
  const authorize=async path=>{assert.equal(path.intent.permissionBasis,"isolated");return {kind:"allowed"};};
  const publications=new runtime.SourceMaterialPublicationWork(store.activityHandoffs,registry,{materials:store.materialCustody,selections:store.contextSelections,authorize,now});
  const preparation=new runtime.ContextInputPreparationWork(store.activityHandoffs,registry,{provider,materials:store.materialCustody,authorize,now});
  const methods=new runtime.RepresentationMethodWork({provider,materials:store.materialCustody,representations:store.representations,selections:store.contextSelections,activities:store.activityHandoffs,authorize,now},registry);
  const reception=bindHelarcMethodInputSupply({store,registry,preparation,methods,authorize,now});
  const work=new stop.HelarcStopModelWork(registry,{provider,activities:store.activityHandoffs,selections:store.contextSelections,authorize,now});
  const lifecycle=new stop.HelarcStopLifecycle(store.activityHandoffs);
  const supply=createHelarcStopPreparation({provider,activities:store.activityHandoffs,responsibilities:store.inputSupplies,publications,preparation,authorize:async b=>{await authorize(b.consumer);},
    binding:async()=>({context,treeScopeId:"tree",modelPoolId:"model",localPoolId:"local",deliveryMode:"buffered"}),
    decisions:store.contextPolicy,selections:store.contextSelections,materials:store.materialCustody,methods,methodInputs:reception.supply,methodConsumers:reception.consumer});
  if(phase==="cancel") {
    const path=await a({kind:"read_path",pathId});await a({kind:"cancel",pathId,expectedControlRevision:path.controlRevision});
    await store.close();store=null;app.exit(73);return;
  }
  const purposes={resolve:(binding,scope)=>{
    const handler=registry.resolve(binding,scope);
    return {authorize:handler.authorize.bind(handler),execute:handler.execute.bind(handler),reconcile:handler.reconcile.bind(handler),settle:handler.settle.bind(handler),
      prepareRetry:handler.prepareRetry?.bind(handler),
      interpret:async(path,stage,...args)=>{
        if(phase==="generated"&&binding.contract.ref.id===methods.purpose.contract.ref.id&&stage.request.stageKind==="model"||
          phase==="materialize"&&binding.contract.ref.id==="context.input-materialization"&&stage.request.stageKind==="read"||
          phase==="sent"&&binding.contract.ref.id===work.purpose.contract.ref.id&&stage.request.stageKind==="model"){
          await writeFile(join(directory,`${phase}.json`),JSON.stringify({stageId:stage.request.id,attemptId:stage.attempt.id,resultId:stage.result.id}));
          app.exit(73);return new Promise(()=>{});
        }
        return handler.interpret(path,stage,...args);
      }};
  }};
  if(phase==="retry"||phase==="rejected") {
    const command=store.activityHandoffs.command.bind(store.activityHandoffs);
    store.activityHandoffs.command=async c=>{
      const result=await command(c);
      if(phase==="rejected"&&c.kind==="accept"&&c.receipt.progress.kind==="model_input_recovery") {
        assert.equal(result.status,"accepted");
        await writeFile(join(directory,"rejected.json"),JSON.stringify(c.receipt));app.exit(73);return new Promise(()=>{});
      }
      if(c.kind==="retry_attempt") {
        assert.equal(result.status,"admitted");assert.equal(result.attemptCount,1);assert.equal(result.attempt,null);
        const raw=await command({kind:"read_raw_result",resultId:c.receipt.resultId});assert.equal(raw.value.kind,"failed");
        const {modelInputValueDigest}=await import("@agent-anything/model-interaction/input");
        await assert.rejects(()=>command({kind:"dispatch",attempt:{id:`${result.request.id}:attempt:2`,requestId:result.request.id,
          executor:c.executor,inputDigest:modelInputValueDigest(result.request.input),startedAt:c.receipt.decidedAt},expectedControlRevision:c.expectedControlRevision}),/attempt_retry_waiting/);
        await writeFile(join(directory,"retry.json"),JSON.stringify({receipt:c.receipt,raw,inputDigest:modelInputValueDigest(result.request.input)}));
        app.exit(73);return new Promise(()=>{});
      }
      return result;
    };
  }
  if(phase==="start"||phase==="adopt"||phase==="rejected") {
    if(phase==="start")for(const [id,capacity] of [["model",1],["local",2]])await a({kind:"bind_resource_pool",pool:{id,capacity,revision:"1",authority:"isolated"}});
    const accept=store.sharedAcceptance.accept.bind(store.sharedAcceptance);
    store.sharedAcceptance.accept=async proposal=>{
      const result=await accept(proposal);
      if(result.outcome==="accepted"&&(phase==="start"&&proposal.id===`${pathId}:submission`||phase==="adopt"&&proposal.parts.some(p=>p.owner==="context_selection"&&p.kind==="selection_input")||
        phase==="rejected"&&proposal.parts.some(p=>p.owner==="activity"&&p.kind==="input_need"&&p.proposal.origin))) {
        await writeFile(join(directory,`${phase}.json`),JSON.stringify(result));app.exit(73);return new Promise(()=>{});
      }
      return result;
    };
  }
  const failures=[];
  service=new HelarcActivityService({store,purposes,purposeIds:[publications.purpose.contract.ref.id,preparation.purpose.contract.ref.id,methods.purpose.contract.ref.id,"context.input-materialization",work.purpose.contract.ref.id],rediscoveryMs:10,
    reconsideration:(owner,subscription)=>owner===work.purpose.contract.acceptanceOwner?lifecycle:owner==="material-source"?publications.deliveries:
      subscription.binding?.kind==="input_need"?supply:subscription.binding?.kind==="activity_path"?reception.consumer:null,
    report:async cycle=>{const found=[...cycle.failures,...cycle.runs.flatMap(r=>r.result.failures),...cycle.reconsiderations.flatMap(r=>[...r.result.failures,...r.result.rejected])];
      failures.push(...found);if(found.length){await writeFile(join(directory,"failures.json"),JSON.stringify(found,(_k,v)=>v instanceof Error?{name:v.name,message:v.message,stack:v.stack,cause:v.cause,...v}:v,2));controller.abort(new Error("Host activity failed"));}}});
  const execution=new stop.HelarcStopModelExecution({work,activities:store.activityHandoffs,acceptance:store.sharedAcceptance,rediscoveryMs:10,
    host:{assertAvailable:()=>service.assertAvailable(),subscribe:l=>store.onActivityChange(l),wake:()=>service.wake()},
    arrange:async(source,id)=>{assert.equal(phase,"start","Recovery must not arrange replacement work");return {
      identity:{id,runId:"root",permissionBasis:"isolated",resourceScope:id,scheduledWorkId:id,maximumStages:8,maximumAttempts:8,maximumConcurrent:1,deadlineAt:"2030-01-01T00:00:00.000Z"},
      schedule:{id:`${id}:schedule`,workId:id,runId:"root",scopeId:"tree",owner:work.purpose.contract.acceptanceOwner,reason:"necessary",decisionId:`${id}:submission`,policyRevision:"isolated:1",
        delayImpact:"Enabled Stop assessment",timing:{kind:"unknown"},allowedPathIds:[id],resources:[{capability:"model-request",poolId:"model",units:1}]}};}});
  const hook=new stop.HelarcTaskFulfillmentHook(provider,[{id:"stop",enabled:true,content:"Assess the supplied execution evidence and original completion candidate. Preserve uncertainty; do not execute any work."}],now,execution);
  const controller=new AbortController();let timedOut=false;
  if(cancelled&&phase==="finish") {
    await assert.rejects(()=>hook.recover(event,{signal:controller.signal,interruption:null}),/stop_original_work_cancelled/);
    const deadline=Date.now()+10000;
    while(!(await a({kind:"read_schedule",workId:pathId})).closed) {
      assert.equal(failures.length,0,JSON.stringify(failures));assert(Date.now()<deadline,"Cancelled Stop duty must settle independently");
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    const stage=await a({kind:"read_stage",requestId:`${pathId}:model`}),saved=JSON.parse(await readFile(join(directory,"sent.json"),"utf8"));
    assert.equal(stage.result.id,saved.resultId);assert.equal(stage.attempt.id,saved.attemptId);assert.equal(stage.status,"settled");
    assert.equal(stage.receipt,null);assert.equal(stage.settlement.disposition.assessmentAccepted,false);assert.equal(hook.getAssessments().length,0);
    await reportVerification({electron:process.versions.electron,totalProviderCalls:1,originalResultRetained:true,assessmentNotAccepted:true,independentWorkClosed:true});
    await service.close();service=null;await store.close();store=null;app.exit(0);return;
  }
  const timeout=setTimeout(()=>{timedOut=true;controller.abort();},90000);
  const decision=await (phase==="start"?hook.handle(event,{signal:controller.signal,interruption:null}):hook.recover(event,{signal:controller.signal,interruption:null})).finally(()=>clearTimeout(timeout));
  assert(!timedOut);assert.equal(phase,"finish");assert.deepEqual(decision,{disposition:"allow"});assert.equal(failures.length,0,JSON.stringify(failures));
  const {readCurrentModelInputNeed,readModelInputRejections}=await import("@agent-anything/agent-runtime/model-access");
  const path=await a({kind:"read_path",pathId}),need=await readCurrentModelInputNeed(store.activityHandoffs,path,`${pathId}:input-need`,`${pathId}:source`);
  const sourceStage=await a({kind:"read_stage",requestId:`${pathId}:source`}),final=await a({kind:"read_stage",requestId:need.stage.id});
  const saved=JSON.parse(await readFile(join(directory,"sent.json"),"utf8"));assert.equal(final.result.id,saved.resultId);assert.equal(final.attempt.id,saved.attemptId);
  const selected=await store.contextSelections.command({kind:"binding",inputId:`${final.request.id}:input`,checkCurrentControl:true});
  assert.deepEqual(selected.input.exactInput.request.instructions,sourceStage.request.input.request.instructions);
  assert.deepEqual(selected.input.exactInput.request.interaction,sourceStage.request.input.request.interaction);
  assert.equal(selected.scope.purpose,"helarc.task-fulfillment");assert.equal(selected.scope.recipient,"helarc-stop");
  const {modelInputValueDigest}=await import("@agent-anything/model-interaction/input");
  assert.equal(selected.input.exactInput.encoded.body.includes("TARGET"),true);
  assert.equal(final.receipt.progress.kind,"helarc_stop_model_result");assert.equal(final.receipt.progress.assessment.id,hook.getAssessments()[0].id);
  const again=await hook.recover(event,{signal:controller.signal,interruption:null});assert.deepEqual(again,decision);assert.equal(hook.getAssessments().length,1);
  const closureDeadline=Date.now()+10000;
  while(!(await a({kind:"read_schedule",workId:pathId})).closed) {
    assert(Date.now()<closureDeadline,"Stop work must close independently");await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.equal((await a({kind:"read_reconsideration",subscriptionId:`${pathId}:stop-lifecycle`,limit:1})).state.closed,true);
  const facts=[];for(let after=0;;){const page=await a({kind:"facts",runId:"root",after,limit:256});facts.push(...page);if(page.length<256)break;after=page.at(-1).sequence;}
  const stages=await Promise.all([...new Set(facts.map(f=>f.requestId).filter(Boolean))].map(id=>a({kind:"read_stage",requestId:id})));
  const totalProviderCalls=stages.filter(s=>s?.request.stageKind==="model").reduce((n,s)=>n+(s.attemptCount??0),0);
  if(retrying) {
    const original=JSON.parse(await readFile(join(directory,"retry.json"),"utf8"));
    assert.equal(final.attemptCount,2);assert.equal(modelInputValueDigest(final.request.input),original.inputDigest);
    assert.deepEqual(await a({kind:"read_raw_result",resultId:original.raw.id}),original.raw);
    assert.deepEqual(final.retry,original.receipt);assert(Date.parse(final.attempt.startedAt)>=Date.parse(original.receipt.notBefore));
    assert.equal(facts.filter(f=>f.kind==="attempt_retry_accepted").length,1);
  }
  assert.equal(stages.filter(s=>s?.request.pathId===pathId&&s.request.stageKind==="model").length,inputRejection?2:1);
  if(inputRejection) {
    const rejections=await readModelInputRejections(store.activityHandoffs,path,need,sourceStage.request.id);assert.equal(rejections.length,1);
    const original=await a({kind:"read_stage",requestId:rejections[0].stageId});assert.equal(original.receipt.progress.kind,"model_input_recovery");
    assert.equal(original.request.pathId,final.request.pathId);assert.equal(original.result.value.failure.code,"provider_context_window_exceeded");
    assert.notEqual(original.request.input.encoded.bodyDigest,final.request.input.encoded.bodyDigest);
  }
  if(large){
    assert(selected.input.exactInput.demand.contributions.some(c=>c.options.find(o=>o.id===selected.input.exactInput.choice[c.id]).dataTextBindings?.length));
    const generated=JSON.parse(await readFile(join(directory,"generated.json"),"utf8")),original=stages.find(s=>s?.request.id===generated.stageId);
    assert.equal(original.result.id,generated.resultId);assert.equal(original.attempt.id,generated.attemptId);
  }
  else assert.equal(modelInputValueDigest(selected.input.exactInput.request.composition.sections),modelInputValueDigest(sourceStage.request.input.request.composition.sections));
  await reportVerification({electron:process.versions.electron,totalProviderCalls,stopOriginalResultResumed:true,
    originalRequestPreserved:true,separateConsumerPurpose:true,duplicateAssessmentAvoided:true,firstDataBodyRepresented:large,independentWorkClosed:true,
    capacityRecoveryInOriginalWork:inputRejection});
  await service.close();service=null;await store.close();store=null;app.exit(0);
}
async function reportVerification(report) {
  const {HelarcInspection}=await import(pathToFileURL(join(__dirname,"../../dist/main/inspection/HelarcInspection.js")));
  inspection=await HelarcInspection.create(join(directory,"inspection-settings.json"),join(directory,"inspection"));
  await inspection.activityObserver.replay("root",store.activityHandoffs);await inspection.contextFoundationObserver.replay("root",store.contextFoundationFacts.bind(store));
  const {InspectionQueryService}=await import("@agent-anything/inspection/query");queries=new InspectionQueryService(join(directory,"inspection"));
  const {selection}=await require("./inspection-settlement.cjs").settleInspection(inspection.recorder,queries);
  if(retrying) {
    const original=JSON.parse(await readFile(join(directory,"retry.json"),"utf8"));
    const detail=await queries.query({kind:"get_subject",...selection,subject:inspection.recorder.ref("activity","contribution",original.raw.id,"root")});
    const content=detail.records.flatMap(r=>r.contents).find(c=>c.name==="Original result and measured usage");assert(content);
    const page=await queries.query({kind:"get_content",...selection,contentId:content.id,length:65536});assert(page.content.text.includes("controlled original transport failure"));
    const retry=await queries.query({kind:"get_subject",...selection,subject:inspection.recorder.ref("activity-retry","contribution",original.receipt.id,"root")});
    assert(retry.records.some(r=>r.payload.executionKind==="technical_attempt_retry"));
  }
  const health=inspection.recorder.health();assert.equal(health.dropped,0);assert.equal(health.rejected,0);
  await writeFile(join(directory,"verification.json"),JSON.stringify({...report,inspection:{coverage:health.coverage,dropped:health.dropped,rejected:health.rejected}},null,2));
  await queries.close();queries=null;await inspection.close();inspection=null;
}
main().catch(async error=>{
  console.error(error.stack??error);await service?.close().catch(()=>{});
  if(store)try{
    const facts=[];for(let after=0;;){const page=await store.activityHandoffs.command({kind:"facts",runId:"root",after,limit:256});facts.push(...page);if(page.length<256)break;after=page.at(-1).sequence;}
    const paths=await Promise.all([...new Set(facts.map(f=>f.pathId).filter(Boolean))].map(pathId=>store.activityHandoffs.command({kind:"read_path",pathId})));
    await writeFile(join(directory,"failure-paths.json"),JSON.stringify(paths,null,2));
  }catch(diagnostic){console.error("Diagnostic failed",diagnostic);}
  await queries?.close().catch(()=>{});await inspection?.close().catch(()=>{});await store?.close().catch(()=>{});app.exit(1);
});
