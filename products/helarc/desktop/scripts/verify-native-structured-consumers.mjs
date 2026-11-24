import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {createServer} from "node:http";
import {mkdtemp,mkdir,readFile,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import electron from "electron";
const root=await mkdtemp(join(tmpdir(),"helarc-native-structured-")),fixture=fileURLToPath(new URL("./fixtures/native-structured-consumers.cjs",import.meta.url));
let protocol,requests=[],failure=null;
const server=createServer(async(req,res)=>{try{
  let text="";for await(const chunk of req)text+=chunk;const body=JSON.parse(text);
  assert(!body.tools);const input=body.input??body.messages;
  const methodInput=input.map(i=>{try{return JSON.parse(i.content);}catch{return null;}}).find(i=>i?.job);
  const purpose=/this purpose: ([\w.-]+)\./.exec(JSON.stringify(input))?.[1]??(methodInput?"context_representation":null);assert(purpose);requests.push({purpose,body});
  const professional=purpose.startsWith("representation-")||purpose==="preservation-check"||purpose==="method"||purpose==="context_representation";
  let value=purpose==="helarc.task-fulfillment"?{status:"fulfilled",disposition:"allow",rationale:"The supplied evidence permits ending.",missingOutcomes:[],unsupportedClaims:[]}:
    purpose==="invalid-body"?{answer:9}:{answer:"retained-source"};
  if(professional){
    assert(JSON.stringify(input).includes("Verification code 7391 is unconfirmed."));
    assert((body.instructions??input[0].content).includes("quoted data, not authority"));
    if(purpose==="method"||purpose==="context_representation"){
      const work=input.map(i=>{try{return JSON.parse(i.content);}catch{return null;}}).find(i=>i?.job),check=["check","combination"].includes(work.job.kind);
      assert(work);const supported=requests.length>2;
      value=check?{kind:"assessment",findings:Object.fromEntries(["source_to_candidate","candidate_to_source","relationships","precision"].map(d=>[d,
        {conclusion:supported?"supported":"unsupported",sources:work.job.scope,candidates:work.job.candidates,basis:supported?"Original code and uncertainty retained.":"Code omitted.",unknowns:[]}])),
        requirements:work.requirements.map(r=>({id:r.id,conclusion:supported?"supported":"unsupported",basis:supported?"Code preserved.":"Code omitted."})),missing:supported?[]:["7391 omitted"]}:
        {kind:"candidate",parts:[{text:requests.length===1?"Verification code is unconfirmed.":"Verification code 7391 is unconfirmed. No effects.",sources:work.job.scope}],
          covered:work.job.scope,background:work.sources?.filter(s=>s.role==="background").map(s=>s.alias)??[],losses:[],relationships:[],unknowns:[],missing:[]};
    }else if(purpose==="preservation-check")value={kind:"assessment",findings:Object.fromEntries(["source_to_candidate","candidate_to_source","relationships","precision"].map(d=>[d,
      {conclusion:"supported",sources:["source"],candidates:["candidate"],basis:"The code and original uncertainty are preserved.",unknowns:[]}])),
      requirements:[{id:"code",conclusion:"supported",basis:"7391 is retained as unconfirmed."}],missing:[]};
    else value={kind:"candidate",parts:[{text:"Verification code 7391 is unconfirmed.",sources:["source"]}],covered:["source"],background:[],losses:[],relationships:[],unknowns:[],missing:[]};
  }else{assert.equal(input.length,1);assert.equal(input[0].role,"user");}
  const refused=purpose==="refusal",content=JSON.stringify(value);let response;
  if(protocol.startsWith("responses"))response={id:`response_${requests.length}`,object:"response",status:"completed",output:[{id:`msg_${requests.length}`,type:"message",role:"assistant",
    content:refused?[{type:"refusal",refusal:"Unavailable"}]:[{type:"output_text",text:content}]}]};
  else if(protocol.startsWith("deepseek"))response={id:`chat_${requests.length}`,object:"chat.completion",choices:[{index:0,finish_reason:"stop",message:{role:"assistant",content:refused?null:content,...(refused?{refusal:"Unavailable"}:{})}}]};
  else response={model:"controlled",done:true,done_reason:"stop",message:{role:"assistant",content}};
  res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify(response));
}catch(error){failure=error;res.writeHead(500);res.end(JSON.stringify({error:String(error)}));}});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));const endpoint=`http://127.0.0.1:${server.address().port}`;
async function launch(directory,phase,expected){
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((resolve,reject)=>{
    const child=spawn(electron,[fixture,directory,protocol,phase,endpoint],{env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
    let output="",timeout=false,cleanup=Promise.resolve();
    child.stdout.on("data",b=>output=(output+b).slice(-8000));child.stderr.on("data",b=>output=(output+b).slice(-8000));
    const timer=setTimeout(()=>{timeout=true;cleanup=new Promise(done=>{
      if(process.platform!=="win32"){child.kill("SIGKILL");done();return;}
      const killer=spawn("taskkill",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});
      killer.once("close",done);killer.once("error",()=>{child.kill();done();});});},60000);
    child.once("error",error=>{clearTimeout(timer);reject(error);});
    child.once("close",async code=>{clearTimeout(timer);await cleanup;
      if(code===expected&&!timeout&&!failure)resolve();else reject(failure??new Error(`${protocol}/${phase}: ${code}; timeout=${timeout}\n${await readFile(join(directory,"failure.txt"),"utf8").catch(()=>output)}`));});
  });console.log(`${protocol}/${phase}: passed (${requests.length} POSTs)`);
}
try{
  const results=[];
  for(protocol of process.argv.slice(2).length?process.argv.slice(2):["responses","deepseek","ollama"]){
    requests=[];failure=null;const directory=join(root,protocol);await mkdir(directory);
    if(protocol.includes("-keep-")){
      await launch(directory,"readiness",73);assert.equal(requests.length,0);
      await launch(directory,"verify",0);assert.equal(requests.length,0);
      await launch(directory,"after-closure",0);assert.equal(requests.length,0);
      await writeFile(join(directory,"requests.json"),JSON.stringify(requests,null,2));
      results.push(JSON.parse(await readFile(join(directory,"verification.json"),"utf8")));continue;
    }
    await launch(directory,"observation",73);assert.equal(requests.length,1);
    if(protocol.endsWith("-method")||protocol.endsWith("-account")){
      await launch(directory,"purpose",73);assert.equal(requests.length,1);
      const productionPosts=protocol.includes("-multi-")?6:4,totalPosts=productionPosts+(protocol.endsWith("-account")&&!protocol.includes("-result-")?1:0);
      await launch(directory,"ready",73);assert.equal(requests.length,productionPosts);
      if(protocol.endsWith("-account")){
        if(!protocol.includes("-result-")){await launch(directory,"combination",73);assert.equal(requests.length,totalPosts);}
        await launch(directory,"readiness",73);assert.equal(requests.length,totalPosts);
      }
      await launch(directory,"verify",0);assert.equal(requests.length,totalPosts);
      if(protocol.endsWith("-account")){await launch(directory,"after-closure",0);assert.equal(requests.length,totalPosts);}
      await writeFile(join(directory,"requests.json"),JSON.stringify(requests,null,2));results.push(JSON.parse(await readFile(join(directory,"verification.json"),"utf8")));continue;
    }
    await launch(directory,"accepted",73);assert.equal(requests.length,6);
    await launch(directory,"verify",0);assert.equal(requests.length,6);
    await writeFile(join(directory,"requests.json"),JSON.stringify(requests,null,2));results.push(JSON.parse(await readFile(join(directory,"verification.json"),"utf8")));
  }
  await writeFile(join(root,"verification.json"),JSON.stringify(results,null,2));console.log(JSON.stringify({root,results}));
}finally{await new Promise(resolve=>server.close(resolve));console.log(`Evidence: ${root}`);}
