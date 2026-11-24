import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {createServer} from "node:http";
import {mkdtemp,readFile,writeFile,rm,mkdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve,dirname,basename} from "node:path";
import {fileURLToPath} from "node:url";
import electron from "electron";
import {createRequire} from "node:module";
const {WebSocketServer}=createRequire(new URL("../../../../harness/integrations/providers/package.json",import.meta.url))("ws");
const root=await mkdtemp(join(tmpdir(),"helarc-native-transport-"));
const fixture=fileURLToPath(new URL("./fixtures/native-transport.cjs",import.meta.url)),desktop=fileURLToPath(new URL("../",import.meta.url));
const arg=process.argv.indexOf("--evidence"),evidencePath=arg<0?null:resolve(process.argv[arg+1]);
const requests=[],phases=[];let passed=false,serverFailure=null,cancels=0,socketCreates=0;
const reasoning={id:"reasoning-original",type:"reasoning",summary:[],encrypted_content:"item-done-opaque"};
const output=[{...reasoning,encrypted_content:"terminal-opaque"},{id:"function-original",type:"function_call",call_id:"call-original",name:"Write_a1",arguments:'{"path":"one.txt"}',status:"completed"}];
const response=(id,status)=>({id,object:"response",status,output:status==="completed"?output:[],usage:status==="completed"?{input_tokens:42,output_tokens:9,total_tokens:51}:null});
const event=(type,sequence_number,extra={})=>({type,sequence_number,...extra});
const done=event("response.function_call_arguments.done",2,{item_id:"function-original",arguments:'{"path":"one.txt"}'});
const server=createServer(async(req,res)=>{
  try{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const encoded=Buffer.concat(chunks).toString();
    const body=encoded?JSON.parse(encoded):null;requests.push({method:req.method,url:req.url,body});
    const stream=events=>{res.writeHead(200,{"content-type":"text/event-stream"});for(const value of events)res.write(`data: ${JSON.stringify(value)}\n\n`);res.end();};
    if(req.method==="POST"&&req.url==="/v1/responses"){
      const id=body.input[0].content;assert(["root","child"].includes(id));
      assert.equal(requests.filter(r=>r.url===req.url&&r.body?.input?.[0]?.content===id).length,1,"Creation must never repeat on recovery");
      assert.equal(body.background,true);assert.equal(body.instructions,undefined);assert.equal(body.max_output_tokens,undefined);
      if(id==="child"){res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify(response("response-child","queued")));}
      else stream([event("response.created",0,{response:response("response-root","in_progress")}),event("keepalive",999),
        event("response.function_call_arguments.delta",1,{item_id:"function-original",delta:'{"path":"one.txt"}'}),done]);
    }else if(req.method==="GET"&&req.url==="/v1/responses/response-root?stream=true&starting_after=2"){
      stream([done,event("response.output_item.done",3,{item:reasoning,output_index:0}),event("response.completed",4,{response:response("response-root","completed")})]);
    }else if(req.method==="POST"&&req.url==="/v1/responses/response-child/cancel"){
      cancels++;res.writeHead(cancels===1?503:200,{"content-type":"application/json"});res.end(JSON.stringify(cancels===1?{error:{code:"temporary"}}:response("response-child","completed")));
    }else throw new Error(`Unexpected ${req.method} ${req.url}`);
  }catch(error){serverFailure=error;if(!res.headersSent)res.writeHead(500);res.end("fixture failed");}
});
const wss=new WebSocketServer({server});
wss.on("connection",socket=>socket.on("message",data=>{
  try{
    const request=JSON.parse(data.toString());assert.equal(request.type,"response.create");assert.equal(request.input[0].content,"socket");
    assert.equal(request.stream,undefined);assert.equal(request.background,undefined);assert.equal(++socketCreates,1);
    socket.send(JSON.stringify(event("response.created",0,{response:response("response-socket","in_progress")})));
    socket.send(JSON.stringify(event("response.function_call_arguments.delta",1,{item_id:"socket-call",delta:'{"path":'})),()=>socket.close());
  }catch(error){serverFailure=error;socket.terminate();}
}));
async function launch(phase,expected,endpoint){
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const started=performance.now();
  await new Promise((done,reject)=>{
    const child=spawn(electron,[fixture,root,phase,endpoint],{cwd:desktop,env,windowsHide:true,stdio:["ignore","pipe","pipe"]});let output="",timedOut=false,killed=Promise.resolve();
    child.stdout.on("data",b=>output=(output+b).slice(-12000));child.stderr.on("data",b=>output=(output+b).slice(-12000));
    const timer=setTimeout(()=>{timedOut=true;killed=new Promise(resolve=>{
      const killer=spawn("taskkill",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});killer.once("close",resolve);killer.once("error",()=>{child.kill();resolve();});
    });},60000);
    child.once("error",error=>{clearTimeout(timer);reject(error);});
    child.once("close",async code=>{clearTimeout(timer);await killed;if(code===expected&&!timedOut)done();else reject(new Error(`${phase}: ${code}, timeout=${timedOut}\n${await readFile(join(root,`failure-${phase}.txt`),"utf8").catch(()=>output)}`));});
  });
  if(serverFailure)throw serverFailure;
  phases.push({...JSON.parse(await readFile(join(root,`${phase}.json`),"utf8")),wallMs:Math.round(performance.now()-started)});
  console.log(`${phase}: passed (${phases.at(-1).wallMs} ms)`);
}
try{
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));const endpoint=`http://127.0.0.1:${server.address().port}/v1`;
  await launch("seed",73,endpoint);await launch("resume",73,endpoint);await launch("followup",0,endpoint);
  await launch("socket",0,endpoint);await launch("socket-recovery",0,endpoint);await launch("scale",0,endpoint);await launch("faults",0,endpoint);await launch("verify",0,endpoint);
  assert.deepEqual(phases.map(p=>p.generation),[1,2,3,4,5,6,7,8]);assert.equal(new Set(phases.map(p=>p.pid)).size,8);assert.equal(cancels,2);assert.equal(socketCreates,1);
  assert.equal(await readFile(join(root,"effect-count"),"utf8"),"1\n");
  const evidence={kind:"batch6-electron-sqlite-native-transport",controlledNetwork:true,requests,phases,completedEffects:1,createdResponses:2,socketCreates,cancelAttempts:cancels};
  if(evidencePath){await mkdir(dirname(evidencePath),{recursive:true});await writeFile(evidencePath,JSON.stringify(evidence,null,2));}
  console.log("Actual Electron and SQLite transport recovery passed.");passed=true;
}finally{
  for(const client of wss.clients)client.terminate();await new Promise(resolve=>wss.close(()=>resolve()));
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  if(passed){const path=resolve(root);assert.equal(dirname(path),resolve(tmpdir()));assert(basename(path).startsWith("helarc-native-transport-"));await rm(path,{recursive:true,force:true});}
  else console.error(`Failure evidence retained: ${root}`);
}
