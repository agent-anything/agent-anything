const assert=require("node:assert/strict"),fs=require("node:fs"),{join}=require("node:path");
const {setTimeout:delay}=require("node:timers/promises"),{createHash}=require("node:crypto");
// The nested result is charged to its own account AND consumes the branch's remaining grant.
const report="Gamma observations.\n"+"Detailed synthetic record; evidence retained.\n".repeat(500)+"DETAIL_CODE 6843";
// Cross the 16,000-character inline boundary without reporting Gamma's entire output a second time.
const betaReport="Beta observations.\n"+"Beta retained observation; see verification scope.\n".repeat(340)+"DETAIL_CODE 6843";
const prompt="HOST_ROOT: Delegate Alpha to ask for a decision and Beta to obtain an independent detailed report. Read the detail from Beta.";
const save=(d,n,v)=>fs.writeFileSync(join(d,n+".json"),JSON.stringify(v,null,2));
const read=(d,n)=>JSON.parse(fs.readFileSync(join(d,n+".json")));
const exists=(d,n)=>fs.existsSync(join(d,n+".json"));
const hash=b=>createHash("sha256").update(b).digest("hex");
function role(body){
  const users=body.input.filter(i=>i.role==="user").map(i=>i.content);
  if(users.includes(prompt))return "parent";
  return ["Alpha","Beta","Gamma"].find(n=>users.some(s=>s.startsWith("Parent assignment:")&&s.includes("CASE_"+n)));
}
const outputs=b=>b.input.filter(i=>i.type==="function_call_output");
const result=i=>JSON.parse(i.output).result;
async function serve(d,post,bytes,body,res){
  const branch=role(body);assert(branch,"Missing assignment");const items=outputs(body);
  fs.writeFileSync(join(d,`wire-${branch}-${items.length}.json`),bytes,{flag:"wx"});
  const call=(name,args)=>({name,args}),agent=n=>call("Agent",{description:n+" report",prompt:"CASE_"+n+": "+({
    Alpha:"Ask the user which option to use.",Beta:"Delegate the detailed report to Gamma, read its detail and report back.",Gamma:"Produce the full synthetic report."})[n]});
  let calls;
  if(branch==="parent"&&!items.length)calls=[agent("Alpha"),agent("Beta")];
  else if(branch==="Alpha"){assert.equal(items.length,0);calls=[call("AskUserQuestion",{questions:[{id:"choice",prompt:"Which option?",options:[{label:"A",description:"First option"}],allow_multiple:false}]})];}
  else if(branch==="Gamma"){assert.equal(items.length,0);calls=[call("final_result",{response:report})];}
  else if(branch==="Beta"&&!items.length)calls=[agent("Gamma")];
  else if(branch==="Beta"&&items.length===1){
    const ref=result(items[0]).output.report.reference;save(d,"waiting-beta",{ref});
    const deadline=Date.now()+65000;
    while(!exists(d,"cancel-admission")&&!res.destroyed){assert(Date.now()<deadline,"Beta gate expired");await delay(30);}
    if(res.destroyed)return;
    calls=[call("ContextMaterialRead",{reference:ref,offset:Buffer.byteLength(report)-64,length:64})];
  }else if(branch==="Beta"){
    assert.equal(items.length,2);assert(result(items[1]).output.text.includes("DETAIL_CODE 6843"));
    calls=[call("final_result",{response:betaReport})];
  }else{
    assert.equal(branch,"parent");const cut=read(d,"cancel-cut");
    if(items.length===2)assert(bytes.equals(Buffer.from(cut.body)),"Recovered Parent input differs from the adopted bytes");
    const [a,b]=items.map(result);assert.equal(a.childRunId,cut.alpha);assert.equal(b.childRunId,cut.beta);
    assert(a.status==="cancelled"||a.output?.status==="cancelled"||a.failure?.code?.includes("cancel"),JSON.stringify(a).slice(0,600));
    assert.equal(b.childTerminalStatus,"completed",b.failure?.message);assert.equal(b.output.report.status,"retained_material");
    assert(!bytes.includes(Buffer.from("Detailed synthetic record"))&&!bytes.includes(Buffer.from("Beta retained observation;")));
    const ref=b.output.report.reference;
    assert.equal(ref.revision,"sha256:"+hash(betaReport));
    if(items.length===2)calls=[call("ContextMaterialRead",{reference:ref,offset:Buffer.byteLength(betaReport)-64,length:64})];
    else{assert.equal(items.length,3);assert(result(items[2]).output.text.includes("DETAIL_CODE 6843"));
      calls=[call("final_result",{response:"Alpha was cancelled. Beta verified DETAIL_CODE 6843."})];}
  }
  const output=calls.map(({name,args},i)=>{
    const tool=body.tools.find(t=>t.name===name||t.name.startsWith(name+"_"));assert(tool,name);
    const values=Object.fromEntries(tool.parameters.required.map(k=>[k,null]));Object.assign(values,args);
    return {id:`fc_${post}_${i}`,call_id:`call_${post}_${i}`,type:"function_call",name:tool.name,arguments:JSON.stringify(values),status:"completed"};
  });
  res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({id:"resp_"+post,object:"response",model:"controlled",status:"completed",output,
    usage:{input_tokens:100,output_tokens:20,total_tokens:120}}));
}

