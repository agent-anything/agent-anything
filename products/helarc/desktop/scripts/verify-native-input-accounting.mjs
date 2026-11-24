import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {createServer} from "node:http";
import {createHash} from "node:crypto";
import {mkdtemp,readFile,writeFile,rm,mkdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve,dirname,basename} from "node:path";
import {fileURLToPath} from "node:url";
import electron from "electron";

const root=await mkdtemp(join(tmpdir(),"helarc-native-input-accounting-"));
const fixture=fileURLToPath(new URL("./fixtures/native-input-accounting.cjs",import.meta.url));
const mergeFixture=fileURLToPath(new URL("./fixtures/native-accounting-merge.cjs",import.meta.url));
const desktop=fileURLToPath(new URL("../",import.meta.url));
const evidenceArg=process.argv.indexOf("--evidence");
const evidencePath=evidenceArg<0?null:resolve(process.argv[evidenceArg+1]??"native-input-accounting-evidence.json");
const posts=[],phases=[];let passed=false,serverFailure=null;
const response={id:"response-original",object:"response",status:"completed",output:[
  {id:"message-original",type:"message",role:"assistant",phase:"commentary",content:[{type:"output_text",text:"Original fixture response. ".repeat(6000),annotations:[]}]},
  {id:"function-original",type:"function_call",call_id:"call-original",name:"Write_a1",arguments:'{"path":"one.txt"}',status:"completed"}],
  usage:{input_tokens:42,output_tokens:9,total_tokens:51,input_tokens_details:{cached_tokens:4}}};
const server=createServer(async(request,res)=>{
  try{
    assert.equal(request.method,"POST");
    assert(["/v1/responses/input_tokens","/v1/responses"].includes(request.url));
    const chunks=[];let bytes=0;
    for await(const chunk of request){bytes+=chunk.length;assert(bytes<1024*1024);chunks.push(chunk);}
    const encoded=Buffer.concat(chunks).toString(),body=JSON.parse(encoded);
    assert.equal(body.model,"fixture-model");assert.deepEqual(body.input,[{role:"user",content:"Write exactly one fixture file, then report."}]);
    assert.equal(body.instructions,undefined);assert.equal(body.max_output_tokens,undefined);assert.equal(body.previous_response_id,undefined);
    assert.equal(body.tools.length,1);assert.equal(body.tools[0].name,"Write_a1");assert.equal(body.tools[0].strict,true);
    assert.equal(body.tools[0].parameters.properties.path.type,"string");
    if(request.url==="/v1/responses"){assert.equal(body.store,true);assert.equal(body.stream,false);}
    else{assert.equal(body.store,undefined);assert.equal(body.stream,undefined);}
    posts.push({route:request.url,bytes,digest:`sha256:${createHash("sha256").update(encoded).digest("hex")}`});
    await writeFile(join(root,"http-evidence.json"),JSON.stringify(posts));
    assert.equal(posts.filter(p=>p.route===request.url).length,1,"Repeated count/create is not recovery");
    res.writeHead(200,{"content-type":"application/json","x-request-id":request.url.endsWith("input_tokens")?"count-request":"create-request"});
    res.end(JSON.stringify(request.url.endsWith("input_tokens")?{object:"response.input_tokens",input_tokens:42}:response));
  }catch(error){serverFailure=error;if(!res.headersSent)res.writeHead(500);res.end("controlled fixture rejected request");}
});
async function launch(phase,expected,endpoint,driver=fixture,directory=root){
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const started=performance.now();
  await new Promise((done,reject)=>{
    const child=spawn(electron,[driver,directory,phase,endpoint],{cwd:desktop,env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
    let output="",timedOut=false,killed=Promise.resolve();
    child.stdout.on("data",value=>output=(output+value).slice(-12000));child.stderr.on("data",value=>output=(output+value).slice(-12000));
    const timer=setTimeout(()=>{timedOut=true;killed=new Promise(resolve=>{
      if(process.platform==="win32"){
        const killer=spawn("taskkill",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});
        killer.once("close",resolve);killer.once("error",()=>{child.kill();resolve();});
      }else{child.kill("SIGKILL");resolve();}
    });},60000);
    child.once("error",error=>{clearTimeout(timer);reject(error);});
    child.once("close",async code=>{clearTimeout(timer);await killed;
      if(code===expected&&!timedOut)done();
      else reject(new Error(`${phase}: code=${code}, timeout=${timedOut}\n${await readFile(join(directory,`failure-${phase}.txt`),"utf8").catch(()=>output)}`));
    });
  });
  if(serverFailure)throw serverFailure;
  const evidence=JSON.parse(await readFile(join(directory,`${phase}.json`),"utf8"));
  phases.push({...evidence,wallMs:Math.round(performance.now()-started)});
  console.log(`${phase}: passed (${phases.at(-1).wallMs} ms)`);
}
try{
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const endpoint=`http://127.0.0.1:${server.address().port}/v1`;
  for(const phase of ["count","execute","reconcile","verify"])await launch(phase,phase==="verify"?0:73,endpoint);
  assert.equal(new Set(phases.map(phase=>phase.pid)).size,4,"Recovery must cross actual process identities");
  assert.deepEqual(phases.map(phase=>phase.generation),[1,2,3,4]);
  assert.equal(posts.filter(p=>p.route.endsWith("input_tokens")).length,1);
  assert.equal(posts.filter(p=>p.route==="/v1/responses").length,1);
  assert.equal(await readFile(join(root,"effect-count"),"utf8"),"1\n");
  assert.equal(await readFile(join(root,"effect-attempts"),"utf8"),"1\n");
  const mergeDirectory=join(root,"merge");await mkdir(mergeDirectory);
  await launch("merge-seed",73,endpoint,mergeFixture,mergeDirectory);
  await launch("merge-verify",0,endpoint,mergeFixture,mergeDirectory);
  assert.notEqual(phases[4].pid,phases[5].pid);assert.deepEqual(phases.slice(4).map(value=>value.generation),[1,2]);
  const evidence={kind:"batch5-electron-sqlite",controlledNetwork:true,deadlinePerPhaseMs:60000,
    countPosts:1,createPosts:1,completedEffects:1,effectAttempts:1,posts,phases,
    verification:JSON.parse(await readFile(join(root,"verification.json"),"utf8")),mergeVerification:phases[5]};
  if(evidencePath){await mkdir(dirname(evidencePath),{recursive:true});await writeFile(evidencePath,JSON.stringify(evidence,null,2));}
  console.log(JSON.stringify(evidence));passed=true;
  console.log("Actual Electron/SQLite native input and accounting recovery passed.");
}finally{
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  if(passed){const path=resolve(root);assert.equal(dirname(path),resolve(tmpdir()));assert(basename(path).startsWith("helarc-native-input-accounting-"));await rm(path,{recursive:true,force:true});}
  else console.error(`Failure evidence retained: ${root}`);
}
