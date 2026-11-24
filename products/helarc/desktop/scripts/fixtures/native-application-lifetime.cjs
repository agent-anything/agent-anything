const assert=require("node:assert/strict"),fs=require("node:fs"),{join}=require("node:path");
const {DatabaseSync}=require("node:sqlite"),{safeStorage}=require("electron");
const mode=process.env.HELARC_P05_LIFETIME;
const file=(d,name)=>join(d,name+".json");
const save=(d,name,value)=>fs.writeFileSync(file(d,name),JSON.stringify(value,null,2));
function query(d,sql,...params){
  const db=new DatabaseSync(join(d,"execution","execution.sqlite"),{readOnly:true});
  try{return db.prepare(sql).all(...params);}finally{db.close();}
}
const nativeHeads=d=>query(d,"select value from protocol_evidence_history where kind='transport' order by rowid").map(r=>JSON.parse(r.value));
async function until(find,label){
  const deadline=Date.now()+25000;
  while(Date.now()<deadline){const value=await find();if(value)return value;await new Promise(r=>setTimeout(r,40));}
  throw Error("Evidence not observed: "+label);
}
function pinState(d,id){
  const db=new DatabaseSync(join(d,"provider-registry","registry.sqlite"),{readOnly:true});
  try{return db.prepare("select state from pins where id=?").get(id)?.state??null;}finally{db.close();}
}
async function seed({directory:d,services,selected,store,inspection,app,settled,custodyPass}){
  let original;
  async function cut(child){
    const {rootRunId:root,productRunId:intent,model:{connection}}=original;
    const resolution=await store.resolveAdmission(root,intent),pin=pinState(d,connection.pinId);
    assert.equal(resolution.status,mode==="provisional"?"unknown":"accepted");
    assert(mode==="provisional"?pin==="provisional":["provisional","confirmed"].includes(pin));
    if(mode==="provisional"){
      fs.writeFileSync(join(d,"delayed-admission.sealed"),safeStorage.encryptString(JSON.stringify(original)));
    }
    save(d,"cut",{root,intent,connection,configuration:selected,resolution,pin,electron:process.versions.electron,pid:process.pid,
      ...(child?{child:child.state.run.id,lineage:child.admission.lineage,delegation:child.admission.delegationRequest}:{}),
      generation:store.generation,recording:inspection.recorder.ref("runtime","run",root,root)});
    if(mode==="takeover"){
      await store.close();save(d,"owner-released",{pid:process.pid});
      await until(()=>fs.existsSync(file(d,"verified")),"new owner cancelled original admission");
      return;
    }
    app.exit(73);return new Promise(()=>{});
  }
  const admit=store.admitProductRun.bind(store);
  store.admitProductRun=async value=>{original=value;if(mode==="provisional")return cut();return admit(value);};
  if(mode==="preadopt"){
    const accept=store.sharedAcceptance.accept.bind(store.sharedAcceptance);
    store.sharedAcceptance.accept=async proposal=>{
      const input=proposal.parts.find(p=>p.kind==="selection_input")?.proposal?.input;
      if(input&&proposal.parts.some(p=>p.kind==="native_input_return")){
        assert.equal(await store.sharedAcceptance.query(proposal.id),null);
        const path=proposal.parts.find(p=>p.kind==="path_condition")?.proposal.pathId;
        const snapshot=await store.activityHandoffs.command({kind:"read_snapshot",pathId:path,requestIds:[path+":stage:1"],inputNeedIds:[]});
        const stage=snapshot.stages[0];assert.equal(stage?.status,"accepted");assert(stage.receipt&&stage.result);
        save(d,"before-adoption",{root:original.rootRunId,acceptance:proposal.id,inputId:input.id,path,receipt:stage.receipt.id,result:stage.result.id,
          body:input.exactInput.wire.body,generation:store.generation});return cut();
      }
      return accept(proposal);
    };
  }
  if(mode==="admitted"||mode==="child"||mode==="takeover"){
    const commit=store.commitRunTree.bind(store);
    store.commitRunTree=async value=>{const receipt=await commit(value);
      const child=value.runs.find(r=>r.admission?.lineage.kind==="descendant");
      if(mode==="child"&&child)return cut(child);
      if(mode==="takeover"&&value.runs.some(r=>r.admission&&r.state.run.id===original.rootRunId)){await cut();return receipt;}
      if(mode==="admitted"&&value.runs.some(r=>r.admission!==null&&r.state.run.id===original.rootRunId))return cut();return receipt;};
  }
  const submission=services.startProtocolRun({taskText:mode==="child"?"P05_ROOT: delegate the number check once.":"P05 admission boundary; no work before activation.",target:{kind:"new_thread"}},selected);
  if(mode==="takeover"){
    const observation=await submission.then(s=>s.ok?null:s.error,e=>({message:e.message,code:e.code}));
    assert(fs.existsSync(file(d,"verified")),"stale callback must follow confirmed takeover");
    assert(observation,"old owner unexpectedly resumed admission");save(d,"late-owner",{observation,pid:process.pid});
    app.exit(73);return new Promise(()=>{});
  }
  const start=await submission;
  assert(start.ok,JSON.stringify(start.error));
  if(mode==="unknown"){
    await until(()=>fs.existsSync(file(d,"wire-unknown")),"peer accepted create");
    const heads=nativeHeads(d),head=heads.at(-1);
    assert(head&&!head.metadata.responseId);assert.equal(head.metadata.operations,1);
    save(d,"pending",{activity:head.activityId,metadata:head.metadata});return cut();
  }
  if(mode==="remote"){
    const root=original.rootRunId;
    const known=await until(()=>nativeHeads(d).find(h=>h.metadata.responseId==="resp_outstanding"),"original response identified");
    const receipt=await services.controller.dispatchHostCommand({version:1,commandId:"cancel-known-response",runId:root,
      kind:"run.cancel",payload:{reason:"P05 stop local work; reconcile original remote response"}},"run.cancel");
    save(d,"remote-cancel",{root,activity:known.activityId,receipt});assert.equal(receipt.status,"handled");
    const t=await until(async()=>{const t=await store.readRunTree(root);return t?.members[0].head.state.status==="cancelled"&&t;},"terminal original Run");
    const transfer=query(d,"select * from protocol_reconciliations where activity_id=?",known.activityId);
    save(d,"remote-terminal",{root,activity:known.activityId,transfer,status:t.members[0].head.state.status,generation:store.generation,
      recording:inspection.recorder.ref("runtime","run",root,root),heads:nativeHeads(d).map(h=>h.metadata)});
    // A pending remote resource may never be retired merely because its local Run stopped.
    const handoff=await until(()=>query(d,"select * from protocol_reconciliations where activity_id=? and closed=0",known.activityId)[0],"independently accepted remote follow-up");
    const pin=pinState(d,known.activityId+":connection");assert.equal(pin,"confirmed");
    save(d,"cut",{root,activity:known.activityId,handoff:handoff.id,receiver:handoff.receiver,pin,generation:store.generation,pid:process.pid});
    if(custodyPass){
      const checked=await until(()=>custodyPass(known.activityId+":connection"),"completed custody pass with a real open follow-up");
      assert.equal(checked.decision,"confirmed");assert.equal(checked.pendingHandoffs,1);
      const native=await store.protocolJournal.command({kind:"state",activityId:known.activityId});
      assert(native.cancelled&&!native.accepted&&!native.retentionReleased&&!native.connectionRelease);
      assert.equal(query(d,"select closed from protocol_reconciliations where id=?",handoff.id)[0].closed,0);
      assert.equal(pinState(d,checked.pin),"confirmed");
      assert.equal(query(d,"select count(*) as n from protocol_effects where activity_id=?",known.activityId)[0].n,0);
      const flush=await inspection.flushRecording(true);assert.equal(flush.native,"settled");
      save(d,"verified",{...checked,root,rootState:"cancelled",responseId:known.metadata.responseId,handoff:handoff.id,
        electron:process.versions.electron,generation:store.generation,pid:process.pid,flush,recording:inspection.recorder.ref("runtime","run",root,root)});
    }
    app.exit(73);return new Promise(()=>{});
  }
  await settled();
  throw Error("Missed original admission boundary");
}
async function recover({directory:d,services,store,inspection,settled}){
  const cut=JSON.parse(fs.readFileSync(file(d,"cut"))),{root,intent,connection}=cut,c=services.controller;
  assert(process.pid!==cut.pid&&store.generation>cut.generation);
  const entries=await c.listRecoverableWork();assert.equal(entries.length,1);
  const [entry]=entries;assert.equal(entry.id,root);
  const resolve=()=>store.resolveAdmission(root,intent);
  let late=null,terminal=null;
  if(mode==="provisional"){
    assert.equal(entry.state,"admission_unconfirmed");assert.equal((await c.recoverWork({...entry,intent:"continue"})).ok,false);
    assert.equal((await resolve()).status,"unknown");assert.equal(pinState(d,connection.pinId),"provisional");
  }else{
    assert.equal(entry.state,"interrupted");assert.deepEqual(await resolve(),cut.resolution);
    assert.deepEqual((await store.readProductRun(root)).model.connection,connection);
    assert.equal((await store.readRunTree(root)).members.length,1);
  }
  const out=await c.recoverWork({id:entry.id,revision:entry.revision,intent:"cancel"});assert(out.ok,out.message);
  if(mode==="provisional"){
    assert.equal((await resolve()).status,"closed");assert.equal(pinState(d,connection.pinId),"released");
    const delayed=JSON.parse(safeStorage.decryptString(fs.readFileSync(join(d,"delayed-admission.sealed"))));
    await assert.rejects(()=>store.admitProductRun(delayed),error=>{late=error.code??error.message;return /execution_admission_closed/.test(String(late));});
    assert.equal(await store.readRunTree(root),null);assert.deepEqual(await store.listProductRuns(),[]);
  }else{
    await settled();const tree=await store.readRunTree(root),[member]=tree.members;
    assert.equal(tree.members.length,1);assert.deepEqual(await resolve(),cut.resolution);
    assert.equal(member.head.state.status,"cancelled");terminal=member.head.state.status;
    assert.equal(member.head.state.items.filter(i=>i.payload.kind==="controller_turn"||i.payload.kind==="model_call_settlement").length,0);
    const [delivery]=await store.listProductRuns();assert(delivery.delivered&&delivery.terminal);
  }
  assert.deepEqual(await c.listRecoverableWork(),[]);
  save(d,"verified",{mode,root,intent,entry:entry.state,from:cut.resolution,to:await resolve(),pin:pinState(d,connection.pinId),late,terminal,
    pid:process.pid,generation:store.generation,recording:inspection.recorder.ref("runtime","run",root,root)});
}
async function resumeChild({directory:d,services,store,inspection,settled,phase,app,childCredentials}){
  const {parentMessage}=require("./native-child-delivery-evidence.cjs");
  const cut=JSON.parse(fs.readFileSync(file(d,"cut"))),c=services.controller;
  assert(process.pid!==cut.pid&&store.generation>cut.generation);
  const entry=(await c.listRecoverableWork()).find(e=>e.id===cut.root);assert(entry,"original Root not discovered");
  const tree=await store.readRunTree(cut.root),child=tree.members.find(m=>m.head.state.run.id===cut.child);
  assert.equal(tree.members.length,2);assert.deepEqual(child.admission.lineage,cut.lineage);
  assert.deepEqual(child.admission.delegationRequest,cut.delegation);
  assert.deepEqual((await store.readProductRun(cut.root)).model.connection,cut.connection);
  const stamp=()=>({pid:process.pid,generation:store.generation,root:cut.root,child:cut.child,entry:entry.state,
    recording:inspection.recorder.ref("runtime","run",cut.root,cut.root)});
  const halt=async(name,data)=>{save(d,name,{...stamp(),...data});app.exit(73);return new Promise(()=>{});};
  if(phase==="lifetime-observe"){
    assert.equal(child.head.state.items.filter(i=>i.payload.kind==="controller_turn").length,0);
    const accept=store.sharedAcceptance.accept.bind(store.sharedAcceptance);
    store.sharedAcceptance.accept=async proposal=>{
      const part=proposal.parts.find(p=>p.owner==="protocol_execution"&&p.kind==="purpose");
      if(part&&proposal.scope===cut.root&&fs.existsSync(join(d,"wire-parent-final.json"))){
        const t=await store.readRunTree(cut.root),sender=t.members.find(m=>m.head.state.run.id===cut.child),
          parent=t.members.find(m=>m.head.state.run.id===cut.root);
        assert.equal(sender.head.state.status,"completed");assert.equal(sender.head.state.finalOutput.summary,"Child result 7391");
        assert.equal(parent.head.control.descendantTransfers.filter(x=>x.childRunId===cut.child&&x.narrative?.text==="Child result 7391").length,1);
        return halt("observed",{acceptance:proposal.id,part:part.kind,childStatus:sender.head.state.status});
      }
      return accept(proposal);
    };
  }else{
    if(phase==="lifetime-deliver"){
      store.commitProductDelivery=async root=>{
        assert.equal(root,cut.root);const [saved]=await store.listProductRuns();assert(saved.terminal&&!saved.delivered);
        const parent=(await store.readRunTree(cut.root)).members.find(m=>m.head.state.run.id===cut.root);
        const summary=parent.head.state.finalOutput?.summary;assert.equal(summary,"Root received 7391");
        return halt("before-ack",{summary,message:parentMessage(d,saved.admission)});
      };
    }else assert.equal(entry.state,"delivery_pending");
  }
  childCredentials.work();
  const out=await c.recoverWork({id:entry.id,revision:entry.revision,intent:"continue"});
  assert(out.ok,out.message);await settled();
  if(phase!=="lifetime-recover"){
    const t=await store.readRunTree(cut.root);
    save(d,"unexpected-settlement",{...stamp(),members:t.members.map(m=>({id:m.head.state.run.id,status:m.head.state.status,output:m.head.state.finalOutput}))});
    throw Error("Run settled before reaching "+phase);
  }
  const [receipt]=await store.listProductRuns();assert(receipt.delivered&&receipt.terminal);
  const message=parentMessage(d,receipt.admission);
  assert.deepEqual(message,JSON.parse(fs.readFileSync(file(d,"before-ack"))).message);
  const parent=(await store.readRunTree(cut.root)).members.find(m=>m.head.state.run.id===cut.root);
  assert.equal(parent.head.state.finalOutput.summary,"Root received 7391");assert.deepEqual(await c.listRecoverableWork(),[]);
  const flush=await inspection.flushRecording(true);assert.equal(flush.native,"settled");assert.equal(inspection.recorder.health().dropped,0);
  assert.equal(parent.head.state.status,"completed");assert.equal(flush.unconfirmed,0);assert.equal(flush.unpersisted,0);
  save(d,"verified",{...stamp(),terminal:parent.head.state.status,summary:parent.head.state.finalOutput.summary,message,flush});
}
async function resumeUnknown({directory:d,services,store,inspection}){
  const cut=JSON.parse(fs.readFileSync(file(d,"cut"))),pending=JSON.parse(fs.readFileSync(file(d,"pending")));
  assert(store.generation>cut.generation&&process.pid!==cut.pid);
  const c=services.controller,entry=(await c.listRecoverableWork()).find(e=>e.id===cut.root);assert(entry);
  const out=await c.recoverWork({id:entry.id,revision:entry.revision,intent:"continue"});assert(out.ok,out.message);
  const head=await until(()=>nativeHeads(d).find(x=>x.activityId===pending.activity&&x.metadata.disposition==="unresolved"),"original create uncertain");
  assert.equal(head.metadata.responseId,null);assert.equal(head.metadata.reason,"original_response_unavailable");assert.equal(head.metadata.operations,1);
  await until(()=>c.getSnapshot().execution==="idle","bounded task disposition");
  const t=await store.readRunTree(cut.root),root=t.members.find(m=>m.head.state.run.id===cut.root);
  const activities=query(d,"select id from protocol_activities where run_id=?",cut.root);
  const dispatch=query(d,"select value from protocol_records where activity_id=?",pending.activity).map(x=>JSON.parse(x.value)).filter(x=>x.kind==="dispatch_intent");
  const facts={root:cut.root,activity:pending.activity,reason:head.metadata.reason,activities,dispatches:dispatch.map(x=>x.ref),
    status:root.head.state.status,output:root.head.state.finalOutput,recoverable:(await c.listRecoverableWork()).map(e=>e.state),generation:store.generation,
    recording:inspection.recorder.ref("runtime","run",cut.root,cut.root),flush:await inspection.flushRecording()};
  save(d,"unknown-outcome",facts);
  assert.equal(dispatch.length,1);assert.equal(facts.status,"failed");assert.equal(facts.output,null);
  const cause=root.head.state.settlementCause.failure,stageId=pending.activity+":scheduled-observation:observe";
  assert.equal(cause.kind,"model");assert.equal(cause.failure.code,"model_response_unavailable");assert.equal(cause.failure.retryable,false);
  const basis={scopeId:head.scopeId,kind:head.kind,key:head.key,revision:head.revision,digest:head.content.digest};
  assert.equal(cause.failure.metadata.activityId,pending.activity);assert.equal(cause.failure.metadata.reason,head.metadata.reason);
  assert.deepEqual(cause.failure.metadata.basis,basis);
  const stage=await store.activityHandoffs.command({kind:"read_stage",requestId:stageId});
  assert.equal(stage.status,"accepted");assert(stage.receipt);assert.deepEqual(stage.result.value,{kind:"protocol_observation_unavailable",
    activityId:pending.activity,reason:head.metadata.reason,basis});
  const native=await store.protocolJournal.command({kind:"state",activityId:pending.activity});
  assert.equal(native.accepted,null);assert.equal(query(d,"select count(*) as n from protocol_effects")[0].n,0);
  assert.deepEqual(facts.recoverable,[]);assert.equal(native.cancelled,false);
  const {readProtocolContent}=await import("@agent-anything/agent-runtime/model-access");
  const prepared=JSON.parse((await readProtocolContent(store.protocolJournal,native.input,pending.activity,32*1024*1024)).toString());
  assert.equal(await store.protocolJournal.command({kind:"record",activityId:pending.activity,ref:prepared.binding.record}),null);
  assert(fs.readFileSync(join(d,"wire-unknown.json")).equals(Buffer.from(prepared.wire.body)));
  // This peer never supplies an ID or a follow-up resource. Run delivery alone is not retirement.
  const local=await until(async()=>{
    const s=await store.protocolJournal.command({kind:"state",activityId:pending.activity});
    return s.connectionRelease&&pinState(d,pending.activity+":connection")==="released"&&s;
  },"scope-specific local release for the unaddressable create (remote exposure remains unknown)");
  const release={bindingId:prepared.responsesTransport.connection.bindingId,observation:{stageId,receiptId:stage.receipt.id,limitation:stage.result.value}};
  assert.deepEqual(local.connectionRelease,release);assert.equal(local.accepted,null);assert.equal(local.cancelled,false);
  assert.equal(local.retentionReleased,false);assert.equal(local.inputUseSettlement,undefined);
  assert.deepEqual(local.contextInput,native.contextInput);assert(local.contextInput);
  const releases=query(d,"select sequence,value from protocol_facts where activity_id=? and json_extract(value,'$.kind')='connection_released'",pending.activity);
  assert.equal(releases.length,1);const released={...JSON.parse(releases[0].value),sequence:releases[0].sequence};assert.deepEqual(released.value,release);
  assert.equal((await store.sharedAcceptance.query(released.identity))?.outcome,"accepted");
  assert.equal(query(d,"select count(*) as n from protocol_reconciliations where activity_id=?",pending.activity)[0].n,0);
  const usage=query(d,"select value from protocol_evidence_history where kind='usage' order by rowid").map(x=>JSON.parse(x.value))
    .filter(x=>x.activityId===pending.activity&&x.metadata.operation==="generation").at(-1)?.metadata;
  assert(usage);assert.equal(usage.costCoverage,"unknown");assert.equal(usage.exposure,"unresolved");
  assert.equal(usage.inputTokens,null);assert.equal(usage.outputTokens,null);
  facts.flush=await inspection.flushRecording(true);
  assert.equal(facts.flush.native,"settled");assert.equal(facts.flush.unpersisted,0);assert.equal(facts.flush.unconfirmed,0);
  const {sourceId,datasetId}=facts.recording,db=new DatabaseSync(join(d,"inspection","sources",sourceId,"datasets",datasetId,"inspection.sqlite"),{readOnly:true});
  try{
    const to=basis.scopeId+":"+basis.kind+":"+basis.key;
    const relation=db.prepare("select id from relations where kind='observes' and json_extract(value,'$.from.id')=? and json_extract(value,'$.to.owner')='protocol-evidence' and json_extract(value,'$.to.id')=? and json_extract(value,'$.to.revision')=?").get(stageId,to,String(basis.revision));
    assert(relation,"Inspector must link the observation to its immutable native basis");
    const entry=db.prepare("select r.id from records r join contents c on c.record_id=r.id join bodies b on b.id=c.body_id where r.run_id=? and instr(cast(b.bytes as text),?)>0 and instr(cast(b.bytes as text),?)>0 limit 1").get(cut.root,head.metadata.reason,basis.digest);
    assert(entry,"Inspector must retain readable disposition and basis together");
    const releaseEvent="protocol-execution:"+released.sequence;
    const incoming=db.prepare("select json_extract(value,'$.from.owner') owner,json_extract(value,'$.from.id') id,json_extract(value,'$.from.revision') revision from relations where kind='binding' and json_extract(value,'$.to.id')=? and json_extract(value,'$.to.owner')='protocol-execution'").all(releaseEvent);
    for(const [owner,id,revision] of [["activity",stageId],["shared_acceptance",stage.receipt.id],["protocol-evidence",to,String(basis.revision)]]){
      assert(incoming.some(r=>r.owner===owner&&r.id===id&&(!revision||r.revision===revision)),"Missing local release basis: "+owner);
    }
    const body=db.prepare("select b.bytes from contents c join bodies b on b.id=c.body_id where c.record_id=? and json_extract(c.value,'$.name')=?")
      .get("protocol-execution:"+cut.root+":"+released.sequence,"Durable evidence and responsibility");
    assert.deepEqual(JSON.parse(Buffer.from(body.bytes).toString()),release);
    save(d,"verified",{...facts,stageReceipt:stage.receipt.id,limitation:cause.failure,inspectionEvidence:{relation:relation.id,record:entry.id,releaseEvent},
      localReleaseBasis:release,connection:"released",costCoverage:usage.costCoverage,exposure:usage.exposure,
      purposeAccepted:false,taskResponse:null,effects:0});
  }finally{db.close();}
}
async function resumeRemote({directory:d,store,inspection,app,retirementCut}){
  const cut=JSON.parse(fs.readFileSync(file(d,"cut")));assert(store.generation>cut.generation);
  const row=await until(()=>query(d,"select * from protocol_reconciliations where id=? and closed=1",cut.handoff)[0],"same handoff closed after restart");
  assert.equal(row.activity_id,cut.activity);assert.equal(row.receiver,cut.receiver);
  const actual=JSON.parse(row.value);
  const head=nativeHeads(d).filter(h=>h.activityId===cut.activity).at(-1);assert.equal(head.metadata.responseId,"resp_outstanding");assert.equal(head.metadata.status,"completed");
  const t=await store.readRunTree(cut.root);assert.equal(t.members.length,1);assert.equal(t.members[0].head.state.status,"cancelled");
  assert.equal(t.members[0].head.state.items.filter(i=>i.payload.kind==="model_call_settlement").length,0);
  assert(!fs.existsSync(join(d,"workspace","late.txt")));
  assert.equal(query(d,"select count(*) as n from protocol_effects").at(0).n,0);
  const flush=await inspection.flushRecording(true);assert.equal(flush.native,"settled");
  save(d,"verified",{root:cut.root,handoff:actual,terminal:"cancelled",lateFile:false,head:head.metadata,generation:store.generation,flush,
    recording:inspection.recorder.ref("runtime","run",cut.root,cut.root)});
  if(retirementCut){
    const proposalId=await until(retirementCut,"original activity reached logical release");
    assert.equal(await store.sharedAcceptance.query(proposalId),null);
    const native=await store.protocolJournal.command({kind:"state",activityId:cut.activity});
    assert(native.cancelled&&!native.retentionReleased);assert.equal(pinState(d,cut.activity+":connection"),"confirmed");
    save(d,"before-retirement",{activity:cut.activity,handoff:cut.handoff,proposalId,generation:store.generation});
    app.exit(73);return new Promise(()=>{});
  }
}
async function resumeAdoption({directory:d,store,services,inspection,settled}){
  const cut=JSON.parse(fs.readFileSync(file(d,"before-adoption"))),c=services.controller;
  assert(store.generation>cut.generation);assert.equal(await store.sharedAcceptance.query(cut.acceptance),null);
  const entry=(await c.listRecoverableWork()).find(e=>e.id===cut.root);assert(entry);
  const out=await c.recoverWork({id:entry.id,revision:entry.revision,intent:"continue"});assert(out.ok,out.message);await settled();
  const s=await store.activityHandoffs.command({kind:"read_snapshot",pathId:cut.path,requestIds:[cut.path+":stage:1"],inputNeedIds:[]});
  assert.equal(s.stages[0].receipt.id,cut.receipt);assert.equal(s.stages[0].result.id,cut.result);
  const adoption=await store.sharedAcceptance.query(cut.acceptance);assert.equal(adoption?.outcome,"accepted");
  const root=(await store.readRunTree(cut.root)).members[0];assert.equal(root.head.state.finalOutput.summary,"Retained input used");
  const flush=await inspection.flushRecording(true);assert.equal(flush.native,"settled");
  save(d,"verified",{root:cut.root,acceptance:adoption.id,receipt:cut.receipt,inputId:cut.inputId,generation:store.generation,flush});
}
module.exports={seed,recover,resumeChild,resumeUnknown,resumeRemote,resumeAdoption};
