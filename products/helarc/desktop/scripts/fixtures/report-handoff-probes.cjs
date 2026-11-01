const assert=require("node:assert/strict");

// Runs inside the real Electron process against the same SQLite Worker, after task dispatch closes.
module.exports=async function({store,createHandoff,result,binding}) {
  const {ActivityHandoffProcessor,ActivityPurposeRegistry,ActivityReconsiderationProcessor}=await import("@agent-anything/agent-runtime/activity");
  const {SourceMaterialPublicationWork}=await import("@agent-anything/agent-runtime/context-representation");
  const {modelInputValueDigest:digest}=await import("@agent-anything/model-interaction/input");
  const {RunRecoveryError}=await import("@agent-anything/agent-runtime/execution-coordinator");
  const registry=new ActivityPurposeRegistry();
  const publications=new SourceMaterialPublicationWork(store.activityHandoffs,registry,{materials:store.materialCustody,authorize:async()=>({kind:"allowed"}),now:()=>new Date().toISOString()});
  const processor=new ActivityHandoffProcessor(store.activityHandoffs,registry,{hostSession:"report-probes",worker:"report-probes",generation:store.generation},()=>new Date().toISOString());
  const reconsideration=new ActivityReconsiderationProcessor(store.activityHandoffs,store.sharedAcceptance,
    owner=>owner==="material-source"?publications.lifecycle:null);
  const a=command=>store.activityHandoffs.command(command),passed=[];
  async function drain(times=1){for(let n=0;n<times;n++){
    const signal=new AbortController().signal;
    await processor.drain(binding.child.runId,signal);
    const cycle=await reconsideration.scan(binding.child.runId,signal);assert.deepEqual(cycle.failures,[]);assert.deepEqual(cycle.rejected,[]);
  }}
  async function waitFor(check){const deadline=Date.now()+5000;while(!await check()){assert(Date.now()<deadline,"Probe did not reach its controlled boundary");await new Promise(r=>setTimeout(r,10));}}
  function probe(name,authorize=async()=>true) {
    let clock=Date.parse("2026-10-31T00:00:00Z");const controller=new AbortController();
    const scoped={...binding,child:{...binding.child,recipient:`${binding.child.recipient}:${name}`},parent:{...binding.parent,recipient:`${binding.parent.recipient}:${name}`}};
    const pathId=`${result.narrative.source.recordId}:publication:${digest(scoped.child)}`;
    const handoff=createHandoff({store,publications,binding:async()=>scoped,authorize,now:()=>clock,rediscoveryMs:5,
      host:{assertAvailable(){},subscribe:listener=>store.onActivityChange(listener),wake(){}}});
    return {handoff,controller,pathId,binding:scoped,expire:()=>{clock=Date.parse("2040-01-01T00:00:00Z");},
      start:()=>handoff.publish(result,controller.signal),path:()=>a({kind:"read_path",pathId}),stage:()=>a({kind:"read_stage",requestId:`${pathId}:capture`})};
  }
  const before=await store.readLatestRun(result.correlation.origin.parent.run.id);
  const retained=digest(before.control.descendantTransfers);
  const pre=probe("cancel-before");pre.controller.abort();assert.deepEqual(await pre.start(),{status:"unavailable",reason:"report_publication_cancelled"});assert.equal(await pre.path(),null);passed.push("cancel-before-publication");
  assert.equal((await pre.handoff.publish(result,new AbortController().signal)).reason,"report_publication_cancelled");
  let auth;auth=probe("cancel-authorize",async(_r,_b,signal)=>{auth.controller.abort();signal.throwIfAborted();});
  assert.equal((await auth.start()).reason,"report_publication_cancelled");assert.equal(await auth.path(),null);passed.push("abort-during-authorization");
  let allowed=false;const denied=probe("denied",async()=>allowed);assert.equal((await denied.start()).reason,"report_access_denied");assert.equal(await denied.path(),null);
  allowed=true;assert.equal((await denied.start()).reason,"report_access_denied");passed.push("explicit-authorization-denial");
  const expired=probe("expired-before");expired.expire();assert.equal((await expired.start()).reason,"report_publication_deadline");assert.equal(await expired.path(),null);passed.push("deadline-before-publication");
  for(const boundary of ["submitted","raw_result"]) {
    for(const reason of ["cancel","deadline"]) {
      const p=probe(`${boundary}-${reason}`),outcome=p.start();outcome.catch(()=>{});
      await waitFor(async()=>Boolean(await p.stage()));
      if(boundary==="raw_result"){await drain(2);assert.equal((await p.stage()).status,"raw_result");}
      if(reason==="cancel")p.controller.abort();else p.expire();
      assert.equal((await outcome).reason,reason==="cancel"?"report_publication_cancelled":"report_publication_deadline");
      assert.equal((await p.path()).cancelled,reason==="cancel");
      const schedule=await a({kind:"read_schedule",workId:p.pathId});assert.equal(schedule.closed,false);assert.equal(schedule.pathsSealed,true);
      await drain(reason==="deadline"?3:1);
      if(reason==="deadline") {
        assert.equal((await p.stage()).status,"accepted","A delivery wait deadline must not cancel the independently valid original publication");
        assert.equal((await store.materialCustody.command({kind:"state",intentId:`${p.pathId}:custody`})).state,"published");
      } else if(boundary==="raw_result") {
        assert.equal((await p.stage()).status,"settled");
        assert.equal((await store.materialCustody.command({kind:"state",intentId:`${p.pathId}:custody`})).state,"deleted");
      } else assert.equal((await p.stage()).attempt,null);
      const closed=await a({kind:"read_schedule",workId:p.pathId});assert(closed.closed&&closed.settlementConfirmed);
      assert((await a({kind:"read_reconsideration",subscriptionId:`${p.pathId}:source-lifecycle`,limit:1})).state.closed);
      assert.equal((await p.handoff.publish(result,new AbortController().signal)).status,"unavailable","Stop acceptance cannot reopen publication on recovery");
      passed.push(`${reason}-${boundary}`);
    }
  }
  // Parent access is independently withdrawn; published source and other owners remain intact.
  const admitted=probe("cancel-admitted"),acceptance=store.sharedAcceptance,originalAccept=acceptance.accept;
  acceptance.accept=async proposal=>{const receipt=await originalAccept.call(acceptance,proposal);
    if(proposal.actor==="helarc.report-handoff"&&receipt.outcome==="accepted")admitted.controller.abort();return receipt;};
  try {
    const outcome=admitted.start();outcome.catch(()=>{});await waitFor(async()=>Boolean(await admitted.stage()));await drain(3);
    assert.equal((await outcome).reason,"report_publication_cancelled");
    assert.equal((await store.materialCustody.command({kind:"state",intentId:`${admitted.pathId}:custody`})).state,"published");
    const id=`${result.narrative.source.recordId}:parent:${digest(admitted.binding.parent)}`;
    await assert.rejects(()=>store.materialCustody.command({kind:"describe",holdId:`${id}:hold`,recipient:admitted.binding.parent}));
  } finally {acceptance.accept=originalAccept;}
  passed.push("cancel-after-parent-access");
  const described=probe("cancel-describe"),custody=store.materialCustody,originalCommand=custody.command;
  custody.command=async command=>{const value=await originalCommand.call(custody,command);
    if(command.kind==="describe"&&command.recipient.recipient===described.binding.parent.recipient)described.controller.abort();return value;};
  try {
    const outcome=described.start();outcome.catch(()=>{});await waitFor(async()=>Boolean(await described.stage()));await drain(3);
    assert.equal((await outcome).reason,"report_publication_cancelled");
    const id=`${result.narrative.source.recordId}:parent:${digest(described.binding.parent)}`;
    await assert.rejects(()=>originalCommand.call(custody,{kind:"describe",holdId:`${id}:hold`,recipient:described.binding.parent}));
  } finally {custody.command=originalCommand;}
  passed.push("cancel-during-final-access-check");
  const race=probe("deadline-acceptance-race");let raced=false;
  acceptance.accept=async proposal=>{
    if(!raced&&proposal.parts.some(p=>p.kind==="fact_publication"&&p.proposal.ref.id===race.pathId&&p.proposal.ref.kind==="report_publication_deadline")){
      raced=true;await drain(3);
    }
    return originalAccept.call(acceptance,proposal);
  };
  try {
    const outcome=race.start();outcome.catch(()=>{});await waitFor(async()=>Boolean(await race.stage()));race.expire();
    assert.equal((await outcome).status,"published");assert(raced);assert.equal((await race.path()).cancelled,false);
  } finally {acceptance.accept=originalAccept;}
  passed.push("accepted-publication-wins-deadline-race");
  const originalRead=store.readLatestRun;
  store.readLatestRun=async()=>{throw new Error("controlled storage unavailability");};
  try {await assert.rejects(()=>probe("read-failure").start(),e=>e instanceof RunRecoveryError&&e.cause.message==="controlled storage unavailability");}
  finally {store.readLatestRun=originalRead;}
  passed.push("source-read-failure-preserves-recovery");
  assert.equal(digest((await store.readLatestRun(result.correlation.origin.parent.run.id)).control.descendantTransfers),retained);
  return passed;
};
