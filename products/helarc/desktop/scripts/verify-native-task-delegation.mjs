import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {createServer} from "node:http";
import {mkdtemp,mkdir,readFile,writeFile,appendFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import electron from "electron";
import {nativeMethodPeer} from "./fixtures/native-method-peer.mjs";
const root=await mkdtemp(join(tmpdir(),"helarc-native-delegation-"));
const fixture=fileURLToPath(new URL("./fixtures/native-task-delegation.cjs",import.meta.url));
const protocols=process.argv.slice(2).length?process.argv.slice(2):["responses","deepseek","ollama"];
const results=[];
const extra=Number(process.env.HELARC_TEST_EXTRA_CHILDREN??0),reportLines=Number(process.env.HELARC_TEST_REPORT_LINES??1100);
assert(Number.isSafeInteger(extra)&&extra>=0&&extra<=5);assert(Number.isSafeInteger(reportLines)&&reportLines>=1100&&reportLines<=20000);
let current,requests=[],failure=null;
const remote=new Map();
function argumentsFor(schema,value){
  if(!schema?.properties)return value;
  return Object.fromEntries(Object.entries(schema.properties).flatMap(([name,child])=>{
    if(Object.hasOwn(value,name))return [[name,value[name]]];
    return schema.required?.includes(name)?[[name,child.type==="array"?[]:null]]:[];
  }));
}
function response(body){
  const items=body.input??body.messages,all=JSON.stringify(items);
  if(!body.tools&&body.text?.format?.schema?.properties?.status){
    assert(current.includes(":stop"));assert.equal(items.length,1);
    const evidence=JSON.parse(items[0].content);assert.equal(evidence.kind,"host_task_fulfillment_evidence");
    assert(evidence.originalTask&&evidence.settledInteraction.length&&body.instructions);
    assert(evidence.settledInteraction.some(i=>i.type==="function_call"&&i.name==="final_result"));
    requests.push({task:"auxiliary:stop",body,calls:[]});
    return {id:`resp_${requests.length}`,object:"response",status:"completed",model:"controlled",output:[{id:`msg_${requests.length}`,type:"message",role:"assistant",
      content:[{type:"output_text",text:JSON.stringify({status:"fulfilled",disposition:"allow",rationale:"Original evidence allows ending.",missingOutcomes:[],unsupportedClaims:[]}),annotations:[]}]}]};
  }
  if(!body.tools&&(all.includes("CHILD_BODY_CONVERSION")||current.includes(":ordinary"))){
    const value=nativeMethodPeer(items);
    requests.push({task:"auxiliary:child-conversion",body,calls:[]});
    if(current.startsWith("deepseek"))return {id:`chat_${requests.length}`,object:"chat.completion",model:"controlled",
      choices:[{index:0,finish_reason:"stop",message:{role:"assistant",content:JSON.stringify(value)}}]};
    if(current.startsWith("ollama"))return {model:"controlled",created_at:new Date().toISOString(),done:true,done_reason:"stop",
      message:{role:"assistant",content:JSON.stringify(value)}};
    return {id:`resp_${requests.length}`,object:"response",status:"completed",model:"controlled",output:[{id:`msg_${requests.length}`,type:"message",role:"assistant",
      content:[{type:"output_text",text:JSON.stringify(value),annotations:[]}]}]};
  }
  assert(Array.isArray(items));assert(!body.instructions);assert(!items.some(i=>i.role==="system"));
  const messages=items.filter(i=>i.role==="user"),assignment=messages.findLast(i=>String(i.content).startsWith("Parent assignment:"));
  const task=assignment?.content??messages.find(i=>String(i.content).startsWith("ROOT_CASE:"))?.content;
  assert(task,"original task is missing");
  const completed=items.some(i=>i.type==="function_call_output"||i.role==="tool");
  const tools=body.tools.map(t=>t.function??t);
  const tool=prefix=>{const found=tools.find(t=>t.name===prefix||t.name.startsWith(`${prefix}_`));assert(found,`missing ${prefix}`);return found;};
  const calls=[];let text="";
  const call=(prefix,args)=>{const definition=tool(prefix);calls.push({id:`call_${requests.length}_${calls.length}`,name:definition.name,
    arguments:argumentsFor(definition.parameters,args)});};
  if(task.includes("ROOT_CASE")){
    if(!completed){call("Agent",{description:"CHILD_ALPHA",prompt:"CHILD_ALPHA: Delegate LEAF_CASE; report its result."});
      call("Agent",{description:"CHILD_BETA",prompt:"CHILD_BETA: Report 8422 using final_result.",
        ...(current.includes(":missing-source")?{material_refs:[{id:"custody:unavailable-original",revision:`sha256:${"0".repeat(64)}`}]}:{})});
      for(let i=0;i<extra;i++)call("Agent",{description:`EXTRA_${i}`,prompt:`EXTRA_${i}: Report your own index ${i} using final_result; do not delegate.`});}
    else{assert(all.includes("7391"));
      const outputs=items.filter(i=>i.type==="function_call_output"||i.role==="tool").map(i=>JSON.parse(i.output??i.content));
      const progress=outputs.find(o=>o.result?.output?.status==="suspended");
      const report=outputs.find(o=>o.result?.output?.report)?.result.output.report;
      const search=outputs.find(o=>o.result?.output?.matches)?.result.output;
      const read=outputs.find(o=>o.result?.output?.coordinate==="utf8_view_bytes")?.result.output;
      if(current.includes(":progress")&&!current.includes(":progress-ending")&&progress&&!outputs.some(o=>o.result?.output?.steering_status)){
        call("SendMessage",{agent_id:progress.result.output.agent_id,prompt:"CORRECTION_CASE: Continue the same assignment and report 8422; preserve the original number."});
      }else if(current.includes(":material")&&!search){
        assert.equal(report?.status,"retained_material");assert(!all.includes("DETAIL_CODE"));
        call("ContextMaterialSearch",{references:[report.reference],query:"DETAIL_CODE",limit:1});
      }else if(current.includes(":material")&&!read){
        assert(search.matches.length===1);call("ContextMaterialRead",{reference:report.reference,offset:search.matches[0].byteStart,length:256});
      }else if(current.endsWith(":successor")&&!all.includes("SUCCESSOR_CASE")){
        const outputs=items.filter(i=>i.type==="function_call_output"||i.role==="tool").map(i=>JSON.parse(i.output??i.content));
        const alpha=outputs.find(o=>o.result?.output?.summary.includes("7391"));assert(alpha?.result.output.agent_id,"closed Child has no continuation target");
        call("SendMessage",{agent_id:alpha.result.output.agent_id,prompt:"SUCCESSOR_CASE: Using your retained leaf result, report 9933. Do not delegate or repeat previous work."});
      }else {assert(!current.includes(":material")||read.text.includes("6843"));
        if(current.includes(":failed-child")){const failed=outputs.find(o=>o.result?.output?.failure_code==="model_protocol_recovery_exhausted");assert(failed);
          assert(failed.result.output.summary.includes("Beta attempt 3"));assert.equal(failed.result.output.status,"failed");}
        if(current.includes(":missing-source")){assert(outputs.some(o=>o.result?.failure));assert(!requests.some(r=>r.task.startsWith("Parent assignment:\nCHILD_BETA")));}
        if(current.includes(":same-text")){const matching=outputs.filter(o=>o.result?.output?.summary==="Shared report: 7391 and 8422.");assert.equal(matching.length,2);}
        call("final_result",{response:current.includes(":missing-source")?"Alpha returned 7391. Beta was not started: its required source was unavailable; requested 8422 is not a produced result.":
          current.includes(":material")?"The child results are 7391 and 8422; DETAIL_CODE is 6843.":
          current.includes(":failed-child")?"Alpha delivered 7391; Beta reported 8422 but failed with no ending signal.":"The child results are 7391 and 8422."});}}
  }else if(task.includes("SUCCESSOR_CASE")){
    assert(all.includes("7391"));assert(!all.includes("ROOT_CASE"));
    const originalCalls=items.filter(i=>i.type==="function_call"||i.role==="assistant");assert(originalCalls.length>=2);
    call("final_result",{response:"Successor result: 9933; the original leaf returned 7391."});
  }else if(task.includes("CHILD_ALPHA")){
    assert(!all.includes("ROOT_CASE"));assert(!all.includes("CHILD_BETA"));
    if(!completed)call("Agent",{description:"LEAF_CASE",prompt:"LEAF_CASE: Report 7391 using final_result."});
    else{assert(all.includes("7391"));call("final_result",{response:current.includes(":same-text")?"Shared report: 7391 and 8422.":"Leaf result: 7391."});}
  }else if(task.includes("CHILD_BETA")){assert(!all.includes("CHILD_ALPHA"));
    if(current.includes(":failed-child")){const n=requests.filter(r=>r.task.startsWith("Parent assignment:\nCHILD_BETA")).length+1;assert(n<=3);
      if(n>1){assert(all.includes(`Beta attempt ${n-1}`));assert(all.includes("final_result"));}
      text=`Beta attempt ${n}: 8422; work is unfinished.`;
    }else if(current.includes(":oversized")&&!completed)call("final_result",{response:"Unbounded proposed text. ".repeat(12000)});
    else {if(current.includes(":oversized"))assert(all.includes("helarc_native_call_input_too_large"));
      call("final_result",{response:current.includes(":same-text")?"Shared report: 7391 and 8422.":current.includes(":material")?
      "Beta result: 8422; measurements remain unverified.\n"+"Detailed source facts, retained exactly.\n".repeat(reportLines)+"DETAIL_CODE 6843; end of original report.":current.includes(":converted")||current.includes(":ordinary")?
      "Beta result: 8422; measurements remain unverified.\n"+"SOURCE_DETAIL repeated measurements without independent confirmation.\n".repeat(50):"Beta result: 8422."});}}
  else if(task.includes("EXTRA_")){assert(!all.includes("CHILD_BETA")&&!all.includes("CHILD_ALPHA"));call("final_result",{response:`Independent result: ${task.match(/EXTRA_\d+/)[0]}.`});}
  else{assert(task.includes("LEAF_CASE"));assert(!all.includes("ROOT_CASE"));call("final_result",{response:"Leaf result: 7391."});}
  requests.push({task,body,calls});
  if(current.startsWith("responses"))return {id:`resp_${requests.length}`,object:"response",status:"completed",model:"controlled",output:[...(text?[{type:"message",id:`msg_${requests.length}`,role:"assistant",content:[{type:"output_text",text,annotations:[]}]}]:[]),...calls.map((c,i)=>({type:"function_call",id:`fc_${requests.length}_${i}`,
    call_id:c.id,name:c.name,arguments:JSON.stringify(c.arguments),status:"completed"}))],usage:{input_tokens:200,output_tokens:80,total_tokens:280}};
  if(current.startsWith("deepseek"))return {id:`chat_${requests.length}`,object:"chat.completion",model:"controlled",choices:[{index:0,finish_reason:calls.length?"tool_calls":"stop",message:{role:"assistant",content:text||null,
    tool_calls:calls.map(c=>({id:c.id,type:"function",function:{name:c.name,arguments:JSON.stringify(c.arguments)}}))}}],usage:{prompt_tokens:200,completion_tokens:80,total_tokens:280}};
  return {model:"controlled",created_at:new Date().toISOString(),done:true,done_reason:"stop",message:{role:"assistant",content:text,
    tool_calls:calls.map((c,i)=>({function:{index:i,name:c.name,arguments:c.arguments}}))},prompt_eval_count:200,eval_count:80};
}
const server=createServer(async(req,res)=>{try{let text="";for await(const chunk of req)text+=chunk;
  if(req.method==="GET"){
    const id=req.url.split("/").at(-1),found=remote.get(id);assert(found,"unknown remote Response");
    res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify(found));return;
  }
  const body=JSON.parse(text);assert.equal(req.method,"POST");
  await appendFile(join(root,current.replaceAll(":","-"),"wire-requests.ndjson"),JSON.stringify(body)+"\n");
  const result=response(body);
  if(body.background){remote.set(result.id,result);res.writeHead(200,{"Content-Type":"application/json"});
    res.end(JSON.stringify({...result,status:"queued",output:[],usage:null}));return;}
  if(body.stream&&current.startsWith("responses")){
    res.writeHead(200,{"Content-Type":"text/event-stream"});
    res.write(`event: response.created\ndata: ${JSON.stringify({type:"response.created",sequence_number:0,response:{...result,status:"in_progress",output:[],usage:null}})}\n\n`);
    res.end(`event: response.completed\ndata: ${JSON.stringify({type:"response.completed",sequence_number:1,response:result})}\n\n`);return;
  }
  if(body.stream&&current.startsWith("deepseek")){
    res.writeHead(200,{"Content-Type":"text/event-stream"});
    const choice=result.choices[0],message=choice.message;
    const delta={...message,...(message.tool_calls?{tool_calls:message.tool_calls.map((c,index)=>({...c,index}))}:{})};
    res.write(`data: ${JSON.stringify({...result,object:"chat.completion.chunk",usage:null,choices:[{index:0,delta,finish_reason:choice.finish_reason}]})}\n\n`);
    res.write(`data: ${JSON.stringify({...result,object:"chat.completion.chunk",choices:[]})}\n\n`);
    res.end("data: [DONE]\n\n");return;
  }
  if(body.stream&&current.startsWith("ollama")){
    res.writeHead(200,{"Content-Type":"application/x-ndjson"});res.end(JSON.stringify(result)+"\n");return;
  }
  res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify(result));
}catch(error){failure=error;res.writeHead(500,{"Content-Type":"application/json"});res.end(JSON.stringify({error:{message:String(error)}}));}});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const endpoint=`http://127.0.0.1:${server.address().port}`;
const taskAndMethodRequests=()=>requests.filter(r=>r.task!=="auxiliary:stop").length;
async function launch(directory,phase,expected){
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((resolve,reject)=>{
    const child=spawn(electron,[fixture,directory,phase,current.replaceAll(":","-"),endpoint],{env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
    let output="",timedOut=false,cleanup=Promise.resolve();
    child.stdout.on("data",b=>output=(output+b).slice(-8000));child.stderr.on("data",b=>output=(output+b).slice(-8000));
    const timer=setTimeout(()=>{timedOut=true;cleanup=new Promise(done=>{
      if(process.platform!=="win32"){child.kill("SIGKILL");done();return;}
      const killer=spawn("taskkill",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});
      killer.once("close",done);killer.once("error",()=>{child.kill();done();});
    });},90000);
    child.once("error",error=>{clearTimeout(timer);reject(error);});
    child.once("close",async code=>{clearTimeout(timer);await cleanup;
      if(code===expected&&!timedOut&&!failure)resolve();else reject(failure??new Error(`${current}/${phase}: ${code}; timeout=${timedOut}\n${await readFile(join(directory,`failure-${phase}.txt`),"utf8").catch(()=>output)}`));
    });
  });
  console.log(`${current}/${phase}: passed (${requests.length} POSTs)`);
}
try{
  for(current of protocols){requests=[];failure=null;const directory=join(root,current.replaceAll(":","-"));await mkdir(directory);
    if(current.includes(":cancel-input")){
      await launch(directory,"input-cancel-control",73);assert.equal(requests.length,0);
      await launch(directory,"input-cancel-finish",0);assert.equal(requests.length,0);
      await launch(directory,"input-cancel-finish",0);assert.equal(requests.length,0);
      results.push(JSON.parse(await readFile(join(directory,"verification.json"),"utf8")));continue;
    }
    if(current.includes(":inputs")){
      await launch(directory,"input-handoff",73);assert.equal(requests.length,0);
      await launch(directory,"input-ready",73);assert.equal(requests.length,0);
    }
    await launch(directory,"root-response",73);assert.equal(requests.length,1);
    if(current.includes(":cancel-publication")){
      await launch(directory,"publication-captured",73);const originalCount=requests.length;
      await launch(directory,"publication-cancel",0);assert.equal(requests.length,originalCount);
      await launch(directory,"publication-cancel",0);assert.equal(requests.length,originalCount);
      results.push(JSON.parse(await readFile(join(directory,"verification.json"),"utf8")));
      await writeFile(join(directory,"requests.json"),JSON.stringify(requests,null,2));continue;
    }
    if(current.includes(":admission")){await launch(directory,"child-admission",73);assert.equal(requests.length,1);}
    if(current.includes(":stop"))await launch(directory,"stop-observed",73);
    if(current.includes(":ordinary")){
      await launch(directory,"ordinary-observed",73);
      await launch(directory,"ordinary-selected",73);
      await launch(directory,"parent-response",73);const completedCount=requests.length;
      await launch(directory,"finish",0);assert.equal(requests.length,completedCount);
      assert.equal(requests.filter(r=>r.body.tools).length,6);assert(requests.some(r=>r.task==="auxiliary:child-conversion"));
      results.push(JSON.parse(await readFile(join(directory,"verification.json"),"utf8")));
      await writeFile(join(directory,"requests.json"),JSON.stringify(requests,null,2));continue;
    }
    if(current.includes(":converted")){
      await launch(directory,"conversion-observed",73);assert.equal(requests.length,6);
      if(current.includes(":cancel-conversion")){
        await launch(directory,"conversion-cancel",0);assert.equal(requests.length,6);
        await launch(directory,"conversion-cancel",0);assert.equal(requests.length,6);
        results.push(JSON.parse(await readFile(join(directory,"verification.json"),"utf8")));
        await writeFile(join(directory,"requests.json"),JSON.stringify(requests,null,2));continue;
      }
      await launch(directory,"conversion-selected",73);assert.equal(requests.length,7);
    }
    if(current.includes(":progress")){
      await launch(directory,"progress-boundary",73);
      await launch(directory,"finish",0);
      const result=JSON.parse(await readFile(join(directory,"verification.json"),"utf8"));results.push(result);
      await writeFile(join(directory,"requests.json"),JSON.stringify(requests,null,2));continue;
    }
    await launch(directory,"child-response",73);assert.equal(taskAndMethodRequests(),(current.includes(":failed-child")||current.includes(":converted")?7:5)+extra+(current.includes(":oversized")?1:0)-(current.includes(":missing-source")?1:0));
    if(current.includes(":cancel:material")){
      for(const phase of ["cancel-control","cancel-selected","cancel-clear"])await launch(directory,phase,73);
      await launch(directory,"cancel-finish",0);assert.equal(requests.length,5);
      results.push(JSON.parse(await readFile(join(directory,"verification.json"),"utf8")));continue;
    }
    if(current.includes(":material")){
      const receiptCount=(current.includes(":converted")?8:6)+extra;
      await launch(directory,"receipt-failed",73);assert.equal(requests.length,receiptCount);
      await launch(directory,"receipt-confirmed",73);assert.equal(requests.length,receiptCount);
      await launch(directory,"receipt-discharged",73);assert.equal(requests.length,receiptCount);
    }
    const total=(current.includes(":material")&&current.includes(":converted")?10:current.includes(":successor")||current.includes(":material")||current.includes(":failed-child")||current.includes(":converted")?8:6)+extra+(current.includes(":oversized")?1:0)-(current.includes(":missing-source")?1:0);
    await launch(directory,"parent-response",73);assert.equal(taskAndMethodRequests(),total);
    await launch(directory,"finish",0);assert.equal(taskAndMethodRequests(),total);
    assert.equal(requests.filter(r=>r.task==="auxiliary:stop").length,current.includes(":stop")?4:0);
    const result=JSON.parse(await readFile(join(directory,"verification.json"),"utf8"));results.push(result);
    await writeFile(join(directory,"requests.json"),JSON.stringify(requests,null,2));
  }
  await writeFile(join(root,"verification.json"),JSON.stringify(results,null,2));console.log(JSON.stringify({root,results}));
}finally{if(current)await writeFile(join(root,current.replaceAll(":","-"),"requests.json"),JSON.stringify(requests,null,2));
  await new Promise(resolve=>server.close(resolve));console.log(`Evidence: ${root}`);}
