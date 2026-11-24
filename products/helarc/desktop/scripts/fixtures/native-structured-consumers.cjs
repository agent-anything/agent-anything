const {app}=require("electron");
const assert=require("node:assert/strict"),{join}=require("node:path"),{pathToFileURL}=require("node:url");
const {writeFile,appendFile,readFile}=require("node:fs/promises");
const [directory,profileName,phase,endpoint]=process.argv.slice(2),protocolName=profileName.split("-")[0],accountWork=profileName.endsWith("-account"),methodWork=profileName.endsWith("-method")||accountWork;
app.setPath("userData",join(directory,"electron"));app.disableHardwareAcceleration();
let store;
async function main(){
  const model=await import("@agent-anything/model-interaction/protocol"),runtime=await import("@agent-anything/agent-runtime/model-access");
  const native=await import("@agent-anything/provider-integrations/native"),h=await import("@agent-anything/helarc/controller"),stop=await import("@agent-anything/helarc/task-fulfillment");
  const {modelInputValueDigest:digest}=await import("@agent-anything/model-interaction/input");
  const {HelarcExecutionStore}=await import(pathToFileURL(join(__dirname,"../../dist/main/execution-storage/HelarcExecutionStore.js")));
  store=await HelarcExecutionStore.open(join(directory,"execution"));
  const {admitComponentRun}=require("./admit-component-run.cjs");
  await admitComponentRun(store,directory);
  // This component's source owner is independent; actual delegation is verified separately.
  if(methodWork)await admitComponentRun(store,directory,"child");
  const profiles={responses:{protocol:model.OPENAI_RESPONSES,adapter:native.OPENAI_RESPONSES_ADAPTER,prepare:h.prepareHelarcResponsesStructured,dispatch:native.dispatchResponses,read:native.readResponsesObservation},
    deepseek:{protocol:model.DEEPSEEK_CHAT_COMPLETIONS,adapter:native.DEEPSEEK_CHAT_ADAPTER,prepare:h.prepareHelarcDeepSeekStructured,dispatch:native.dispatchDeepSeekChat,read:native.readDeepSeekObservation},
    ollama:{protocol:model.OLLAMA_CHAT,adapter:native.OLLAMA_CHAT_ADAPTER,prepare:h.prepareHelarcOllamaStructured,dispatch:native.dispatchOllamaChat,read:native.readOllamaChatObservation}};
  const p=profiles[protocolName],ref=id=>({id,revision:"1"}),purposes=["representation-generation","preservation-check","representation-repair","invalid-body","refusal","helarc.task-fulfillment"];
  const participant=implementation=>({implementation,protocol:p.protocol});
  const composition=model.bindModelAgentComposition({agent:ref("agent"),protocol:p.protocol,
    configuration:{configuration:ref("original"),protocol:p.protocol,model:"controlled",connectionBinding:ref("original-connection")},adapter:participant(p.adapter),
    task:{purpose:ref("task"),input:participant(ref("task-input")),interpreter:participant(h.HELARC_NATIVE_TASK_INTERPRETER)},
    auxiliary:[...purposes,"method","context_representation"].map(id=>({purpose:ref(id),input:participant(ref(methodWork&&["method","context_representation","helarc.task-fulfillment"].includes(id)
      ?`helarc.${p.protocol.id}.${id}-input`:`${p.protocol.id}.body-input`)),interpreter:participant(h.HELARC_NATIVE_STRUCTURED_INTERPRETER)}))});
  const schema={type:"object",properties:{answer:{type:"string"}},required:["answer"],additionalProperties:false};
  const context={signal:new AbortController().signal,interruption:null},journal=store.protocolJournal;
  const prepare=(purpose,activityId=purpose,source=ref(purpose),bodySchema=schema,data={expected:"retained-source",purpose})=>{
    const activity=runtime.bindProtocolModelActivity({composition,scope:{runId:"root",activityId,recipientId:"auxiliary",purpose:ref(purpose),compositionDigest:composition.digest},
      conditions:{input:source,authority:ref("original-disclosure"),resources:ref("bounded-request"),control:ref("active")}});
    const input=[{role:"user",content:`Return a JSON object for this purpose: ${purpose}. JSON schema: ${JSON.stringify(bodySchema)}\nEvidence: ${JSON.stringify(data)}`}];
    return p.prepare({activity,source},protocolName==="responses"?{input,stream:false,store:false,textSchema:bodySchema}:
      protocolName==="deepseek"?{messages:input,stream:false,jsonSchema:bodySchema,thinking:{type:"disabled"}}:{messages:input,stream:false,format:bodySchema,think:false});
  };
  let authorized=0,dispatched=0;
  const executionPorts={journal,acceptance:store.sharedAcceptance,generation:store.generation,now:()=>"2026-11-15T00:00:00Z",
    authorize:async request=>{authorized++;assert.deepEqual(request.activity.composition,composition);assert.equal(request.activity.scope.runId,"root");},
    observe:async(state,request,context)=>{
      const activityId=request.activity.scope.activityId,old=await journal.command({kind:"record",activityId,ref:request.observation});if(old)return old;
      const intent=ref(`${request.operationId}:dispatch`);assert.equal(await journal.command({kind:"record",activityId,ref:intent}),null,"unresolved POST cannot be repeated");
      const accept=async(id,record,fence)=>{const result=await store.sharedAcceptance.accept({id,scope:"root",actor:p.adapter.id,
        parts:[{owner:"protocol_execution",kind:"record",proposal:{record,fence}}]});assert.equal(result.outcome,"accepted",JSON.stringify(result));};
      await accept(`${activityId}:dispatch`,{ref:intent,activityId,operationId:request.operationId,kind:"dispatch_intent",content:state.input,source:null,dependencies:[]},state.fence);
      const wire={body:JSON.parse(request.wire.body),encoded:request.wire.body,digest:request.wire.digest};
      const response=p.read(await p.dispatch(wire,{baseUrl:endpoint,apiKey:"synthetic"},{signal:context.signal,retainChunk:async()=>{}}));
      dispatched++;await appendFile(join(directory,"dispatches.ndjson"),JSON.stringify({activityId,purpose:request.activity.scope.purpose.id})+"\n");
      const content=await runtime.retainProtocolContent(journal,`${activityId}:body`,activityId,Buffer.from(JSON.stringify(response)));
      const record={ref:request.observation,activityId,operationId:request.operationId,kind:"observation",content,dependencies:[intent],
        source:{scope:request.activity.scope,protocol:p.protocol,interpretation:p.adapter,operationId:request.operationId,record:request.observation,
          position:{format:"json-pointer",value:""},nativeIdentity:response.id?{kind:"response",id:response.id}:null}};
      await accept(`${activityId}:observation`,record,null);
      if(phase==="observation"){app.exit(73);await new Promise(()=>{});}return record;
    }};
  const execution=new h.HelarcNativeStructuredExecution(executionPorts);
  if(accountWork)return require("./native-account-work.cjs")({app,store,executionPorts,composition,protocolName,phase,directory,h,digest,ref,
    multiple:profileName.includes("-multi-"),normalPolicy:profileName.includes("-policy-")||profileName.includes("-keep-"),keep:profileName.includes("-keep-"),resultBody:profileName.includes("-result-")});
  if(methodWork)return require("./native-method-work.cjs")({app,store,executionPorts,composition,p,protocolName,phase,directory,h,runtime,digest,ref});
  const values=[];
  for(const purpose of purposes.slice(0,-1)){
    if(purpose.startsWith("representation-")||purpose==="preservation-check"){
      const check=purpose==="preservation-check",recipient={runId:"root",recipient:"auxiliary",purpose};
      const material=alias=>({alias,role:alias==="candidate"?"candidate":"source",access:{holdId:`${alias}:hold`,recipient,
        range:{materialId:alias,version:"1",coordinate:"bytes",start:0,end:20}},representation:null,order:alias==="candidate"?1:0,label:alias,originalRole:"tool_result",indivisibleGroup:alias});
      const scope={methodRevision:"1",objective:`this purpose: ${purpose}. Preserve the verification code.`,sources:[material("source"),...(check?[material("candidate")]:[])],
        requirements:[{id:"code",revision:"1",basis:"original-source",description:"Keep 7391 and its uncertainty unchanged."}],relationships:[],sourceBoundary:"original-material:1",combinationDigest:null};
      const source=h.createHelarcNativeRepresentationSource({runId:"root",recipientId:"auxiliary",scope,
        job:{id:purpose,kind:check?"check":"generate",sources:["source"],candidates:check?["candidate"]:[],level:0,repair:purpose==="representation-repair"?1:0,
          feedback:purpose==="representation-repair"?"The earlier candidate omitted 7391; restore it.":null},
        evidence:scope.sources.map(s=>({alias:s.alias,role:s.role,originalRole:s.originalRole,order:s.order,label:s.label,text:"Verification code 7391 is unconfirmed.",limitations:[]}))});
      const evaluation=new h.HelarcNativeRepresentationEvaluation({execution,prepare:async source=>{
        const activity=runtime.bindProtocolModelActivity({composition,scope:{runId:"root",activityId:source.activityId,recipientId:"auxiliary",purpose:ref(purpose),compositionDigest:composition.digest},
          conditions:{input:source.source,authority:ref("original-disclosure"),resources:ref("bounded-method"),control:ref("active")}});
        return protocolName==="responses"?h.prepareHelarcResponsesRepresentation(source,activity,{stream:false,store:false}):
          protocolName==="deepseek"?h.prepareHelarcDeepSeekRepresentation(source,activity,{stream:false,thinking:{type:"disabled"}}):
          h.prepareHelarcOllamaRepresentation(source,activity,{stream:false,think:false});}});
      const result=await evaluation.evaluate(source,context);assert.equal(result.kind,"contract_result");
      assert.equal(result.value.kind,check?"assessment":"candidate");
      if(check)assert.equal(result.value.requirements[0].conclusion,"supported");else assert(result.value.body.includes("7391"));
      assert.deepEqual(await evaluation.evaluate(source,context),result);continue;
    }
    const request=prepare(purpose),result=await execution.execute(request,context);values.push(result);
    assert.equal(result.assessment.outcome,purpose==="invalid-body"?"invalid":purpose==="refusal"&&protocolName!=="ollama"?"refused":"valid");
    assert.equal(result.evidence.scope.purpose.id,purpose);
    if(phase==="verify")assert.deepEqual(await execution.recover(purpose,context),result);
  }
  const run={id:"root"},event={ref:{run,id:"root:stop:1",sequence:1,revision:"1"},point:"Stop",run,runKind:"root",agent:ref("agent"),
    task:{id:"task",kind:"test",input:{prompt:"Report the retained source."},createdAt:"2026-11-15T00:00:00Z",metadata:{}},controllerRequestId:"decision",
    iteration:1,candidate:{ref:ref("candidate"),kind:"complete",output:{summary:"retained-source"}},
    interaction:{kind:"native_evidence",id:"history",revision:"1",seed:null,entries:[],unsettledCalls:[],settledCallCount:0},plan:null,pending:[],emittedAt:"2026-11-15T00:00:00Z"};
  let preparedStop=0;
  const evaluation=stop.createHelarcNativeStopEvaluation({execution,prepare:async source=>{
    preparedStop++;return prepare("helarc.task-fulfillment",source.activityId,source.source,source.schema,{event:source.event,instructions:source.instructions});}});
  const disabled=new stop.HelarcTaskFulfillmentHook(evaluation,[{id:"stop_instructions",content:"Check evidence.",enabled:false}]);
  assert.deepEqual(await disabled.handle(event,context),{disposition:"allow"});assert.equal(preparedStop,0);
  const hook=new stop.HelarcTaskFulfillmentHook(evaluation,[{id:"stop_instructions",content:"Check evidence.",enabled:true}]);
  assert.deepEqual(await hook.recover(event,context),{disposition:"allow"});
  assert.equal(preparedStop,phase==="verify"?0:1);assert.equal(hook.getAssessments().length,1);
  if(phase==="accepted"){app.exit(73);await new Promise(()=>{});}
  assert.equal(phase,"verify");assert.equal(dispatched,0);
  const original=prepare("invalid-body"),body=JSON.parse(original.wire.body);body.model="changed-current-settings";
  await assert.rejects(()=>execution.execute({...original,wire:{body:JSON.stringify(body),digest:digest(body)}},context),/original_binding_invalid/);
  const facts=await journal.command({kind:"facts",runId:"root",after:0,limit:128});
  const accepted=facts.filter(f=>f.kind==="purpose_accepted");assert.equal(accepted.length,6);
  assert.equal((await readFile(join(directory,"dispatches.ndjson"),"utf8")).trim().split("\n").length,6);
  await writeFile(join(directory,"verification.json"),JSON.stringify({protocol:protocolName,generation:store.generation,accepted:accepted.length,authorized,
    replayedDispatches:dispatched,disabledStopRequests:0,originalAssessmentTime:hook.getAssessments()[0].assessedAt},null,2));
}
app.whenReady().then(main).then(async()=>{await store?.close();app.exit(0);}).catch(async error=>{
  await writeFile(join(directory,"failure.txt"),require("node:util").inspect(error,{depth:8,colors:false}));try{await store?.close();}finally{app.exit(1);}});
