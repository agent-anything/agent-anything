import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {createServer} from "node:http";
import {mkdtemp,readFile,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import electron from "electron";
const root=await mkdtemp(join(tmpdir(),"helarc-observation-scheduling-")),posts=[];let failure;
const server=createServer(async(req,res)=>{try{
  if(req.url==="/received"){res.setHeader("Content-Type","application/json");res.end(JSON.stringify({running:posts.includes("running")}));return;}
  let body="";for await(const part of req)body+=part;
  assert.equal(req.method,"POST");const input=JSON.parse(body),id=input.messages[0].content;posts.push(id);
  assert.notEqual(id,"queued");
  if(id==="running")return;
  assert.equal(id,"later");res.setHeader("Content-Type","application/json");
  res.end(JSON.stringify({id:"later-response",object:"chat.completion",choices:[{index:0,message:{role:"assistant",content:"Retained once"},finish_reason:"stop"}]}));
}catch(error){failure=error;res.writeHead(500);res.end(String(error));}});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
try{
  for(const phase of ["seed","resume"]){
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
    await new Promise((resolve,reject)=>{
      const child=spawn(electron,[fileURLToPath(new URL("./fixtures/native-observation-scheduling.cjs",import.meta.url)),root,phase,`http://127.0.0.1:${server.address().port}`],
        {env,windowsHide:true,stdio:["ignore","pipe","pipe"]});let output="",timedOut=false,cleanup=Promise.resolve();
      child.stdout.on("data",b=>output=(output+b).slice(-6000));child.stderr.on("data",b=>output=(output+b).slice(-6000));
      const timer=setTimeout(()=>{timedOut=true;cleanup=new Promise(done=>{
        if(process.platform!=="win32"){child.kill("SIGKILL");done();return;}
        const kill=spawn("taskkill",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});
        kill.once("close",done);kill.once("error",()=>{child.kill();done();});
      });},60000);
      child.once("error",e=>{clearTimeout(timer);reject(e);});
      child.once("close",async code=>{clearTimeout(timer);await cleanup;
        if(code===0&&!timedOut&&!failure)resolve();else reject(failure??new Error(`${phase}: ${code}, timeout=${timedOut}\n${await readFile(join(root,`failure-${phase}.txt`),"utf8").catch(()=>output)}`));
      });
    });
    assert.deepEqual(posts,["running","later"]);console.log(await readFile(join(root,`${phase}.json`),"utf8"));
  }
  await writeFile(join(root,"verification.json"),JSON.stringify({posts,queuedNotDispatched:true,unknownNotRepeated:true,resourceReleased:true},null,2));
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));console.log(`Evidence: ${root}`);}
