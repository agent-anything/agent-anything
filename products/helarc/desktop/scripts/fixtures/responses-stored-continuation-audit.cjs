const fs=require("node:fs"), path=require("node:path"), assert=require("node:assert/strict");
const {digest}=require("./responses-stored-continuation-dispatch.cjs");

// Compare service, dispatch, local settlement and Desktop evidence. No live transport.
function review(c,e,turns) {
  assert.equal(e.status,"completed");assert(e.delivered && e.visible===e.final && e.final.includes(c.value));
  assert.equal(e.dropped,0);assert.equal(e.rejected,0);assert.equal(e.flush,"settled");
  assert(turns.length>=3 && turns.length<=4);
  const seen=new Set(),received=new Set(),priorItems=new Set(),read=[],allCalls=[];
  let previous=null,expectedOutputs=[];
  for(const [index,t] of turns.entries()) {
    const {body,response,wire,measure}=t, suffix=body.input;
    assert.equal(wire.index,index+1);assert.equal(digest(JSON.stringify(body)),wire.digest);
    assert.equal(body.model,c.target.model);assert.equal(body.store,true);assert.equal(body.stream,true);
    assert.equal(body.previous_response_id??null,previous);
    assert.equal(response.status,"completed");assert(!seen.has(response.id));seen.add(response.id);
    assert.equal(t.observed,response.id);previous=response.id;
    assert.equal(body.conversation,undefined);assert.equal(body.context_management,undefined);
    const rendered=JSON.stringify(suffix);
    if(!index){assert(rendered.includes(c.prompt));assert(!rendered.includes(c.second) && !rendered.includes(c.value));}
    else assert(!rendered.includes(c.prompt),"original user input repeated in suffix");
    assert(!suffix.some(i=>i.type==="function_call"),"service-owned call repeated in suffix");
    assert(!suffix.some(i=>i.id && priorItems.has(i.id)),"service-owned output item repeated in suffix");
    const outputs=suffix.filter(i=>i.type==="function_call_output");
    assert.deepEqual(outputs.map(i=>i.call_id),expectedOutputs.map(i=>i.id));
    for(const [j,output] of outputs.entries()) {
      const s=expectedOutputs[j];assert(JSON.stringify(output.output).includes(s.value));received.add(s.id);
    }
    expectedOutputs=[];
    for(const item of response.output)if(item.id)priorItems.add(item.id);
    for(const call of response.output.filter(i=>i.type==="function_call")){
      assert(!allCalls.includes(call.call_id));allCalls.push(call.call_id);
      assert(e.settlements.some(s=>s.name===call.name && s.call===call.call_id && s.status==="succeeded"));
      if(/^Read(?:_|$)/.test(call.name)){
        const file=[c.first,c.second][read.length];assert(file);
        assert(Object.values(JSON.parse(call.arguments)).some(v=>typeof v==="string" && path.win32.basename(v)===file));
        if(read.length===1)assert(received.has(read[0]));
        expectedOutputs.push({id:call.call_id,value:read.length?c.value:c.second});read.push(call.call_id);
      }else{
        assert.equal(call.name,"final_result");assert.equal(index,turns.length-1);
        assert.equal(read.length,2);assert(received.has(read[1]));
      }
    }
    if(measure) {
      assert(Number.isSafeInteger(measure.tokens) && measure.tokens>0);
      assert.equal(measure.wire.previous,body.previous_response_id??null);
    }
  }
  assert.deepEqual(allCalls,e.settlements.map(s=>s.call));assert.equal(allCalls.length,3);
  assert.equal(e.counts.generate,turns.length);assert.equal(e.counts.count,turns.filter(t=>t.measure).length);
  assert.equal(e.settlements.at(-1).name,"final_result");
}

async function audit(directory) {
  const json=name=>JSON.parse(fs.readFileSync(path.join(directory,name+".json")));
  const c=json("case"),e=json("evidence"),log=fs.readFileSync(path.join(directory,"attempt.ndjson"),"utf8").trim().split("\n").map(JSON.parse);
  const {InspectionQueryService}=await import("@agent-anything/inspection/query"),q=new InspectionQueryService(path.join(directory,"inspection"));
  const get=request=>q.query({...e.selection,...request});
  async function content(desc){let offset=0,text="";do{const {content}=await get({kind:"get_content",contentId:desc.id,offset,length:65536});
    text+=content.text;offset=content.nextOffset;}while(offset!==null);return JSON.parse(text);}
  try {
    const page=await get({kind:"list_native_interactions",runId:e.root,limit:100});assert(!page.next);
    const data=new Map(), observed=log.filter(r=>r.kind==="remote-completed"), wire=log.filter(r=>r.kind==="generate");
    for(const r of page.records){
      const n=Number(/:controller_turn:(\d+):native-task/.exec(r.subject.id)?.[1]);assert(n);
      const turn=data.get(n)??{};data.set(n,turn);
      const refs=new Map();let after;
      do{const result=await get({kind:"get_native_interaction",subject:r.subject,limit:100,...after?{after}:{}});
        for(const row of result.records)for(const desc of row.contents)if(desc.availability==="present"&&!refs.has(desc.name))refs.set(desc.name,desc);
        after=result.next;}while(after);
      if(refs.has("input_tokens response")){
        const tokens=(await content(refs.get("input_tokens response"))).input_tokens;
        turn.measure={tokens};
      }else{
        assert(!turn.body);turn.body=(await content(refs.get("create"))).body;
        turn.response=(await content(refs.get("response.completed"))).response;
      }
    }
    const counts=log.filter(r=>r.kind==="count");
    const turns=[...data.entries()].sort((a,b)=>a[0]-b[0]).map(([n,t],i)=>{
      assert.equal(n,i+1);if(t.measure) t.measure.wire=counts.find(r=>r.previous===(t.body.previous_response_id??null));
      return {...t,wire:wire[i],observed:observed[i]?.response};
    });
    review(c,e,turns);
    const report={root:e.root,selection:e.selection,turns:turns.map(t=>({digest:t.wire.digest,previous:t.body.previous_response_id??null,
      response:t.response.id,calls:t.response.output.filter(i=>i.type==="function_call").map(i=>({name:i.name,id:i.call_id})),
      results:t.body.input.filter(i=>i.type==="function_call_output").map(i=>i.call_id),measured:t.measure?.tokens??null,usage:t.response.usage??null}))};
    fs.writeFileSync(path.join(directory,"wire-audit.json"),JSON.stringify(report,null,2));
    console.log("stored-continuation stored-response chain verified:",turns.length,"turns");
  } finally {await q.close();}
}
if(require.main===module)audit(process.argv[2]).catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={review};
