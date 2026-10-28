import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {createServer} from "node:http";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {resolve,dirname,basename,join} from "node:path";
import {fileURLToPath} from "node:url";
import electron from "electron";

const directory = await mkdtemp(join(tmpdir(),"helarc-activity-handoff-"));
const context = process.argv.includes("--context-foundation");
const fixture = fileURLToPath(new URL(context?"./fixtures/context-foundation.cjs":"./fixtures/activity-handoffs.cjs",import.meta.url));
let calls = 0, passed = false;
const live = process.argv.includes("--live-model");
const server = createServer(async (request,response) => {
  const chunks=[];
  for await (const chunk of request) {chunks.push(chunk);}
  calls++;
  try {
    let value={content:"original complete response",call:calls};
    if (live) {
      const received=Buffer.concat(chunks).toString("utf8");
      const result=await fetch("http://localhost:11435/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:received,signal:AbortSignal.timeout(60000)});
      if (!result.ok) throw new Error(`Live model HTTP ${result.status}`);
      const raw=await result.json();
      assert.equal(typeof raw.message?.content,"string"); assert(raw.message.content.trim().length);
      value={content:raw.message.content,raw,request:JSON.parse(received),call:calls};
    }
    response.setHeader("Content-Type","application/json"); response.end(JSON.stringify(value));
  } catch (error) {response.statusCode=502; response.end(JSON.stringify({error:String(error)}));}
});
await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
const endpoint = `http://127.0.0.1:${server.address().port}`;
async function launch(stage,expected = 0) {
  const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
  if (live) env.ACTIVITY_LIVE_MODEL="gemma4:e4b";
  await new Promise((resolve,reject) => {
    const child = spawn(electron,[fixture,directory,stage,endpoint],{env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
    let output = "", timedOut = false;
    child.stdout.on("data",chunk => {output += chunk;}); child.stderr.on("data",chunk => {output += chunk;});
    const timeout = setTimeout(() => {timedOut = true; child.kill();},90000);
    child.once("error",error => {clearTimeout(timeout);reject(error);});
    child.once("close",code => {clearTimeout(timeout); if (timedOut || code !== expected) reject(new Error(`${stage}: exit=${code}, timeout=${timedOut}\n${output}`)); else resolve();});
  });
  console.log(`${stage}: passed`);
}
try {
  await launch("save-raw",73);
  assert.equal(calls,context?0:1);
  await launch("accept-and-expand",73);
  await launch("finish");
  assert.equal(calls,1,"Recovery must not repeat completed external work");
  console.log(await readFile(join(directory,"verification.json"),"utf8"));
  console.log(`Provider: ${live ? "actual Ollama gemma4:e4b" : "controlled endpoint"}; requests: ${calls}`);
  passed = true;
} finally {
  await new Promise(resolve => server.close(resolve));
  if (passed) {
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("helarc-activity-handoff-")) throw new Error("Unsafe fixture cleanup");
    await rm(target,{recursive:true,force:true});
  } else console.error(`Isolated evidence: ${directory}`);
}
