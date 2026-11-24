const assert=require("node:assert/strict"),fs=require("node:fs"),{join}=require("node:path"),{createHash}=require("node:crypto");
const material=require("./native-application-material.cjs");
const sha=b=>createHash("sha256").update(b).digest("hex");
const capacity=16080,threshold=14450;
const rootPrompt=material.rootPrompt+" Alpha must read once.txt before reporting its own result.";
const role=b=>b.input.some(i=>i.role==="user"&&i.content.startsWith("HOST_ROOT"))?"parent":
  b.input.some(i=>i.role==="user"&&i.content.includes("HOST_CHILD_ALPHA"))?"alpha":"beta";
function hasDetail(body){return body.input.some(i=>i.type==="function_call_output"&&JSON.parse(i.output).result?.output?.text?.includes("DETAIL_CODE 6843"));}
async function calls(body,directory){
  if(role(body)==="alpha"){
    assert(!JSON.stringify(body.input).includes("HOST_CHILD_BETA"));
    const results=body.input.filter(i=>i.type==="function_call_output");
    if(!results.length)return [{name:"Read",values:{file_path:"once.txt"}}];
    assert.equal(results.length,1);assert(results[0].output.includes("ORIGINAL"));
    const deadline=Date.now()+15000;
    while(!fs.existsSync(join(directory,"beta-transfer.json"))){
      assert(Date.now()<deadline,"Alpha read succeeded but Beta's retained transfer did not arrive while Alpha was active");
      await new Promise(r=>setTimeout(r,25));
    }
    return [{name:"final_result",values:{response:"Child result 7391"}}];
  }
  const plans=material.calls(body);
  if(plans.length===2){
    plans[0].values.prompt="HOST_CHILD_ALPHA: Read once.txt and confirm ORIGINAL before reporting 7391 using final_result.";
    return plans.reverse();
  }
  return plans;
}
function interrupt(store,app,directory){
  let seen=false;
  const commit=store.commitRunTree.bind(store);
  store.commitRunTree=async value=>{
    const receipt=await commit(value);
    if(!seen){
      const t=value.runs.flatMap(r=>r.control?.descendantTransfers??[]).find(t=>t.narrative?.text===material.report);
      if(t){
        seen=true;const root=value.checkpoint.input.rootRunId,beta=t.childRunId;
        const children=value.checkpoint.nodes.filter(n=>n.runId!==root);
        assert.equal(children.length,2);
        const alpha=children.find(n=>n.runId!==beta),b=children.find(n=>n.runId===beta);
        assert(b&&alpha?.startedAt&&!alpha.completedAt);
        assert.equal(alpha.dispatch.requestedForm,"concurrent_sibling");assert.equal(b.dispatch.requestedForm,"concurrent_sibling");
        assert.equal(alpha.dispatch.controllerTurnId,b.dispatch.controllerTurnId);assert.notEqual(alpha.dispatch.siblingIndex,b.dispatch.siblingIndex);
        fs.writeFileSync(join(directory,"beta-transfer.json"),JSON.stringify({commit:value.id,revision:value.revision,root,alpha:alpha.runId,beta,
          alphaStatus:alpha.status,turn:b.dispatch.controllerTurnId,source:t.narrative.source,result:t.result.ref}));
      }
    }
    return receipt;
  };
  const accept=store.sharedAcceptance.accept.bind(store.sharedAcceptance);
  store.sharedAcceptance.accept=async proposal=>{
    const receipt=await accept(proposal);
    const input=proposal.parts.find(p=>p.owner==="context_selection"&&p.kind==="selection_input")?.proposal.input;
    if(receipt.outcome==="accepted"&&input?.exactInput?.wire?.body&&proposal.parts.some(p=>p.kind==="native_input_return")){
      const raw=input.exactInput.wire.body,body=JSON.parse(raw);
      if(role(body)==="parent"&&hasDetail(body)){
        const {root,alpha,beta}=JSON.parse(fs.readFileSync(join(directory,"beta-transfer.json")));
        assert.equal(proposal.scope,root);const grant=input.exactInput.compactionAgreement;
        const a=await store.readProductRun(root);
        fs.writeFileSync(join(directory,"root.json"),JSON.stringify({root,threadId:a.sessionId}));
        fs.writeFileSync(join(directory,"siblings-seed.json"),JSON.stringify({pid:process.pid,generation:store.generation,electron:process.versions.electron,
          root,alpha,beta,acceptance:proposal.id,inputId:input.id,wire:input.exactInput.wire.digest,adoptedBody:raw,sha256:sha(raw),
          agreementId:grant?.id??null,eligibilityId:grant?.useEvidence.id??null}));
        app.exit(73);return new Promise(()=>{});
      }
    }
    return receipt;
  };
}
function audit(directory,seed,last,requests,hashes){
  const {DatabaseSync}=require("node:sqlite"),read=name=>JSON.parse(fs.readFileSync(join(directory,name)));
  const {sourceId,datasetId}=last.recording,ins=new DatabaseSync(join(directory,"inspection","sources",sourceId,"datasets",datasetId,"inspection.sqlite"),{readOnly:true});
  const ex=new DatabaseSync(join(directory,"execution","execution.sqlite"),{readOnly:true});
  try{
    const parent=requests.filter(r=>role(r)==="parent"),alpha=requests.filter(r=>role(r)==="alpha"),beta=requests.filter(r=>role(r)==="beta");
    assert.equal(parent.length,5);assert.equal(alpha.length,2);assert.equal(beta.length,1);
    const wire=parent.at(-1),delivery=read("siblings-delivery.json"),transfer=read("beta-transfer.json");
    assert.equal(hashes.at(-1),seed.sha256);assert.deepEqual([transfer.root,transfer.alpha,transfer.beta],[seed.root,seed.alpha,seed.beta]);
    const calls=wire.input.filter(i=>i.type==="function_call"),results=wire.input.filter(i=>i.type==="function_call_output");
    assert.deepEqual(calls.map(c=>c.name.split("_")[0]),["Write","Agent","Agent","ContextMaterialSearch","ContextMaterialRead"]);
    assert.deepEqual(results.map(i=>i.call_id),calls.map(i=>i.call_id));assert.equal(new Set(calls.map(c=>c.call_id)).size,calls.length);
    const [,b,a,search,page]=results.map(r=>JSON.parse(r.output).result);
    assert.equal(a.childRunId,seed.alpha);assert.equal(b.childRunId,seed.beta);assert.equal(a.output.summary,"Child result 7391");
    assert.equal(delivery.reference.revision,"sha256:"+sha(material.report));
    for(const ref of [b.output.report.reference,JSON.parse(calls[3].arguments).references[0],search.output.matches[0].description.reference,
      JSON.parse(calls[4].arguments).reference,page.output.description.reference])assert.deepEqual(ref,delivery.reference);
    assert.equal(page.output.byteStart,search.output.matches[0].byteStart);assert(hasDetail(wire));
    for(const p of parent)assert(!JSON.stringify(p.input).includes("Detailed synthetic record"));
    const inInspector=ins.prepare("SELECT id FROM records WHERE id=? AND run_id=?");
    assert(inInspector.get("material-delivery:"+seed.root+":"+delivery.receipt,seed.root));
    for(const [run,count] of [[seed.root,5],[seed.alpha,2],[seed.beta,1]]){
      const facts=ex.prepare("SELECT sequence,value FROM protocol_facts WHERE run_id=? AND activity_id LIKE '%:native-task' ORDER BY sequence").all(run);
      for(const kind of ["dispatch_intent","purpose_accepted"]){
        const relevant=facts.filter(f=>JSON.parse(f.value).kind===kind);assert.equal(relevant.length,count);
        for(const f of relevant)assert(inInspector.get("protocol-execution:"+run+":"+f.sequence,run));
      }
    }
    const c=JSON.parse(ins.prepare("SELECT coverage FROM dataset").get().coverage);
    assert.equal(c.dropped+c.rejected+c.recording.native.rejected+c.recording.ingress.rejected,0);
    assert.equal(last.inspection.unpersisted+last.inspection.unconfirmed,0);
    assert.deepEqual(c.recording.ingress.history,{started:2,confirmed:2,incomplete:0});
    return {transfer,delivery,parentRequests:parent.length,alphaRequests:alpha.length,betaRequests:beta.length,sha256:seed.sha256,
      peerBytes:Buffer.byteLength(seed.adoptedBody),captured:c.captured,duplicates:c.recording.native.duplicates,projection:last.inspection.projection};
  }finally{ex.close();ins.close();}
}
module.exports={capacity,threshold,rootPrompt,role,hasDetail,calls,interrupt,audit};
