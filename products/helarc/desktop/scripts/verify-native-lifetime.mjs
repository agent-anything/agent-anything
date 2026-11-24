import assert from "node:assert/strict";
import {cp,mkdtemp,readFile,readdir,writeFile} from "node:fs/promises";
import {DatabaseSync} from "node:sqlite";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {fileURLToPath} from "node:url";
import {spawn} from "node:child_process";
import {createServer} from "node:http";
import electron from "electron";
import {nativeVerificationEnvironment} from "./fixtures/native-verification-environment.mjs";
import connectionProbe from "./fixtures/native-connection-retirement.cjs";

const mode=process.argv[2],connectionOnly=["connection-retire","connection-integrity"].includes(mode);
const fromCheckpoint=mode==="retire"||mode==="integrity"||connectionOnly;assert(fromCheckpoint||["provisional","admitted","child","unknown","remote","takeover","preadopt"].includes(mode));
const keepCut=process.argv.includes("--retain-retirement-cut");assert(!keepCut||mode==="remote");
const pendingOnly=process.argv.includes("--pending-only");assert(!pendingOnly||mode==="remote"&&!keepCut);
const recordingOff=process.argv.includes("--recording-off");assert(!recordingOff||mode==="preadopt");
const directory=await mkdtemp(join(tmpdir(),"helarc-p05-"+mode+"-")),traffic=[];
if(recordingOff)await writeFile(join(directory,"inspection-settings.json"),JSON.stringify({formatVersion:1,
  settings:{enabled:false,definition:true,agent:true,provider:true,execution:true}}),{flag:"wx"});
