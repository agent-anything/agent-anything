import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import electron from "electron";
const settingsPath=process.argv[2];if(!settingsPath)throw new Error("Provide the explicit live settings file (no key on the command line)");
const settings=JSON.parse(await readFile(settingsPath,"utf8"));assert.equal(settings.live,true);
const material=process.argv[3]==="material";
const root=await mkdtemp(join(tmpdir(),"helarc-live-native-tree-")),env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
// Electron rejects arguments following a URL on Windows. Keep the URL last.
env.HELARC_NATIVE_TREE_LIVE_SETTINGS=resolve(settingsPath);
try{
  for(const phase of ["root-response","child-response","parent-response","finish"]){
    await new Promise((accept,reject)=>{
      const child=spawn(electron,[fileURLToPath(new URL("./fixtures/native-task-delegation.cjs",import.meta.url)),root,phase,material?"responses-transport-stream-material":"responses-transport",settings.baseUrl],
        {env,windowsHide:true,stdio:["ignore","pipe","pipe"]});let output="",expired=false,cleanup=Promise.resolve();
      child.stdout.on("data",b=>output=(output+b).slice(-6000));child.stderr.on("data",b=>output=(output+b).slice(-6000));
      // Covers the admitted 300 s tree lifetime plus bounded shutdown, not a local performance allowance.
      const timer=setTimeout(()=>{expired=true;cleanup=new Promise(done=>{const kill=spawn("taskkill",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});
        kill.once("close",done);kill.once("error",()=>{child.kill();done();});});},330000);
      child.once("error",e=>{clearTimeout(timer);reject(e);});
      child.once("close",async code=>{clearTimeout(timer);await cleanup;
        if(code===(phase==="finish"?0:73)&&!expired)accept();else reject(new Error(`${phase}: ${code}, timeout=${expired}\n${await readFile(join(root,`failure-${phase}.txt`),"utf8").catch(()=>output)}`));});
    });
    console.log(`${phase}: passed`);
  }
  console.log(await readFile(join(root,"verification.json"),"utf8"));
}finally{console.log(`Evidence: ${root}`);}
