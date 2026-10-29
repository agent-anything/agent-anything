import {createServer} from "node:http";
import {spawn} from "node:child_process";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import assert from "node:assert/strict";
const require=createRequire(import.meta.url),electron=require("electron"),root=await mkdtemp(join(tmpdir(),"helarc-representation-method-"));
const fixture=fileURLToPath(new URL("./fixtures/representation-method.cjs",import.meta.url));
const live=process.argv.includes("--live-model"),openai=process.argv.includes("--openai");
const adoption=process.argv.includes("--adoption");
const lines=process.argv.includes("--line-ranges");
const layered=process.argv.includes("--layered")||lines;
const distributed=process.argv.includes("--distributed");
const contracts=process.argv.includes("--contracts");
const normalPolicy=process.argv.includes("--normal-policy");
const normalRevision=process.argv.includes("--normal-revision");
const simple=process.argv.includes("--simple");
const wholeCheckTarget=process.argv.includes("--whole-check-target-capacity");
const inFlight=new Set();
let calls=0;const bodies=[],methodBodies=[];
const server=createServer(async(req,res)=>{
  try {
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks).toString("utf8"));bodies.push(body);calls++;
    assert(!body.tools?.length);assert(!body.max_tokens&&!body.options?.num_predict);
    const text=body.prompt??body.messages.map(m=>m.content).join("\n");
    const objects=text.split("\n").flatMap(line=>{try{return [JSON.parse(line.replace(/^user: /,""))];}catch{return [];}});
    const work=objects.findLast(v=>v.job&&v.outputContract);assert(work||adoption&&text.includes("Based on the Child reports"),"method work data missing");
    if(work)methodBodies.push(body);
    if(live) {
      const controller=new AbortController();inFlight.add(controller);
      try {
        const response=await fetch(`http://localhost:11435${req.url}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(120000)])});
        res.writeHead(response.status,{"Content-Type":"application/json"});res.end(await response.text());return;
      }finally{inFlight.delete(controller);}
    }
    const check=work&&["check","relation","combination"].includes(work.job.kind);
    const output=!work?(simple?"The current staging port is 7542; 7431 is superseded.":"Image 5: radius 3. Image 6: radius 5. Preserve alpha throughout. TARGET: 7391. The version remains unverified."):check?{kind:"assessment",findings:Object.fromEntries(["source_to_candidate","candidate_to_source","relationships","precision"].map(direction=>[direction,{conclusion:"supported",sources:work.job.scope,candidates:work.job.candidates,basis:"Controlled fixture explicitly preserves the original agreement and correction",unknowns:[]}])),requirements:work.requirements.map(r=>({id:r.id,conclusion:"supported",basis:"controlled source evidence"})),missing:[]}:
      {kind:"candidate",parts:layered||distributed?work.job.scope.map(alias=>{const evidence=objects.find(v=>v.alias===alias);assert(evidence);return {text:evidence.originalRole==="derived_representation"?evidence.text:evidence.text.includes("User agreement")?"Original agreement: radius 3 for images 2 through 10, preserve alpha. TARGET: 7391.":evidence.text.includes("User correction")?"Later correction: from image 6 use radius 5. Image 5 used radius 3. Preserve alpha. Child B's version is unverified.":"Repeated read-only inspections recorded no changes.",sources:[alias]};}):[{text:"For images 2-5 use radius 3 and preserve alpha. From image 6 through 10 use radius 5, preserving alpha. The output version is unverified according to Child B. TARGET: 7391.",sources:work.job.scope}],covered:work.job.scope,background:[],losses:[],relationships:[],unknowns:[],missing:[]};
    if(layered&&work?.job.kind==="merge") {
      const texts=work.job.scope.map(alias=>objects.find(v=>v.alias===alias).text);
      output.parts=[{text:texts.some(t=>t.includes("radius 3"))?"Images 2-5: radius 3; 6-10: radius 5. Preserve alpha. TARGET: 7391. Child B's version is unverified. Repeated inspections made no changes.":"Repeated inspections made no changes.",sources:work.job.scope}];
    }
    if(work?.objective==="contract fixture: stage budget")output.parts=null;
    if(contracts&&check)for(const value of Object.values(output.findings))value.basis+=" Independent evidence description, not an identity field.".repeat(25);
    res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify(openai?{id:`response-${calls}`,choices:[{message:{role:"assistant",content:JSON.stringify(output)},finish_reason:"stop"}],usage:{prompt_tokens:400,completion_tokens:100,total_tokens:500}}:
      {model:"controlled",response:JSON.stringify(output),done:true,done_reason:"stop",prompt_eval_count:400,eval_count:100}));
  }catch(error){console.error(error);res.writeHead(500);res.end(JSON.stringify({error:String(error)}));}
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
let success=false;
try {
  const endpoint=`http://127.0.0.1:${server.address().port}`;
  for(const phase of adoption?["start","generated","checked","adopt","sent","finish"]:["start","generated","checked","finish"]) {
    const result=await run(phase,endpoint);assert.equal(result.code,phase==="finish"?0:73,result.output);console.log(`${phase}: passed`);
  }
  const verification=JSON.parse(await readFile(join(root,"verification.json"),"utf8"));
  assert.equal(calls,verification.totalProviderCalls);if(!live&&!layered&&!distributed&&!contracts)assert.equal(calls,(adoption?4:2)+(verification.revision?.additionalProviderCalls??0));if(layered||distributed)assert(calls>2);if(distributed)assert(verification.checkGroups>0);assert.equal(verification.inspection.dropped,0);assert.equal(verification.inspection.rejected,0);
  assert.equal(bodies.length-methodBodies.length,adoption?1:0,"Only the adopted Parent request is task work");
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
