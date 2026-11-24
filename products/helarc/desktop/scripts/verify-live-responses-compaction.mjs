import {spawn} from "node:child_process";
import {mkdtemp,readFile,writeFile,mkdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve,dirname} from "node:path";
import {fileURLToPath} from "node:url";
import assert from "node:assert/strict";
import electron from "electron";
const settings=resolve(process.argv[2]),evidence=process.argv[3]?resolve(process.argv[3]):null;
assert.equal(JSON.parse(await readFile(settings,"utf8")).live,true);
const directory=process.argv[4]?resolve(process.argv[4]):await mkdtemp(join(tmpdir(),"helarc-live-compaction-")),phases=[];
const fixture=fileURLToPath(new URL("./fixtures/live-responses-compaction.cjs",import.meta.url)),cwd=fileURLToPath(new URL("../",import.meta.url));
try{
  for(const phase of ["compact","probe","internal-8000","follow-8000","compare"]){
    const prior=await readFile(join(directory,`${phase}.json`),"utf8").then(JSON.parse).catch(()=>null);
    if(prior?.supported!==false&&prior?.pid){phases.push(prior);console.log(`${phase}: reusing completed evidence`);continue;}
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const start=performance.now();
    await new Promise((done,reject)=>{
      const child=spawn(electron,[fixture,directory,phase,settings],{cwd,env,windowsHide:true,stdio:["ignore","pipe","pipe"]});let log="",timeout=false,killing=Promise.resolve();
      child.stdout.on("data",v=>log=(log+v).slice(-8000));child.stderr.on("data",v=>log=(log+v).slice(-8000));
      const timer=setTimeout(()=>{timeout=true;killing=new Promise(resolve=>{const k=spawn("taskkill",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});k.once("close",resolve);k.once("error",()=>{child.kill();resolve();});});},200000);
      child.once("error",e=>{clearTimeout(timer);reject(e);});child.once("close",async code=>{clearTimeout(timer);await killing;
        if(!timeout&&code===(phase.startsWith("follow")||phase==="compare"?0:73))done();else reject(new Error(`${phase}: exit ${code}, timeout ${timeout}\n${await readFile(join(directory,`failure-${phase}.txt`),"utf8").catch(()=>log)}`));});
    });
    phases.push({...JSON.parse(await readFile(join(directory,`${phase}.json`),"utf8")),wallMs:Math.round(performance.now()-start)});
    console.log(`${phase}: passed (${phases.at(-1).wallMs} ms)`);
    if(evidence){await mkdir(dirname(evidence),{recursive:true});await writeFile(evidence,JSON.stringify({directory,phases},null,2));}
  }
  assert.equal(new Set(phases.map(p=>p.pid)).size,5);console.log("Live compaction, original-result continuation and unchanged comparison passed.");
}finally{console.log(`Evidence retained: ${directory}`);}