let port=0;
if(fromCheckpoint){
  const source=process.argv[3];assert((connectionOnly?/^helarc-p05-unknown-[a-z0-9]+$/i:/^helarc-p05-remote-[a-z0-9]+$/i).test(source??""));
  const root=join(tmpdir(),source),cfg=JSON.parse(await readFile(join(root,"application-provider.json"))),url=new URL(cfg.baseUrl);
  const completed=JSON.parse(await readFile(join(root,"result.json")));assert.equal(completed.mode,connectionOnly?"unknown":"remote");
  assert.equal(url.hostname,"127.0.0.1");assert.equal(cfg.model,"controlled");port=Number(url.port);
  for(const name of ["execution","provider-registry","electron","cut.json","application-provider.json"])
    await cp(join(root,name),join(directory,name),{recursive:true,errorOnExist:true,force:false});
  const cut=JSON.parse(await readFile(join(directory,"cut.json")));
  assert.equal(completed.verified.root,cut.root);
  if(connectionOnly){
    connectionProbe.prepare(directory,source,mode,completed.verified);
  }else{
    assert.equal(completed.verified.handoff.id,cut.handoff);
    assert.equal(completed.verified.handoff.activityId,cut.activity);
    const db=new DatabaseSync(join(directory,"execution","execution.sqlite"));
    try{
      const state=JSON.parse(db.prepare("select value from protocol_activities where id=?").get(cut.activity).value);
      assert.equal(state.activity.scope.runId,cut.root);assert(state.cancelled&&!state.retentionReleased);
      assert.equal(db.prepare("select closed from protocol_reconciliations where id=? and activity_id=?").get(cut.handoff,cut.activity)?.closed,1);
      const registry=new DatabaseSync(join(directory,"provider-registry","registry.sqlite"),{readOnly:true});
      try{assert.equal(registry.prepare("select state from pins where id=?").get(cut.activity+":connection")?.state,"confirmed");}
      finally{registry.close();}
      if(mode==="integrity"){
        const row=db.prepare("select bytes from protocol_content_chunks where id=? and offset=0").get(state.input.id);
        const damaged=Buffer.from(row.bytes);assert(damaged.length);damaged[0]^=1;
        db.prepare("update protocol_content_chunks set bytes=? where id=? and offset=0").run(damaged,state.input.id);
      }
    }finally{db.close();}
    await writeFile(join(directory,"origin.json"),JSON.stringify({evidence:source,mode,activity:cut.activity}));
  }
}
let peerFailure,currentPhase;
const childStages=[];
async function childCredentialEvents(phase){
  const rows=(await readFile(join(directory,"credential-"+phase+".ndjson"),"utf8")).trim().split("\n").map(s=>JSON.parse(s));
  assert.equal(rows[0].kind,"start");
  return rows;
}
const generations=()=>traffic.filter(t=>t.path==="/v1/responses");
const peer=createServer(async(req,res)=>{
  const trace={method:req.method,path:req.url,phase:currentPhase};traffic.push(trace);
  if(!["child","unknown","remote","preadopt"].includes(mode)){res.writeHead(503);res.end();return;}
  try{
    if(mode==="child")trace.workLookups=(await childCredentialEvents(trace.phase)).filter(r=>r.kind==="lookup"&&r.segment==="work").length;
    const chunks=[];for await(const b of req)chunks.push(b);const raw=Buffer.concat(chunks),body=raw.length?JSON.parse(raw):null;
    const send=value=>{res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify(value));};
    if(req.url==="/v1/responses/input_tokens"){
      assert.equal(req.method,"POST");return send({object:"response.input_tokens",input_tokens:100});
    }
    if(mode==="remote"){
      const id="resp_outstanding",base={id,object:"response",model:"controlled"};
      if(req.url==="/v1/responses"){
        assert.equal(req.method,"POST");assert(body.background&&body.store);await writeFile(join(directory,"wire-remote.json"),raw,{flag:"wx"});
        return send({...base,status:"in_progress",output:[]});
      }
      assert(req.method==="GET"&&req.url==="/v1/responses/"+id||req.method==="POST"&&req.url==="/v1/responses/"+id+"/cancel",
        "follow-up must retrieve or cancel the original resource");
      if(currentPhase==="lifetime-seed")return; // Keep the original resource outstanding at the process boundary.
      const initial=JSON.parse(await readFile(join(directory,"wire-remote.json")));
      const name=initial.tools.find(t=>/^Write(?:_|$)/.test(t.name)).name;
      return send({...base,status:"completed",output:[{type:"function_call",id:"fc_late",call_id:"call_late",name,status:"completed",
        arguments:JSON.stringify({file_path:"late.txt",content:"NOT AUTHORIZED"})}],usage:{input_tokens:100,output_tokens:20,total_tokens:120}});
    }
    assert.equal(req.url,"/v1/responses");assert.equal(req.method,"POST");
    if(mode==="preadopt"){
      const original=JSON.parse(await readFile(join(directory,"before-adoption.json")));
      assert(raw.equals(Buffer.from(original.body)));await writeFile(join(directory,"wire-adopted.json"),raw,{flag:"wx"});
      const tool=body.tools.find(t=>t.name==="final_result"),args={...Object.fromEntries(tool.parameters.required.map(k=>[k,null])),response:"Retained input used"};
      return send({id:"resp_use",object:"response",model:"controlled",status:"completed",output:[{id:"fc_use",type:"function_call",
        call_id:"call_use",name:tool.name,arguments:JSON.stringify(args),status:"completed"}],usage:{input_tokens:100,output_tokens:20,total_tokens:120}});
    }
    if(mode==="unknown"){await writeFile(join(directory,"wire-unknown.json"),raw,{flag:"wx"});return;}
    const root=JSON.stringify(body.input).includes("P05_ROOT:"),outputs=body.input.filter(i=>i.type==="function_call_output");
    trace.role=root?(outputs.length?"parent-final":"parent-first"):"child";
    await writeFile(join(directory,"wire-"+trace.role+".json"),raw,{flag:"wx"});
    const first=trace.role==="parent-first",tool=body.tools.find(t=>first?/^Agent(?:_|$)/.test(t.name):t.name==="final_result");
    const values=first?{description:"Check number",prompt:"P05_CHILD: report Child result 7391."}:{response:root?"Root received 7391":"Child result 7391"};
    if(trace.role==="parent-final"){
      const cut=JSON.parse(await readFile(join(directory,"cut.json")));
      const calls=body.input.filter(i=>i.type==="function_call"&&i.call_id==="call_parent-first");
      assert.equal(calls.length,1);assert.equal(outputs.length,1);assert.equal(outputs[0].call_id,calls[0].call_id);
      assert(outputs[0].output.includes("Child result 7391"));assert(outputs[0].output.includes(cut.child));
    }
    const args={...Object.fromEntries(tool.parameters.required.map(k=>[k,null])),...values};
    const id=trace.role;send({id:"resp_"+id,model:"controlled",object:"response",status:"completed",output:[
      {id:"fc_"+id,type:"function_call",name:tool.name,call_id:"call_"+id,arguments:JSON.stringify(args),status:"completed"}],
      usage:{input_tokens:100,output_tokens:20,total_tokens:120}});
  }catch(e){peerFailure??=e;res.writeHead(500);res.end();}
});
await new Promise((resolve,reject)=>peer.once("error",reject).listen(port,"127.0.0.1",resolve));
const endpoint="http://127.0.0.1:"+peer.address().port+"/v1";
console.log("Evidence:",directory);
try{
  const phases=pendingOnly?[["lifetime-seed",73]]:mode.endsWith("integrity")?[["lifetime-check-integrity",0]]:mode.endsWith("retire")?[["lifetime-logical",73],["lifetime-physical",73],["lifetime-retired",0]]:
    mode==="child"?[["lifetime-seed",73],["lifetime-observe",73],["lifetime-deliver",73],["lifetime-recover",0]]:
    [["lifetime-seed",73],["lifetime-recover",keepCut?73:0]];
  async function launch(phase,expected){
    currentPhase=phase;
    const env=nativeVerificationEnvironment({HELARC_P05_LIFETIME:mode,HELARC_VERIFICATION_PROTOCOL:"openai.responses",
      HELARC_VERIFICATION_RETIREMENT_CUT:keepCut?"1":"0",HELARC_VERIFICATION_PENDING_ONLY:pendingOnly?"1":"0"});
    await new Promise((resolve,reject)=>{
      const child=spawn(electron,[fileURLToPath(new URL("./fixtures/native-application-run.cjs",import.meta.url)),directory,phase,endpoint],
        {env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
      let log="",timedOut=false,cleanup=Promise.resolve();
      for(const s of [child.stdout,child.stderr])s.on("data",v=>log=(log+v).slice(-4000));
      const timer=setTimeout(()=>{timedOut=true;cleanup=new Promise(done=>{
        const k=spawn("taskkill",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});k.once("close",done);k.once("error",()=>{child.kill();done();});});},90000);
      child.once("error",e=>{clearTimeout(timer);reject(e);});
      child.once("close",async code=>{clearTimeout(timer);await cleanup;if(code===expected&&!timedOut)return resolve();
        reject(peerFailure??Error(phase+": "+await readFile(join(directory,"failure-"+phase+".txt"),"utf8").catch(()=>log)));});
    });
    if(peerFailure)throw peerFailure;
    if(mode==="preadopt"){
      assert.equal(generations().length,phase==="lifetime-seed"?0:1);
      assert.equal(traffic.filter(t=>t.path==="/v1/responses/input_tokens").length,1);
    }else if(mode==="child"){
      const roles={"lifetime-seed":["parent-first"],"lifetime-observe":["child","parent-final"],"lifetime-deliver":[],"lifetime-recover":[]};
      assert.deepEqual(traffic.filter(r=>r.phase===phase).map(r=>[r.method,r.path,r.role??null]),
        roles[phase].flatMap(role=>[["POST","/v1/responses/input_tokens",null],["POST","/v1/responses",role]]),
        phase+": verify measurements as well as generation");
      const marker={"lifetime-seed":"cut","lifetime-observe":"observed","lifetime-deliver":"before-ack","lifetime-recover":"verified"}[phase];
      const checkpoint=JSON.parse(await readFile(join(directory,marker+".json")));
      const rows=await childCredentialEvents(phase),requests=traffic.filter(r=>r.phase===phase);
      assert(rows.every(r=>r.pid===checkpoint.pid));assert.equal(rows.filter(r=>r.kind==="boundary").length,1);
      const lookups=segment=>rows.filter(r=>r.kind==="lookup"&&r.segment===segment).length;
      assert.deepEqual(requests.map(r=>r.workLookups),requests.map((_,i)=>i+1),phase+": one vault resolution per real request");
      assert.equal(lookups("work"),requests.length,phase+": no subsequent or replay-only lookup");
      if(phase!=="lifetime-seed")assert.equal(lookups("bootstrap"),0,phase+": no recovery bootstrap lookup");
      childStages.push({phase,pid:checkpoint.pid,generation:checkpoint.generation,entry:checkpoint.entry??"new",
        counts:requests.length-roles[phase].length,generations:roles[phase],workLookups:lookups("work"),bootstrapLookups:lookups("bootstrap")});
    }
    else if(mode==="unknown")assert.deepEqual(traffic.map(r=>[r.phase,r.method,r.path]),[
      ["lifetime-seed","POST","/v1/responses/input_tokens"],["lifetime-seed","POST","/v1/responses"]],"recovery must not access the Provider");
    else if(mode==="remote"){
      assert.equal(generations().length,1,"original create cannot silently be replayed");
      assert.deepEqual(traffic.filter(r=>r.path==="/v1/responses/input_tokens").map(r=>r.phase),["lifetime-seed"]);
      if(phase==="lifetime-recover")assert(traffic.some(r=>r.phase===phase),"original follow-up must reach the peer after restart");
    }
    else assert.deepEqual(traffic,[],"Neither provisional custody nor preactivation cancellation permits a Provider request");
  }
  if(mode==="takeover"){
    await launch("lifetime-profile",0);
    const resumed=async()=>{
      const deadline=Date.now()+35000;
      while(!await readFile(join(directory,"owner-released.json")).then(()=>true,()=>false)){
        assert(Date.now()<deadline,"original store not released");await new Promise(r=>setTimeout(r,40));
      }
      return launch("lifetime-recover",0);
    };
    const both=await Promise.allSettled([launch("lifetime-seed",73),resumed()]);
    for(const result of both)if(result.status==="rejected")throw result.reason;
  }else for(const [phase,expected] of phases)await launch(phase,expected);
  const verified=JSON.parse(await readFile(join(directory,"verified.json"),"utf8"));
  const scenario=pendingOnly?"remote-pending":recordingOff?"preadopt-recording-off":mode;
  if(recordingOff){
    const {sourceId}=JSON.parse(await readFile(join(directory,"cut.json"))).recording;
    const path=join(directory,"inspection","sources",sourceId,"datasets"),ids=await readdir(path);assert.equal(ids.length,2);
    for(const id of ids){const db=new DatabaseSync(join(path,id,"inspection.sqlite"),{readOnly:true});
      try{assert.equal(db.prepare("SELECT count(*) n FROM records").get().n,0);
        const coverage=JSON.parse(db.prepare("SELECT coverage FROM dataset").get().coverage);assert.equal(coverage.capture.enabled,false);}
      finally{db.close();}}
    verified.disabledRecordings=ids;
  }
  if(mode==="child"){
    assert.equal(new Set(childStages.map(s=>s.pid)).size,4);
    assert.deepEqual(childStages.map(s=>s.generation),[1,2,3,4]);
    assert.deepEqual(childStages.map(s=>s.entry),["new","interrupted","interrupted","delivery_pending"]);
  }
  await writeFile(join(directory,"result.json"),JSON.stringify({mode:scenario,traffic,verified,...(mode==="child"?{childStages}:{})},null,2));console.log(scenario,"passed");
}finally{await writeFile(join(directory,"traffic.json"),JSON.stringify(traffic));peer.closeAllConnections();await new Promise(r=>peer.close(r));}
