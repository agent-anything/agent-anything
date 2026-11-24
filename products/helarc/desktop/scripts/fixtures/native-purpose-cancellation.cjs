const {app}=require("electron"),assert=require("node:assert/strict");
const {join}=require("node:path"),{pathToFileURL}=require("node:url"),{writeFile}=require("node:fs/promises");
const [directory,phase,endpoint]=process.argv.slice(2);
app.setPath("userData",join(directory,"electron"));app.disableHardwareAcceleration();
let store,provider,observer;
async function main(){
  const load=p=>import(pathToFileURL(join(__dirname,"../../dist/main",p)));
  const runtime=await import("@agent-anything/agent-runtime/model-access"),model=await import("@agent-anything/model-interaction/protocol");
  const native=await import("@agent-anything/provider-integrations/native"),h=await import("@agent-anything/helarc/controller");
  const {HelarcExecutionStore}=await load("execution-storage/HelarcExecutionStore.js");
  const {HelarcResponsesPurposeObserver}=await load("provider/HelarcResponsesPurposeObserver.js");
  store=await HelarcExecutionStore.open(join(directory,"execution"));
  provider=await require("./native-task-provider.cjs")(directory,phase,endpoint,load,"responses-transport-background");
  observer=new HelarcResponsesPurposeObserver(store,provider.service);
  const ref=id=>({id,revision:"1"}),participant=id=>({implementation:ref(id),protocol:model.OPENAI_RESPONSES}),cfg=provider.configuration;
  const composition=model.bindModelAgentComposition({agent:ref("agent"),protocol:model.OPENAI_RESPONSES,
    configuration:{configuration:{id:cfg.id,revision:cfg.revision},protocol:model.OPENAI_RESPONSES,model:cfg.model,connectionBinding:ref(cfg.connectionBindingId)},
    adapter:{implementation:native.OPENAI_RESPONSES_ADAPTER,protocol:model.OPENAI_RESPONSES},
    task:{purpose:ref("task"),input:participant("task-input"),interpreter:{implementation:h.HELARC_NATIVE_TASK_INTERPRETER,protocol:model.OPENAI_RESPONSES}},
    auxiliary:[{purpose:ref("check"),input:participant("check-input"),interpreter:{implementation:h.HELARC_NATIVE_STRUCTURED_INTERPRETER,protocol:model.OPENAI_RESPONSES}}]});
  const accept=async(id,scope,actor,parts)=>{const r=await store.sharedAcceptance.accept({id,scope,actor,parts});assert.equal(r.outcome,"accepted",JSON.stringify(r));};
  const owner=native.OPENAI_RESPONSES_ADAPTER.id,journal=store.protocolJournal;
  for(const id of ["known","unknown","unsent"]){
    let state=await journal.command({kind:"state",activityId:id});
    if(!state){
      const activity=runtime.bindProtocolModelActivity({composition,scope:{runId:id,activityId:id,recipientId:"check",purpose:ref("check"),compositionDigest:composition.digest},
        conditions:{input:ref(id),authority:ref("original-authority"),resources:ref("bounded"),control:ref("active")}});
      const prepared=h.prepareHelarcResponsesStructured({activity,source:ref(id)},{input:[{role:"user",content:id}],stream:false,background:true,store:true,
        textSchema:{type:"object",properties:{answer:{type:"string"}},required:["answer"],additionalProperties:false}});
      const request=await observer.prepare(activity,prepared,cfg);
      const input=await runtime.retainProtocolContent(journal,`${id}:input`,id,Buffer.from(JSON.stringify(request)));
      await accept(`${id}:prepare`,id,"execution-coordinator",[{owner:"protocol_execution",kind:"prepare",proposal:{activity,input}}]);
      state=await journal.command({kind:"state",activityId:id});
    }
    if(state.fence.generation!==store.generation||!state.fence.epoch){
      await accept(`${id}:claim:${store.generation}`,id,owner,[{owner:"protocol_execution",kind:"claim",proposal:{activityId:id,expectedEpoch:state.fence.epoch}}]);
      state=await journal.command({kind:"state",activityId:id});
    }
    const request=JSON.parse((await runtime.readProtocolContent(journal,state.input,id,33554432)).toString());
    if(phase==="seed"){
      if(id!=="unsent"){
        const original=store.sharedAcceptance.accept.bind(store.sharedAcceptance);let recorded=false;
        store.sharedAcceptance.accept=async proposal=>{
          const receipt=await original(proposal);
          if(id==="known"&&receipt.outcome==="accepted"&&proposal.parts.some(p=>p.kind==="evidence"&&p.proposal.evidence.metadata.responseId)){
            recorded=true;throw new Error("stop-driver-after-durable-response-id");
          }
          return receipt;
        };
        const controller=new AbortController();
        if(id==="known"){
          // The store resolves a lost acknowledgement; interrupt before a GET can start.
          store.sharedAcceptance.accept=async proposal=>{const receipt=await original(proposal);
            if(receipt.outcome==="accepted"&&proposal.parts.some(p=>p.kind==="evidence"&&p.proposal.evidence.metadata.responseId)){recorded=true;controller.abort();}
            return receipt;};
        }
        await assert.rejects(()=>observer.observe(state,request,controller.signal,async()=>{}));
        store.sharedAcceptance.accept=original;
        if(id==="known")assert(recorded);
      }
      continue;
    }
    if(phase==="handoff"){
      await accept(`${id}:cancel`,id,"execution-coordinator",[{owner:"protocol_execution",kind:"control",proposal:{activityId:id,expectedRevision:state.fence.controlRevision,cancelled:true}}]);
      state=await journal.command({kind:"state",activityId:id});
      const handoff=await observer.interrupt(state,request,`${id}:cancel`);assert(handoff);
      assert.equal(handoff.activityId,id);continue;
    }
    const handoff=await journal.command({kind:"reconciliation",activityId:id,id:`${id}:responses:reconciliation`});assert(handoff);
    const disposition=await observer.reconcile(handoff,new AbortController().signal,async operation=>{assert.notEqual(operation,"create");});
    assert.equal(disposition.outcome,id==="unknown"?"unresolved":"resolved");
    assert.equal(await journal.command({kind:"acceptance",activityId:id}),null,"Reconciliation must not accept task or auxiliary results");
    assert.deepEqual(await observer.reconcile(handoff,new AbortController().signal,async()=>{throw new Error("closed follow-up dispatched");}),disposition);
  }
  const pending=await journal.command({kind:"reconciliation_list",receiver:owner,after:null,limit:10});
  assert.equal(pending.length,phase==="handoff"?3:0);
  await writeFile(join(directory,`${phase}.json`),JSON.stringify({phase,generation:store.generation,pending:pending.length}));
}
app.whenReady().then(main).then(async()=>{await observer?.close();await provider?.close();await store?.close();app.exit(0);}).catch(async error=>{
  await writeFile(join(directory,`failure-${phase}.txt`),error.stack??String(error));try{await observer?.close();await provider?.close();await store?.close();}finally{app.exit(1);}});
