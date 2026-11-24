import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {createServer} from "node:http";
import {createHash} from "node:crypto";
import {mkdtemp,readFile,writeFile} from "node:fs/promises";
import {writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import electron from "electron";
import {nativeVerificationEnvironment} from "./fixtures/native-verification-environment.mjs";
import applicationMaterial from "./fixtures/native-application-material.cjs";
import ordinaryCase from "./fixtures/native-application-ordinary.cjs";
import standaloneCase from "./fixtures/native-application-standalone.cjs";
import beforeCase from "./fixtures/native-application-before-use.cjs";
import stopCase from "./fixtures/native-application-stop.cjs";
import siblingsCase from "./fixtures/native-application-siblings.cjs";
import childCancel from "./fixtures/native-application-child-cancel.cjs";
import {checkBeforeUseRecording} from "./fixtures/read-before-use-admission.mjs";
import {checkBackgroundCompact,readPreparationComparison,readAssessmentAdmissions} from "./fixtures/read-preparation-comparison.mjs";
import {nativeMethodPeer} from "./fixtures/native-method-peer.mjs";
import {assertRefusalCoverage,checkRefusalRecovery,verifyReplacementFindings} from "./fixtures/native-application-refusal.mjs";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
const application=process.argv.includes("--application");
const productIdentities=process.argv.includes("--product-identities");
if(productIdentities)assert(application&&process.argv.slice(2).every(a=>["--application","--product-identities"].includes(a)));
const jointWork=process.argv.includes("--work-attribution");
const siblings=process.argv.includes("--concurrent-material"),material=siblings||process.argv.includes("--material");
const refusal=process.argv.includes("--input-refusal");
const cancelEntry=process.argv.includes("--child-cancel-entry");
if(cancelEntry)assert(process.argv.slice(2).every(a=>["--application","--child-cancel-entry","--protocol=openai.responses"].includes(a))&&application);
assert(!material||application,"Material verification requires ApplicationServices");
const protocol=process.argv.find(a=>a.startsWith("--protocol="))?.slice("--protocol=".length)??"openai.responses";
const ordinary=process.argv.includes("--ordinary"),auxiliary=[];
const stop=process.argv.includes("--stop-hook");
const standalone=process.argv.includes("--standalone"),compactRequests=[],compactOutputs=[],wireHashes=[];
const rejectRepair=process.argv.includes("--reject-plan-repair");
const repairPlan=rejectRepair||process.argv.includes("--repair-plan");assert(!repairPlan||standalone);
const beforeUse=process.argv.find(a=>a.startsWith("--before-use="))?.slice("--before-use=".length)??"",counted=ordinary||standalone||!!beforeUse||refusal||siblings;
assert(!siblings||application&&protocol==="openai.responses"&&!process.argv.includes("--report-recovery"));
assert(!refusal||application&&!ordinary&&!standalone&&!beforeUse&&!material&&protocol==="openai.responses");
assert(!stop||application&&!ordinary&&!standalone&&!beforeUse&&!material&&!refusal&&protocol==="openai.responses");
assert(!beforeUse||["allow","uncovered"].includes(beforeUse)&&application&&!ordinary&&!standalone&&!material&&protocol==="openai.responses");
assert(!jointWork||beforeUse==="uncovered"&&application);
assert(!standalone||application&&!material&&!ordinary&&protocol==="openai.responses");
assert(!ordinary||application&&!material&&protocol==="openai.responses");
assert(["openai.responses","deepseek.chat-completions","ollama.chat"].includes(protocol));
assert(application||protocol==="openai.responses","Additional Protocols require the formal application fixture");
const directory=await mkdtemp(join(tmpdir(),application?"helarc-native-application-":"helarc-native-host-")),requests=[],measurements=[],phases=[];
let failure;
const refused=[];
const server=createServer(async(req,res)=>{try{
  const paths=protocol==="openai.responses"?["/v1/responses","/v1/responses/input_tokens"]:protocol==="deepseek.chat-completions"?["/chat/completions"]:["/api/chat"];
  assert(paths.includes(req.url)||(standalone||refusal||beforeUse==="uncovered")&&req.url==="/v1/responses/compact",`Unexpected endpoint: ${req.url}`);assert.equal(req.method,"POST");const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const bytes=Buffer.concat(chunks),body=JSON.parse(bytes);
  const items=body.input??body.messages;
  assert.equal(body.model,"controlled");const properties=body.text?.format?.schema?.properties;
  const assessment=(standalone||refusal)&&["queries","answers","findings","facts","checks","requirements","reviews","assignments"].some(k=>properties&&Object.hasOwn(properties,k))&&
    items.some(i=>{try{const v=JSON.parse(i.content);return Array.isArray(v.duties)||Array.isArray(v.questions);}catch{return false;}});
  const method=assessment||(ordinary||standalone||refusal)&&!body.tools?.length&&items.some(item=>{try{return !!JSON.parse(item.content).job;}catch{return false;}});
  const stopInput=stop&&stopCase.isStop(body);
  if(!method&&!stopInput)assert(!body.instructions);assert(items.every(i=>i.role!=="system"));
  if(req.url==="/v1/responses/compact"){
    if(beforeUse==="uncovered"){
      const {root}=JSON.parse(await readFile(join(directory,"root.json")));
      const basis=checkBackgroundCompact(directory,root,bytes);
      await writeFile(join(directory,"background-compact-received.json"),JSON.stringify(basis),{flag:"wx"});
      // This controlled background response stays in flight. Foreground work must not need it.
      return;
    }
    compactRequests.push(body);await writeFile(join(directory,"compact-requests.json"),JSON.stringify(compactRequests,null,2));
    assert.equal(compactRequests.length,1);assert(!body.tools&&!body.previous_response_id);
    const output=standaloneCase.produce(items,!refusal);compactOutputs.push(output);
    await writeFile(join(directory,"compact-output.json"),JSON.stringify(output,null,2));
    res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({id:"cmp_result",object:"response.compaction",output}));return;
  }
  if(req.url.endsWith("input_tokens")){
    assert.equal(body.stream,undefined);assert.equal(body.store,undefined);
    measurements.push(body);if(siblings)writeFileSync(join(directory,"measurements.json"),JSON.stringify(measurements));else await writeFile(join(directory,"measurements.json"),JSON.stringify(measurements,null,2));
    res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({object:"response.input_tokens",input_tokens:counted?ordinaryCase.counted(body):100}));return;
  }
  const post=requests.push(body);wireHashes.push(createHash("sha256").update(bytes).digest("hex"));
  if(cancelEntry){
    await childCancel.serve(directory,post,bytes,body,res);
    return;
  }
  if(siblings){
    writeFileSync(join(directory,"requests.json"),JSON.stringify(requests));writeFileSync(join(directory,"peer-wire-hashes.json"),JSON.stringify(wireHashes));
    if(siblingsCase.role(body)==="parent"&&siblingsCase.hasDetail(body)){
      const seed=JSON.parse(await readFile(join(directory,"siblings-seed.json"),"utf8"));
      assert(bytes.equals(Buffer.from(seed.adoptedBody)),"Recovered Parent request differs from the accepted bytes");
    }
  }else await writeFile(join(directory,"requests.json"),JSON.stringify(requests,null,2));
  if(stop)await writeFile(join(directory,"peer-wire-hashes.json"),JSON.stringify(wireHashes));
  if(stopInput){
    const value=stopCase.answer(body),id="stop_"+requests.length;
    res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({id:"resp_"+id,object:"response",status:"completed",model:"controlled",
      output:[{id,type:"message",role:"assistant",content:[{type:"output_text",text:JSON.stringify(value),annotations:[]}]}],
      usage:{input_tokens:100,output_tokens:20,total_tokens:120}}));return;
  }
  if(refusal){
    await writeFile(join(directory,"peer-wire-hashes.json"),JSON.stringify(wireHashes));
    assert.equal(body.context_management,undefined);
    const count=measurements.findLast(m=>JSON.stringify(m.input)===JSON.stringify(items)&&JSON.stringify(m.tools)===JSON.stringify(body.tools));
    assert(count,"No complete-input count for the wire request");
    if(ordinaryCase.counted(count)>ordinaryCase.capacity){
      const evidence={post:requests.length,sha256:wireHashes.at(-1),tokens:ordinaryCase.counted(count),status:400,code:"context_length_exceeded"};
      assert(!refused.some(v=>v.sha256===evidence.sha256),"The application dispatched the same refused bytes again");
      refused.push(evidence);await writeFile(join(directory,"peer-refusals.json"),JSON.stringify(refused));
      res.writeHead(400,{"content-type":"application/json"});res.end(JSON.stringify({error:{type:"invalid_request_error",code:evidence.code,message:"Input exceeds controlled deployment capacity."}}));return;
    }
  }
  if(beforeUse==="allow"&&body.context_management){
    const checkpoint=JSON.parse(await readFile(join(directory,"before-selected.json"),"utf8"));
    assert(bytes.equals(Buffer.from(checkpoint.adoptedBody,"utf8")),"Parent HTTP entity differs from the adopted input");
    await writeFile(join(directory,"parent-wire-receipt.json"),JSON.stringify({bytes:bytes.length,sha256:wireHashes.at(-1),
      bytewiseEqual:true,acceptedInput:checkpoint.inputId,post:requests.length}));
  }
  if(method){
    assert(body.text?.format?.type==="json_schema");const assessed=assessment?standaloneCase.assess(items,rejectRepair?"reject":repairPlan):null;
    const value=assessed?assessed.value:nativeMethodPeer(items);auxiliary.push(assessed?.kind??value.kind);
    const id="aux_"+requests.length;res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({id:"resp_"+id,object:"response",model:"controlled",status:"completed",
      output:[{id,type:"message",role:"assistant",content:[{type:"output_text",text:JSON.stringify(value),annotations:[]}]}],
      usage:{input_tokens:ordinaryCase.counted(body),output_tokens:20,total_tokens:ordinaryCase.counted(body)+20}}));return;
  }
  const semanticItems=refusal&&items.some(i=>i.type==="compaction")?standaloneCase.expand(items):items;
  const text=JSON.stringify(semanticItems),followup=text.includes("HOST_FOLLOWUP"),child=!text.includes("HOST_ROOT"),results=semanticItems.filter(i=>i.type==="function_call_output"||i.role==="tool");
  if(followup){
    const calls=protocol==="openai.responses"?items.filter(i=>i.type==="function_call"):items.flatMap(i=>i.tool_calls??[]).map(c=>c.function);
    assert.equal(calls.filter(i=>/^Write(?:_|$)/.test(i.name)).length,1);
    const isWriteResult=i=>protocol==="ollama.chat"?i.role==="tool"&&/^Write(?:_|$)/.test(i.tool_name):i.call_id==="call_1"||i.tool_call_id==="call_1";
    assert.equal(results.filter(isWriteResult).length,1);
    assert(text.includes("Child result 7391"));
    assert(items.findIndex(i=>JSON.stringify(i).includes("HOST_FOLLOWUP"))>items.findIndex(isWriteResult));
  }
  const name=followup||child?"final_result":results.length===0?"Write":results.length===1?"Agent":"final_result";
  if(ordinary&&!child&&name==="final_result")ordinaryCase.parentReply(items);
  if(refusal&&refused.length&&!child)verifyReplacementFindings(semanticItems);
  const values=child?{response:ordinary||refusal?ordinaryCase.report:"Child result 7391"}:name==="Write"?{file_path:"once.txt",content:"ORIGINAL"}:name==="Agent"?
    {description:"Report number",prompt:ordinary||refusal?"HOST_CHILD: Report result 7391 and all 60 identical calibration observations. State that measurements are unverified and that no changes were made.":"HOST_CHILD: Report 7391 using final_result. No tools or children."}:{response:"Root received 7391"};
  const i=post;
  const calls=(siblings?await siblingsCase.calls(body,directory):beforeUse?[beforeCase.call(items)]:material?applicationMaterial.calls(body):standalone?[standaloneCase.call(items)]:[{name,values}]).map((plan,index)=>{
    const tool=body.tools.map(t=>t.function??t).find(t=>t.name===plan.name||t.name.startsWith(`${plan.name}_`));assert(tool,`Missing ${plan.name}`);
    const args={};for(const key of tool.parameters.required??[])args[key]=Object.hasOwn(plan.values,key)?plan.values[key]:null;
    Object.assign(args,plan.values);return {name:tool.name,args,id:`call_${i}${index?`_${index}`:""}`};
  });
  if(protocol==="openai.responses"){
    const tokens=counted?ordinaryCase.counted(measurements.findLast(m=>JSON.stringify(m.input)===JSON.stringify(items))??body):100;
    res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({id:`resp_${i}`,object:"response",status:"completed",model:"controlled",
      output:[...((beforeUse||siblings)&&body.context_management?[{type:"compaction",id:"cmp_before_use",encrypted_content:"controlled-opaque-result"}]:[]),
        ...calls.map((c,index)=>({id:`fc_${i}_${index}`,type:"function_call",call_id:c.id,name:c.name,arguments:JSON.stringify(c.args),status:"completed"}))],usage:{input_tokens:tokens,output_tokens:20,total_tokens:tokens+20}}));
  }else if(protocol==="deepseek.chat-completions"){
    const message={role:"assistant",content:null,tool_calls:calls.map(c=>({id:c.id,type:"function",function:{name:c.name,arguments:JSON.stringify(c.args)}}))};
    const envelope={id:`chat_${i}`,object:"chat.completion",model:"controlled",created:1,usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}};
    if(body.stream){
      res.writeHead(200,{"content-type":"text/event-stream"});
      res.write(`data: ${JSON.stringify({...envelope,object:"chat.completion.chunk",usage:null,choices:[{index:0,delta:{...message,tool_calls:message.tool_calls.map((c,index)=>({...c,index}))},finish_reason:"tool_calls"}]})}\n\n`);
      res.write(`data: ${JSON.stringify({...envelope,object:"chat.completion.chunk",choices:[]})}\n\n`);res.end("data: [DONE]\n\n");
    }else{res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({...envelope,choices:[{index:0,finish_reason:"tool_calls",message}]}));}
  }else{
    const response={model:"controlled",created_at:new Date().toISOString(),done:true,done_reason:"stop",prompt_eval_count:100,eval_count:20,
      message:{role:"assistant",content:"",tool_calls:calls.map((c,index)=>({function:{index,name:c.name,arguments:c.args}}))}};
    res.writeHead(200,{"content-type":body.stream?"application/x-ndjson":"application/json"});res.end(JSON.stringify(response)+(body.stream?"\n":""));
  }
}catch(error){failure??=error;await writeFile(join(directory,"peer-failure.txt"),failure.stack??String(failure));res.writeHead(500);res.end("Controlled native peer rejected request");}});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));const endpoint=`http://127.0.0.1:${server.address().port}${protocol==="openai.responses"?"/v1":""}`;
async function verify(){
  const reportRecovery=process.argv.includes("--report-recovery");
  assert(!reportRecovery||material);
  const sequence=siblings?["siblings-seed","resume"]:stop?["stop-seed","resume"]:refusal?["refusal-seed","resume"]:beforeUse?["gate","start",...(beforeUse==="allow"?["before-selected"]:[]),"resume"]:standalone?["gate","start","compact-observed","compact-selected","resume"]:ordinary?["gate","start","ordinary-selected","resume"]:[...(application?["gate"]:[]),"start",...(reportRecovery?["report-before","report-captured","report-granted"]:[]),"resume","followup","followup-resume"];
  if(rejectRepair)sequence.splice(sequence.indexOf("compact-selected"),1);
  if(jointWork)sequence.splice(sequence.indexOf("gate"),1);
  if(productIdentities)sequence.splice(sequence.indexOf("followup-resume"),1,"identity-new");
  for(const phase of cancelEntry?["child-cancel-entry","child-cancel-resume"]:sequence){
    const env=nativeVerificationEnvironment({HELARC_VERIFICATION_SIBLINGS:siblings?"1":"0",HELARC_VERIFICATION_STOP:stop?"1":"0",HELARC_VERIFICATION_PROTOCOL:protocol,HELARC_VERIFICATION_MATERIAL:String(material),HELARC_VERIFICATION_ORDINARY:String(ordinary),HELARC_VERIFICATION_STANDALONE:String(standalone),HELARC_VERIFICATION_BEFORE_USE:beforeUse,HELARC_VERIFICATION_INPUT_REFUSAL:refusal?"1":"0"});const started=performance.now();
    await new Promise((resolve,reject)=>{
      if(jointWork)env.HELARC_WORK_ATTRIBUTION="1";
      if(rejectRepair)env.HELARC_REJECT_PLAN_REPAIR="1";
      const child=spawn(electron,[fileURLToPath(new URL(application?"./fixtures/native-application-run.cjs":"./fixtures/native-host-run.cjs",import.meta.url)),directory,phase,endpoint],
        {cwd:fileURLToPath(new URL("../",import.meta.url)),env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
      let log="",timedOut=false,killing=Promise.resolve();for(const s of [child.stdout,child.stderr])s.on("data",x=>log=(log+x).slice(-8000));
      const timer=setTimeout(()=>{timedOut=true;killing=new Promise(done=>{const k=spawn("taskkill",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});k.once("close",done);k.once("error",()=>{child.kill();done();});});},90000);
      child.once("error",error=>{clearTimeout(timer);reject(error);});child.once("close",async code=>{clearTimeout(timer);await killing;
        if(!timedOut&&code===(phase==="child-cancel-entry"||phase==="siblings-seed"||phase==="stop-seed"||phase==="refusal-seed"||phase==="start"||phase==="ordinary-selected"||phase==="before-selected"||phase.startsWith("compact-")||phase.startsWith("report-")?73:0)&&!failure)resolve();else reject(failure??new Error(`${phase}: code=${code} timeout=${timedOut}\n${await readFile(join(directory,`failure-${phase}.txt`),"utf8").catch(()=>log)}`));});
    });
    if(failure)throw failure;
    if(cancelEntry){
      if(phase==="child-cancel-entry"){assert.equal(requests.length,6);continue;}
      const result=JSON.parse(await readFile(join(directory,"cancel-resumed.json"),"utf8"));
      assert.equal(requests.length,8);assert.equal(measurements.length,8);
      const {DatabaseSync}=await import("node:sqlite"),cut=JSON.parse(await readFile(join(directory,"cancel-cut.json"),"utf8"));
      const open=({sourceId,datasetId})=>new DatabaseSync(join(directory,"inspection","sources",sourceId,"datasets",datasetId,"inspection.sqlite"),{readOnly:true});
      const seed=open(cut.recording),db=open(result.recording);
      try{
        const byId=db.prepare("select value from records where id=? and run_id=?");
        const r=result.request,b=r.delegation;
        const recordId=r.id+":delegated-scope";
        const observed=JSON.parse(seed.prepare("select value from records where id=? and run_id=?").get(recordId,b.childRunId).value);
        assert(observed.links.some(l=>l.kind==="trigger"&&l.from.runId===b.parentRunId));
        assert(observed.links.some(l=>l.kind==="binding"&&l.to.runId===b.childRunId));
        const body=seed.prepare("select b.bytes from contents c join bodies b on c.body_id=b.id where c.record_id=?").get(recordId);
        assert.deepEqual(JSON.parse(Buffer.from(body.bytes)).delegation,b);
        assert(byId.get("material-delivery:"+b.parentRunId+":"+result.parentReceipt,b.parentRunId),"Missing Parent delivery receipt in Inspector");
      }finally{db.close();seed.close();}
      console.log(JSON.stringify({directory,scenario:"child_cancellation_isolation",passed:true,requests:requests.length,sha256:result.sha256}));return;
    }
    if(phase==="gate"){
      assert.equal(requests.length,0);assert.equal(measurements.length,0);
      phases.push(JSON.parse(await readFile(join(directory,"gate.json"),"utf8")));console.log("gate passed (default remains closed)");continue;
    }
    const attempts=(await readFile(join(directory,"physical-write-attempts.ndjson"),"utf8")).trim().split("\n").map(line=>JSON.parse(line));
    assert.equal(attempts.length,1,"Recovery/follow-up must not reopen the file for another mutation");assert.equal(attempts[0].phase,siblings?"siblings-seed":stop?"stop-seed":refusal?"refusal-seed":"start");
    const data={...JSON.parse(await readFile(join(directory,`${phase}.json`),"utf8")),physicalWriteAttempts:attempts.length};phases.push(data);console.log(`${phase} passed (${Math.round(performance.now()-started)}ms)`);
    if(beforeUse)Object.assign(data,{measurementsAtBoundary:measurements.length,postsAtBoundary:requests.length});
    if(phase==="refusal-seed"){assert.equal(refused.length,1);assert.equal(requests.length,4);assert.equal(data.evidence.bodyDigest,"sha256:"+refused[0].sha256);}
    if(phase==="siblings-seed"){
      assert.equal(requests.length,7);assert(!requests.some(siblingsCase.hasDetail));
      data.measurementsAtCut=measurements.length;
    }
    if(phase==="stop-seed"){
      assert.equal(requests.length,3);assert.equal(requests.filter(stopCase.isStop).length,0);
      assert.equal(measurements.filter(stopCase.isStop).length,1);
    }
    if(phase==="ordinary-selected"){assert.deepEqual(auxiliary,["candidate","assessment"]);assert.equal(requests.length,5);}
    if(beforeUse)assert.equal(requests.length,phase==="start"?3:phase==="before-selected"?4:5);
    if(standalone){
      assert.equal(compactRequests.length,phase==="start"?0:1);
      if(rejectRepair&&phase==="resume"){
        assert.deepEqual(auxiliary,["oracle","plan-ownership"]);assert.equal(requests.length,5);continue;
      }
      assert.equal(requests.length,phase==="resume"?7+Number(repairPlan):phase==="compact-selected"?6+Number(repairPlan):3);
      assert.deepEqual(auxiliary,phase==="compact-selected"||phase==="resume"?["oracle",...(repairPlan?["plan-ownership"]:[]),"probe","judgment"]:[]);
    }
  }
  if(!refusal)assert.equal(requests.length,productIdentities?6:stop?6:rejectRepair?5:standalone?7+Number(repairPlan):ordinary?6:material?8:5);
  if(!counted)assert.equal(measurements.length,protocol==="openai.responses"?requests.length:0);
  assert.equal(new Set(phases.map(p=>p.pid)).size,sequence.length);
  if(protocol==="openai.responses"){
    const remaining=[...measurements];
    for(const request of requests){
      const index=remaining.findIndex(m=>["model","input","tools"].every(key=>JSON.stringify(m[key])===JSON.stringify(request[key])));
      assert(index>=0,"Each dispatched native input requires its own matching measurement");remaining.splice(index,1);
    }
    if(siblings){
      const [seed,last]=phases,wire=requests.at(-1);
      assert(last.generation>seed.generation);assert.equal(measurements.length,seed.measurementsAtCut);
      const details=siblingsCase.audit(directory,seed,last,requests,wireHashes);
      await writeFile(join(directory,"siblings-audit.json"),JSON.stringify(details,null,2));
      assert(seed.agreementId,"No adopted method agreement for the Parent input containing the detail");
      assert.deepEqual(wire.context_management,[{type:"compaction",compact_threshold:siblingsCase.threshold}]);
      assert.equal(remaining.length,1);assert.deepEqual(remaining[0].input,wire.input);
      last.siblings={...details,method:checkBeforeUseRecording(directory,last.recording,seed,wire,{members:3,responseId:"resp_"+requests.length})};
    }else if(stop){
      assert.equal(remaining.length,0);
      const barrier=JSON.parse(await readFile(join(directory,"stop-projection-barrier.json"),"utf8"));
      phases.at(-1).stop=stopCase.audit(directory,phases[0],phases.at(-1),requests,measurements,wireHashes,barrier);
      await writeFile(join(directory,"stop-audit.json"),JSON.stringify(phases.at(-1).stop,null,2));
      stopCase.assertCoverage(phases.at(-1).stop);
    }else if(refusal){
      phases.at(-1).refusal=checkRefusalRecovery({directory,seed:phases[0],resume:phases.at(-1),requests,wireHashes,refused});
      await writeFile(join(directory,"refusal-audit.json"),JSON.stringify(phases.at(-1).refusal,null,2));
      assertRefusalCoverage(phases.at(-1).refusal);
    }else if(beforeUse){
      assert(requests.slice(0,-1).every(b=>b.context_management===undefined));
      const final=requests.at(-1),positive=beforeUse==="allow",accepted=positive?phases.at(-2):null;
      assert.deepEqual(final.context_management,positive?[{type:"compaction",compact_threshold:beforeCase.threshold}]:undefined);
      if(positive){
        assert.deepEqual(final,JSON.parse(accepted.adoptedBody));assert.equal(wireHashes.at(-1),accepted.bytesSha256);
        assert.equal(modelInputValueDigest(final),accepted.wire);
        assert.equal(measurements.length,accepted.measurementsAtBoundary,"Recovery repeated complete-input measurement");
        assert.equal(requests.length,accepted.postsAtBoundary+1,"Recovery repeated an earlier generation");
      }
      phases.at(-1).beforeUse=checkBeforeUseRecording(directory,phases.at(-1).recording,accepted,final);
    }else if(ordinary){
      assert.deepEqual(auxiliary,["candidate","assessment"]);
      phases.at(-1).comparison=readPreparationComparison(directory,phases.at(-1).recording);
      assert.equal(modelInputValueDigest(requests.at(-1)),JSON.parse(await readFile(join(directory,"ordinary-selected.json"),"utf8")).wire,
        "Restored Parent must dispatch the exact adopted native input");
      assert.equal(remaining.length,1);assert(ordinaryCase.counted(remaining[0])>ordinaryCase.capacity);
      assert(remaining[0].input.some(i=>i.type==="function_call_output"&&JSON.parse(i.output).result?.output?.summary===ordinaryCase.report));
    }else if(rejectRepair){
      assert(!requests.some(b=>b.tools?.length&&b.input.some(i=>i.type==="compaction")));
      assert.equal(remaining.length,1);assert(ordinaryCase.counted(remaining[0])>standaloneCase.capacity);
      const last=phases.at(-1),admissions=readAssessmentAdmissions(directory,last.recording);
      assert(auxiliary.every(step=>admissions.some(a=>a.scope.activityId.endsWith(":compact-assessment:"+step))));
      Object.assign(last,{assessment:auxiliary,compactPosts:compactRequests.length});
    }else if(standalone){
      const final=requests.at(-1),accepted=JSON.parse(await readFile(join(directory,"compact-selected.json"),"utf8"));
      assert.equal(modelInputValueDigest(final),accepted.wire);
      assert.equal(wireHashes.at(-1),accepted.bytesSha256,"Restored HTTP bytes differ from adopted Parent input");
      assert.equal(remaining.length,1);const raw=remaining[0],prefix=compactRequests[0].input;
      assert.deepEqual(raw.input.slice(0,prefix.length),prefix);
      assert.deepEqual(final.input,[...compactOutputs[0],...raw.input.slice(prefix.length)]);
      const count=m=>ordinaryCase.counted(m),adopted=measurements.find(m=>modelInputValueDigest(m.input)===modelInputValueDigest(final.input)&&m.tools);
      assert(count(raw)>standaloneCase.capacity&&count(adopted)<=standaloneCase.capacity);
      const comparison=readPreparationComparison(directory,phases.at(-1).recording);
      assert.equal(comparison.chosen.family,"protocol");assert(comparison.candidates>1);
      const admissions=readAssessmentAdmissions(directory,phases.at(-1).recording);
      for(const [index,step] of auxiliary.entries()){
        const matches=admissions.filter(a=>a.scope.activityId.endsWith(":compact-assessment:"+step)&&a.requestDigest===modelInputValueDigest(requests[3+index]));
        assert(matches.length&&new Set(matches.map(a=>a.id)).size===1);
        const a=matches[0],m=measurements.find(m=>modelInputValueDigest(m.input)===modelInputValueDigest(requests[3+index].input));
        assert.equal(a.status,"submission_permitted");assert(a.measurements.some(e=>e.dimension==="input_tokens"&&e.quantity.kind==="exact"&&e.quantity.value===count(m)));
      }
      Object.assign(phases.at(-1),{comparison,capacity:standaloneCase.capacity,original:count(raw),adopted:count(adopted),compactPosts:compactRequests.length,assessment:auxiliary,
        parentHttpSha256:wireHashes.at(-1),inspectedAdmissions:[...new Set(admissions.map(a=>a.id))]});
    }else assert.equal(remaining.length,0);
  }
  await writeFile(join(directory,"result.json"),JSON.stringify({passed:true,protocol,requests:requests.length,measurements:measurements.length,phases},null,2));console.log(JSON.stringify({passed:true,protocol,directory,requests:requests.length,measurements:measurements.length}));
}
try{await verify();}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));console.log(`Evidence: ${directory}`);}
