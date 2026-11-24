import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {createServer} from "node:http";
import {mkdtemp,readFile,writeFile,mkdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve,dirname} from "node:path";
import {fileURLToPath} from "node:url";
import electron from "electron";
const directory=await mkdtemp(join(tmpdir(),"helarc-native-compaction-")),phases=[],posts=[];
const fixture=fileURLToPath(new URL("./fixtures/native-compaction.cjs",import.meta.url)),cwd=fileURLToPath(new URL("../",import.meta.url));
const evidenceArg=process.argv.indexOf("--evidence"),evidencePath=evidenceArg<0?null:resolve(process.argv[evidenceArg+1]);
const historyArg=process.argv.indexOf("--history-repetitions"),historyRepetitions=historyArg<0?18000:Number(process.argv[historyArg+1]);
assert(Number.isSafeInteger(historyRepetitions)&&historyRepetitions>0&&historyRepetitions<=100000);
let failure=null;
const compact={id:"cmp-resource-not-a-response",object:"response.compaction",output:[
  {type:"message",role:"user",content:"The selected option is blue."},
  {type:"compaction",id:"cmp-1",encrypted_content:"controlled-opaque-1"},
  {type:"compaction",id:"cmp-2",encrypted_content:"controlled-opaque-2"}],usage:{input_tokens:12000,output_tokens:100,total_tokens:12100}};
const server=createServer(async(req,res)=>{try{
  assert.equal(req.method,"POST");assert(["/v1/responses/compact","/v1/responses"].includes(req.url));
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString());
  assert.equal(body.instructions,undefined);assert.equal(body.previous_response_id,undefined);assert.equal(body.model,"fixture-model");
  const internal=Boolean(body.context_management);
  posts.push({route:req.url,internal,body});assert.equal(posts.filter(p=>p.route===req.url&&p.internal===internal).length,1,"Completed operation must not be repeated");
  await writeFile(join(directory,"requests.json"),JSON.stringify(posts));
  if(req.url.endsWith("compact")){assert.equal(body.input.length,2);assert.equal(body.tools,undefined);}
  else{assert.deepEqual(body.input.slice(0,3),compact.output);assert.match(body.input[3].content,/Child delivered/);assert(!JSON.stringify(body).includes("Historical discussion"));}
  if(internal){
    assert.equal(body.stream,true);const response={id:"internal-response",object:"response",status:"completed",output:[
      {id:"internal-cmp",type:"compaction",encrypted_content:"internal-opaque"},
      {id:"internal-call",type:"function_call",name:"Write_a1",call_id:"write-once",arguments:'{"path":"one.txt"}',status:"completed"}],usage:{input_tokens:1200,output_tokens:60,total_tokens:1260}};
    res.writeHead(200,{"content-type":"text/event-stream"});
    for(const [sequence_number,type]of ["response.created","response.completed"].entries())res.write(`data: ${JSON.stringify({type,sequence_number,response:type==="response.created"?{...response,status:"in_progress",output:[]}:response})}\n\n`);
    res.end();return;
  }
  res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify(req.url.endsWith("compact")?compact:
    {id:"response-after-compact",object:"response",status:"completed",output:[{id:"m",type:"message",role:"assistant",status:"completed",content:[{type:"output_text",text:"Blue, smaller shape.",annotations:[]}]}]}));
}catch(error){failure=error;res.writeHead(500);res.end("fixture rejected request");}});
async function launch(phase){
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const started=performance.now();
  // Keep the URL last: this Windows Electron entry rejects trailing positional arguments before loading JS.
  await new Promise((done,reject)=>{const child=spawn(electron,[fixture,directory,phase,String(historyRepetitions),endpoint],{cwd,env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
    let log="",timedOut=false,killing=Promise.resolve();child.stdout.on("data",v=>log=(log+v).slice(-8000));child.stderr.on("data",v=>log=(log+v).slice(-8000));
    const timer=setTimeout(()=>{timedOut=true;killing=new Promise(resolve=>{
      const killer=spawn("taskkill",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});killer.once("close",resolve);killer.once("error",()=>{child.kill();resolve();});
    });},60000);
    child.once("error",e=>{clearTimeout(timer);reject(e);});child.once("close",async code=>{clearTimeout(timer);await killing;
      if(!timedOut&&code===(phase==="verify"?0:73))done();else reject(new Error(`${phase}: ${code}, timeout=${timedOut}\n${await readFile(join(directory,`failure-${phase}.txt`),"utf8").catch(()=>log)}`));});
  });
  if(failure)throw failure;phases.push({...JSON.parse(await readFile(join(directory,`${phase}.json`),"utf8")),wallMs:Math.round(performance.now()-started)});
  console.log(`${phase}: passed (${phases.at(-1).wallMs}ms)`);
}
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));const endpoint=`http://127.0.0.1:${server.address().port}/v1`;
try{
  for(const phase of ["compact","check","receive","adopt","use","internal","internal-effect","verify"])await launch(phase);
  assert.equal(new Set(phases.map(p=>p.pid)).size,8);assert.deepEqual(phases.map(p=>p.generation),[1,2,3,4,5,6,7,8]);assert.equal(posts.length,3);
  const result={kind:"batch7-electron-sqlite",directory,historyRepetitions,phases,posts:posts.map(({route,body})=>({route,bytes:Buffer.byteLength(JSON.stringify(body))})),optionalInstructions:false};
  if(evidencePath){await mkdir(dirname(evidencePath),{recursive:true});await writeFile(evidencePath,JSON.stringify(result,null,2));}
  console.log(JSON.stringify({directory,phases:phases.length,posts:posts.length,passed:true}));
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));console.log(`Evidence: ${directory}`);}
