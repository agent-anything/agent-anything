const assert=require("node:assert/strict"),{join}=require("node:path"),fs=require("node:fs/promises"),{createHash}=require("node:crypto");
const {DatabaseSync}=require("node:sqlite");
const instructions="Evaluate only this Run's proposed completion and settled evidence. P05_STOP_SCOPE.";
const purpose="helarc.task-fulfillment",sha=text=>createHash("sha256").update(text).digest("hex");
const isStop=body=>body.input?.length===1&&typeof body.input[0].content==="string"&&
  body.input[0].content.includes('"kind":"host_task_fulfillment_evidence"');

async function configure(load,directory,enabled){
  const {FileHelarcInstructionSettingsStore}=await load("instructions/FileHelarcInstructionSettingsStore.js");
  const settings=new FileHelarcInstructionSettingsStore(join(directory,"instruction-settings.json")),current=await settings.load();
  assert([...current.agent,...current.delegated,...current.protocol].every(x=>!x.enabled));
  if(!enabled)assert(current.stop.some(x=>x.enabled&&x.content===instructions));
  await settings.save({...current,stop:current.stop.map(x=>({...x,enabled,content:enabled?instructions:"Different current instructions"}))});
}
function interrupt(store,app,directory){
  const accept=store.sharedAcceptance.accept.bind(store.sharedAcceptance);
  store.sharedAcceptance.accept=async proposal=>{
    const part=proposal.parts.find(p=>p.owner==="protocol_execution"&&p.kind==="prepare"&&p.proposal.activity.scope.purpose.id===purpose);
    if(!part)return accept(proposal);
    const activity=part.proposal.activity,scope=activity.scope,entries=await store.listProductRuns();
    assert.equal(entries.length,1);
    const {rootRunId:root,sessionId:threadId}=entries[0].admission;
    assert.notEqual(scope.runId,root,"Child Stop evaluation must precede the Parent's");
    const stage=await store.activityHandoffs.command({kind:"read_stage",requestId:scope.activityId+":input-preparation:prepare"});
    assert.equal(stage?.status,"accepted","No accepted independent Stop preparation at the first generation boundary");
    const value=stage.result.value,{readProtocolContent}=await import("@agent-anything/agent-runtime/model-access");
    const original=JSON.parse((await readProtocolContent(store.protocolJournal,value.content,scope.activityId,32*1024*1024)).toString());
    assert.equal(value.countActivityId,scope.activityId+":input-count");assert(original.inputPreparation.assessment.allowed);
    assert.equal(await store.protocolJournal.command({kind:"state",activityId:scope.activityId}),null);
    await fs.writeFile(join(directory,"root.json"),JSON.stringify({root,threadId}));
    await fs.writeFile(join(directory,"stop-seed.json"),JSON.stringify({root,child:scope.runId,pid:process.pid,generation:store.generation,
      electron:process.versions.electron,activity:scope.activityId,stage:stage.request.id,count:value.countActivityId,
      admission:original.inputPreparation.id,wire:sha(original.wire.body),source:original.source}));
    app.exit(73);return new Promise(()=>{});
  };
}
function answer(body){
  assert(isStop(body)&&body.input[0].role==="user"&&!body.tools?.length);
  assert.equal(body.instructions,instructions);assert.equal(body.text.format.type,"json_schema");assert.equal(body.context_management,undefined);
  const e=JSON.parse(body.input[0].content);
  const child=e.completionProposal.summary==="Child result 7391";
  assert.equal(e.completionProposal.summary,child?"Child result 7391":"Root received 7391");
  assert(e.originalTask.includes(child?"HOST_CHILD":"HOST_ROOT"));
  const calls=e.settledInteraction.filter(i=>i.type==="function_call"),outputs=e.settledInteraction.filter(i=>i.type==="function_call_output");
  assert.deepEqual(calls.map(c=>c.name.split("_")[0]==="final"?c.name:c.name.split("_")[0]),child?["final_result"]:["Write","Agent","final_result"]);
  // Before the Hook verdict the ending control itself cannot already be settled.
  assert.deepEqual(calls.filter(c=>!outputs.some(o=>o.call_id===c.call_id)).map(c=>c.name),["final_result"]);
  assert.equal(e.unsettledCallCount,1);assert.equal(e.settledCallCount,calls.length-1);assert.equal(outputs.length,calls.length-1);
  if(!child){for(const c of calls.slice(0,2))assert.equal(outputs.filter(o=>o.call_id===c.call_id).length,1);
    assert(outputs.find(o=>o.call_id===calls[1].call_id).output.includes("Child result 7391"));}
  return {status:"fulfilled",disposition:"allow",rationale:"P05_STOP_VERDICT: scoped evidence permits ending.",missingOutcomes:[],unsupportedClaims:[]};
}
function checkHookFlow(exec,ins,run,child,seed,last){
  const entries=exec.prepare("SELECT id,stage,generation,value FROM hook_records WHERE json_extract(value,'$.event.run.id')=? ORDER BY stage").all(run);
  assert.deepEqual(entries.map(e=>[e.stage,e.generation]),[[0,child?seed.generation:last.generation],[1,last.generation]]);
  const original=JSON.parse(entries[0].value);assert.equal(entries[1].id,original.id);
  const checks=ins.prepare("SELECT value FROM records WHERE run_id=? AND kind='flow_constraint' AND json_extract(value,'$.payload.observation.definition.id')='hook-handler' ORDER BY sequence")
    .all(run).map(r=>JSON.parse(r.value).payload.observation);
  assert.deepEqual(checks.map(c=>[c.stepId,c.checkId,c.disposition]),child?
    [["invoke","recovery_entry","passed"],["settle","result_contract","passed"]]:[["settle","result_contract","passed"]]);
  assert(checks.every(c=>c.definition.owner==="agent-hooks"&&c.definition.revision==="2"&&c.invocationId===checks[0].invocationId));
  if(child)assert.deepEqual(checks[0].basis,{invocationId:original.id,startedAt:original.startedAt});
  return checks.map(c=>c.checkId);
}
function audit(directory,seed,last,requests,measurements,hashes,barrier){
  const {sourceId,datasetId}=last.recording;
  const exec=new DatabaseSync(join(directory,"execution","execution.sqlite"),{readOnly:true});
  const ins=new DatabaseSync(join(directory,"inspection","sources",sourceId,"datasets",datasetId,"inspection.sqlite"),{readOnly:true});
  try{
    assert.notEqual(seed.pid,last.pid);assert(last.generation>seed.generation);
    const posts=requests.filter(isStop),counts=measurements.filter(isStop);
    assert.equal(posts.length,2);assert.equal(counts.length,2);assert.equal(last.runs,2);assert.equal(last.writes,1);assert.equal(last.delivered,1);
    const rows=exec.prepare("SELECT value FROM protocol_activities WHERE json_extract(value,'$.activity.scope.purpose.id')=?").all(purpose);
    assert.equal(rows.length,2);const details=[];
    for(const row of rows){
      const st=JSON.parse(row.value),s=st.activity.scope,child=s.runId===seed.child;
      assert.equal(s.runId,child?seed.child:seed.root);assert(st.accepted);
      const b=posts.find(b=>JSON.parse(b.input[0].content).completionProposal.source.evidence.scope.runId===s.runId);assert(b);
      const count=counts.filter(m=>m.instructions===b.instructions&&JSON.stringify(m.input)===JSON.stringify(b.input));assert.equal(count.length,1);
      const stored=JSON.parse(Buffer.concat(exec.prepare("SELECT bytes FROM protocol_content_chunks WHERE id=? ORDER BY offset").all(st.input.id).map(r=>r.bytes)).toString());
      assert.deepEqual(JSON.parse(stored.wire.body),b);const hash=hashes[requests.indexOf(b)];assert.equal(sha(stored.wire.body),hash);
      assert(stored.inputPreparation.measurements.some(m=>m.dimension==="input_tokens"&&m.coverage==="complete"&&m.quantity.kind==="exact"&&m.quantity.value===100));
      if(child){assert.equal(hash,seed.wire);assert.equal(s.activityId,seed.activity);assert.equal(stored.inputPreparation.id,seed.admission);assert.deepEqual(stored.source,seed.source);}
      const contents=ins.prepare("SELECT b.bytes FROM contents c JOIN records r ON c.record_id=r.id JOIN bodies b ON c.body_id=b.id WHERE r.run_id=? AND json_extract(c.value,'$.name')=?")
        .all(s.runId,"Auxiliary complete-input admission").map(r=>JSON.parse(Buffer.from(r.bytes).toString()));
      assert(contents.some(a=>a.id===stored.inputPreparation.id&&a.scope.activityId===s.activityId&&a.status==="submission_permitted"&&a.purposeAccepted===false));
      const facts=exec.prepare("SELECT sequence,value FROM protocol_facts WHERE activity_id=?").all(s.activityId);
      const records=kind=>facts.map(f=>({...JSON.parse(f.value),sequence:f.sequence})).filter(f=>f.kind===kind);
      const dispatch=records("dispatch_intent"),observations=records("observation"),accepted=records("purpose_accepted");
      assert.equal(dispatch.length,1);assert.equal(accepted.length,1);assert.deepEqual(accepted[0].value.evidence.acceptance,st.accepted);
      assert(observations.length&&observations.every(o=>o.value.operationId===dispatch[0].value.operationId));
      for(const f of [...dispatch,...observations,...accepted])
        assert(ins.prepare("SELECT id FROM records WHERE id=? AND run_id=?").get("protocol-execution:"+s.runId+":"+f.sequence,s.runId));
      const prep=exec.prepare("SELECT id,intent FROM activity_paths WHERE id=? AND run_id=?").get(s.activityId+":input-preparation",s.runId);
      assert(prep);const allowance=JSON.parse(prep.intent).resourceLimits.measurementCalls;assert(allowance>0);
      assert.equal(exec.prepare("SELECT COUNT(*) n FROM activity_attempts WHERE request_id=?").get(prep.id+":prepare").n,1);
      assert(ins.prepare("SELECT id FROM records WHERE run_id=? AND json_extract(value,'$.subject.id')=? AND json_extract(value,'$.payload.executionKind')='auxiliary_input_preparation' AND json_extract(value,'$.payload.status')='accepted'").get(s.runId,prep.id+":prepare"));
      const hookChecks=checkHookFlow(exec,ins,s.runId,child,seed,last);
      details.push({run:s.runId,activity:s.activityId,allowance,admission:stored.inputPreparation.id,wire:hash,observations:observations.length,hookChecks});
    }
    assert.deepEqual(details.map(s=>s.run).sort(),[seed.child,seed.root].sort());
    assert(requests.filter(b=>!isStop(b)).every(b=>!JSON.stringify(b).includes("P05_STOP_VERDICT")));
    const coverage=JSON.parse(ins.prepare("SELECT coverage FROM dataset").get().coverage);
    assert.equal(last.inspection.unpersisted+last.inspection.unconfirmed,0);
    assert.equal(barrier.drain.barrier.accepted,last.inspection.barrier.accepted);
    assert.equal(barrier.progress.nativeTarget,coverage.recording.lastFlush.nativeTarget);
    assert.equal(barrier.progress.projection,"settled");
    assert(last.inspection.projectionCursor>=barrier.progress.nativeTarget);
    const rejectedOffers=ins.prepare("SELECT value FROM batch_receipts WHERE json_extract(value,'$.rejected')>0").all().flatMap(r=>JSON.parse(r.value).rejectedOffers);
    return {details,captured:coverage.captured,history:coverage.recording.ingress.history,projection:last.inspection.projection,
      rejected:coverage.rejected,nativeRejected:coverage.recording.native.rejected,ingressRejected:coverage.recording.ingress.rejected,
      dropped:coverage.dropped,rejectedOffers};
  }finally{ins.close();exec.close();}
}
function assertCoverage(report){
  assert.deepEqual(report.history,{started:2,confirmed:2,incomplete:0});
  assert.equal(report.ingressRejected,0);assert.equal(report.dropped,0);
  assert.equal(report.nativeRejected,0,JSON.stringify(report.rejectedOffers));assert.equal(report.rejected,0);
  assert.equal(report.projection,"settled","Inspector projection did not catch up");
}
module.exports={isStop,configure,interrupt,answer,audit,assertCoverage};
