const {app}=require("electron"),assert=require("node:assert/strict"),http=require("node:http"),net=require("node:net"),{once}=require("node:events");
const fs=require("node:fs"),{join}=require("node:path"),{tmpdir}=require("node:os");
app.setPath("userData",fs.mkdtempSync(join(tmpdir(),"helarc-http-deadline-")));app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-background-networking");
app.whenReady().then(async()=>{
  let code=0;
  const arrivals=[],httpPeer=http.createServer((req,res)=>{
    arrivals.push(req.url);req.resume();const t=setTimeout(()=>{
      res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({object:"response",id:"original",status:"completed",output:[]}));
    },15500);res.on("close",()=>clearTimeout(t));
  }),sockets=new Set(),tlsPeer=net.createServer(s=>{sockets.add(s);s.on("error",()=>{});s.on("close",()=>sockets.delete(s));});
  try{
    const {prepareResponses,ResponsesSession,DEFAULT_RESPONSES_OBSERVATION_POLICY:policy}=await import("@agent-anything/provider-integrations/native");
    for(const s of [httpPeer,tlsPeer]){s.listen(0,"127.0.0.1");await once(s,"listening");}
    async function run(name,baseUrl,connectMs,remaining,interrupt=false){
      const profile={transport:"http",background:false,stream:false,store:false,temporaryRetention:false,continuity:"native_replay",connectionIncarnation:null},
        prepared=prepareResponses({model:"local-test",purpose:{id:"assessment",revision:"1"},input:[{role:"user",content:"test"}],transport:"http",background:false,stream:false,store:false}),
        createdAt=Date.now(),segments=[],binding={id:name,scopeId:"local",target:"peer",prepared,profile,policy:{...policy,connectMs},createdAt,deadlineAt:createdAt+remaining,
          maximumBytes:65536,maximumFrameBytes:65536,maximumEvents:100};
      let state=null;const store={load:async()=>state,commit:async(_,v,s)=>{state=v;if(s)segments.push(s);},async *segments(n){yield* segments.slice(0,n);}};
      const session=await ResponsesSession.open(binding,store),signal=interrupt?AbortSignal.timeout(350):new AbortController().signal;
      await session.step({now:Date.now,jitter:()=>0,target:"peer",headers:{},baseUrl,authorize:async()=>{},signal});
      const head=session.snapshot();assert.equal(head.operations,1);assert.deepEqual((await ResponsesSession.open(binding,store)).snapshot(),head);
      console.log(name,Date.now()-createdAt,head.disposition,head.reason);
      return head;
    }
    const url="http://127.0.0.1:"+httpPeer.address().port;
    const slow=await run("delayed",url,15000,30000);assert.equal(slow.disposition,"terminal");assert.equal(slow.head.responseId,"original");
    assert.equal((await run("header-deadline",url,15000,400)).reason,"native_response_headers_deadline");
    assert.equal((await run("user-abort",url,15000,3000,true)).reason,"native_request_aborted");
    const stalled=await run("tls-stall","https://127.0.0.1:"+tlsPeer.address().port,200,4000);
    assert.equal(stalled.reason,"native_connect_timeout");assert.equal(arrivals.length,3);
  }catch(e){console.error(e);code=1;}finally{for(const s of sockets)s.destroy();tlsPeer.close();httpPeer.closeAllConnections();httpPeer.close();app.exit(code);}
});

