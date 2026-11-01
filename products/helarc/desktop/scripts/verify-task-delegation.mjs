import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {createServer} from "node:http";
import {mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve,dirname,basename} from "node:path";
import {fileURLToPath} from "node:url";
import electron from "electron";
const directory=await mkdtemp(join(tmpdir(),"helarc-task-delegation-"));
const fixture=fileURLToPath(new URL("./fixtures/task-delegation.cjs",import.meta.url));
const requests=[];let passed=false;
const redistribute=process.argv.includes("--redistribute-material");
const retainedContinuation=process.argv.includes("--retained-continuation")||redistribute;
const continuation=process.argv.includes("--continuation")||retainedContinuation;
const largeResult=process.argv.includes("--large-result");
const retainedReport=process.argv.includes("--retained-report")||retainedContinuation;
assert(!retainedReport||!largeResult&&(!continuation||retainedContinuation));
assert(!largeResult||!continuation,"Large first delivery and directed continuation are independent verification scenarios");
// Large UTF-8 body within the existing character contract; auxiliary checks still face the same byte bound.
const longReport=retainedReport?"ALPHA: LEAF 7391. "+"Retained evidence; no effects occurred. ".repeat(700)+"REPORT DETAIL TARGET 9507":
  "ALPHA: LEAF 7391. Version unverified. "+"\u53ea\u8bfb\u68c0\u67e5\u5df2\u7ecf\u5b8c\u6210\uff0c\u672a\u4fee\u6539\u6587\u4ef6\u6216\u542f\u52a8\u5176\u4ed6\u5de5\u4f5c\u3002".repeat(500);
