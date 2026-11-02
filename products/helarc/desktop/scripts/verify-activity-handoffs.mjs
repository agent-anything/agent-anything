import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {createServer} from "node:http";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {resolve,dirname,basename,join} from "node:path";
import {fileURLToPath} from "node:url";
import electron from "electron";

const taskAuthorization=process.argv.includes("--task-authorization");
if(taskAuthorization&&process.argv.slice(2).some(arg=>arg!=="--task-authorization"))throw new Error("Task authorization verification requires its independent controlled scenario");
const directory = await mkdtemp(join(tmpdir(),"helarc-activity-handoff-"));
const context = process.argv.includes("--context-foundation");
const input = process.argv.includes("--context-input");
const service = process.argv.includes("--activity-service");
const publication = process.argv.includes("--source-publication");
const sourceLimitations = process.argv.includes("--source-limitations");
const unavailableSource = process.argv.includes("--unavailable-task-source");
const taskRunner = process.argv.includes("--task-runner");
const inputExit=process.argv.includes("--task-input-exit");
const cancelledInput=process.argv.includes("--cancel-input-before-supply");
const supply = process.argv.includes("--task-input-supply")||inputExit||cancelledInput||taskRunner||unavailableSource||taskAuthorization;
if(unavailableSource&&process.argv.some(arg=>["--task-runner","--live-model","--task-preparation","--reject-task-preparation","--task-multiple-turns","--interrupt-task"].includes(arg)))throw new Error("Unavailable source verification requires its independent controlled input supplier");
const fixture = fileURLToPath(new URL(sourceLimitations?"./fixtures/source-limitations.cjs":supply?"./fixtures/task-input-supply.cjs":publication?"./fixtures/source-publication.cjs":service?"./fixtures/activity-service.cjs":input?"./fixtures/context-input.cjs":context?"./fixtures/context-foundation.cjs":"./fixtures/activity-handoffs.cjs",import.meta.url));
let calls = 0, passed = false;
const live = process.argv.includes("--live-model");
const multipleTurns=process.argv.includes("--task-multiple-turns");
if(multipleTurns&&(!taskRunner||live||process.argv.some(arg=>["--task-preparation","--reject-task-preparation","--interrupt-task"].includes(arg))))throw new Error("Multiple-turn verification requires a dedicated controlled task-runner case");
const openai=process.argv.includes("--openai");
const remoteMeasurement=process.argv.includes("--remote-measurement");let measurements=0;
const requests=[];
const server = createServer(async (request,response) => {
  const chunks=[];
  for await (const chunk of request) {chunks.push(chunk);}
  if(request.url==="/measure") {measurements++;response.setHeader("Content-Type","application/json");response.end(JSON.stringify({tokens:500}));return;}
  calls++;
  requests.push(Buffer.concat(chunks).toString("utf8"));
  try {
    let value=input?{model:"controlled",message:{role:"assistant",content:"TARGET is 7391"},done:true,done_reason:"stop",prompt_eval_count:500,eval_count:6}:{content:"original complete response",call:calls};
    if(supply)value={model:"controlled",message:{role:"assistant",content:"",tool_calls:[{function:{name:"final_result",arguments:{response:"TARGET is 7391"}}}]},done:true,done_reason:"stop",prompt_eval_count:500,eval_count:12};
    if(multipleTurns)value={...value,message:calls===1?{role:"assistant",content:"I have retained the target and will report it after recording the plan.",
      tool_calls:[{function:{name:"update_plan",arguments:{plan:[{step:"Retain TARGET 7391",status:"completed"}]}}}]}:
      {role:"assistant",content:"",tool_calls:[{function:{name:"final_result",arguments:{response:"TARGET is 7391",plan:[{step:"Retain TARGET 7391",status:"completed"}]}}}]}};
    if(input&&openai)value={choices:[{message:{role:"assistant",content:"TARGET is 7391"},finish_reason:"stop"}],usage:{prompt_tokens:500,completion_tokens:6}};
    if (live) {
      const received=Buffer.concat(chunks).toString("utf8");
      const result=await fetch(openai?"http://localhost:11435/v1/chat/completions":"http://localhost:11435/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:received,signal:AbortSignal.timeout(60000)});
      if (!result.ok) throw new Error(`Live model HTTP ${result.status}`);
      const raw=await result.json();
      if(input||supply){assert(openai?raw.choices?.length:raw.message);}
      else {assert.equal(typeof raw.message?.content,"string"); assert(raw.message.content.trim().length);}
      value=input||supply?raw:{content:raw.message.content,raw,request:JSON.parse(received),call:calls};
    }
    response.setHeader("Content-Type","application/json"); response.end(JSON.stringify(value));
  } catch (error) {response.statusCode=502; response.end(JSON.stringify({error:String(error)}));}
});
await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
const endpoint = `http://127.0.0.1:${server.address().port}`;
async function launch(stage,expected = 0) {
  const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
  if(taskAuthorization) {
    for(const key of ["ACTIVITY_TASK_RUNNER","ACTIVITY_INTERRUPT_TASK","ACTIVITY_TASK_PREPARATION","ACTIVITY_TASK_MULTIPLE_TURNS",
      "ACTIVITY_SOURCE_UNAVAILABLE","ACTIVITY_LIVE_MODEL","ACTIVITY_OPENAI","ACTIVITY_REMOTE_MEASUREMENT"])delete env[key];
    env.ACTIVITY_TASK_AUTHORIZATION="1";
  } else delete env.ACTIVITY_TASK_AUTHORIZATION;
  if (live) env.ACTIVITY_LIVE_MODEL="gemma4:e4b";
  if(openai)env.ACTIVITY_OPENAI="1";
  if(remoteMeasurement)env.ACTIVITY_REMOTE_MEASUREMENT="1";
  if(taskRunner)env.ACTIVITY_TASK_RUNNER="1";
  if(unavailableSource)env.ACTIVITY_SOURCE_UNAVAILABLE="1";
  if(multipleTurns)env.ACTIVITY_TASK_MULTIPLE_TURNS="1";
  if(process.argv.includes("--task-preparation"))env.ACTIVITY_TASK_PREPARATION="accepted";
  if(process.argv.includes("--reject-task-preparation"))env.ACTIVITY_TASK_PREPARATION="rejected";
  if(process.argv.includes("--interrupt-task"))env.ACTIVITY_INTERRUPT_TASK="1";
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
  if(taskAuthorization) {
    for(const stage of ["need","materials","restricted-preparation","selected","restricted-dispatch","response","restricted-interpretation"]) {
      await launch(stage,73);
      assert.equal(calls,["response","restricted-interpretation"].includes(stage)?1:0,`${stage}: authorization recovery must not duplicate external work`);
      const checkpoint=JSON.parse(await readFile(join(directory,`authorization-${stage}.json`),"utf8"));
      assert.equal(checkpoint.phase,stage);assert.equal(checkpoint.state.source.status,"accepted");
      if(stage.startsWith("restricted-")) {
        const {requestId,action,refusal}=checkpoint.restriction;
        const retained=stage==="restricted-preparation"?checkpoint.state.preparation:checkpoint.state.task;
        assert.equal(retained.request.id,requestId);assert.deepEqual(retained.authorizationRestrictions[action],refusal);
        assert.equal(retained.status,action==="interpretation"?"raw_result":"admitted");
        assert.equal(retained.receipt,null);
        assert.equal(retained.attempt===null,action!=="interpretation");
        assert.equal(retained.result===null,action!=="interpretation");
      }
    }
  }
  else if(cancelledInput){await launch("need",73);await launch("cancel-unregistered");assert.equal(calls,0);}
  else if(unavailableSource){await launch("need",73);await launch("unavailable",73);assert.equal(calls,0);}
  else if(sourceLimitations){await launch("seed",73);assert.equal(calls,1);await launch("stop",73);}
  else if(supply){for(const stage of ["need","materials","selected",...(inputExit?["exiting"]:[])]){await launch(stage,73);assert.equal(calls,0);}await launch("response",73);}
  else if(input){await launch("prepare",73);assert.equal(calls,0);if(remoteMeasurement)await launch("measure",73);await launch("accept-input",73);assert.equal(calls,0);await launch("execute",73);}
  else {await launch("save-raw",73);assert.equal(calls,context?0:1);await launch("accept-and-expand",73);}
  if(!cancelledInput)await launch("finish");
  assert.equal(calls,unavailableSource||cancelledInput?0:multipleTurns?2:1,"Recovery must not repeat completed external work");
  assert.equal(measurements,remoteMeasurement?1:0,"Saved remote counts must not be requested again");
  if((input||supply)&&!unavailableSource&&!cancelledInput)assert.equal(requests[0],await readFile(join(directory,"encoded-request.json"),"utf8"),"Actual transport must consume the original accepted bytes");
  if(supply&&!unavailableSource&&!cancelledInput) {
    const actual=JSON.parse(requests[0]);
    assert(actual.messages.some(message=>message.role==="user"&&message.content.includes("Report TARGET 7391 using final_result. No operations are needed.")),"Original task must reach the model");
    assert(!actual.messages.some(message=>message.role==="system"),"Disabled optional instructions must remain disabled");
    assert(actual.tools.some(tool=>tool.function.name==="final_result"),"The actual Product ending control must be exposed");
  }
  if(multipleTurns){
    assert.equal(requests[1],await readFile(join(directory,"follow-up-request.json"),"utf8"));
    const reuse=JSON.parse(await readFile(join(directory,"source-reuse.json"),"utf8"));
    console.log(JSON.stringify({sourceReuse:reuse},null,2));
    const second=JSON.parse(requests[1]),assistantIndex=second.messages.findIndex(m=>m.role==="assistant"&&m.tool_calls?.some(c=>c.function.name==="update_plan"));
    assert(assistantIndex>=0,"The real follow-up must retain the original call");
    assert(second.messages[assistantIndex].content.includes("I have retained the target"),"Text accompanying the call must remain");
    assert(second.messages.slice(assistantIndex+1).some(m=>m.role==="tool"),"The correlated result follows the call");
    assert(second.messages.some(m=>m.role==="user"&&m.content.includes("TARGET 7391")));
    assert(!second.messages.some(m=>m.role==="system"));
    assert.equal(second.messages.filter(m=>m.role==="assistant"&&m.tool_calls?.some(c=>c.function.name==="update_plan")).length,1);
  }
  const verification=JSON.parse(await readFile(join(directory,"verification.json"),"utf8"));
  try{verification.processMetrics=JSON.parse(await readFile(join(directory,"process-metrics.json"),"utf8"));}catch(error){if(error.code!=="ENOENT")throw error;}
  if(taskAuthorization) {
    assert.equal(verification.authorization.recoveredBoundaries,7);
    assert.equal(verification.authorization.restrictions.length,3);
    assert.equal(verification.authorization.inspectedFacts,6);
    const response=JSON.parse(await readFile(join(directory,"authorization-response.json"),"utf8"));
    const finished=JSON.parse(await readFile(join(directory,"authorization-finish.json"),"utf8"));
    assert.deepEqual(finished.state.task.request,response.state.task.request);
    assert.deepEqual(finished.state.task.attempt,response.state.task.attempt);
    assert.deepEqual(finished.state.task.result,response.state.task.result);
    assert.equal(finished.state.task.receipt.resultId,response.state.task.result.id);
    assert.equal(requests[0],finished.state.selection.input.exactInput.encoded.body);
  }
  console.log(input||supply?JSON.stringify({...verification,inspection:{captured:verification.inspection.coverage.captured,dropped:verification.inspection.dropped,rejected:verification.inspection.rejected},measurements},null,2):JSON.stringify(verification,null,2));
  console.log(`Provider: ${live ? "actual Ollama gemma4:e4b" : "controlled endpoint"}; protocol: ${service?"controlled activity transport":openai?"OpenAI-compatible":"Ollama"}; requests: ${calls}`);
  passed = true;
} finally {
  await new Promise(resolve => server.close(resolve));
  if (passed) {
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("helarc-activity-handoff-")) throw new Error("Unsafe fixture cleanup");
    await rm(target,{recursive:true,force:true});
  } else console.error(`Isolated evidence: ${directory}`);
}
