import {createServer} from "node:http";
import {spawn} from "node:child_process";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";
import {mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import assert from "node:assert/strict";
const require=createRequire(import.meta.url),electron=require("electron"),root=await mkdtemp(join(tmpdir(),"helarc-representation-method-"));
const resupply=process.argv.includes("--ordinary-resupply");
const methodRetry=process.argv.includes("--method-retry");
const inputRejection=process.argv.includes("--provider-input-rejection");
const stopRejection=process.argv.includes("--stop-input-rejection");
const stopLong=process.argv.includes("--stop-long")||stopRejection,stopCancel=process.argv.includes("--stop-cancel"),stopRetry=process.argv.includes("--stop-retry"),stop=process.argv.includes("--stop-input")||stopLong||stopCancel||stopRetry;
const taskRejection=process.argv.includes("--ordinary-input-rejection"),multiple=process.argv.includes("--ordinary-multiple")||taskRejection;
const jointResultText=process.argv.includes("--joint-result-text");
const joint=process.argv.includes("--joint-input")||jointResultText;
const ordinaryPolicy=process.argv.includes("--ordinary-policy")||resupply||multiple;
const inputUnavailable=process.argv.includes("--input-unavailable");
assert(!inputUnavailable||ordinaryPolicy||joint,"--input-unavailable requires --ordinary-policy or --joint-input");
assert(!resupply||!inputUnavailable,"Original resupply requires a successful first input");
assert(!multiple||!inputUnavailable&&!resupply,"Multiple-source verification uses two successful original methods");
const ordinary=process.argv.includes("--ordinary-input")||ordinaryPolicy;
const fixture=fileURLToPath(new URL(stop?"./fixtures/stop-input.cjs":ordinaryPolicy?"./fixtures/ordinary-input-policy.cjs":ordinary?"./fixtures/ordinary-input-method.cjs":"./fixtures/representation-method.cjs",import.meta.url));
const live=process.argv.includes("--live-model"),openai=process.argv.includes("--openai");
const adoption=process.argv.includes("--adoption")||ordinary||joint||stop;
const cancelConsumer=process.argv.includes("--cancel-consumer");
assert(!cancelConsumer||adoption,"--cancel-consumer requires --adoption");
const lines=process.argv.includes("--line-ranges");
const layered=process.argv.includes("--layered")||lines;
const distributed=process.argv.includes("--distributed");
const contracts=process.argv.includes("--contracts");
const normalPolicy=process.argv.includes("--normal-policy");
const normalRevision=process.argv.includes("--normal-revision");
const simple=process.argv.includes("--simple");
const wholeCheckTarget=process.argv.includes("--whole-check-target-capacity");
assert(!joint||!ordinary&&!live&&!cancelConsumer&&!layered&&!distributed&&!contracts&&!normalPolicy&&!normalRevision&&!simple&&!wholeCheckTarget,"Joint-input verification uses its own controlled multi-producer path");
assert(!ordinary||!live&&!cancelConsumer&&!layered&&!distributed&&!contracts&&!normalPolicy&&!normalRevision&&!simple&&!wholeCheckTarget,"Ordinary-input verification has its own controlled interruption path");
const inFlight=new Set();
let calls=0,consumerCalls=0;const bodies=[],methodBodies=[],methodJobs=[];
const server=createServer(async(req,res)=>{
  try {
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks).toString("utf8"));bodies.push(body);calls++;
    assert(ordinary||jointResultText||!body.tools?.length);assert(!body.max_tokens&&!body.options?.num_predict);
    const text=body.prompt??body.messages.map(m=>m.content).join("\n");
    const objects=text.split("\n").flatMap(line=>{try{return [JSON.parse(line.replace(/^user: /,""))];}catch{return [];}});
    const work=objects.findLast(v=>v.job&&v.outputContract);assert(work||stop||adoption&&text.includes("Based on the Child reports"),"method work data missing");
    if(work){methodBodies.push(body);methodJobs.push(work.job.kind);}
    else consumerCalls++;
    if(taskRejection&&!work&&consumerCalls<=2){res.writeHead(400,{"Content-Type":"application/json"});res.end(JSON.stringify({error:"the input length exceeds the context length"}));return;}
    if((stopRetry||methodRetry)&&calls===1) {res.writeHead(503,{"Content-Type":"application/json"});res.end(JSON.stringify({error:"controlled original transport failure"}));return;}
    if((inputRejection||stopRejection)&&calls===1) {res.writeHead(400,{"Content-Type":"application/json"});res.end(JSON.stringify({error:"the input length exceeds the context length"}));return;}
    if(live) {
      const controller=new AbortController();inFlight.add(controller);
      try {
        const response=await fetch(`http://localhost:11435${req.url}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(120000)])});
        res.writeHead(response.status,{"Content-Type":"application/json"});res.end(await response.text());return;
      }finally{inFlight.delete(controller);}
    }
    const check=work&&["check","relation","combination"].includes(work.job.kind);
    let output=!work?(simple?"The current staging port is 7542; 7431 is superseded.":"Image 5: radius 3. Image 6: radius 5. Preserve alpha throughout. TARGET: 7391. The version remains unverified."):check?{kind:"assessment",findings:Object.fromEntries(["source_to_candidate","candidate_to_source","relationships","precision"].map(direction=>[direction,{conclusion:"supported",sources:work.job.scope,candidates:work.job.candidates,basis:"Controlled fixture explicitly preserves the original agreement and correction",unknowns:[]}])),requirements:work.requirements.map(r=>({id:r.id,conclusion:"supported",basis:"controlled source evidence"})),missing:[]}:
      {kind:"candidate",parts:layered||distributed?work.job.scope.map(alias=>{const evidence=objects.find(v=>v.alias===alias);assert(evidence);return {text:evidence.originalRole==="derived_representation"?evidence.text:evidence.text.includes("User agreement")?"Original agreement: radius 3 for images 2 through 10, preserve alpha. TARGET: 7391.":evidence.text.includes("User correction")?"Later correction: from image 6 use radius 5. Image 5 used radius 3. Preserve alpha. Child B's version is unverified.":"Repeated read-only inspections recorded no changes.",sources:[alias]};}):[{text:"For images 2-5 use radius 3 and preserve alpha. From image 6 through 10 use radius 5, preserving alpha. The output version is unverified according to Child B. TARGET: 7391.",sources:work.job.scope}],covered:work.job.scope,background:[],losses:[],relationships:[],unknowns:[],missing:[]};
    if(ordinary&&work&&!check)output.parts[0].text="For images 2-5 use radius 3 and preserve alpha. From image 6 through 10 use radius 5, preserving alpha. The output version is unverified. TARGET: 7391.";
    if(multiple&&work&&!check&&objects.some(o=>work.job.scope.includes(o.alias)&&o.text?.includes("SECOND_SCOPE")))
      output.parts[0].text="SECOND_SCOPE: 9021. Version is unverified. The independent read-only inspections made no changes.";
    if(joint&&work&&!check)output.parts=work.job.scope.map(alias=>({text:objects.find(v=>v.alias===alias).text.includes("User agreement")?
      "Original agreement: radius 3, preserve alpha, images 2 through 10. TARGET: 7391.":"Later correction: from image 6 use radius 5 and preserve alpha. Image 5 used radius 3. The output version is unverified.",sources:[alias]}));
    if(joint&&work?.job.kind==="combination") {
      assert.deepEqual(work.requirements.map(r=>r.id),["producer_0:agreement","producer_1:agreement"]);
      assert(text.includes("Previously checked derived evidence"));
    }
    if(inputUnavailable&&work?.job.kind==="combination") {
      output.findings.relationships.conclusion="unsupported";
      output.findings.relationships.basis="Controlled recipient combination limitation; the producer result remains retained.";
    }
    if(layered&&work?.job.kind==="merge") {
      const texts=work.job.scope.map(alias=>objects.find(v=>v.alias===alias).text);
      output.parts=[{text:texts.some(t=>t.includes("radius 3"))?"Images 2-5: radius 3; 6-10: radius 5. Preserve alpha. TARGET: 7391. Child B's version is unverified. Repeated inspections made no changes.":"Repeated inspections made no changes.",sources:work.job.scope}];
    }
    if(work?.objective==="contract fixture: stage budget")output.parts=null;
    if(contracts&&check)for(const value of Object.values(output.findings))value.basis+=" Independent evidence description, not an identity field.".repeat(25);
    if(stop&&work&&!check)output={...output,parts:[{text:"TARGET: 7391. Version unverified. No files changed.",sources:work.job.scope}]};
    if(stop&&!work){
      const result={status:"fulfilled",disposition:"allow",rationale:"The original evidence reports TARGET 7391 and retains the unverified version.",missingOutcomes:[],unsupportedClaims:[]};
      res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({model:"controlled",response:JSON.stringify(result),done:true,done_reason:"stop",prompt_eval_count:400,eval_count:100}));return;
    }
    if(ordinaryPolicy&&!work){
      assert(body.tools.some(t=>t.function.name==="final_result"));
      const call={function:{name:"final_result",arguments:openai?JSON.stringify({response:output}):{response:output}},...(openai?{id:"ordinary-final",type:"function"}:{})};
      const message={role:"assistant",content:"",tool_calls:[call]};
      res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify(openai?{id:`response-${calls}`,choices:[{message,finish_reason:"tool_calls"}],usage:{prompt_tokens:400,completion_tokens:100,total_tokens:500}}:
        {model:"controlled",message,done:true,done_reason:"stop",prompt_eval_count:400,eval_count:100}));return;
    }
    res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify(openai?{id:`response-${calls}`,choices:[{message:{role:"assistant",content:ordinary&&!work?output:JSON.stringify(output)},finish_reason:"stop"}],usage:{prompt_tokens:400,completion_tokens:100,total_tokens:500}}:
      (ordinary||jointResultText)&&!work?{model:"controlled",message:{role:"assistant",content:output},done:true,done_reason:"stop",prompt_eval_count:400,eval_count:100}:
      {model:"controlled",response:JSON.stringify(output),done:true,done_reason:"stop",prompt_eval_count:400,eval_count:100}));
  }catch(error){console.error(error);res.writeHead(500);res.end(JSON.stringify({error:String(error)}));}
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
let success=false;
try {
  const endpoint=`http://127.0.0.1:${server.address().port}`;
  for(const phase of stop?(stopRejection?["start","rejected","generated","materialize","adopt","sent","finish"]:stopLong?["start","generated","materialize","adopt","sent","finish"]:stopCancel?["start","sent","cancel","finish"]:stopRetry?["start","retry","sent","finish"]:["start","sent","finish"]):multiple?["start","generated","materialize","second-generated","adopt","sent","finish"]:joint?(inputUnavailable?["start","generated","checked","second-generated","materialize","limitation","finish"]:["start","generated","checked","second-generated","materialize","adopt","sent","finish"]):resupply?["start","generated","materialize","adopt","sent","finish","resupply-start","resupply-finish"]:inputUnavailable?["start","generated","materialize","limitation","finish"]:ordinary?["start","generated","materialize","adopt","sent","finish"]:cancelConsumer?["start","generated","checked","materialize","cancel","finish"]:adoption?["start","generated","checked","materialize","adopt","sent","finish"]:["start","generated","checked","finish"]) {
    const result=await run(phase,endpoint);assert.equal(result.code,phase==="finish"||phase==="resupply-finish"?0:73,result.output);console.log(`${phase}: passed`);
  }
  const verification=JSON.parse(await readFile(join(root,"verification.json"),"utf8"));
  await writeFile(join(root,"physical-requests.json"),JSON.stringify({methodJobs,bodies},null,2));
  assert.equal(calls,verification.totalProviderCalls);if(!live&&!layered&&!distributed&&!contracts&&!stopLong)assert.equal(calls,taskRejection?9:inputRejection?6:methodRetry?3:stop?(stopRetry?2:1):multiple?6:joint?(inputUnavailable?5:6):resupply?6:inputUnavailable?3:(adoption&&!cancelConsumer?4:2)+(verification.revision?.additionalProviderCalls??0));if(layered||distributed)assert(calls>2);if(distributed)assert(verification.checkGroups>0);assert.equal(verification.inspection.dropped,0);assert.equal(verification.inspection.rejected,0);
  assert.equal(bodies.length-methodBodies.length,taskRejection?3:stopRetry||stopRejection?2:resupply?2:adoption&&!cancelConsumer&&!inputUnavailable?1:0,"Only accepted consumer requests and their recorded retries reach the Provider");
  if(stopRetry||methodRetry)assert.deepEqual(bodies[1],bodies[0],"Technical retry preserves the original wire input");
  if(inputRejection)assert.notDeepEqual(bodies[1],bodies[0],"Capacity rejection must not resend the original rejected encoding");
  if(stopRejection){assert.notDeepEqual(bodies.at(-1),bodies[0]);assert(JSON.stringify(bodies.at(-1)).length<JSON.stringify(bodies[0]).length);}
  if(resupply)assert.equal(methodJobs.filter(kind=>kind==="generate").length,1,"Original generation must not repeat");
  assert(methodBodies.every(body=>JSON.stringify(body).includes("read_only_background")));
  console.log(JSON.stringify({...verification,inspection:{captured:verification.inspection.coverage.captured,dropped:verification.inspection.dropped,rejected:verification.inspection.rejected}},null,2));
  console.log(`Provider: ${live?"actual Ollama gemma4:e4b":"controlled endpoint"}; protocol: ${openai?"OpenAI-compatible":"Ollama"}; calls: ${calls}`);success=true;
} finally {
  for(const controller of inFlight)controller.abort(new Error("Isolated verification ended"));
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  if(success&&resolve(root).startsWith(resolve(tmpdir())+"\\")&&root.includes("helarc-representation-method-"))await rm(root,{recursive:true,force:true});
  else console.log(`Preserved isolated evidence: ${root}`);
}
function run(phase,endpoint) {
  return new Promise(resolve=>{
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
    if(live)env.ACTIVITY_LIVE_MODEL="gemma4:e4b";if(openai)env.ACTIVITY_OPENAI="1";
    if(adoption)env.ACTIVITY_ADOPTION="1";
    if(joint)env.ACTIVITY_JOINT_INPUT="1";
    if(jointResultText)env.ACTIVITY_JOINT_RESULT_TEXT="1";
    if(inputUnavailable)env.ACTIVITY_INPUT_UNAVAILABLE="1";
    if(resupply)env.ACTIVITY_METHOD_RESUPPLY="1";
    if(multiple)env.ACTIVITY_MULTIPLE_SOURCES="1";
    if(taskRejection)env.ACTIVITY_TASK_REJECTION="1";
    if(stopLong)env.ACTIVITY_STOP_LONG="1";
    if(stopCancel)env.ACTIVITY_STOP_CANCEL="1";
    if(stopRetry)env.ACTIVITY_STOP_RETRY="1";
    if(stopRejection)env.ACTIVITY_STOP_REJECTION="1";
    if(methodRetry)env.ACTIVITY_METHOD_RETRY="1";
    if(inputRejection)env.ACTIVITY_PROVIDER_INPUT_REJECTION="1";
    if(cancelConsumer)env.ACTIVITY_CANCEL_CONSUMER="1";
    if(layered)env.ACTIVITY_LAYERED="1";
    if(lines)env.ACTIVITY_LINES="1";
    if(distributed)env.ACTIVITY_DISTRIBUTED="1";
    if(contracts)env.ACTIVITY_CONTRACTS="1";
    if(normalPolicy)env.ACTIVITY_NORMAL_POLICY="1";
    if(normalRevision)env.ACTIVITY_NORMAL_REVISION="1";
    if(simple)env.ACTIVITY_SIMPLE="1";
    if(wholeCheckTarget)env.ACTIVITY_WHOLE_CHECK_TARGET="1";
    const child=spawn(electron,[fixture,root,phase,endpoint],{env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
    let output="",timedOut=false;child.stdout.on("data",data=>output+=data);child.stderr.on("data",data=>output+=data);
    const timeout=setTimeout(()=>{timedOut=true;child.kill();},180000);
    child.on("error",error=>{clearTimeout(timeout);resolve({code:-1,output:String(error)});});
    child.on("close",code=>{clearTimeout(timeout);resolve({code:timedOut?-2:code,output});});
  });
}