const shortReport="ALPHA: LEAF 7391. Version unverified. Repeated inspections made no changes.";
let methodCalls=0,reportReference=null;const methodKinds=[];
const server=createServer(async(req,res)=>{
  try{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const raw=Buffer.concat(chunks).toString("utf8"),body=JSON.parse(raw);requests.push(body);
    await writeFile(join(directory,"requests.json"),JSON.stringify(requests,null,2));
    if(!body.tools?.length){
      assert(largeResult);
      const text=body.prompt??body.messages.map(m=>m.content).join("\n");
      const objects=text.split("\n").flatMap(line=>{try{return [JSON.parse(line.replace(/^user: /,""))];}catch{return [];}});
      const work=objects.findLast(value=>value.job&&value.outputContract);assert(work,"Original method job must be present");methodCalls++;methodKinds.push(work.job.kind);
      const checking=["check","relation","combination"].includes(work.job.kind);
      const output=checking?{kind:"assessment",findings:Object.fromEntries(["source_to_candidate","candidate_to_source","relationships","precision"].map(direction=>
        [direction,{conclusion:"supported",sources:work.job.scope,candidates:work.job.candidates,basis:"Controlled report preserves LEAF 7391 and unverified version; execution facts stay exact",unknowns:[]}])),
        requirements:work.requirements.map(r=>({id:r.id,conclusion:"supported",basis:"controlled source evidence"})),missing:[]}:
        {kind:"candidate",parts:[{text:shortReport,sources:work.job.scope}],covered:work.job.scope,background:[],losses:[],relationships:[],unknowns:[],missing:[]};
      res.setHeader("Content-Type","application/json");res.end(JSON.stringify({model:"controlled",response:JSON.stringify(output),done:true,done_reason:"stop",prompt_eval_count:700,eval_count:50}));return;
    }
    const users=body.messages.filter(m=>m.role==="user").map(m=>m.content).join("\n");
    const isRoot=users.includes("ROOT_CASE"),isAlpha=!isRoot&&users.includes("CHILD_ALPHA"),isBeta=!isRoot&&!isAlpha&&users.includes("CHILD_BETA");
    const tool=body.tools.find(t=>/^Agent(?:_|$)/.test(t.function.name))?.function.name;
    assert(tool);assert(!body.messages.some(m=>m.role==="system"));
    const hasAgent=body.messages.some(m=>m.role==="assistant"&&m.tool_calls?.some(c=>c.function.name===tool));
    const send=body.tools.find(t=>/^SendMessage(?:_|$)/.test(t.function.name))?.function.name;
    const hasMessage=body.messages.some(m=>m.role==="assistant"&&m.tool_calls?.some(c=>c.function.name===send));
    const hasPlan=body.messages.some(m=>m.role==="assistant"&&m.tool_calls?.some(c=>c.function.name==="update_plan"));
    const call=(name,args)=>({function:{name,arguments:args}});
    let calls;
    if(redistribute&&!isRoot&&users.includes("READ_MATERIAL_CASE")) {
      assert(reportReference&&JSON.stringify(body.messages).includes(reportReference.id));
      const read=body.tools.find(t=>/^ContextMaterialRead(?:_|$)/.test(t.function.name)).function.name;
      const readResult=body.messages.filter(m=>m.role==="tool").map(m=>JSON.parse(m.content).content).find(r=>r?.output?.text?.includes("TARGET 9507"));
      calls=readResult?[call("final_result",{response:"READER TARGET 9507",material_refs:[reportReference]})]:
        [call(read,{reference:reportReference,offset:Buffer.byteLength(longReport.slice(0,longReport.indexOf("REPORT DETAIL TARGET"))),length:128})];
    }
    else if(!isRoot&&users.includes("CONTINUE_ALPHA")){
      assert(JSON.stringify(body.messages).includes("ALPHA: LEAF 7391"),"Directed continuation must preserve Alpha's original conversation");
      if(redistribute) {
        assert(reportReference&&JSON.stringify(body.messages).includes(reportReference.id));
        const completed=body.messages.filter(m=>m.role==="tool").some(m=>m.content.includes("READER TARGET 9507"));
        calls=completed?[call("final_result",{response:"ALPHA UPDATED: LEAF 7391; TARGET 9507",material_refs:[reportReference]})]:
          [call(tool,{description:"Read retained material",prompt:"READ_MATERIAL_CASE: Read the supplied report reference and return TARGET 9507 with the same material attachment.",material_refs:[reportReference]})];
      } else calls=[call("final_result",{response:retainedContinuation?longReport:"ALPHA UPDATED: LEAF 7391; TARGET 9507"})];
    }
    else if(isRoot&&!hasAgent)calls=[call(tool,{description:"Independent alpha",prompt:"CHILD_ALPHA: Delegate LEAF_CASE to find the number; return its report."}),
      call(tool,{description:"Independent beta",prompt:"CHILD_BETA: Report BETA 8422."})];
    else if(isRoot&&retainedReport&&(!continuation||hasMessage)){
      const values=body.messages.filter(m=>m.role==="tool").map(m=>JSON.parse(m.content).content);
      const report=values.find(r=>r?.output?.report?.status==="retained_material");assert(report);
      assert.equal(report.childTerminalStatus,"completed");assert.equal(report.output.summary,"");assert.equal(report.output.report.inline,false);
      assert(!JSON.stringify(body.messages).includes(longReport));
      const search=body.tools.find(t=>/^ContextMaterialSearch(?:_|$)/.test(t.function.name)).function.name;
      const read=body.tools.find(t=>/^ContextMaterialRead(?:_|$)/.test(t.function.name)).function.name;
      const called=name=>body.messages.some(m=>m.role==="assistant"&&m.tool_calls?.some(c=>c.function.name===name));
      if(!called(search))calls=[call(search,{references:[report.output.report.reference],query:"REPORT DETAIL TARGET",limit:4})];
      else if(!called(read)) {
        const found=values.find(r=>r?.output?.matches)?.output;assert(found?.exhausted);assert.equal(found.matches.length,1);
        assert(found.matches[0].byteStart>16000);
        calls=[call(read,{reference:report.output.report.reference,offset:found.matches[0].byteStart,length:128})];
      } else {
        assert(values.some(r=>r?.output?.text?.includes("TARGET 9507")));
        calls=[call("final_result",{response:"ALPHA: LEAF 7391; BETA 8422; REPORT DETAIL TARGET 9507"})];
      }
    }
    else if(isRoot&&(continuation&&!hasMessage||largeResult&&!hasPlan)){
      const alpha=body.messages.filter(m=>m.role==="tool").map(m=>JSON.parse(m.content).content)
        .find(r=>r?.output?.summary?.includes("ALPHA: LEAF 7391")||redistribute&&r?.output?.report?.status==="retained_material");
      assert(alpha?.output.agent_id);
      if(largeResult){assert(alpha.output.summary.includes(shortReport));assert(!alpha.output.summary.includes(longReport));
        assert.equal(alpha.childTerminalStatus,"completed");assert.equal(alpha.effects.status,"none");assert(alpha.limits);assert(alpha.limitDisposition);}
      if(largeResult)calls=[call("update_plan",{plan:[{step:"Synthesize both delegated reports",status:"in_progress"}]})];
      else {assert(send);if(redistribute)reportReference=alpha.output.report.reference;
        calls=[call(send,{agent_id:alpha.output.agent_id,prompt:"CONTINUE_ALPHA: Keep the leaf finding, add TARGET 9507 and return the updated report.",...(redistribute?{material_refs:[reportReference]}:{})})];}
    }
    else if(isAlpha&&!hasAgent)calls=[call(tool,{description:"Nested leaf",prompt:"LEAF_CASE: Report LEAF 7391."})];
    else{
      const results=body.messages.filter(m=>m.role==="tool").map(m=>m.content).join("\n");
      if(isRoot){assert(results.includes("ALPHA: LEAF 7391"));assert(results.includes("BETA 8422"));}
      if(isAlpha)assert(results.includes("LEAF 7391"));
      if(!isRoot&&!isAlpha&&!isBeta)assert(users.includes("LEAF_CASE"));
      if(isRoot&&continuation)assert(results.includes("TARGET 9507"));
      if(isRoot&&largeResult){assert(results.includes(shortReport));assert(!results.includes(longReport),"Later Parent history must retain the delivered representation");}
      calls=[call("final_result",{response:isRoot?`ALPHA: LEAF 7391; BETA 8422${continuation?"; TARGET 9507":""}`:isAlpha?largeResult||retainedReport&&(!continuation||redistribute)?longReport:"ALPHA: LEAF 7391":isBeta?"BETA 8422":"LEAF 7391",
        ...(isRoot&&largeResult?{plan:[{step:"Synthesize both delegated reports",status:"completed"}]}:{})})];
    }
    res.setHeader("Content-Type","application/json");res.end(JSON.stringify({model:"controlled",message:{role:"assistant",content:"",tool_calls:calls},done:true,done_reason:"stop",prompt_eval_count:700,eval_count:50}));
  }catch(error){res.statusCode=500;res.end(JSON.stringify({error:String(error)}));}
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
async function launch(phase,expected){
  const env={...process.env,...(continuation?{TASK_DELEGATION_CONTINUATION:"1"}:{}),...(redistribute?{TASK_DELEGATION_REDISTRIBUTE:"1"}:{}),...(largeResult?{TASK_DELEGATION_LARGE_RESULT:"1"}:{}),...(retainedReport?{TASK_DELEGATION_RETAINED_REPORT:"1"}:{})};delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((resolve,reject)=>{
    const child=spawn(electron,[fixture,directory,phase,`http://127.0.0.1:${server.address().port}`],{env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
    let output="",timedOut=false;child.stdout.on("data",b=>output+=b);child.stderr.on("data",b=>output+=b);
    const timer=setTimeout(()=>{timedOut=true;child.kill();},90000);
    child.once("error",error=>{clearTimeout(timer);reject(error);});child.once("close",code=>{clearTimeout(timer);code===expected&&!timedOut?resolve():reject(new Error(`${phase}: ${code}, timeout=${timedOut}\n${output}`));});
  });console.log(`${phase}: passed`);
}
try{
  await launch("root-response",73);assert.equal(requests.length,1);
  await launch("child-response",73);
  const active=JSON.parse(await readFile(join(directory,"child-response.json"),"utf8"));
  assert(active.members.some(m=>m.runId!=="root"&&m.status!=="completed"));
  if(retainedReport){
    await launch("report-retained",73);const requestsAtPublication=requests.length;
    for(const phase of ["report-interrupted","report-captured","report-published","report-admitted"]){await launch(phase,73);assert.equal(requests.length,requestsAtPublication,"Publication recovery cannot repeat Child requests");}
  }
  await launch("parent-response",73);assert.equal(requests.length-methodCalls,redistribute?11:retainedContinuation?8:6);
  const before=JSON.parse(await readFile(join(directory,"parent-response.json"),"utf8"));assert.equal(before.members.length,redistribute?6:retainedContinuation?5:4);
  assert(before.members.filter(m=>m.runId!=="root").every(m=>m.status==="completed"));
  await launch("finish",0);assert.equal(requests.length-methodCalls,redistribute?13:retainedContinuation?10:continuation||retainedReport?8:largeResult?7:6,"Recovery cannot repeat accepted work");
  if(largeResult){assert.deepEqual(methodKinds,["generate","check","relation","combination"],"Generation, preservation, declared relations and recipient combination each run once across recovery");console.log(`Auxiliary calls: ${methodCalls}`);}
  if(retainedReport)assert.equal(methodCalls,0,"Publishing retained source does not generate a replacement report");
  console.log(await readFile(join(directory,"verification.json"),"utf8"));passed=true;
}finally{
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  if(passed){const target=resolve(directory);if(dirname(target)!==resolve(tmpdir())||!basename(target).startsWith("helarc-task-delegation-"))throw new Error("Unsafe cleanup");await rm(target,{recursive:true,force:true});}
  else {await writeFile(join(directory,"requests.json"),JSON.stringify(requests,null,2));console.error(`Isolated evidence: ${directory}`);}
}
