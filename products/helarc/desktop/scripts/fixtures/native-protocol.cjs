const {app}=require("electron");
const assert=require("node:assert/strict");
const {join}=require("node:path");
const {pathToFileURL}=require("node:url");
const {readFile,writeFile,appendFile,mkdir}=require("node:fs/promises");
const {existsSync}=require("node:fs");
const {createServer}=require("node:http");
const [directory,protocolName,phase]=process.argv.slice(2);
app.setPath("userData",join(directory,"electron"));app.disableHardwareAcceleration();
const ref=id=>({id,revision:"1"});
let store;
async function main(){
  const runtime=await import("@agent-anything/agent-runtime/model-access"),model=await import("@agent-anything/model-interaction/protocol");
  const {modelInputValueDigest}=await import("@agent-anything/model-interaction/input");
  const native=await import("@agent-anything/provider-integrations/native"),helarc=await import("@agent-anything/helarc/controller");
  const {HelarcExecutionStore}=await import(pathToFileURL(join(process.cwd(),"dist/main/execution-storage/HelarcExecutionStore.js")));
  const {ProtocolJournalInspectionAdapter}=await import(pathToFileURL(join(process.cwd(),"dist/main/inspection/ProtocolJournalInspectionAdapter.js")));
  const profiles={responses:{protocol:model.OPENAI_RESPONSES,adapter:native.OPENAI_RESPONSES_ADAPTER,interpret:helarc.interpretHelarcResponses,validate:helarc.validateHelarcResponsesTaskInput},
    deepseek:{protocol:model.DEEPSEEK_CHAT_COMPLETIONS,adapter:native.DEEPSEEK_CHAT_ADAPTER,interpret:helarc.interpretHelarcDeepSeek,validate:helarc.validateHelarcDeepSeekTaskInput},
    ollama:{protocol:model.OLLAMA_CHAT,adapter:native.OLLAMA_CHAT_ADAPTER,interpret:helarc.interpretHelarcOllama,validate:helarc.validateHelarcOllamaTaskInput}};
  const profile=profiles[protocolName],observed=[],work=[],counts={};
  assert(profile);
  store=await HelarcExecutionStore.open(join(directory,"execution"),undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,{observe:fact=>observed.push(fact)});
  const journal={command:async command=>{counts[command.kind]=(counts[command.kind]??0)+1;return store.protocolJournal.command(command);}};
  const content=(id,activityId,value)=>runtime.retainProtocolContent(journal,id,activityId,Buffer.from(JSON.stringify(value)),entry=>work.push(entry));
  const jp=(kind,proposal)=>({owner:"protocol_execution",kind,proposal});
  const accept=async(id,actor,parts,scope="root")=>{
    const receipt=await store.sharedAcceptance.accept({id,scope,actor,parts});assert.equal(receipt.outcome,"accepted",JSON.stringify(receipt));return receipt;
  };
  const reject=async(id,actor,parts,scope="root")=>{
    const receipt=await store.sharedAcceptance.accept({id,scope,actor,parts});assert.equal(receipt.outcome,"rejected",JSON.stringify(receipt));return receipt;
  };
  const composition=model.bindModelAgentComposition({agent:ref("fixture-agent"),protocol:profile.protocol,
    configuration:{configuration:ref("original-config"),protocol:profile.protocol,model:"fixture-model",connectionBinding:ref("original-connection")},
    adapter:{implementation:profile.adapter,protocol:profile.protocol},task:{purpose:ref("task"),input:{implementation:ref("task-input"),protocol:profile.protocol},
      interpreter:{implementation:helarc.HELARC_NATIVE_TASK_INTERPRETER,protocol:profile.protocol}},auxiliary:[]});
  const makeActivity=(runId,activityId)=>runtime.bindProtocolModelActivity({composition,scope:{runId,activityId,recipientId:"task",purpose:ref("task"),compositionDigest:composition.digest},
    conditions:{input:ref(`${activityId}:input`),authority:ref("authority"),resources:ref("resources"),control:ref("control")}});
  const activity=makeActivity("root","activity"),activityId=activity.scope.activityId;
  const definition={name:"Write_a1",description:"Write one test file",inputSchema:{type:"object",properties:{path:{type:"string"}},required:["path"],additionalProperties:false}};
  const bindingBase={scope:activity.scope,protocol:profile.protocol,adapter:profile.adapter,interpreter:helarc.HELARC_NATIVE_TASK_INTERPRETER,
    acceptance:ref("task-acceptance"),requestId:"request",controllerRequestId:"decision",operationId:"create",record:ref("response"),
    catalog:[{definition,binding:{kind:"tool",callableName:"Write_a1",toolName:"Write",tool:{tool:{namespace:"fixture",name:"Write"},revision:"1"},
      binding:{kind:"operation",operation:{operation:{namespace:"fixture",name:"write"},revision:"1"},revision:"1"}}}],
    schemaMode:protocolName==="responses"?"responses-strict":"identity",hasPlan:false,planLimits:{maxSteps:20,maxStepLength:1000,maxExplanationLength:2000}};
  const binding={...bindingBase,catalogRevision:helarc.nativeTaskCatalog(bindingBase).revision};
  const prompt="Create exactly one file. This is synthetic verification.";
  const prepared=protocolName==="responses"?native.prepareResponses({model:"fixture-model",input:[{role:"user",content:prompt}],purpose:ref("task"),stream:false,store:false,tools:[definition]}):
    protocolName==="deepseek"?native.prepareDeepSeekChat({model:"fixture-model",messages:[{role:"user",content:prompt}],purpose:ref("task"),stream:false,tools:[definition]}):
    native.prepareOllamaChat({model:"fixture-model",messages:[{role:"user",content:prompt}],purpose:ref("task"),stream:false,tools:[definition]});
  const original={format:"helarc.native-prepared-task.v1",binding,wire:{body:prepared.encoded,digest:prepared.digest},previous:null};
  const input=phase==="seed"?await content("prepared",activityId,original):(await journal.command({kind:"state",activityId}))?.input;
  assert(input,"recovery requires original prepared custody");
  if(phase==="seed")await accept("prepare","execution-coordinator",[jp("prepare",{activity,input})]);
  let state=await journal.command({kind:"state",activityId});
  if(state.fence.generation!==store.generation||state.fence.epoch===0){await accept(`claim:${store.generation}`,profile.adapter.id,[jp("claim",{activityId,expectedEpoch:state.fence.epoch})]);state=await journal.command({kind:"state",activityId});}
  const fence=state.fence;
  const dispatch={ref:ref("dispatch"),activityId,operationId:"create",kind:"dispatch_intent",content:input,source:null,dependencies:[]};
  if(!await journal.command({kind:"record",activityId,ref:dispatch.ref}))await accept("dispatch",profile.adapter.id,[jp("record",{record:dispatch,fence})]);
  const prose="Synthetic original response. ".repeat(12000);
  const raw=protocolName==="responses"?{id:"resp1",object:"response",status:"completed",output:[
    {id:"reason1",type:"reasoning",summary:[],encrypted_content:"opaque-preserved"},
    {id:"msg1",type:"message",role:"assistant",phase:"commentary",content:[{type:"output_text",text:prose,annotations:[]}]},
    {id:"fc1",type:"function_call",call_id:"call1",name:"Write_a1",arguments:'{"path":"one.txt"}',status:"completed"}],usage:{input_tokens:42,output_tokens:9}}:
    protocolName==="deepseek"?{id:"chat1",object:"chat.completion",choices:[{index:0,finish_reason:"tool_calls",message:{role:"assistant",content:prose,reasoning_content:"retained thinking",tool_calls:[{id:"call1",type:"function",function:{name:"Write_a1",arguments:'{"path":"one.txt"}'}}]}}],usage:{prompt_tokens:42,completion_tokens:9}}:
    {model:"fixture",done:true,done_reason:"stop",message:{role:"assistant",content:prose,thinking:"retained thinking",tool_calls:[{function:{name:"Write_a1",arguments:{path:"one.txt"}}}]},prompt_eval_count:42,eval_count:9};
  if(!await journal.command({kind:"record",activityId,ref:ref("response")})){
    assert.equal(phase,"seed","recovery must not regenerate a missing response");
    let requestError=null;
    const server=createServer(async(req,res)=>{try{
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      assert.equal(Buffer.concat(chunks).toString(),prepared.encoded);
      assert.equal(req.url,protocolName==="responses"?"/v1/responses":protocolName==="deepseek"?"/chat/completions":"/api/chat");
      assert(!prepared.body.instructions);assert.equal(prepared.body.max_tokens,undefined);assert.equal(prepared.body.max_output_tokens,undefined);
      await appendFile(join(directory,"remote-create-count"),"1\n");res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify(raw));
    }catch(error){requestError=error;res.writeHead(500);res.end("fixture rejected request");}});
    await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
    try{
      const baseUrl=`http://127.0.0.1:${server.address().port}`,retained=[],options={signal:AbortSignal.timeout(10000),retainChunk:async bytes=>{retained.push(Buffer.from(bytes));}};
      const observation=protocolName==="responses"?await native.dispatchResponses(prepared,{baseUrl:baseUrl+"/v1",apiKey:"synthetic"},options):
        protocolName==="deepseek"?await native.dispatchDeepSeekChat(prepared,{baseUrl,apiKey:"synthetic"},options):await native.dispatchOllamaChat(prepared,{baseUrl},options);
      if(requestError)throw requestError;
      const received=protocolName==="responses"?native.readResponsesObservation(observation):protocolName==="deepseek"?native.readDeepSeekObservation(observation):native.readOllamaChatObservation(observation);
      assert.deepEqual(received,raw);assert.equal(Buffer.concat(retained).toString(),JSON.stringify(raw));
    }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  }
  const responseContent=phase==="seed"?await content("response-body",activityId,raw):(await journal.command({kind:"record",activityId,ref:ref("response")})).content;
  const rootSource={scope:activity.scope,protocol:profile.protocol,interpretation:profile.adapter,
    operationId:"create",record:ref("response"),position:{format:"json-pointer",value:""},nativeIdentity:protocolName==="ollama"?null:{kind:protocolName==="responses"?"response":"chat.completion",id:raw.id}};
  const record={ref:ref("response"),activityId,operationId:"create",kind:"observation",content:responseContent,source:rootSource,dependencies:[dispatch.ref]};
  if(phase==="seed")await accept("observe",profile.adapter.id,[jp("record",{record,fence:null})]);
  if(phase==="seed"){await writeFile(join(directory,"retained.json"),JSON.stringify({activity,original}));app.exit(73);await new Promise(()=>{});}
  const saved=JSON.parse(await readFile(join(directory,"retained.json"),"utf8"));assert.deepEqual(saved.activity,activity);
  const before=counts.content_read??0;
  for(let i=0;i<20;i++){await journal.command({kind:"state",activityId});await journal.command({kind:"record",activityId,ref:ref("response")});}
  assert.equal(counts.content_read??0,before,"metadata must not hydrate bodies");
  const proposal=await helarc.recoverHelarcNativeTask({journal,activity:saved.activity,observation:ref("response"),interpret:profile.interpret,validateOriginalInput:profile.validate,observe:e=>work.push(e)});
  assert.equal(proposal.kind,"advance");assert.equal(proposal.calls.length,1);assert.equal(proposal.calls[0].call.modelCallRef.turnId,null);
  assert.equal(proposal.text[0].text,prose);assert.deepEqual(proposal.calls[0].call.input,{path:"one.txt"});
  await assert.rejects(()=>helarc.recoverHelarcNativeTask({journal,activity:makeActivity("child","activity"),observation:ref("response"),interpret:profile.interpret,validateOriginalInput:profile.validate}));
  assert.throws(()=>profile.validate(JSON.stringify({...prepared.body,tools:[]}),binding,"fixture-model"));
  const result=await content("interpreted",activityId,proposal);
  const acceptance={evidence:proposal.evidence,result,effects:[{call:proposal.calls[0].call,owner:"fixture-file-executor"}],deliveries:[]};
  if(!await journal.command({kind:"acceptance",activityId})){
    const forged={...acceptance,evidence:{...acceptance.evidence,sources:acceptance.evidence.sources.map(s=>({...s,operationId:"different-operation"}))}};
    await reject("wrong-original-operation",helarc.HELARC_NATIVE_TASK_INTERPRETER.id,[jp("purpose",{fence,acceptance:forged})]);
    await accept("purpose",helarc.HELARC_NATIVE_TASK_INTERPRETER.id,[jp("purpose",{fence,acceptance})]);
  }
  const callId=proposal.calls[0].call.modelCallRef.id;
  let effect=await journal.command({kind:"effect",activityId,callId});
  if(!effect.dispatched)await accept("effect-dispatch","fixture-file-executor",[jp("effect_dispatch",{fence,callId})]);
  // The fixture effect has an independently observable identity, allowing reconciliation after a lost ACK.
  if(!existsSync(join(directory,"one.txt"))){await writeFile(join(directory,"one.txt"),"one accepted effect");await appendFile(join(directory,"effect-count"),"1\n");}
  if(phase==="resume"){app.exit(73);await new Promise(()=>{});}
  const output=await content("effect-output",activityId,{written:true});
  await accept("effect-confirm","fixture-file-executor",[jp("effect_confirmation",{activityId,callId,dispatchBasis:"intent_recorded",confirmation:ref("effect-confirmation"),result:output,deliveries:[]})]);
  await reject("repeat-dispatch","fixture-file-executor",[jp("effect_dispatch",{fence,callId})]);
  assert.equal(await readFile(join(directory,"effect-count"),"utf8"),"1\n");
  assert.equal(await readFile(join(directory,"remote-create-count"),"utf8"),"1\n");
  await accept("observe-again",profile.adapter.id,[jp("record",{record,fence:null})]);
  assert.deepEqual(await journal.command({kind:"acceptance",activityId}),acceptance);
  const child=makeActivity("child","child-activity");model.assertChildModelComposition(activity.composition,child.composition);
  const childInput=await content("child-input","child-activity",{kind:"independent-child"});
  await accept("child-prepare","execution-coordinator",[jp("prepare",{activity:child,input:childInput})],"child");
  await assert.rejects(()=>runtime.readProtocolContent(journal,responseContent,"child-activity",32*1024*1024));
  await accept("cancel","execution-coordinator",[jp("control",{activityId,expectedRevision:0,cancelled:true})]);
  await reject("cancelled-acceptance",helarc.HELARC_NATIVE_TASK_INTERPRETER.id,[jp("purpose",{fence,acceptance})]);
  const offers=[],recorder={ref:(owner,kind,id,runId,revision="1")=>({sourceId:"fixture",datasetId:"fixture",owner,kind,id,runId,revision}),offer:r=>offers.push(r)};
  await new ProtocolJournalInspectionAdapter(recorder).replay(async(after,limit)=>journal.command({kind:"facts",runId:"root",after,limit}));
  assert(offers.some(o=>o.payload.name==="model.purpose_evidence_accepted"));assert(!JSON.stringify(offers).includes(prose.slice(0,100)));
  assert(offers.some(o=>o.payload.name==="model.native_source_bound"&&o.contents[0].value.position.value===proposal.calls[0].call.modelCallRef.nativeSource.position.value));
  assert(offers.some(o=>o.links?.some(link=>link.to.owner===profile.protocol.id&&link.to.id==="response")));
  const facts=await journal.command({kind:"facts",runId:"root",after:0,limit:128});assert.equal(facts.filter(f=>f.kind==="purpose_accepted").length,1);
  assert.equal(facts.filter(f=>f.kind==="effect_confirmed").length,1);
  const scale=[];
  if(protocolName==="responses")for(const n of [8,16,32]){
    const scaled=makeActivity(`scale-${n}`,`scale-${n}`),sid=scaled.scope.activityId;
    const catalog=Array.from({length:n},(_,i)=>i===0?binding.catalog[0]:{
      definition:{...definition,name:`Write_${i}`},binding:{...binding.catalog[0].binding,callableName:`Write_${i}`}});
    const basis={...binding,scope:scaled.scope,catalog,requestId:`${sid}:request`,controllerRequestId:`${sid}:decision`,record:ref(`${sid}:response`),acceptance:ref(`${sid}:acceptance`)};
    const schemaWork=[];
    basis.catalogRevision=helarc.nativeTaskCatalog(basis,e=>schemaWork.push(e)).revision;
    const reused=[];assert.equal(helarc.nativeTaskCatalog(basis,e=>reused.push(e)).revision,basis.catalogRevision);
    assert.equal(reused.length,n);assert(reused.every(e=>e.disposition==="reused"));
    const wire=native.prepareResponses({model:"fixture-model",input:[{role:"user",content:prompt}],purpose:ref("task"),stream:false,store:false,tools:catalog.map(c=>c.definition)});
    const preparedContent=await content(`${sid}:prepared`,sid,{...original,binding:basis,wire:{body:wire.encoded,digest:wire.digest}});
    await accept(`${sid}:prepare`,"execution-coordinator",[jp("prepare",{activity:scaled,input:preparedContent})],sid);
    let status=await journal.command({kind:"state",activityId:sid});
    await accept(`${sid}:claim`,profile.adapter.id,[jp("claim",{activityId:sid,expectedEpoch:status.fence.epoch})],sid);
    status=await journal.command({kind:"state",activityId:sid});
    const dispatch={ref:ref(`${sid}:dispatch`),activityId:sid,operationId:"create",kind:"dispatch_intent",content:preparedContent,source:null,dependencies:[]};
    await accept(`${sid}:dispatch`,profile.adapter.id,[jp("record",{record:dispatch,fence:status.fence})],sid);
    const scaledRaw={...raw,output:[...Array.from({length:n},(_,i)=>({id:`msg-${i}`,type:"message",role:"assistant",content:[{type:"output_text",text:"x".repeat(4096)}]})),raw.output.at(-1)]};
    const retained=await content(`${sid}:body`,sid,scaledRaw),source={...rootSource,scope:scaled.scope,record:basis.record};
    const observation={ref:basis.record,activityId:sid,operationId:"create",kind:"observation",content:retained,source,dependencies:[dispatch.ref]};
    await accept(`${sid}:observe`,profile.adapter.id,[jp("record",{record:observation,fence:null})],sid);
    const reads=counts.content_read??0;
    for(let i=0;i<20;i++)await journal.command({kind:"state",activityId:sid});
    assert.equal(counts.content_read??0,reads);
    const measured=[];
    const result=await helarc.recoverHelarcNativeTask({journal,activity:scaled,observation:basis.record,interpret:profile.interpret,validateOriginalInput:profile.validate,observe:e=>measured.push(e)});
    assert.equal(result.text.length,n);assert.equal(result.calls.length,1);
    assert.equal(measured.reduce((sum,e)=>sum+e.bytes,0),preparedContent.bytes+retained.bytes);
    const view=await content(`${sid}:view`,sid,result),accepted={evidence:result.evidence,result:view,effects:[{call:result.calls[0].call,owner:"fixture-file-executor"}],deliveries:[]};
    await reject(`${sid}:wrong-owner`,"unrelated-interpreter",[jp("purpose",{fence:status.fence,acceptance:accepted})],sid);
    await accept(`${sid}:accepted`,helarc.HELARC_NATIVE_TASK_INTERPRETER.id,[jp("purpose",{fence:status.fence,acceptance:accepted})],sid);
    await accept(`${sid}:authority-invalidated`,"execution-coordinator",[jp("control",{activityId:sid,expectedRevision:0,cancelled:false})],sid);
    await reject(`${sid}:stale-dispatch`,"fixture-file-executor",[jp("effect_dispatch",{fence:status.fence,callId:result.calls[0].call.modelCallRef.id})],sid);
    scale.push({items:n,catalog:n,metadataBodyReads:0,requiredReadBytes:preparedContent.bytes+retained.bytes,measured,
      schema:{initialCompiled:schemaWork.filter(e=>e.disposition==="compiled").length,repeatCompiled:reused.filter(e=>e.disposition==="compiled").length,
        repeatReused:reused.length,repeatElapsedMs:reused.reduce((sum,e)=>sum+e.elapsedMs,0)}});
  }
  // Corrupt persisted bytes in an isolated test store; no warm proof may conceal the damage.
  const Database=require("better-sqlite3"),db=new Database(join(directory,"execution","execution.sqlite"));
  try{db.prepare("UPDATE protocol_content_chunks SET bytes=? WHERE id=? AND offset=0").run(Buffer.from("damaged"),responseContent.id);
    await assert.rejects(()=>runtime.readProtocolContent(journal,responseContent,activityId,32*1024*1024));}finally{db.close();}
  await writeFile(join(directory,"verification.json"),JSON.stringify({protocol:protocolName,effectCount:1,scopeIsolation:true,metadataBodyReads:0,
    originalResponseRecovered:true,originalMapping:binding.catalogRevision,inspectorRecords:offers.length,counts,work,scale},null,2));
}
app.whenReady().then(main).then(async()=>{await store?.close();app.exit(0);}).catch(async error=>{
  await mkdir(directory,{recursive:true});await writeFile(join(directory,"failure.txt"),error.stack??String(error));try{await store?.close();}finally{app.exit(1);}
});
