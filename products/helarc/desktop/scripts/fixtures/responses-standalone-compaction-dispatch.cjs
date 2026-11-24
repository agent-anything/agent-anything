const assert=require("node:assert/strict"),fs=require("node:fs"),{join,resolve,dirname,relative}=require("node:path");
const {digest,toolRoundtripGuard}=require("./responses-tool-roundtrip-dispatch.cjs"),{witness}=require("./responses-stored-continuation-dispatch.cjs");
const neutral=new Set(["stream","stream_options","background","store","include","metadata"]);
const carried=new Set(["model","input","instructions","previous_response_id","tools","tool_choice","parallel_tool_calls","reasoning","text","personality","truncation"]);
const ordered=v=>Array.isArray(v)?v.map(ordered):v&&typeof v==="object"?Object.fromEntries(Object.keys(v).sort().map(k=>[k,ordered(v[k])])):v;
function countKey(body){
  const content={};
  for(const [k,v] of Object.entries(body)){if(neutral.has(k))continue;assert(carried.has(k),"uncovered count field: "+k);content[k]=v;}
  return digest(JSON.stringify(ordered(content)));
}
function checkCaseCall(c,files,receipt){
  const a=JSON.parse(c.arguments),workspace=dirname(receipt);
  const matches=p=>typeof a.file_path==="string"&&relative(p,resolve(workspace,a.file_path))==="";
  if(/^Read(?:_|$)/.test(c.name))assert(files.some(matches),"read outside synthetic workspace");
  else if(/^Write(?:_|$)/.test(c.name))assert(matches(receipt)&&["REVIEWED","REVIEWED\n","REVIEWED\r\n"].includes(a.content),"write outside case");
  else assert(["update_plan","final_result"].includes(c.name),"unexpected local call");
  return a;
}
module.exports.checkCaseCall=checkCaseCall;
module.exports.guard=function({directory,phase,target,deadline,files,receipt},send,record){
  const eligible=c=>toolRoundtripGuard(target,send,()=>{},deadline).eligible(c)&&!c.isDefault;
  const history=fs.existsSync(join(directory,"attempt.ndjson"))?fs.readFileSync(join(directory,"attempt.ndjson"),"utf8").trim().split("\n").filter(Boolean).map(s=>JSON.parse(s)):[];
  const calls=history.filter(r=>r.kind==="dispatch"),counts={count:0,generate:0,compact:0},measured=new Map();
  for(const c of calls)counts[c.operation]++;
  for(const r of history.filter(r=>r.kind==="measured"))measured.set(r.key,r.tokens);
  const completed=new Set(history.filter(r=>r.kind==="finished").map(r=>r.call));
  assert(calls.every(c=>completed.has(c.call)),"unresolved dispatch from first process");
  let armed=false,stopped=false,recoverSend=phase==="recover";
  const completedCalls=new Set(history.filter(r=>r.kind==="local-call").map(r=>r.call));
  function observe(r){
    for(const c of (r.output??[]).filter(i=>i.type==="function_call")){
      const a=checkCaseCall(c,files,receipt);
      assert(c.call_id&&!completedCalls.has(c.call_id),"duplicate local call ID");completedCalls.add(c.call_id);
      record({kind:"local-call",name:c.name,call:c.call_id,path:a.file_path??null});
    }
  }
  return {counts,eligible,arm(c){assert(eligible(c));armed=true;},stop(){stopped=true;},async fetch(url,init){
    try{
      const base="https://api.openai.com/v1/responses",op=String(url)===base?"generate":String(url)===base+"/input_tokens"?"count":String(url)===base+"/compact"?"compact":null;
      assert(armed&&!stopped&&Date.now()<deadline&&op&&counts[op]<(op==="compact"?1:10),"dispatch limit or destination");
      assert.equal(init?.method,"POST");assert(typeof init.body==="string"||ArrayBuffer.isView(init.body));
      const bytes=Buffer.from(init.body),body=JSON.parse(bytes);assert(bytes.length<=262144 && body.model===target.model && Array.isArray(body.input),"unexpected body");
      assert(!body.previous_response_id&&!body.conversation&&!body.background&&!body.store&&!body.context_management,"unexpected native mode");
      assert((body.tools??[]).every(t=>t.type==="function"),"server tool outside case");
      const key=op==="compact"?null:countKey(body);
      if(op==="generate"){
        assert.equal(body.store,false);const n=measured.get(key);assert(Number.isSafeInteger(n)&&n<=16384,"generation lacks matching count within budget");
      }
      if(recoverSend){
        assert.equal(op,"generate","unexpected new preparation after adoption");
        assert(bytes.equals(fs.readFileSync(join(directory,"accepted.wire"))),"recovered bytes differ");recoverSend=false;
      }
      const index=++counts[op],call=op+"-"+index,sha256=digest(bytes);
      fs.writeFileSync(join(directory,call+".wire"),bytes,{flag:"wx"});
      record({kind:"dispatch",phase,operation:op,call,key,bytes:bytes.length,sha256,...(op==="generate"?{tokens:measured.get(key)}:{})});
      const res=await send(url,{...init,redirect:"error",signal:AbortSignal.any([...(init.signal?[init.signal]:[]),AbortSignal.timeout(Math.max(1,deadline-Date.now()))])});
      record({kind:"http",call,status:res.status,requestId:res.headers.get("x-request-id")});if(!res.ok){stopped=true;return res;}
      const finish=r=>{if(op==="generate")observe(r);record({kind:"finished",call,response:r.id??null});};
      if(op==="generate"&&body.stream)return witness(res,r=>{
        try{finish(r);}catch(error){record({kind:"witness-rejected",call,reason:error.message.split("\n")[0]});throw error;}
      },()=>{stopped=true;record({kind:"stream-incomplete",call});});
      const value=await res.clone().json();
      if(op==="count"){assert(Number.isSafeInteger(value.input_tokens)&&value.input_tokens>=0);measured.set(key,value.input_tokens);record({kind:"measured",call,key,tokens:value.input_tokens});}
      finish(value);return res;
    }catch(e){stopped=true;record({kind:"guard-stopped",reason:e.message.slice(0,180)});throw e;}
  }};
};
