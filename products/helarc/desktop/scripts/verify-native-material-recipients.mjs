import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {readFile} from "node:fs/promises";
import {join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import electron from "electron";
const [path,fanout="3"]=process.argv.slice(2);assert(path);
const directory=resolve(path),fixture=fileURLToPath(new URL("./fixtures/native-material-recipients.cjs",import.meta.url));
for(const phase of ["receiver-accepted","source-accepted","finish"]){
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((accept,reject)=>{
    const child=spawn(electron,[fixture,directory,phase,fanout],{env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
    let output="",timeout=false,cleanup=Promise.resolve();
    child.stdout.on("data",b=>output=(output+b).slice(-8000));child.stderr.on("data",b=>output=(output+b).slice(-8000));
    const timer=setTimeout(()=>{timeout=true;cleanup=new Promise(done=>{
      if(process.platform!=="win32"){child.kill("SIGKILL");done();return;}
      const killer=spawn("taskkill",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});
      killer.once("close",done);killer.once("error",()=>{child.kill();done();});
    });},90000);
    child.once("error",e=>{clearTimeout(timer);reject(e);});
    child.once("close",async code=>{clearTimeout(timer);await cleanup;
      if(!timeout&&code===(phase==="finish"?0:73))accept();else reject(new Error(`${phase}: ${code}, timeout=${timeout}\n${await readFile(join(directory,`recipient-failure-${phase}.txt`),"utf8").catch(()=>output)}`));});
  });
  console.log(`${phase}: passed`);
}
console.log(await readFile(join(directory,"recipient-verification.json"),"utf8"));
