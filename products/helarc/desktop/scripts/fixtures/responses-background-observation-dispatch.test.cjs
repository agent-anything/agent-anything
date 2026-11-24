const {test}=require("node:test"),assert=require("node:assert/strict");
const {backgroundObservationGuard,eligible}=require("./responses-background-observation-dispatch.cjs");
const base="https://api.openai.com/v1",url=base+"/responses",target={id:"background-observation",revision:"r1",binding:"b1",model:"test"};
const config={...target,connectionBindingId:target.binding,protocol:"openai.responses",baseUrl:base,native:{
  transport:"http",background:true,allowTemporaryRetention:true,store:true,stream:false,continuity:"replay"}};
const post={method:"POST",body:JSON.stringify({model:"test",input:[],background:true,store:true,stream:false})};
function harness(replies){
  const calls=[],log=[];
  const g=backgroundObservationGuard(target,async(a,i)=>{calls.push([a,i.method]);const next=replies.shift();if(next instanceof Error)throw next;return Response.json(next);},
    r=>log.push(r),Date.now()+10000);g.arm(config);return {g,calls,log};
}
test("verify the returned original ID for each poll, no new generation",async()=>{
  const id="resp_same",{g,calls,log}=harness([{input_tokens:2},{id,status:"queued"},{id,status:"in_progress"},{id,status:"completed"}]);
  await (await g.fetch(url+"/input_tokens",{method:"POST",body:JSON.stringify({model:"test",input:[]})})).json();
  await (await g.fetch(url,post)).json();
  for(let i=0;i<2;i++)await(await g.fetch(url+"/"+id,{method:"GET"})).json();
  assert.deepEqual(calls.map(c=>c[1]),["POST","POST","GET","GET"]);
  assert.deepEqual(log.filter(r=>r.kind==="observation").map(r=>[r.id,r.status]),[[id,"queued"],[id,"in_progress"],[id,"completed"]]);
  await assert.rejects(()=>g.fetch(url+"/"+id,{method:"GET"}));assert.equal(calls.length,4);
});
test("a lost create cannot be replaced, including after rearming",async()=>{
  const {g,calls}=harness([Error("connection lost")]);await assert.rejects(()=>g.fetch(url,post));
  assert.throws(()=>g.arm(config));await assert.rejects(()=>g.fetch(url,post));assert.equal(calls.length,1);
});
test("another ID, cancel and duplicate create cannot spend the original authority",async()=>{
  for(const [u,i] of [[url+"/resp_other",{method:"GET"}],[url+"/resp_bound/cancel",{method:"POST"}],[url,post]]){
    const {g,calls}=harness([{id:"resp_bound",status:"queued"}]);await(await g.fetch(url,post)).json();
    await assert.rejects(()=>g.fetch(u,i));assert.equal(calls.length,1);
  }
  assert(!eligible({...config,native:{...config.native,allowTemporaryRetention:false}},target));
  assert(!eligible({...config,native:{...config.native,store:false}},target));
});
test("polling the right URL cannot certify a different returned ID",async()=>{
  const {g}=harness([{id:"resp_original",status:"queued"},{id:"resp_different",status:"completed"}]);await(await g.fetch(url,post)).json();
  await assert.rejects(async()=>(await g.fetch(url+"/resp_original",{method:"GET"})).json(),/another response/);
  assert.throws(()=>g.arm(config));
});
