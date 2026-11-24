const {app}=require("electron"),assert=require("node:assert/strict");
const {join}=require("node:path"),{pathToFileURL}=require("node:url"),{readFile,writeFile,appendFile}=require("node:fs/promises");
const [directory,phase,endpoint]=process.argv.slice(2);
app.setPath("userData",join(directory,"electron"));app.disableHardwareAcceleration();
let store,provider;
async function main(){
  const load=name=>import(pathToFileURL(join(__dirname,"../../dist/main",name)));
  const model=await import("@agent-anything/model-interaction/protocol"),runtime=await import("@agent-anything/agent-runtime/model-access");
  const native=await import("@agent-anything/provider-integrations/native"),h=await import("@agent-anything/helarc/controller");
  const {modelInputValueDigest:digest}=await import("@agent-anything/model-interaction/input");
  const {HelarcExecutionStore}=await load("execution-storage/HelarcExecutionStore.js");
  const {HelarcResponsesCompactConnection}=await load("provider/HelarcResponsesCompactConnection.js");
  store=await HelarcExecutionStore.open(join(directory,"execution"),pathToFileURL(join(__dirname,"native-input-accounting-worker.mjs")));
  provider=await require("./native-task-provider.cjs")(directory,phase,endpoint,load,"responses");
  const c=provider.configuration,ref=id=>({id,revision:"1"}),purpose=ref("compact");
  const composition=model.bindModelAgentComposition({agent:ref("agent"),protocol:model.OPENAI_RESPONSES,
    configuration:{configuration:{id:c.id,revision:c.revision},model:c.model,protocol:model.OPENAI_RESPONSES,connectionBinding:ref(c.connectionBindingId)},
    adapter:{implementation:native.OPENAI_RESPONSES_ADAPTER,protocol:model.OPENAI_RESPONSES},
    task:{purpose:ref("task"),input:{implementation:ref("task-input"),protocol:model.OPENAI_RESPONSES},interpreter:{implementation:h.HELARC_NATIVE_TASK_INTERPRETER,protocol:model.OPENAI_RESPONSES}},
    auxiliary:[{purpose,input:{implementation:ref("compact-input"),protocol:model.OPENAI_RESPONSES},interpreter:{implementation:h.HELARC_RESPONSES_COMPACT_INTERPRETER,protocol:model.OPENAI_RESPONSES}}]});
  const activity=id=>runtime.bindProtocolModelActivity({composition,scope:{runId:"root",activityId:id,recipientId:"compact-worker",purpose,compositionDigest:composition.digest},
    conditions:{input:ref("source"),authority:ref("disclosure"),resources:ref("allowance"),control:ref("control")}});
  const items=[{role:"user",content:"Keep the selected blue option and the completed command."}],task=native.prepareResponses({model:c.model,purpose:ref("task"),input:items,stream:false,store:false});
  const settings=native.nativeInputSettings(task.body),manifest=native.bindNativeInputManifest({protocol:model.OPENAI_RESPONSES,
    scope:{id:"root-task",runId:"root",recipientId:"task",purpose:ref("task"),compositionDigest:composition.digest},
    target:{model:c.model,configuration:`${c.id}:${c.revision}`,connection:c.connectionBindingId,disclosure:"disclosure"},
    selection:{id:"original",revision:"1",boundary:"delivered",judgments:["delivered-input"]},
    groups:[{id:"source",representation:ref("source"),sources:["original-delivery"],holds:["original-hold"],deliveries:[],requires:[],items,replay:"local"}],settings,
    settingSources:Object.keys(settings).map(field=>({field,source:"original-config",digest:digest(settings[field])}))});
  const duties=[{id:"blue",revision:"1",requirement:"semantic",permittedEvidence:["continuation_probe"]}];
  const source=h.bindHelarcResponsesCompactSource({manifest,throughGroups:1,receipts:[{groupId:"source",basis:"original-delivery"}],duties,purpose,ancestry:[],
    dependencies:{recipient:manifest.scope.id,target:manifest.target.configuration,authority:"disclosure",source:digest([{id:"source",digest:native.nativeInputGroupDigest(manifest.groups[0]),deliveredBasis:"original-delivery"}]),
      requirements:digest(duties),method:`${native.RESPONSES_COMPACT_METHOD.id}:${native.RESPONSES_COMPACT_METHOD.revision}`}});
  let network=0;const withConnection=provider.service.withConnection.bind(provider.service);
  provider.service.withConnection=async(...args)=>{network++;assert.equal(phase,"produce","Local recovery must not resolve credentials or dispatch");return withConnection(...args);};
  const connection=new HelarcResponsesCompactConnection(store,provider.service),signal=new AbortController().signal;
  const evidence=extra=>writeFile(join(directory,`${phase}.json`),JSON.stringify({phase,pid:process.pid,electron:process.versions.electron,generation:store.generation,network,...extra},null,2));
  const crash=async extra=>{await evidence(extra);app.exit(73);await new Promise(()=>{});};
  const mark=stage=>appendFile(join(directory,"stages.ndjson"),JSON.stringify({phase,stage,at:Date.now()})+"\n");
  const acceptance={query:id=>store.sharedAcceptance.query(id),accept:async proposal=>{
    const receipt=await store.sharedAcceptance.accept(proposal);
    if(receipt.outcome==="accepted"&&phase==="produce"&&proposal.parts.some(p=>p.kind==="evidence"&&p.proposal.evidence.metadata.status==="observed"))
      await crash({lostAcknowledgement:"complete compact observation"});
    if(receipt.outcome==="accepted"&&phase==="accept"&&proposal.parts.some(p=>p.owner==="protocol_execution"&&p.kind==="purpose"))
      await crash({lostAcknowledgement:"compact production acceptance"});
    return receipt;
  }};
  const ports={journal:store.protocolJournal,acceptance,generation:store.generation,
    authorize:async(request,action)=>{assert.equal(request.activity.scope.runId,"root");assert.equal(request.source.dependencies.authority,"disclosure");
      await connection.check(request);if(action==="dispatch")assert.equal(phase,"produce");},
    dispatch:(request,session,signal,authorize)=>connection.dispatch(request,session,signal,authorize)};
  const execution=new h.HelarcResponsesCompactExecution(ports);
  await mark("opened");
  if(phase==="produce"){
    await assert.rejects(()=>connection.prepare({activity:activity("compact-main"),source,configuration:c,startedAt:Date.now(),maximumBytes:1024*1024}),/native_run_admission_closed/);
    assert.equal(await provider.service.readPin("compact-main:connection"),null);
    await admitOwnerRun(store,directory);
    const request=await connection.prepare({activity:activity("compact-main"),source,configuration:c,startedAt:Date.now(),maximumBytes:1024*1024});
    await writeFile(join(directory,"request.json"),JSON.stringify(request));
    await mark("dispatch");await execution.execute(request,signal);throw new Error("Expected lost acknowledgement");
  }
  const original=JSON.parse(await readFile(join(directory,"request.json"),"utf8"));
  if(phase==="accept"){
    const current=await provider.service.get(c.id);
    await provider.service.save({configurationId:c.id,updateId:require("node:crypto").randomUUID(),expectedRevision:current.revision,
      draft:{protocol:current.protocol,name:"Changed configuration",model:"not-the-original-model",baseUrl:current.baseUrl,native:current.native,
        generationLifetimeMs:current.generationLifetimeMs,observation:current.observation},credential:{kind:"keep"}});
    await execution.recover("compact-main",signal);throw new Error("Expected lost purpose acknowledgement");
  }
  const restored=await execution.recover("compact-main",signal);assert.equal(restored.kind,"produced");
  assert.deepEqual(restored.result.outcome.candidate.items,[{type:"message",role:"user",content:"Keep blue; command completed."},{type:"compaction",encrypted_content:"opaque",id:"cmp-item"}]);
  assert.equal(h.assessHelarcResponsesCompact({source,candidate:restored.result.outcome.candidate,findings:[]}).quality.allowed,false);
  assert.deepEqual(await connection.prepare({activity:activity("compact-main"),source,configuration:c,startedAt:Date.now(),maximumBytes:1}),original);
  await assert.rejects(()=>connection.prepare({activity:activity("compact-main"),source,configuration:{...c,revision:"wrong"},startedAt:Date.now(),maximumBytes:1}),/configuration_changed/);
  await assert.rejects(()=>execution.execute({...original,binding:{...original.binding,disclosure:"wrong"}},signal),/original_request_invalid/);
  if(phase==="recover"){
    const prepare=async id=>connection.prepare({activity:activity(id),source,configuration:c,startedAt:Date.now(),maximumBytes:1024*1024});
    const unknown=new h.HelarcResponsesCompactExecution({...ports,dispatch:async(_request,session)=>{
      await session.execute({now:Date.now(),authorize:async()=>true,dispatch:async()=>{throw new Error("controlled interrupted dispatch");}});
    }});
    const unknownRequest=await prepare("compact-unknown");
    await assert.rejects(()=>unknown.execute(unknownRequest,signal),/controlled interrupted dispatch/);
    const beforeDispatch=new h.HelarcResponsesCompactExecution({...ports,dispatch:async()=>{throw new Error("controlled pre-dispatch stop");}});
    const cancelRequest=await prepare("compact-cancel");
    await assert.rejects(()=>beforeDispatch.execute(cancelRequest,signal),/controlled pre-dispatch stop/);
    const cancelled=await execution.interrupt("compact-cancel",signal);assert.equal(cancelled.cancelled,true);assert.equal(cancelled.status,"prepared");
    await crash({produced:restored.result.outcome.evidence,unknownRetained:true,cancelledBeforeDispatch:true});
  }
  assert.equal(phase,"verify");assert.equal((await execution.recover("compact-unknown",signal)).kind,"unresolved");
  assert.equal((await execution.recover("compact-cancel",signal)).kind,"cancelled");
  assert.equal((await execution.interrupt("compact-cancel",signal)).revision,(await execution.recover("compact-cancel",signal)).state.revision);
  assert.equal(network,0);assert.equal((await provider.service.readPin("compact-main:connection")).state,"confirmed");
  const {InspectionRecorder}=await import("@agent-anything/inspection/recording"),{InspectionQueryService}=await import("@agent-anything/inspection/query");
  const {ProtocolJournalInspectionAdapter}=await load("inspection/ProtocolJournalInspectionAdapter.js");
  const recorder=await InspectionRecorder.create({root:join(directory,"inspection"),application:"compact-operation",name:"Compact original operation",
    policy:{revision:"1",enabled:true,definition:true,agent:true,provider:true,execution:true}});
  const adapter=new ProtocolJournalInspectionAdapter(recorder);adapter.bindContentReader(store.protocolJournal);
  await adapter.replay((after,limit)=>store.protocolJournal.command({kind:"facts",runId:"root",after,limit}));await adapter.flush();
  const closure=await recorder.flush(true);assert.equal(closure.native,"settled");assert.equal(closure.unpersisted,0);assert.equal(recorder.health().dropped,0);
  const subject=recorder.ref("protocol-execution","model-activity","compact-main","root");
  const queries=new InspectionQueryService(join(directory,"inspection"));let inspectionRecords=0;
  try{
    const snapshot=await queries.query({kind:"get_snapshot",sourceId:subject.sourceId,datasetId:subject.datasetId});const selection=snapshot.selection;assert(selection);
    const records=[];let after;
    do{const page=await queries.query({...selection,kind:"get_native_interaction",subject,limit:100,...(after?{after}:{})});
      assert.equal(page.readWork.bodyReads,0);records.push(...page.records);after=page.next;
    }while(after);
    assert(records.some(r=>r.contents.some(c=>c.name==="Prepared compact input"&&c.availability==="present")));
    assert(records.some(r=>r.contents.some(c=>c.name==="Compact source requirements"&&c.availability==="present")));
    assert(records.some(r=>r.payload.kind==="native_fact"&&r.payload.nativeType==="compaction"));
    inspectionRecords=records.length;
  }finally{await queries.close();}
  await evidence({produced:restored.result.outcome.evidence,unknownNotReplayed:true,cancelledNotDispatched:true,qualityNotInferred:true,inspectionRecords,closure});
  await provider.close();provider=null;await store.close();store=null;app.exit(0);
}
const {admitComponentRun:admitOwnerRun}=require("./admit-component-run.cjs");
app.whenReady().then(main).catch(async error=>{
  await writeFile(join(directory,`failure-${phase}.txt`),error.stack??String(error));
  try{await provider?.close();await store?.close();}finally{app.exit(1);}
});
