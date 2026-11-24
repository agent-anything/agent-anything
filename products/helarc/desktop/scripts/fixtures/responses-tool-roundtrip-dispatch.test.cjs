const {test}=require("node:test"),assert=require("node:assert/strict"),{toolRoundtripGuard}=require("./responses-tool-roundtrip-dispatch.cjs");
const target={id:"id",revision:"r",binding:"b",model:"test"};
const config={...target,connectionBindingId:"b",protocol:"openai.responses",baseUrl:"https://api.openai.com/v1",
  native:{transport:"http",stream:true,store:false,background:false,continuity:"replay",allowInRequestCompaction:false}};
const url="https://api.openai.com/v1/responses";
const init={method:"POST",headers:{Authorization:"secret-canary"},body:JSON.stringify({model:"test",store:false,stream:true,input:[]})};
function fixture(){const records=[],sent=[];const guard=toolRoundtripGuard(target,async(u,i)=>{sent.push([u,i]);return new Response();},r=>records.push(r),Date.now()+60000);
  return {guard,records,sent};}
test("scope and independent budgets are enforced before dispatch; no header or body dump",async()=>{
  const {guard,records,sent}=fixture();
  for(const key of ["id","revision","connectionBindingId","model"])assert.throws(()=>guard.arm({...config,[key]:"other"}));
  guard.arm(config);
  for(let n=0;n<4;n++){await guard.fetch(url+"/input_tokens",init);await guard.fetch(url,init);}
  await assert.rejects(guard.fetch(url,init));assert.equal(sent.length,8);assert.equal(sent[0][1].redirect,"error");
  assert(!JSON.stringify(records).includes("secret-canary"));
});
test("another endpoint, remote storage, or server tool cannot spend the allowance",async()=>{
  for(const [u,b] of [[url+"?other",{}],[url,{store:true}],[url,{tools:[{type:"web_search"}]}]]){
    const {guard,sent}=fixture();guard.arm(config);await assert.rejects(guard.fetch(u,{...init,body:JSON.stringify({...JSON.parse(init.body),...b})}));
    assert.equal(sent.length,0);
  }
});
