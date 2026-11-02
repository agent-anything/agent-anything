import {mkdtemp,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {spawn} from "node:child_process";
import assert from "node:assert/strict";
import electron from "electron";
const directory=await mkdtemp(join(tmpdir(),"helarc-response-transport-"));
console.log(directory);
for(const phase of ["seed","resume"]){
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((resolve,reject)=>{
    const child=spawn(electron,[fileURLToPath(new URL("./fixtures/response-transport.cjs",import.meta.url)),directory,phase],
      {env,windowsHide:true,stdio:["ignore","pipe","pipe"]});let output="",expired=false;
    child.stdout.on("data",b=>output+=b);child.stderr.on("data",b=>output+=b);
    const timer=setTimeout(()=>{expired=true;child.kill();},30000);
    child.once("error",error=>{clearTimeout(timer);reject(error)});
    child.once("close",code=>{clearTimeout(timer);code===0&&!expired?resolve():reject(new Error(`${phase}: ${code}, timeout=${expired}\n${output}`))});
  });
  const result=JSON.parse(await readFile(join(directory,`${phase}.json`),"utf8"));
  assert.equal(result.generation,phase==="seed"?1:2);assert.equal(result.attempts,0);
  assert(result.reused&&result.corruptionRejected);
  if(phase==="resume")assert(result.readTrips>0,"New process must establish its own verified bytes");
  console.log(JSON.stringify({phase,...result}));
}
