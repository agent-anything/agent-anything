const {test}=require("node:test"),assert=require("node:assert/strict");
const {guard,eligible,digest}=require("./responses-stored-continuation-dispatch.cjs");
const {review}=require("./responses-stored-continuation-audit.cjs");
const base="https://api.openai.com/v1", target={id:"stored-continuation",revision:"rev",binding:"binding",model:"test"};
const config={...target,baseUrl:base,connectionBindingId:target.binding,protocol:"openai.responses",isDefault:false,
  archived:false,native:{stream:true,store:true,continuity:"stored-response",transport:"http",background:false}};
const body=(previous)=>({model:target.model,input:[],stream:true,store:true,...previous?{previous_response_id:previous}:{}});
const post=(g,b,endpoint="responses")=>g.fetch(base+"/"+endpoint,{method:"POST",body:JSON.stringify(b)});
test("real sender only receives new work using this attempt's observed predecessor",async()=>{
  const req=[];
  const send=async(url,init)=>{
    req.push(url);if(url.endsWith("/input_tokens"))return Response.json({input_tokens:10});
    const data=Buffer.from('data: '+JSON.stringify({type:"response.completed",response:{id:"resp_"+req.length,status:"completed"}})+'\r\n\r\n');
    return new Response(new ReadableStream({start(ctl){ctl.enqueue(data.subarray(0,11));ctl.enqueue(data.subarray(11));ctl.close();}}),
      {headers:{"content-type":"text/event-stream"}});
  };
  const g=guard(target,send,()=>{},Date.now()+30000);g.arm(config);
  await (await post(g,body())).text();
  await post(g,{model:target.model,input:[],previous_response_id:"resp_1"},"responses/input_tokens");
  await (await post(g,body("resp_1"))).text();
  await assert.rejects(()=>post(g,body("resp_1")));assert.equal(req.length,3);
  assert(!eligible({...config,isDefault:true},target));assert(!eligible({...config,native:{...config.native,store:false}},target));
});
test("wire audit distinguishes valid use from wrong predecessor, repeated prefix or missing evidence",()=>{
  const c={target,first:"index.txt",second:"other.txt",value:"marker",prompt:"objective"};
  const e={status:"completed",delivered:true,visible:c.value,final:c.value,dropped:0,rejected:0,flush:"settled",counts:{generate:3,count:0},
    settlements:["Read_id","Read_id","final_result"].map((name,i)=>({name,call:"call"+i,status:"succeeded"}))};
  const ts=e.settlements.map((s,i)=>{
    const b={...body(i?"resp_"+(i-1):null),input:!i?[{role:"user",content:c.prompt}]:
      [{type:"function_call_output",call_id:"call"+(i-1),output:i===1?c.second:c.value}]};
    return {body:b,wire:{index:i+1,digest:digest(JSON.stringify(b))},observed:"resp_"+i,
      response:{status:"completed",id:"resp_"+i,output:[{type:"function_call",id:"item"+i,call_id:s.call,name:s.name,
        arguments:JSON.stringify(i<2?{file_path:i?c.second:c.first}:{response:c.value})}]}};
  });
  review(c,e,ts);
  for(const change of [t=>t.body.previous_response_id="resp_foreign",t=>t.body.input.push({role:"user",content:c.prompt}),
    t=>t.body.input.push({id:"item0",type:"reasoning"}),t=>t.body.input[0].output="not the answer"]){
    const copy=structuredClone(ts);change(copy[2]);copy[2].wire.digest=digest(JSON.stringify(copy[2].body));
    assert.throws(()=>review(c,e,copy));
  }
});