async function seed({directory:d,services,selected,store,app,inspection}){
  const c=services.controller;let root,alpha,beta,command;
  const accept=store.sharedAcceptance.accept.bind(store.sharedAcceptance);
  store.sharedAcceptance.accept=async proposal=>{
    const receipt=await accept(proposal),input=proposal.parts.find(p=>p.kind==="selection_input")?.proposal.input;
    if(receipt.outcome==="accepted"&&root&&proposal.scope===root&&input?.exactInput.wire?.body&&
        proposal.parts.some(p=>p.kind==="native_input_return")&&outputs(JSON.parse(input.exactInput.wire.body)).length===2){
      assert(exists(d,"cancel-admission"));const admission=await store.readProductRun(root);
      save(d,"cancel-cut",{root,alpha,beta,threadId:admission.sessionId,command,pid:process.pid,electron:process.versions.electron,
        recording:inspection.recorder.ref("runtime","run",root,root),
        generation:store.generation,body:input.exactInput.wire.body,acceptance:proposal.id});app.exit(73);return new Promise(()=>{});
    }
    return receipt;
  };
  const start=await services.startProtocolRun({taskText:prompt,target:{kind:"new_thread"}},selected);assert(start.ok);
  const deadline=Date.now()+80000;
  while(!exists(d,"waiting-beta")||!c.getSnapshot().run?.host.pendingInteractions.length){
    assert(c.getSnapshot().execution!=="idle"&&Date.now()<deadline,"Did not reach Beta material and Alpha interaction");await delay(35);
  }
  root=c.getSnapshot().run.host.runTree.rootRunId;
  const tree=await store.readRunTree(root),children=tree.commit.checkpoint.nodes.filter(n=>n.lineage.parent?.id===root).sort((a,b)=>a.dispatch.siblingIndex-b.dispatch.siblingIndex);
  assert.equal(children.length,2);[alpha,beta]=children.map(n=>n.runId);
  assert.equal(children[0].dispatch.controllerTurnId,children[1].dispatch.controllerTurnId);
  const target=c.getSnapshot().run.host.activeDelegations.find(x=>x.child.id===alpha);assert(target);
  const ref=read(d,"waiting-beta").ref;
  const {HELARC_CONTROLLER_CAPABILITY:purpose}=await import("@agent-anything/helarc/controller");
  const betaState=tree.members.find(m=>m.head.state.run.id===beta).head.state;
  const recipient={runId:beta,recipient:betaState.activeAgent.id,purpose};
  const {helarcReportDeliveryRef}=await import("../../dist/main/context/HelarcNativeReportDelivery.js");
  const obligation=helarcReportDeliveryRef(ref,recipient);
  const custody=async()=>({access:await store.materialCustody.command({kind:"resolve_reference",reference:ref,recipient}),
    delivery:await store.materialDeliveries.query({kind:"obligation",ref:obligation})});
  const before=await custody();assert(before.access&&before.delivery.protection.selected&&!before.delivery.discharged.length);
  command={version:1,kind:"descendant.cancel",commandId:"p05-cancel-alpha",runId:root,payload:{parentRunId:root,childRunId:alpha,
    relationId:target.relation.id,requestId:target.request.id,requestRevision:target.request.revision,reason:"Stop only Alpha"}};
  const mismatch=await c.dispatchHostCommand({...command,commandId:"mismatched",payload:{...command.payload,childRunId:beta}},command.kind);
  assert.equal(mismatch.result?.code,"delegation_route_mismatch");
  const receipt=await c.dispatchHostCommand(command,command.kind);
  assert.equal(receipt.result?.cancellation?.status,"accepted",JSON.stringify({status:receipt.status,result:receipt.result,code:receipt.code}));
  const after=await custody();assert.deepEqual(after,before);
  const now=await store.readRunTree(root),cn=now.commit.checkpoint.nodes.find(n=>n.runId===alpha);
  assert.equal(cn.cancellation.scope,"subtree");assert(now.commit.checkpoint.nodes.every(n=>n.runId===alpha||!n.cancellation));
  assert.equal(now.members.find(m=>m.head.state.run.id===alpha).head.state.cancellationRequest.delegation.commandId,command.commandId);
  save(d,"cancel-admission",{root,alpha,beta,ref,obligation,before,after,request:receipt.result.cancellation.request,revision:now.commit.revision});
  while(Date.now()<deadline&&c.getSnapshot().execution!=="idle")await delay(40);
  throw Error("No durable post-cancellation Parent input at the send boundary: "+JSON.stringify(c.getSnapshot().error));
}
async function resume({directory:d,services,store,inspection,settled}){
  const cut=read(d,"cancel-cut"),prior=read(d,"cancel-admission"),c=services.controller;
  assert(process.pid!==cut.pid&&store.generation>cut.generation);
  assert.equal((await store.sharedAcceptance.query(cut.acceptance)).outcome,"accepted");
  const retained=(await c.listRecoverableWork()).find(w=>w.id===cut.root);assert(retained);
  const resumed=await c.recoverWork({id:retained.id,revision:retained.revision,intent:"continue"});assert(resumed.ok,resumed.message);
  await settled();
  const tree=await store.readRunTree(cut.root),members=tree.members.map(m=>m.head.state),root=members.find(s=>s.run.id===cut.root);
  assert.equal(members.length,4);assert.equal(root.finalOutput.summary,"Alpha was cancelled. Beta verified DETAIL_CODE 6843.");
  assert(members.every(s=>s.status===(s.run.id===cut.alpha?"cancelled":"completed")));
  const pairs=root.items.filter(i=>i.payload.kind==="model_call_settlement").map(i=>i.payload.result);
  assert.equal(pairs.filter(c=>/^Agent_/.test(c.name)).length,2);
  for(const [state,expected] of members.map(s=>[s,s.run.id===cut.root?["Agent","Agent","ContextMaterialRead","final_result"]:
        s.run.id===cut.alpha?["AskUserQuestion"]:s.run.id===cut.beta?["Agent","ContextMaterialRead","final_result"]:["final_result"]])){
    const calls=state.items.filter(i=>i.payload.kind==="model_call_settlement").map(i=>i.payload.result);
    assert.deepEqual(calls.map(c=>c.name.replace(/_[0-9a-f]{12}$/,"")),expected);
    assert.equal(new Set(calls.map(c=>c.modelCallRef.id)).size,calls.length);
  }
  const request=members.find(s=>s.run.id===cut.alpha).cancellationRequest;assert.deepEqual(request,prior.request);
  const del=await store.materialDeliveries.query({kind:"obligation",ref:prior.obligation});assert.equal(del.discharged.length,1);
  const facts=await store.materialDeliveryFacts(cut.root,0,128);assert.equal(facts.filter(f=>f.kind==="material_delivery.evidence"&&f.value.kind==="receipt").length,1);
  assert.equal((await c.listRecoverableWork()).length,0);
  await services.close();
  const flush=await inspection.flushRecording(true),coverage=inspection.recorder.health().coverage.recording;
  assert.equal(flush.native,"settled");assert.equal(flush.unconfirmed+flush.unpersisted+coverage.ingress.rejected+coverage.ingress.dropped+coverage.native.rejected,0);
  const recording=inspection.recorder.ref("runtime","run",cut.root,cut.root);
  save(d,"cancel-resumed",{pid:process.pid,generation:store.generation,recording,coverage,flush,request,memberStatus:members.map(s=>[s.run.id,s.status]),
    parentReceipt:facts.find(f=>f.kind==="material_delivery.evidence"&&f.value.kind==="receipt").sequence,
    parentBytes:Buffer.byteLength(cut.body),sha256:hash(cut.body)});
}
module.exports={serve,seed,resume};
