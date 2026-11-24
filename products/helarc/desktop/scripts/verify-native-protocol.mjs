import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp,mkdir,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve,dirname,basename} from "node:path";
import {fileURLToPath} from "node:url";
import electron from "electron";
const root=await mkdtemp(join(tmpdir(),"helarc-native-protocol-"));
const fixture=fileURLToPath(new URL("./fixtures/native-protocol.cjs",import.meta.url));
let passed=false;
async function launch(directory,protocol,phase,expected){
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((done,reject)=>{
    const process=spawn(electron,[fixture,directory,protocol,phase],{env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
    let output="",timedOut=false,killed=Promise.resolve();
    process.stdout.on("data",v=>output=(output+v).slice(-8000));process.stderr.on("data",v=>output=(output+v).slice(-8000));
    const timer=setTimeout(()=>{timedOut=true;killed=new Promise(resolve=>{
      if(globalThis.process.platform==="win32"){
        const killer=spawn("taskkill",["/PID",String(process.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});killer.once("close",resolve);killer.once("error",()=>{process.kill();resolve();});
      }else{process.kill("SIGKILL");resolve();}
    });},60000);
    process.once("error",error=>{clearTimeout(timer);reject(error);});
    process.once("close",async code=>{clearTimeout(timer);await killed;
      if(code===expected&&!timedOut)done();else reject(new Error(`${protocol}/${phase} code=${code} timeout=${timedOut}\n${await readFile(join(directory,"failure.txt"),"utf8").catch(()=>output)}`));
    });
  });
  console.log(`${protocol}/${phase}: passed`);
}
try{
  for(const protocol of process.argv.slice(2).length?process.argv.slice(2):["responses","deepseek","ollama"]){
    const directory=join(root,protocol);await mkdir(directory);
    await launch(directory,protocol,"seed",73);await launch(directory,protocol,"resume",73);await launch(directory,protocol,"verify",0);
    const result=JSON.parse(await readFile(join(directory,"verification.json"),"utf8"));
    console.log(JSON.stringify(result));
  }
  passed=true;console.log("Actual Electron/SQLite native interpretation recovery passed.");
}finally{
  if(passed){const path=resolve(root);assert.equal(dirname(path),resolve(tmpdir()));assert(basename(path).startsWith("helarc-native-protocol-"));await rm(path,{recursive:true,force:true});}
  else console.error(`Failure evidence retained: ${root}`);
}
