import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {createServer} from "node:http";
import {mkdtemp,readFile,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import electron from "electron";
const directory=await mkdtemp(join(tmpdir(),"helarc-native-compact-operation-")),phases=[],requests=[];
const fixture=fileURLToPath(new URL("./fixtures/native-compact-operation.cjs",import.meta.url)),cwd=fileURLToPath(new URL("../",import.meta.url));
let failure=null;
const server=createServer(async(req,res)=>{try{
  assert.equal(req.method,"POST");assert.equal(req.url,"/v1/responses/compact");
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const body=JSON.parse(Buffer.concat(chunks).toString());requests.push(body);assert.equal(requests.length,1);
  assert.equal(body.model,"controlled");assert.equal(body.instructions,undefined);assert.equal(body.tools,undefined);
  assert.deepEqual(body.input,[{role:"user",content:"Keep the selected blue option and the completed command."}]);
  await writeFile(join(directory,"requests.json"),JSON.stringify(requests));
  res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({id:"cmp-result",object:"response.compaction",output:[
    {type:"message",role:"user",content:"Keep blue; command completed."},{type:"compaction",encrypted_content:"opaque",id:"cmp-item"}]}));
}catch(error){failure=error;res.writeHead(500);res.end("controlled peer rejected request");}});
async function launch(phase){
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const started=performance.now();
  await new Promise((done,reject)=>{
    const child=spawn(electron,[fixture,directory,phase,endpoint],{cwd,env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
    let log="",timedOut=false,killing=Promise.resolve();
    child.stdout.on("data",v=>log=(log+v).slice(-8000));child.stderr.on("data",v=>log=(log+v).slice(-8000));
    const timer=setTimeout(()=>{timedOut=true;killing=new Promise(resolve=>{
      const killer=spawn("taskkill",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});
      killer.once("close",resolve);killer.once("error",()=>{child.kill();resolve();});
    });},60000);
    child.once("error",e=>{clearTimeout(timer);reject(e);});
    child.once("close",async code=>{clearTimeout(timer);await killing;
      if(!timedOut&&code===(phase==="verify"?0:73))done();
      else reject(new Error(`${phase}: ${code}, timeout=${timedOut}\n${await readFile(join(directory,`failure-${phase}.txt`),"utf8").catch(()=>log)}`));});
  });
  if(failure)throw failure;
  phases.push({...JSON.parse(await readFile(join(directory,`${phase}.json`),"utf8")),wallMs:Math.round(performance.now()-started)});
  console.log(`${phase}: passed (${phases.at(-1).wallMs}ms)`);
}
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));const endpoint=`http://127.0.0.1:${server.address().port}/v1`;
try{
  for(const phase of ["produce","accept","recover","verify"])await launch(phase);
  assert.equal(new Set(phases.map(p=>p.pid)).size,4);assert.equal(requests.length,1);
  assert.deepEqual(phases.map(p=>p.generation),[1,2,3,4]);assert.deepEqual(phases.map(p=>p.network),[1,0,0,0]);
  await writeFile(join(directory,"result.json"),JSON.stringify({directory,phases,requests:requests.length,passed:true},null,2));
  console.log(JSON.stringify({directory,passed:true,processes:phases.length,posts:requests.length}));
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));console.log(`Evidence: ${directory}`);}
