import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp,readFile,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import electron from "electron";
const root=await mkdtemp(join(tmpdir(),"helarc-native-input-rejection-")),results=[];
const fixture=fileURLToPath(new URL("./fixtures/native-input-rejection.cjs",import.meta.url));
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
console.log(`Evidence: ${root}`);
for(const phase of ["seed","resume"]){
  const start=performance.now();
  await new Promise((resolve,reject)=>{
    const child=spawn(electron,[fixture,root,phase],{env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
    let output="",timedOut=false,cleaned=Promise.resolve();
    for(const stream of [child.stdout,child.stderr])stream.on("data",d=>{output=(output+d).slice(-6000);});
    const timer=setTimeout(()=>{
      timedOut=true;cleaned=new Promise(done=>{
        if(process.platform!=="win32"){child.kill("SIGKILL");done();return;}
        const stop=spawn("taskkill",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});
        stop.once("close",done);stop.once("error",()=>{child.kill();done();});
      });
    },60000);
    child.once("error",error=>{clearTimeout(timer);reject(error);});
    child.once("close",async code=>{clearTimeout(timer);await cleaned;
      if(!timedOut&&code===(phase==="seed"?73:0))resolve();
      else reject(new Error(`${phase}: code=${code}, timeout=${timedOut}\n${await readFile(join(root,`failure-${phase}.txt`),"utf8").catch(()=>output)}`));
    });
  });
  results.push({...JSON.parse(await readFile(join(root,`${phase}.json`),"utf8")),wallMs:Math.round(performance.now()-start)});
}
assert.notEqual(results[0].pid,results[1].pid);assert.deepEqual(results.map(r=>r.generation),[1,2]);
await writeFile(join(root,"evidence.json"),JSON.stringify({controlledNativeObservation:true,results},null,2));
console.log(JSON.stringify(results));
