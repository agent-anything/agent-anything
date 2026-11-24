import {spawn} from "node:child_process";
import {mkdtemp,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import electron from "electron";
const execution=process.argv[2];if(!execution)throw new Error("An isolated completed native delegation directory is required");
const root=await mkdtemp(join(tmpdir(),"helarc-native-inspection-"));
const fixture=fileURLToPath(new URL("./fixtures/native-inspection.cjs",import.meta.url));
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
for(const phase of ["capture","repair-start","repair-finish"]){
  await new Promise((resolve,reject)=>{
    const child=spawn(electron,[fixture,execution,root,phase],{windowsHide:true,stdio:["ignore","pipe","pipe"],env});
    let output="";child.stdout.on("data",c=>output+=c);child.stderr.on("data",c=>output+=c);
    let timeout=false,cleanup=Promise.resolve();
    const timer=setTimeout(()=>{timeout=true;cleanup=new Promise(done=>{
      if(process.platform!=="win32"){child.kill("SIGKILL");done();return;}
      const killer=spawn("taskkill",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});
      killer.once("close",done);killer.once("error",()=>{child.kill();done();});
    });},120000);
    child.on("error",e=>{clearTimeout(timer);reject(e);});child.on("close",async code=>{clearTimeout(timer);await cleanup;
      if(code===0&&!timeout)resolve();else reject(new Error(`${phase} failed (${code}, timeout=${timeout}) ${root}\n${output}\n${await readFile(join(root,`failure-${phase}.txt`),"utf8").catch(()=>"")}`));});
  });
  console.log(JSON.stringify({phase,root,result:JSON.parse(await readFile(join(root,`${phase}.json`),"utf8"))}));
}
console.log(JSON.stringify({root,result:JSON.parse(await readFile(join(root,"repair-finish.json"),"utf8"))}));
