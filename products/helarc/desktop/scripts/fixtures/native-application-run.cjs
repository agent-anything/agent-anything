const {app}=require("electron"),assert=require("node:assert/strict");
const fs=require("node:fs"),fsp=require("node:fs/promises"),{join,resolve,dirname,basename}=require("node:path");
const {pathToFileURL}=require("node:url"),{randomUUID}=require("node:crypto");
const [directory,phase,endpoint]=process.argv.slice(2);
const protocol=process.env.HELARC_VERIFICATION_PROTOCOL??"openai.responses";
const material=process.env.HELARC_VERIFICATION_MATERIAL==="true",materialCase=require("./native-application-material.cjs");
const ordinary=process.env.HELARC_VERIFICATION_ORDINARY==="true",ordinaryCase=require("./native-application-ordinary.cjs");
const standalone=process.env.HELARC_VERIFICATION_STANDALONE==="true",standaloneCase=require("./native-application-standalone.cjs");
const rejectRepair=process.env.HELARC_REJECT_PLAN_REPAIR==="1";
const beforeUse=process.env.HELARC_VERIFICATION_BEFORE_USE,beforeCase=require("./native-application-before-use.cjs");
const refusal=process.env.HELARC_VERIFICATION_INPUT_REFUSAL==="1";
const stop=process.env.HELARC_VERIFICATION_STOP==="1",stopCase=require("./native-application-stop.cjs");
const siblings=process.env.HELARC_VERIFICATION_SIBLINGS==="1",siblingsCase=require("./native-application-siblings.cjs");
const target=resolve(fs.realpathSync.native(directory),"workspace","once.txt").toLowerCase(),open=fsp.open;
fsp.open=async function(path,flags,...rest){
  if(typeof path==="string"&&["wx+","r+"].includes(flags)&&basename(path).toLowerCase()==="once.txt"&&
    resolve(fs.realpathSync.native(dirname(path)),basename(path)).toLowerCase()===target)
    fs.appendFileSync(join(directory,"physical-write-attempts.ndjson"),JSON.stringify({phase,pid:process.pid,flags})+"\n");
  return open.call(this,path,flags,...rest);
};
require("node:module").syncBuiltinESMExports();
app.setPath("userData",join(directory,"electron"));app.disableHardwareAcceleration();
let store,host,inspection,services,diagnostics,failure;
const rootPrompt=siblings?siblingsCase.rootPrompt:beforeUse?beforeCase.rootPrompt:material?materialCase.rootPrompt:standalone?standaloneCase.rootPrompt:ordinary||refusal?"HOST_ROOT: Write once.txt with the text ORIGINAL. Delegate HOST_CHILD to report calibration result 7391, the number of repeated observations, uncertainty and changes. Report its findings.":"HOST_ROOT: Write once.txt with the text ORIGINAL. Then delegate HOST_CHILD to report 7391. Report its answer. No other work.";
const followupPrompt=material?materialCase.followupPrompt:"HOST_FOLLOWUP: Report the prior result without executing the old calls again.";
const approved=new Set();
async function approve(snapshot){
  for(const pending of snapshot.run?.host.pendingInteractions??[]){
    if(approved.has(pending.request.id))continue;
    const request=pending.presentation,option=request.decisionOptions?.find(o=>o.kind==="accept"||o.kind==="grantPermissions");
    assert(option,`Unexpected interaction ${pending.request.protocol.kind}`);approved.add(pending.request.id);
    const id=`fixture-approval:${pending.request.id}`,payload={submissionId:id,runId:request.runId,requestId:request.id,
      pendingVersion:pending.request.requestVersion,optionId:option.id,
      grantedPermissions:option.kind==="grantPermissions"&&request.category==="permissions"?request.payload.permissions:null,reason:null};
    const receipt=await services.controller.dispatchHostCommand({version:1,commandId:id,runId:request.runId,kind:"interaction.submit",
      payload:{request:pending.request,submissionId:id,payload}},"interaction.submit");assert.equal(receipt.status,"handled");
  }
}
async function settled(){
  const deadline=Date.now()+80000;
  for(;;){
    if(failure)throw failure;
    const snapshot=services.controller.getSnapshot();
    await approve(snapshot);
    if(snapshot.execution==="idle"){
      if(rejectRepair&&phase==="resume")assert.equal(snapshot.error?.code,"model_request_input_preparation_failed");
      else assert(!snapshot.error,JSON.stringify(snapshot.error));
      return snapshot;
    }
    assert(Date.now()<deadline,`Application did not settle: ${snapshot.status}`);
    await new Promise(r=>setTimeout(r,20));
  }
}
async function main(){
  if(process.env.HELARC_P05_LIFETIME==="takeover"){
    const cipher=require("electron").safeStorage,path=join(directory,"profile-canary.bin");
    if(phase==="lifetime-profile"){await fsp.writeFile(path,cipher.encryptString("p05-profile"));return;}
    assert.equal(cipher.decryptString(await fsp.readFile(path)),"p05-profile","original test profile must be shared");
  }
  const load=name=>import(pathToFileURL(join(__dirname,"../../dist/main",name)));
  const childCredentials=process.env.HELARC_P05_LIFETIME==="child"
    ?await require("./native-child-delivery-evidence.cjs").watchCredentials(directory,phase,load):null;
  const retirement=["retire","integrity","connection-retire","connection-integrity"].includes(process.env.HELARC_P05_LIFETIME)?require("./native-application-retirement.cjs"):null;
  const {HelarcExecutionStore}=await load("execution-storage/HelarcExecutionStore.js"),{HelarcInspection}=await load("inspection/HelarcInspection.js");
  const {ElectronSafeStorageCredentialCipher}=await load("provider/ElectronSafeStorageCredentialCipher.js");
  const {createHelarcActivityHost}=await load("context/HelarcActivityHost.js");
  const {createHelarcApplicationServices}=await load("HelarcApplicationServices.js");
  const {HelarcExecutionDiagnostics}=await load("diagnostics/HelarcExecutionDiagnostics.js");
  const {defaultProviderDraft,providerCapacityTarget,providerCompactionTarget}=await load("../shared/ProviderConfiguration.js");
  if(stop)await stopCase.configure(load,directory,phase==="stop-seed");
  inspection=await HelarcInspection.create(join(directory,"inspection-settings.json"),join(directory,"inspection"));assert(inspection.recorder);
  diagnostics=new HelarcExecutionDiagnostics(join(directory,`${phase}-diagnostics.json`),inspection.performanceObserver);
  store=await HelarcExecutionStore.open(join(directory,"execution"),undefined,inspection.evidenceObserver,inspection.fileMaterialObserver,diagnostics,
    new ElectronSafeStorageCredentialCipher(),inspection.contextMaterialObserver,inspection.activityObserver,inspection.contextFoundationObserver,inspection.protocolObserver);
  inspection.protocolObserver.bindContentReader(store.protocolJournal);
  const custodyPass=process.env.HELARC_VERIFICATION_PENDING_ONLY==="1"?
    await require("./native-application-retirement.cjs").observeOpenHandoff(store,load):null;
  const retirementCut=phase==="lifetime-recover"&&process.env.HELARC_P05_LIFETIME==="remote"&&process.env.HELARC_VERIFICATION_RETIREMENT_CUT==="1"?
    require("./native-application-retirement.cjs").beforeRelease(store,JSON.parse(fs.readFileSync(join(directory,"cut.json"))).activity):null;
  if(retirement)await retirement.install({directory,store,phase,load,inspection,app});
  host=createHelarcActivityHost(store,{diagnostics,report:async cycle=>{
    failure??=cycle.failures[0]?.error??cycle.runs.flatMap(x=>x.result.failures)[0]?.error??cycle.reconsiderations.flatMap(x=>x.result.failures)[0]?.error;
  }});
  services=await createHelarcApplicationServices({userDataPath:directory,inspection,executions:store,activityHost:host,diagnostics,
    ...(phase==="gate"?{}:{nativeExecutionEligibility:c=>c.protocol===protocol&&c.baseUrl===endpoint&&c.model==="controlled"?
      {available:true,reason:null}:{available:false,reason:"outside_controlled_application_scope"}})});
  const workspace=join(directory,"workspace");await fsp.mkdir(workspace,{recursive:true});
  const controller=services.controller;controller.selectWorkspacePath(workspace);
  if(retirement)return retirement.inspect({directory,store,phase,inspection});
  const api=services.providerConfigurations,manifest=join(directory,"application-provider.json");
  let original;
  if(phase==="gate"||phase==="start"&&process.env.HELARC_WORK_ATTRIBUTION==="1"||phase==="refusal-seed"||phase==="siblings-seed"||phase==="stop-seed"||phase==="child-cancel-entry"||phase==="lifetime-seed"){
    const draft=defaultProviderDraft(protocol);
    let configured={...draft,name:"Controlled application",model:"controlled",baseUrl:endpoint,
      native:protocol==="openai.responses"?{...draft.native,transport:"http",stream:false,store:false,background:false,continuity:"replay",...(beforeUse||refusal||siblings?{allowInRequestCompaction:!refusal}:{})}:draft.native};
    if(phase==="lifetime-seed"&&process.env.HELARC_P05_LIFETIME==="remote")configured.native={...configured.native,store:true,background:true,allowTemporaryRetention:true};
    if(beforeUse)configured=beforeCase.configure(configured,beforeUse,providerCompactionTarget(configured),(await import("@agent-anything/helarc/configuration")).HELARC_COMPACTION_PRESERVATION);
    if(siblings){
      configured=beforeCase.configure(configured,"allow",providerCompactionTarget(configured),(await import("@agent-anything/helarc/configuration")).HELARC_COMPACTION_PRESERVATION);
      configured.inRequestCompaction.trigger={...configured.inRequestCompaction.trigger,windowTokens:siblingsCase.capacity,thresholdTokens:siblingsCase.threshold};
    }
    const saved=await api.save({configurationId:`provider-${randomUUID()}`,updateId:randomUUID(),expectedRevision:null,
      draft:ordinary||standalone||beforeUse||refusal||stop||siblings?{...configured,capacityDeclaration:{target:providerCapacityTarget(configured),sharedTokens:siblings?siblingsCase.capacity:refusal||stop?32768:beforeUse?beforeCase.capacity:standalone?standaloneCase.capacity:ordinaryCase.capacity,
        basis:"controlled_full_input_utf8_v1",validUntil:new Date(Date.now()+60*60*1000).toISOString()}}:configured,
      credential:protocol==="ollama.chat"?{kind:"none"}:{kind:"set",storage:"safe-storage",secret:"synthetic"}});
    assert(saved.ok,JSON.stringify(saved));original=saved.value.configuration;
    await fsp.writeFile(manifest,JSON.stringify(original));
    if(phase==="lifetime-seed"){
      const selected={id:original.id,revision:original.revision};assert((await api.activate(selected)).ok);
      childCredentials?.work();
      return require("./native-application-lifetime.cjs").seed({directory,services,selected,store,inspection,app,settled,custodyPass});
    }
    if(phase==="child-cancel-entry"){
      const selected={id:original.id,revision:original.revision};assert((await api.activate(selected)).ok);
      return require("./native-application-child-cancel.cjs").seed({directory,services,selected,store,app,inspection});
    }
    if(phase==="siblings-seed"){
      const selected={id:original.id,revision:original.revision};assert((await api.activate(selected)).ok);
      siblingsCase.interrupt(store,app,directory);
      const started=await services.startProtocolRun({taskText:rootPrompt,target:{kind:"new_thread"}},selected);
      assert(started.ok,JSON.stringify(started.error));await settled();throw Error("No accepted Parent input after material read");
    }
    if(phase==="stop-seed"){
      const selected={id:original.id,revision:original.revision};assert((await api.activate(selected)).ok);
      stopCase.interrupt(store,app,directory);
      const started=await services.startProtocolRun({taskText:rootPrompt,target:{kind:"new_thread"}},selected);
      assert(started.ok,JSON.stringify(started.error));await settled();throw Error("Application finished without reaching Child Stop generation");
    }
    if(phase==="refusal-seed"){
      const selected={id:original.id,revision:original.revision};
      assert((await api.activate(selected)).ok);
      const accept=store.sharedAcceptance.accept.bind(store.sharedAcceptance);
      store.sharedAcceptance.accept=async proposal=>{
        const receipt=await accept(proposal),part=proposal.parts.find(p=>p.owner==="protocol_execution"&&p.kind==="input_refusal");
        if(receipt.outcome==="accepted"&&part){
          const admission=await store.readProductRun(proposal.scope);assert.equal(admission.rootRunId,proposal.scope);
          await fsp.writeFile(join(directory,"root.json"),JSON.stringify({root:proposal.scope,threadId:admission.sessionId}));
          await fsp.writeFile(join(directory,"refusal-seed.json"),JSON.stringify({pid:process.pid,generation:store.generation,electron:process.versions.electron,
            acceptance:proposal.id,proof:part.proposal.proof,evidence:part.proposal.evidence}));
          app.exit(73);return new Promise(()=>{});
        }
        return receipt;
      };
      const started=await services.startProtocolRun({taskText:rootPrompt,target:{kind:"new_thread"}},selected);
      assert(started.ok,JSON.stringify(started.error));await settled();throw Error("Application settled without committing the capacity refusal");
    }
    if(phase==="gate"){
      const selection={id:original.id,revision:original.revision};
      assert.deepEqual(await api.eligibility(selection),{ok:true,value:{available:false,reason:"provider_native_activation_pending"}});
      assert.equal((await api.activate(selection)).ok,false);
      await assert.rejects(services.startProtocolRun({taskText:rootPrompt,target:{kind:"new_thread"}},selection),/provider_arrangement_unavailable/);
      assert.deepEqual(await store.listProductRuns(),[]);
      await fsp.writeFile(join(directory,"gate.json"),JSON.stringify({pid:process.pid,defaultClosed:true,admissions:0}));return;
    }
  }
  if(phase==="lifetime-recover"||phase==="lifetime-observe"||phase==="lifetime-deliver"){
    const probe=require("./native-application-lifetime.cjs");
    const input={directory,services,store,inspection,settled,phase,app,retirementCut};
    if(childCredentials)await probe.resumeChild({...input,childCredentials});
    else if(process.env.HELARC_P05_LIFETIME==="preadopt")await probe.resumeAdoption(input);
    else if(process.env.HELARC_P05_LIFETIME==="unknown")await probe.resumeUnknown(input);
    else if(process.env.HELARC_P05_LIFETIME==="remote")await probe.resumeRemote(input);else await probe.recover(input);
    return;
  }
  if(phase==="child-cancel-resume"){
    await require("./native-application-child-cancel.cjs").resume({directory,services,store,inspection,settled});
    services=null;return;
  }
  original=JSON.parse(await fsp.readFile(manifest,"utf8"));
  const originalDraft={protocol:original.protocol,name:original.name,model:original.model,baseUrl:original.baseUrl,
    generationLifetimeMs:original.generationLifetimeMs,native:original.native,observation:original.observation};
  const selection={id:original.id,revision:original.revision};
  if(phase==="start"){
    assert.equal((await api.activate(selection)).ok,true);
    const commit=store.commitRunTree.bind(store);
    store.commitRunTree=async value=>{
      const receipt=await commit(value);
      const written=value.runs.find(r=>r.state.items.some(i=>i.payload.kind==="model_call_settlement"&&/^Write(?:_|$)/.test(i.payload.result.name)&&i.payload.result.settlement==="succeeded"));
      if(written){
        const admission=await store.readProductRun(written.state.run.id);assert.equal(admission.version,4);
        await fsp.writeFile(join(directory,"root.json"),JSON.stringify({root:admission.rootRunId,threadId:admission.sessionId}));
        if(process.env.HELARC_WORK_ATTRIBUTION==="1"){
          const drain=await inspection.flushRecording();
          assert.equal(drain.native,"settled");
          assert.equal(inspection.recorder.health().rejected,0,"Work diagnostics must pass the regular Inspector inlet");
          await fsp.writeFile(join(directory,"work-first-recording.json"),JSON.stringify(inspection.recorder.ref("runtime","run",admission.rootRunId,admission.rootRunId)));
        }
        await fsp.writeFile(join(directory,"start.json"),JSON.stringify({pid:process.pid,generation:store.generation,checkpoint:value.id,
          productRunId:admission.productRunId,taskId:admission.task.id,threadId:admission.sessionId,root:admission.rootRunId,connection:admission.model.connection}));
        app.exit(73);return new Promise(()=>{});
      }return receipt;
    };
    const started=await services.startProtocolRun({taskText:rootPrompt,target:{kind:"new_thread"}},selection);
    assert(started.ok,JSON.stringify(started.error));await settled();throw new Error("Expected post-Write checkpoint interruption");
  }
  const {root,threadId}=JSON.parse(await fsp.readFile(join(directory,"root.json"),"utf8"));
  if(phase==="resume"||phase==="ordinary-selected"||phase==="before-selected"||phase.startsWith("compact-")||phase.startsWith("report-")){
    if(!fs.existsSync(join(directory,"report-before.json"))&&!fs.existsSync(join(directory,"ordinary-selected.json"))&&!fs.existsSync(join(directory,"compact-observed.json"))&&!fs.existsSync(join(directory,"before-selected.json"))){
      const changed=await api.save({configurationId:original.id,updateId:randomUUID(),expectedRevision:original.revision,
      draft:{...originalDraft,name:"Changed current configuration",model:"wrong-model"},credential:{kind:"keep"}});
      assert(changed.ok,JSON.stringify(changed));
    }
    if(phase==="ordinary-selected"||phase==="before-selected"||phase.startsWith("compact-")){
      const accept=store.sharedAcceptance.accept.bind(store.sharedAcceptance);
      store.sharedAcceptance.accept=async proposal=>{
        const receipt=await accept(proposal);
        if(phase==="compact-observed"&&receipt.outcome==="accepted"&&proposal.parts.some(p=>p.kind==="evidence"&&
          p.proposal.evidence.metadata.status==="observed"&&p.proposal.evidence.activityId?.endsWith(":native-compact"))){
          await fsp.writeFile(join(directory,phase+".json"),JSON.stringify({pid:process.pid,generation:store.generation,acceptance:proposal.id}));
          app.exit(73);return new Promise(()=>{});
        }
        const input=proposal.parts.find(p=>p.owner==="context_selection"&&p.kind==="selection_input")?.proposal.input;
        const match=phase==="before-selected"?input?.exactInput.compactionAgreement:phase==="ordinary-selected"?input?.exactInput.resultPresentations?.length:phase==="compact-selected"&&
          input&&JSON.parse(input.exactInput.wire.body).input.some(i=>i.type==="compaction");
        if(receipt.outcome==="accepted"&&proposal.scope===root&&match&&
          proposal.parts.some(p=>p.owner==="context_input_supply"&&p.kind==="native_input_return")){
          await fsp.writeFile(join(directory,phase+".json"),JSON.stringify({pid:process.pid,generation:store.generation,
            acceptance:proposal.id,wire:input.exactInput.wire.digest,inputId:input.id,
            ...(standalone||beforeUse?{bytesSha256:require("node:crypto").createHash("sha256").update(input.exactInput.wire.body).digest("hex")}:{ }),
            ...(beforeUse?{agreementId:match.id,eligibilityId:match.useEvidence.id,adoptedBody:input.exactInput.wire.body}:{})}));
          app.exit(73);return new Promise(()=>{});
        }
        return receipt;
      };
    }
    if(phase.startsWith("report-")){
      const accept=store.sharedAcceptance.accept.bind(store.sharedAcceptance);
      store.sharedAcceptance.accept=async proposal=>{
        const evidence=proposal.parts.find(p=>p.kind==="fact_publication"&&p.proposal.ref.kind==="accepted_report_capture");
        const grant=proposal.parts.find(p=>p.owner==="report_recipient"&&p.kind==="require_open");
        const interrupt=async()=>{
          await fsp.writeFile(join(directory,phase+".json"),JSON.stringify({pid:process.pid,generation:store.generation,acceptance:proposal.id}));
          app.exit(73);return new Promise(()=>{});
        };
        if(phase==="report-captured"&&grant)return interrupt();
        const saved=await accept(proposal);
        if(saved.outcome==="accepted"&&(phase==="report-before"&&evidence||phase==="report-granted"&&grant))return interrupt();
        return saved;
      };
    }
    const retained=(await controller.listRecoverableWork()).find(w=>w.id===root);assert(retained);
    const resumed=await controller.recoverWork({id:retained.id,revision:retained.revision,intent:"continue"});assert(resumed.ok,resumed.message);
    await settled();
    assert.notEqual(phase,"before-selected","Parent finished without adopting a before-use agreement");
    assert.notEqual(phase,"ordinary-selected","Parent completed without accepting a prepared short result");
    assert(!phase.startsWith("compact-"),"Expected durable standalone boundary was not observed");
  }else{
    assert((await controller.openThread(threadId)).ok);
    if(phase==="followup"){
      const listing=await api.list();assert(listing.ok);
      const current=listing.value.configurations.find(c=>c.id===original.id);assert(current);
      const saved=await api.save({configurationId:original.id,updateId:randomUUID(),expectedRevision:current.revision,
        draft:{...originalDraft,name:"New task configuration"},credential:{kind:"keep"}});assert(saved.ok,JSON.stringify(saved));
      const selected={id:original.id,revision:saved.value.configuration.revision};assert((await api.activate(selected)).ok);
      const started=await services.startProtocolRun({taskText:followupPrompt,target:{kind:"continue_thread",threadId}},selected);
      assert(started.ok,JSON.stringify(started.error));await settled();
    }else if(phase==="identity-new"){
      const prior=(await store.listProductRuns()).map(e=>e.admission);
      assert.equal(prior.length,2);assert(prior.every(a=>a.sessionId===threadId));
      const seed=JSON.parse(await fsp.readFile(join(directory,"start.json"),"utf8")),first=prior.find(a=>a.rootRunId===seed.root);
      assert.equal(first.productRunId,seed.productRunId);assert.equal(first.task.id,seed.taskId);assert.equal(first.sessionId,seed.threadId);
      assert.deepEqual(first.model.connection,seed.connection);
      const listing=await api.list();assert(listing.ok);
      const cfg=listing.value.configurations.find(c=>c.id===original.id);assert(cfg);
      const started=await services.startProtocolRun({taskText:"IDENTITY_FRESH: Confirm 7391 with no other work.",target:{kind:"new_thread"}},{id:cfg.id,revision:cfg.revision});
      assert(started.ok,JSON.stringify(started.error));assert.notEqual(started.threadId,threadId);
      await settled();
      const admissions=(await store.listProductRuns()).map(e=>e.admission);
      for(const old of prior)assert.deepEqual(admissions.find(a=>a.rootRunId===old.rootRunId),old);
      for(const key of [a=>a.productRunId,a=>a.rootRunId,a=>a.task.id,a=>a.model.connection.pinId])assert.equal(new Set(admissions.map(key)).size,3);
      const added=admissions.find(a=>a.productRunId===started.productRunId);
      assert.equal(added.task.id,started.taskId);assert.equal(added.sessionId,started.threadId);
    }else assert.equal(phase,"followup-resume");
  }
  const entries=await store.listProductRuns();assert.equal(entries.length,phase==="identity-new"?3:phase==="resume"?1:2);
  assert(entries.every(e=>e.delivered&&e.terminal));assert.deepEqual(await controller.listRecoverableWork(),[]);
  const trees=await Promise.all(entries.map(e=>store.readRunTree(e.admission.rootRunId)));
  const rootTree=trees.find(t=>t.members.some(m=>m.head.state.run.id===root));assert.equal(rootTree.members.length,material?3:2);
  const parentState=rootTree.members.find(m=>m.head.state.run.id===root).head.state;
  assert(trees.every(t=>t.members.every(m=>m.head.state.status===(rejectRepair&&m.head.state.run.id===root?"failed":"completed"))));
  if(rejectRepair){
    const cause=parentState.settlementCause.failure;
    assert.equal(cause.kind,"input_preparation");assert.equal(cause.failure.code,"model_request_input_preparation_failed");
    assert.deepEqual(controller.getSnapshot().error,{code:cause.failure.code,message:cause.failure.message});
    assert.match(cause.failure.message,/assessment plan could not establish/i);assert.equal(parentState.finalOutput,null);
  }
  const writes=trees.flatMap(t=>t.members.flatMap(m=>m.head.state.items)).filter(i=>i.payload.kind==="model_call_settlement"&&/^Write(?:_|$)/.test(i.payload.result.name));assert.equal(writes.length,1);
  assert.equal(await fsp.readFile(join(directory,"workspace","once.txt"),"utf8"),"ORIGINAL");
  assert.equal(entries.find(e=>e.admission.rootRunId===root).admission.model.configuration.revision,original.revision);
  if(stop){
    const parent=rootTree.members.find(m=>m.head.state.run.id===root),child=rootTree.members.find(m=>m!==parent);
    assert.equal(child.head.state.finalOutput.summary,"Child result 7391");assert.equal(parent.head.state.finalOutput.summary,"Root received 7391");
    assert.equal(parent.head.control.descendantTransfers.filter(t=>t.childRunId===child.head.state.run.id&&t.narrative?.text==="Child result 7391").length,1);
  }
  if(beforeUse==="allow"){
    const listing=await api.list();assert(listing.ok);
    assert.equal(listing.value.configurations.find(v=>v.id===original.id)?.model,"wrong-model");
    const binding=entries.find(e=>e.admission.rootRunId===root).admission.contextBinding;
    assert.equal(binding.revision,"3");
    assert.deepEqual(binding.purposes.filter(p=>p.ref.id==="helarc.responses-in-request-reception").map(p=>p.ref.revision),["1","2"]);
  }
  for(let i=0;i<trees.length;i++){
    const rootState=trees[i].members.find(m=>m.head.state.run.id===entries[i].admission.rootRunId).head.state;
    if(!rejectRepair)assert(JSON.stringify(rootState.finalOutput).includes("7391"));
    if(material)assert(rootState.finalOutput.summary.includes("6843"));
  }
  if(material){
    const parent=rootTree.members.find(m=>m.head.state.run.id===root).head.state;
    const children=rootTree.members.filter(m=>m.head.state.run.id!==root);
    assert(children.some(m=>m.head.state.finalOutput.summary===materialCase.report));
    const outcomes=parent.items.filter(i=>i.payload.kind==="model_call_settlement").map(i=>i.payload.result.content);
    const reference=outcomes.find(o=>o?.output?.report)?.output.report.reference;assert(reference);
    const {createHelarcMaterialAccess}=await load("context/HelarcMaterialAccess.js");
    const access=createHelarcMaterialAccess(store),signal=new AbortController().signal;
    const page=await access.read(root,{reference,length:128},signal,"verification-original-detail");assert(page.text.includes("8422"));
    const sibling=children.find(m=>m.head.state.finalOutput.summary==="Child result 7391");assert(sibling);
    await assert.rejects(()=>access.read(sibling.head.state.run.id,{reference,length:128},signal,"forbidden-sibling"));
    const {helarcReportDeliveryRef}=await load("context/HelarcNativeReportDelivery.js");
    const {HELARC_CONTROLLER_CAPABILITY}=await import("@agent-anything/helarc/controller");
    const {modelInputValueDigest:digest}=await import("@agent-anything/model-interaction/input");
    const transfer=rootTree.members.find(m=>m.head.state.run.id===root).head.control.descendantTransfers.find(t=>t.narrative?.text===materialCase.report);
    assert(transfer);const sender=children.find(m=>m.head.state.run.id===transfer.childRunId).head.state;
    const path=transfer.narrative.source.recordId+":publication:"+digest({runId:sender.run.id,recipient:sender.activeAgent.id,purpose:HELARC_CONTROLLER_CAPABILITY});
    const capture=await store.activityHandoffs.command({kind:"read_path",pathId:path});
    assert.equal(capture.dispatchedAttempts,1);assert.equal(capture.progress.version.digest,transfer.narrative.source.digest);
    const authority=await store.activityHandoffs.command({kind:"read_fact",id:path+":capture-authority"});
    assert.deepEqual(authority.handoff.result,transfer.result.ref);assert.equal(authority.handoff.parent.runId,root);
    assert.equal((await store.sharedAcceptance.query(authority.ref.id)).outcome,"accepted");
    const ref=helarcReportDeliveryRef(reference,{runId:root,recipient:parent.activeAgent.id,purpose:HELARC_CONTROLLER_CAPABILITY});
    const obligation=await store.materialDeliveries.query({kind:"obligation",ref});assert(obligation);
    assert.equal(obligation.discharged.length,1);assert.equal(obligation.protection.inFlight,"none");
    const facts=await store.materialDeliveryFacts(root,0,128);
    assert.equal(facts.filter(f=>f.kind==="material_delivery.evidence"&&f.value.kind==="receipt").length,1);
    if(siblings){
      const seed=JSON.parse(await fsp.readFile(join(directory,"siblings-seed.json"),"utf8"));
      assert.equal((await store.sharedAcceptance.query(seed.acceptance)).outcome,"accepted");
      assert.equal(seed.alpha,sibling.head.state.run.id);assert.equal(seed.beta,sender.run.id);
      assert.equal(sibling.head.state.items.filter(i=>i.payload.kind==="model_call_settlement"&&/^Read_/.test(i.payload.result.name)).length,1);
      await fsp.writeFile(join(directory,"siblings-delivery.json"),JSON.stringify({reference,capture:path,authority:authority.ref,
        receipt:facts.find(f=>f.kind==="material_delivery.evidence"&&f.value.kind==="receipt").sequence,obligation:ref}));
    }
  }
  if(ordinary||standalone||beforeUse||refusal){
    const child=rootTree.members.find(m=>m.head.state.run.id!==root);
    assert.equal(child.head.state.finalOutput.summary,ordinaryCase.report);
    const parent=rootTree.members.find(m=>m.head.state.run.id===root);
    assert.equal(parent.head.control.descendantTransfers.filter(t=>t.childRunId===child.head.state.run.id&&t.narrative?.text===ordinaryCase.report).length,1);
    for(const file of refusal?["refusal-seed"]:beforeUse?(beforeUse==="allow"?["before-selected"]:[]):rejectRepair?["compact-observed"]:standalone?["compact-observed","compact-selected"]:["ordinary-selected"]){
      const accepted=JSON.parse(await fsp.readFile(join(directory,file+".json"),"utf8"));
      assert.equal((await store.sharedAcceptance.query(accepted.acceptance)).outcome,"accepted");
    }
  }
  await services.close();services=null;
  if(stop){
    // Normal close bounds telemetry work; this audit also requires the derived view.
    const drain=await inspection.flushRecording(),progress=inspection.recorder.health().coverage.recording.lastFlush;
    await fsp.writeFile(join(directory,"stop-projection-barrier.json"),JSON.stringify({drain,progress}));
    assert.equal(drain.native,"settled");assert.equal(drain.projection,"settled");
    assert.equal(drain.code,null);assert(progress.projectionCursor>=progress.nativeTarget);
  }
  const flushed=await inspection.flushRecording(true);assert.equal(flushed.native,"settled");assert.equal(inspection.recorder.health().dropped,0);
  if(process.env.HELARC_WORK_ATTRIBUTION==="1"||rejectRepair)assert.equal(inspection.recorder.health().rejected,0);
  if(beforeUse==="allow"){
    const coverage=inspection.recorder.health().coverage.recording;
    assert.deepEqual(coverage.ingress.history,{started:2,confirmed:2,incomplete:0});
    assert.equal(coverage.native.rejected,0);assert.equal(coverage.ingress.rejected,0);
    assert.equal(flushed.unpersisted,0);assert.equal(flushed.unconfirmed,0);
  }
  await fsp.writeFile(join(directory,`${phase}.json`),JSON.stringify({pid:process.pid,generation:store.generation,electron:process.versions.electron,
    application:true,protocol,delivered:entries.length,runs:trees.reduce((n,t)=>n+t.members.length,0),writes:writes.length,inspection:flushed,
    ...(rejectRepair?{terminal:parentState.settlementCause.failure.failure.message}:{}),
    ...(ordinary||standalone||beforeUse||refusal||siblings||stop?{recording:inspection.recorder.ref("runtime","run",root,root)}:{})}));
}
async function close(){
  const status=await host?.service.close();if(status)assert(status.localExecutionsFinished);
  await services?.close();await inspection?.close();await store?.close();await diagnostics?.flush();
}
app.whenReady().then(main).then(close).then(()=>app.exit(0)).catch(async error=>{
  const {captureExecutionError}=await import(pathToFileURL(join(__dirname,"../../dist/main/diagnostics/ExecutionErrorDetails.js")));
  await fsp.writeFile(join(directory,`failure-${phase}.json`),JSON.stringify(captureExecutionError(error),null,2));
  await fsp.writeFile(join(directory,`failure-${phase}.txt`),error.stack??String(error));
  try{await close();}catch(cleanup){await fsp.writeFile(join(directory,`cleanup-${phase}.txt`),cleanup.stack??String(cleanup));}app.exit(1);
});
