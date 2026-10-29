import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {createServer} from "node:http";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {resolve,dirname,basename,join} from "node:path";
import {fileURLToPath} from "node:url";
import electron from "electron";

const directory=await mkdtemp(join(tmpdir(),"helarc-activity-scheduling-"));
const fixture=fileURLToPath(new URL("./fixtures/activity-scheduling.cjs",import.meta.url));
const effects=[];let passed=false;
const connections=new Set();let probeStarted=()=>{},probeObserved=false;
const server=createServer(async(request,response)=>{
  const chunks=[];for await(const chunk of request)chunks.push(chunk);
  const value=JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if(value.probe){probeObserved=true;probeStarted();return;}
  effects.push(value);response.setHeader("Content-Type","application/json");response.end(JSON.stringify(value));
});
server.on("connection",socket=>{connections.add(socket);socket.once("close",()=>connections.delete(socket));});
await new Promise(done=>server.listen(0,"127.0.0.1",done));
const endpoint=`http://127.0.0.1:${server.address().port}`;
async function launch(phase,expected=0){
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((done,reject)=>{
    const child=spawn(electron,[fixture,directory,phase,endpoint],{env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
    let output="",timedOut=false;const start=performance.now();
    const capture=chunk=>{output=(output+chunk).slice(-64000);};child.stdout.on("data",capture);child.stderr.on("data",capture);
    const timer=setTimeout(()=>{timedOut=true;child.kill();},60000);
    if(phase==="timeout-probe")probeStarted=()=>{timedOut=true;child.kill();};
    child.once("error",error=>{clearTimeout(timer);reject(error);});
    child.once("close",code=>{clearTimeout(timer);if(phase==="timeout-probe"&&timedOut){console.log(`${phase}: terminated after opening SQLite and starting transport`);done();}
      else if(timedOut||code!==expected)reject(new Error(`${phase}: code=${code}, timeout=${timedOut}\n${output}`));else {console.log(`${phase}: ${(performance.now()-start).toFixed(0)}ms`);done();}});
  });
}
try {
  if(process.argv.includes("--timeout-cleanup")) {
    await launch("timeout-probe");
    assert(probeObserved,"Timeout cleanup must be exercised after the actual in-flight request");
    const until=Date.now()+5000;
    while(connections.size&&Date.now()<until)await new Promise(done=>setTimeout(done,10));
    assert.equal(connections.size,0,"Timed-out Electron transport must not remain connected");
    assert.equal(effects.length,0);
    // The following processes reopen the same SQLite files, then complete the independent test.
  }
  await launch("seed-and-dispatch",73);assert.deepEqual(effects.map(e=>e.work),["task"]);
  await launch("continue-round",73);assert.deepEqual(effects.slice(0,3).map(e=>e.work),["task","child-task","preparation"]);
  assert(effects.length===3||effects.length===4,"A completed preparation may release capacity for the next original task stage in the same bounded scan");
  await launch("finish");assert.equal(effects.length,5);assert.equal(new Set(effects.map(e=>e.stage)).size,5,"Completed effects must not repeat");
  console.log(await readFile(join(directory,"verification.json"),"utf8"));passed=true;
} finally {
  server.closeAllConnections();await new Promise(done=>server.close(done));
  if(passed){const target=resolve(directory);if(dirname(target)!==resolve(tmpdir())||!basename(target).startsWith("helarc-activity-scheduling-"))throw new Error("Unsafe fixture cleanup");await rm(target,{recursive:true,force:true});}
  else console.error(`Isolated evidence retained: ${directory}`);
}
