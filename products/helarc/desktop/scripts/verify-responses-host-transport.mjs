import assert from "node:assert/strict";
import {createServer} from "node:http";
import {spawn,spawnSync,execFile} from "node:child_process";
import {mkdtemp,writeFile,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve,dirname,basename} from "node:path";
import {randomUUID} from "node:crypto";
import {fileURLToPath} from "node:url";
import {createRequire} from "node:module";
import electron from "electron";
import {NativeWindowsCredentialBackend} from "../dist/main/provider/WindowsCredentialBackend.js";
const {WebSocketServer}=createRequire(new URL("../../../../harness/integrations/providers/package.json",import.meta.url))("ws");
const build=spawnSync("cargo",["build","--locked","--release","--target","x86_64-pc-windows-msvc","--example","external-credential-fixture"],
  {cwd:fileURLToPath(new URL("../native/credential-helper",import.meta.url)),windowsHide:true,stdio:"inherit",timeout:120000});
if(build.error||build.status!==0)throw new Error("Test-only external credential fixture build failed.");
const root=await mkdtemp(join(tmpdir(),"helarc-responses-host-")),backend=new NativeWindowsCredentialBackend();
const target=`Helarc-Custody-Test/${randomUUID()}`,secret="synthetic-custody-verification-key";
const credentialFixture=(operation)=>new Promise((accept,reject)=>execFile(fileURLToPath(new URL("../native/credential-helper/target/x86_64-pc-windows-msvc/release/examples/external-credential-fixture.exe",import.meta.url)),
  [operation,target],{windowsHide:true,timeout:10000},error=>error?reject(new Error("external_credential_fixture_failed")):accept()));
const fixture=fileURLToPath(new URL("./fixtures/live-responses-transport.cjs",import.meta.url));
let created=false,passed=false,sequence=0,failure=null,httpCreates=0,socketCreates=0,cancels=0,resumes=0;
const bodies=new Map();
const response=(id,status)=>({id,object:"response",status,output:status==="completed"?[{id:`${id}-message`,type:"message",role:"assistant",status:"completed",content:[{type:"output_text",text:"BATCH6_OK",annotations:[]}]}]:[],usage:status==="completed"?{input_tokens:10,output_tokens:4,total_tokens:14}:null});
const events=(id,status)=>[{type:"response.created",sequence_number:0,response:response(id,"in_progress")},
  ...(status==="completed"?[{type:"response.completed",sequence_number:1,response:response(id,status)}]:[])];
const server=createServer(async(req,res)=>{
  try{
    assert.equal(req.headers.authorization,`Bearer ${secret}`);
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=chunks.length?JSON.parse(Buffer.concat(chunks)):null;
    const url=new URL(req.url,"http://localhost");
    const stream=items=>{res.writeHead(200,{"content-type":"text/event-stream"});for(const item of items)res.write(`data: ${JSON.stringify(item)}\n\n`);res.end();};
    if(req.method==="POST"&&url.pathname==="/v1/responses"){
      httpCreates++;assert.equal(body.model,"fixture");assert.equal(body.instructions,undefined);
      if(body.previous_response_id)assert(bodies.has(body.previous_response_id));
      const id=`response-${++sequence}`;bodies.set(id,body);
      if(body.stream)stream(events(id,body.background?"in_progress":"completed"));
      else {res.setHeader("content-type","application/json");res.end(JSON.stringify(response(id,body.background?"queued":"completed")));}
    }else{
      const id=url.pathname.split("/")[3];assert(bodies.has(id));
      if(url.pathname.endsWith("/cancel")){cancels++;res.setHeader("content-type","application/json");res.end(JSON.stringify(response(id,"cancelled")));}
      else {assert.equal(url.searchParams.get("starting_after"),"0");resumes++;stream(events(id,"completed").slice(1));}
    }
  }catch(error){failure=error;if(!res.headersSent)res.writeHead(500);res.end("fixture error");}
});
const wss=new WebSocketServer({server});
wss.on("connection",(socket,req)=>{assert.equal(req.headers.authorization,`Bearer ${secret}`);socket.on("message",data=>{
  try{
    const body=JSON.parse(data);assert.equal(body.type,"response.create");assert.equal(body.stream,undefined);assert.equal(body.background,undefined);
    if(body.previous_response_id)assert(bodies.has(body.previous_response_id));
    socketCreates++;const id=`response-${++sequence}`;bodies.set(id,body);for(const event of events(id,"completed"))socket.send(JSON.stringify(event));
  }catch(error){failure=error;socket.terminate();}
});});
try{
  await credentialFixture("create");created=true;
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const settings=join(root,"settings.json");await writeFile(settings,JSON.stringify({live:true,baseUrl:`http://127.0.0.1:${server.address().port}/v1`,model:"fixture",credentialTarget:target}));
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((accept,reject)=>{
    const child=spawn(electron,[fixture,root,settings],{env,windowsHide:true,stdio:["ignore","pipe","pipe"]});let output="",timedOut=false,killed=Promise.resolve();
    child.stdout.on("data",b=>output=(output+b).slice(-12000));child.stderr.on("data",b=>output=(output+b).slice(-12000));
    const timer=setTimeout(()=>{timedOut=true;killed=new Promise(done=>{
      const killer=spawn("taskkill",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});killer.once("close",done);killer.once("error",()=>{child.kill();done();});
    });},60000);
    child.once("error",error=>{clearTimeout(timer);reject(error);});
    child.once("close",async code=>{clearTimeout(timer);await killed;code===0&&!timedOut?accept():reject(new Error(`Host verification ${code}, timeout=${timedOut}\n${output}`));});
  });
  if(failure)throw failure;
  const evidence=JSON.parse(await readFile(join(root,"live-evidence.json"),"utf8"));
  assert.equal(evidence.profiles.length,6);
  for(const profile of evidence.profiles){assert.equal(profile.error,undefined,JSON.stringify(profile));assert.equal(profile.localRecoveryVerified,true);}
  assert.equal(httpCreates,6);assert.equal(socketCreates,3);assert.equal(cancels,1);assert.equal(resumes,1);assert(evidence.inspectorRecords>0);
  console.log(JSON.stringify({controlled:true,electron:true,windowsCredential:true,sqliteWorker:true,httpCreates,socketCreates,cancels,resumes,profiles:6,inspectorRecords:evidence.inspectorRecords}));
  passed=true;
}finally{
  for(const client of wss.clients)client.terminate();await new Promise(resolve=>wss.close(()=>resolve()));server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  if(created){await credentialFixture("delete");assert.equal(await backend.read(target,"utf16le"),null);}
  if(passed){assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert(basename(root).startsWith("helarc-responses-host-"));await rm(root,{recursive:true,force:true});}
  else console.error(`Host verification evidence: ${root}`);
}
