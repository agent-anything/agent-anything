import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";

const build=spawnSync("cargo",["build","--locked","--release","--target","x86_64-pc-windows-msvc","--example","external-credential-fixture"],
  {cwd:fileURLToPath(new URL("../native/credential-helper",import.meta.url)),windowsHide:true,stdio:"inherit",timeout:120000});
if(build.error||build.status!==0)throw new Error("Test-only external credential fixture build failed.");
const root=await mkdtemp(join(tmpdir(),"helarc-provider-custody-"));
const driver=fileURLToPath(new URL("./fixtures/provider-custody.cjs",import.meta.url));
let passed=false;
async function launch(directory,scenario,phase,expected=0){
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((accept,reject)=>{
    const started=performance.now();let exitedAt=null;
    const child=spawn(electron,[driver,directory,scenario,phase],{env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
    let output="",timedOut=false,kill=Promise.resolve();
    child.stdout.on("data",chunk=>{output=(output+chunk).slice(-8000);});child.stderr.on("data",chunk=>{output=(output+chunk).slice(-8000);});
    const timer=setTimeout(()=>{timedOut=true;kill=new Promise(done=>{
      if(process.platform==="win32"){const killer=spawn("taskkill",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});killer.once("close",done);killer.once("error",()=>{child.kill();done();});}
      else{child.kill("SIGKILL");done();}
    });},60000);
    child.once("error",error=>{clearTimeout(timer);reject(error);});
    child.once("exit",()=>{exitedAt=performance.now()-started;});
    child.once("close",async code=>{clearTimeout(timer);await kill;
      if(code===expected&&!timedOut)accept();else reject(new Error(`${scenario}/${phase}: exit=${code}, timeout=${timedOut}, exitMs=${exitedAt}, closeMs=${performance.now()-started}\n${await readFile(join(directory,`${phase}-failure.txt`),"utf8").catch(()=>output)}\n${await readFile(join(directory,`${phase}-stages.jsonl`),"utf8").catch(()=>"")}`));
    });
  });
  console.log(`${scenario}/${phase}: passed`);
}
try{
  for(const scenario of process.argv.slice(2).length?process.argv.slice(2):["staging","recovery"]){
    const directory=join(root,scenario);await mkdir(directory);
    const failures=[];
    try{await launch(directory,scenario,"seed",73);await launch(directory,scenario,"resume");console.log(await readFile(join(directory,"verification.json"),"utf8"));}catch(error){failures.push(error);}
    try{await launch(directory,scenario,"cleanup");}catch(error){failures.push(error);}
    if(failures.length)throw new AggregateError(failures,failures.map(error=>String(error)).join("\n"));
  }
  passed=true;console.log("Actual Electron, Windows credentials, safeStorage and SQLite Worker custody verification passed.");
}finally{
  if(passed&&process.env.HELARC_KEEP_VERIFICATION_EVIDENCE!=="1"){const target=resolve(root);assert.equal(dirname(target),resolve(tmpdir()));assert(basename(target).startsWith("helarc-provider-custody-"));await rm(target,{recursive:true,force:true});}
  else if(passed)console.log(`Verification evidence retained: ${root}`);
  else console.error(`Evidence retained: ${root}`);
}
