import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import electron from "electron";
const directory=await mkdtemp(join(tmpdir(),"helarc-in-request-reception-"));
const fixture=fileURLToPath(new URL("./fixtures/native-in-request-reception.cjs",import.meta.url)),cwd=fileURLToPath(new URL("../",import.meta.url));
async function launch(phase){
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((done,reject)=>{
    const child=spawn(electron,[fixture,directory,phase],{cwd,env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
    let log="",timedOut=false,killing=Promise.resolve();
    child.stdout.on("data",v=>log=(log+v).slice(-8000));child.stderr.on("data",v=>log=(log+v).slice(-8000));
    const timer=setTimeout(()=>{timedOut=true;killing=new Promise(resolve=>{
      const killer=spawn("taskkill",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});
      killer.once("close",resolve);killer.once("error",()=>{child.kill();resolve();});
    });},60000);
    child.once("error",error=>{clearTimeout(timer);reject(error);});
    child.once("close",async code=>{clearTimeout(timer);await killing;
      if(!timedOut&&code===(phase==="receive"?73:0))done();
      else reject(new Error(`${phase}: ${code}, timeout=${timedOut}\n${await readFile(join(directory,`${phase}-failure.txt`),"utf8").catch(()=>log)}`));
    });
  });
  return JSON.parse(await readFile(join(directory,`${phase}.json`),"utf8"));
}
try{
  const before=await launch("receive"),after=await launch("adopt");
  assert.notEqual(before.pid,after.pid);assert.equal(after.generation,before.generation+1);
  assert.equal(before.receptionReceipt,after.receptionReceipt);assert.equal(before.originalReceipt,after.originalReceipt);
  assert.equal(after.attempts,1);
  console.log(JSON.stringify({directory,before,after,passed:true,scope:"component-input-reception-only"},null,2));
}finally{console.log(`Evidence: ${directory}`);}
