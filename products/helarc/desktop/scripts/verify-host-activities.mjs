import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {createServer} from "node:http";
import {mkdtemp,readFile,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve,dirname,basename} from "node:path";
import {fileURLToPath} from "node:url";
import electron from "electron";

const directory=await mkdtemp(join(tmpdir(),"helarc-host-activities-"));
const requests=[];let passed=false;
const cancel=process.argv.includes("--cancel"),hook=process.argv.includes("--hook");
const application=process.argv.includes("--application");
const defaultEntry=process.argv.includes("--default-entry");
const graceful=process.argv.includes("--graceful-close");
const live=process.argv.includes("--live-model"),network=new AbortController();
const capacityRecovery=process.argv.includes("--capacity-recovery"),pressure=process.argv.includes("--pressure")||capacityRecovery;
const repeated="retained test content; ",writeContent=pressure?repeated.repeat(5000):"exactly one accepted effect";
let rejected=0,methodCalls=0,taskCalls=0;
assert(!live||!cancel&&!hook&&!pressure);
assert(!pressure||!cancel&&!hook);
assert(!cancel||!hook);
const report="ALPHA REPORT: "+"Retained evidence from the original child. ".repeat(700)+" TARGET 9507";
const server=createServer(async(req,res)=>{
  try {
    const bytes=[];for await(const part of req)bytes.push(part);
    const body=JSON.parse(Buffer.concat(bytes).toString("utf8"));requests.push(body);
    await writeFile(join(directory,"requests.json"),JSON.stringify(requests,null,2));
    if(live) {
      assert(!body.messages.some(m=>m.role==="system"));assert(body.tools.length>10);
      const response=await fetch(`http://localhost:11435${req.url}`,{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify(body),signal:AbortSignal.any([network.signal,AbortSignal.timeout(60000)])});
      res.writeHead(response.status,Object.fromEntries([...response.headers].filter(([key])=>!["transfer-encoding","content-length","content-encoding"].includes(key))));
      res.end(Buffer.from(await response.arrayBuffer()));return;
    }
    if(!body.tools?.length) {
      const text=body.prompt??body.messages.map(m=>m.content).join("\n");
      const objects=text.split("\n").flatMap(line=>{try{return [JSON.parse(line.replace(/^user: /,""))];}catch{return [];}});
      const work=objects.findLast(value=>value.job&&value.outputContract);
      if(work) {
        assert(pressure);methodCalls++;
        const check=["check","relation","combination"].includes(work.job.kind);
        const output=check?{kind:"assessment",findings:Object.fromEntries(["source_to_candidate","candidate_to_source","relationships","precision"].map(direction=>
          [direction,{conclusion:"supported",sources:work.job.scope,candidates:work.job.candidates,basis:"Controlled exact repetition fixture",unknowns:[]}])),
          requirements:work.requirements.map(r=>({id:r.id,conclusion:"supported",basis:"The original repeated content is represented with its exact count"})),missing:[]}:
          {kind:"candidate",parts:work.job.scope.map(alias=>{const source=objects.find(o=>o.alias===alias);assert(source?.text);
            return {text:source.text.replaceAll(writeContent,`[Exactly 5000 consecutive copies of ${JSON.stringify(repeated)}]`),sources:[alias]};}),
            covered:work.job.scope,background:[],losses:[],relationships:[],unknowns:[],missing:[]};
        res.setHeader("Content-Type","application/json");res.end(JSON.stringify({model:"controlled",response:JSON.stringify(output),done:true,done_reason:"stop",prompt_eval_count:2000,eval_count:100}));return;
      }
      assert(hook);const hookText=JSON.stringify(body);assert(hookText.includes("helarc_task_fulfillment")||hookText.includes("missingOutcomes"));
      res.setHeader("Content-Type","application/json");res.end(JSON.stringify({model:"controlled",response:JSON.stringify({status:"fulfilled",disposition:"allow",
        rationale:"The recorded task result supports completion.",missingOutcomes:[],unsupportedClaims:[]}),done:true,done_reason:"stop",prompt_eval_count:900,eval_count:50}));return;
    }
    assert(!body.messages.some(m=>m.role==="system"));assert(body.tools.length>10);
    const text=body.messages.filter(m=>m.role==="user").map(m=>m.content).join("\n");
    const name=label=>{const tool=body.tools.find(t=>new RegExp(`^${label}(?:_|$)`).test(t.function.name));assert(tool,label);return tool.function.name;};
    const called=label=>body.messages.some(m=>m.role==="assistant"&&m.tool_calls?.some(c=>c.function.name===name(label)));
    taskCalls++;
    if(capacityRecovery&&taskCalls===2&&!rejected) {rejected++;res.writeHead(400,{"Content-Type":"application/json"});res.end(JSON.stringify({error:"the input length exceeds the context length"}));return;}
    const call=(label,args)=>({function:{name:name(label),arguments:args}});
    let calls;
    if(!text.includes("ROOT_CASE"))calls=[call("final_result",{response:text.includes("CHILD_ALPHA")?report:"BETA 8422"})];
    else if(!called("Write")&&!JSON.stringify(body.messages).includes("5000 consecutive copies"))calls=[call("Write",{file_path:"once.txt",content:writeContent})];
    else if(!called("Agent"))calls=[call("Agent",{description:"Alpha report",prompt:"CHILD_ALPHA: Return your original report."}),
      call("Agent",{description:"Beta report",prompt:"CHILD_BETA: Return BETA 8422."})];
    else {
      const results=body.messages.filter(m=>m.role==="tool").map(m=>JSON.parse(m.content).content);
      const retained=results.find(r=>r?.output?.report?.status==="retained_material");assert(retained);
      assert(!JSON.stringify(body.messages).includes(report));
      if(!called("ContextMaterialRead"))calls=[call("ContextMaterialRead",{reference:retained.output.report.reference,
        offset:Buffer.byteLength(report)-40,length:128})];
      else {assert(results.some(r=>r?.output?.text?.includes("TARGET 9507")));
        calls=[call("final_result",{response:"TARGET 9507; BETA 8422; original write retained."})];}
    }
    res.setHeader("Content-Type","application/json");
    res.end(JSON.stringify({model:"controlled",message:{role:"assistant",content:"",tool_calls:calls},done:true,done_reason:"stop",
      prompt_eval_count:pressure?Math.ceil(JSON.stringify(body).length/4):2000,eval_count:pressure?Math.ceil(JSON.stringify(calls).length/4):100}));
  } catch(error){res.statusCode=500;res.end(String(error.stack));}
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const endpoint=`http://127.0.0.1:${server.address().port}`,env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
if(cancel)env.HOST_ACTIVITY_CANCEL="1";if(hook)env.HOST_ACTIVITY_HOOK="1";
if(live)env.HOST_ACTIVITY_LIVE_MODEL="gemma4:e4b";
if(pressure)env.HOST_ACTIVITY_PRESSURE="1";if(capacityRecovery)env.HOST_ACTIVITY_CAPACITY_RECOVERY="1";
if(application||defaultEntry)Object.assign(env,{HOST_ACTIVITY_APPLICATION:"1",HELARC_PROVIDER_KIND:"ollama",HELARC_PROVIDER_BASE_URL:endpoint,
  HELARC_PROVIDER_MODEL:live?"gemma4:e4b":"controlled",HELARC_PROVIDER_TIMEOUT_MS:"60000",
  HELARC_OLLAMA_CONTEXT_WINDOW_TOKENS:pressure&&!capacityRecovery?"32768":"163840",HELARC_PROVIDER_API_KEY:""});
if(graceful)env.HOST_ACTIVITY_GRACEFUL_CLOSE="1";
try {
  for(const phase of defaultEntry?["default"]:live?["live"]:["start","recover"]) {
    const driver=defaultEntry?"./fixtures/default-entry.cjs":"./fixtures/host-activities.cjs";
    const child=spawn(electron,[fileURLToPath(new URL(driver,import.meta.url)),directory,phase,endpoint],
      {env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
    let output="",expired=false,termination=Promise.resolve();child.stdout.on("data",b=>{output+=b;});child.stderr.on("data",b=>{output+=b;});
    const timer=setTimeout(()=>{expired=true;
      termination=process.platform==="win32"&&child.pid?new Promise(resolve=>{
        const killer=spawn("taskkill",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});
        killer.once("close",resolve);killer.once("error",()=>{child.kill();resolve();});
      }):Promise.resolve(child.kill());
    },180000);
    const code=await new Promise((resolve,reject)=>{child.once("error",reject);child.once("close",resolve);}).finally(()=>clearTimeout(timer));
    await termination;
    assert(!expired&&code===(phase==="start"?73:0),`${phase} exit=${code} timeout=${expired}\n${output}`);
    if(phase==="start")assert.equal(requests.filter(r=>r.tools?.length).length,2);
    console.log(`${phase}: passed\n${output}`);
  }
  if(pressure){assert(methodCalls>=2,"Actual Host must produce and assess a shorter representation");assert.equal(taskCalls,6+rejected);assert.equal(rejected,capacityRecovery?1:0);}
  else if(!live)assert.equal(requests.length,cancel?2:hook?9:6,"Original task responses are not repeated on recovery");
  else assert(requests.length>0&&requests.length<=4);
  console.log(await readFile(join(directory,"verification.json"),"utf8"));console.log(JSON.stringify({taskCalls,methodCalls,rejected}));passed=true;
} finally {
  network.abort();
  server.closeAllConnections();
  await new Promise(resolve=>server.close(resolve));
  if(passed&&process.env.HELARC_KEEP_VERIFICATION!=="1") {
    const target=resolve(directory);if(dirname(target)!==resolve(tmpdir())||!basename(target).startsWith("helarc-host-activities-"))throw new Error("Unsafe cleanup");
    await rm(target,{recursive:true,force:true});
  } else console.error(`Isolated evidence: ${directory}`);
}
