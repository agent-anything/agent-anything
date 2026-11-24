import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {createServer} from "node:http";
import {mkdtemp,readFile,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import electron from "electron";
const root=await mkdtemp(join(tmpdir(),"helarc-native-cancellation-")),calls=[];let failure;
const server=createServer(async(req,res)=>{try{
  let text="";for await(const part of req)text+=part;
  calls.push({method:req.method,url:req.url});
  if(req.url.endsWith("/cancel")){
    assert.equal(req.method,"POST");assert(req.url.includes("known-response"));
    res.setHeader("Content-Type","application/json");res.end(JSON.stringify({id:"known-response",object:"response",status:"cancelled",output:[]}));return;
  }
  assert.equal(req.method,"POST");const body=JSON.parse(text),id=body.input[0].content;
  if(id==="unknown"){req.socket.destroy();return;}
  assert.equal(id,"known");res.setHeader("Content-Type","application/json");
  res.end(JSON.stringify({id:"known-response",object:"response",status:"queued",output:[]}));
}catch(error){failure=error;res.writeHead(500);res.end(String(error));}});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
try{
  for(const phase of ["seed","handoff","followup","verify"]){
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
    await new Promise((resolve,reject)=>{
      const child=spawn(electron,[fileURLToPath(new URL("./fixtures/native-purpose-cancellation.cjs",import.meta.url)),root,phase,`http://127.0.0.1:${server.address().port}`],
        {env,windowsHide:true,stdio:["ignore","pipe","pipe"]});let output="",timedOut=false,cleanup=Promise.resolve();
      child.stdout.on("data",b=>output=(output+b).slice(-6000));child.stderr.on("data",b=>output=(output+b).slice(-6000));
      const timer=setTimeout(()=>{timedOut=true;cleanup=new Promise(done=>{const kill=spawn("taskkill",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});
        kill.once("close",done);kill.once("error",()=>{child.kill();done();});});},60000);
      child.once("error",e=>{clearTimeout(timer);reject(e);});
      child.once("close",async code=>{clearTimeout(timer);await cleanup;
        if(code===0&&!timedOut&&!failure)resolve();else reject(failure??new Error(`${phase}: ${code}, timeout=${timedOut}\n${await readFile(join(root,`failure-${phase}.txt`),"utf8").catch(()=>output)}`));});
    });
    assert.equal(calls.length,phase==="seed"||phase==="handoff"?2:3);console.log(`${phase}: passed (${calls.length} native operations)`);
  }
  await writeFile(join(root,"verification.json"),JSON.stringify({calls,unknownNotRepeated:true,unsentNotCreated:true,cancelledNotInterpreted:true},null,2));
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));console.log(`Evidence: ${root}`);}
