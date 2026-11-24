const {app}=require("electron");
const assert=require("node:assert/strict");
const {join}=require("node:path");
const {pathToFileURL}=require("node:url");
const {readFile,writeFile,appendFile,mkdir}=require("node:fs/promises");
const [directory,phase,endpoint]=process.argv.slice(2);
app.setPath("userData",join(directory,"electron"));app.disableHardwareAcceleration();
const ref=id=>({id,revision:"1"}),jp=(kind,proposal)=>({owner:"protocol_execution",kind,proposal});
let store;
async function main(){
  const runtime=await import("@agent-anything/agent-runtime/model-access"),model=await import("@agent-anything/model-interaction/protocol");
  const native=await import("@agent-anything/provider-integrations/native"),helarc=await import("@agent-anything/helarc/controller");
  const {HelarcExecutionStore}=await import(pathToFileURL(join(process.cwd(),"dist/main/execution-storage/HelarcExecutionStore.js")));
  const {ProtocolJournalInspectionAdapter}=await import(pathToFileURL(join(process.cwd(),"dist/main/inspection/ProtocolJournalInspectionAdapter.js")));
  const calls={},work=[],facts=[];
  store=await HelarcExecutionStore.open(join(directory,"execution"),undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,{observe:f=>facts.push(f)});
  const journal={command:async command=>{calls[command.kind]=(calls[command.kind]??0)+1;return store.protocolJournal.command(command);}};
  const content=(id,activityId,value)=>runtime.retainProtocolContent(journal,id,activityId,Buffer.from(JSON.stringify(value)),w=>work.push(w));
  const owner=native.OPENAI_RESPONSES_ADAPTER.id;
  const composition=model.bindModelAgentComposition({agent:ref("agent"),protocol:model.OPENAI_RESPONSES,
    configuration:{configuration:ref("cfg"),protocol:model.OPENAI_RESPONSES,model:"fixture",connectionBinding:ref("original-connection")},
    adapter:{implementation:native.OPENAI_RESPONSES_ADAPTER,protocol:model.OPENAI_RESPONSES},
    task:{purpose:ref("task"),input:{implementation:ref("input"),protocol:model.OPENAI_RESPONSES},interpreter:{implementation:helarc.HELARC_NATIVE_TASK_INTERPRETER,protocol:model.OPENAI_RESPONSES}},auxiliary:[]});
  const accept=async(id,actor,parts,scope)=>{const receipt=await store.sharedAcceptance.accept({id,actor,parts,scope});assert.equal(receipt.outcome,"accepted",JSON.stringify(receipt));return receipt;};
  const evidence=extra=>writeFile(join(directory,`${phase}.json`),JSON.stringify({phase,pid:process.pid,electron:process.versions.electron,generation:store.generation,calls,work,...extra},null,2));
  let now=Date.now();
  async function setup(id,seed=false){
    const activity=runtime.bindProtocolModelActivity({composition,scope:{runId:id,activityId:id,recipientId:"task",purpose:ref("task"),compositionDigest:composition.digest},
      conditions:{input:ref(`${id}:input`),authority:ref("authority"),resources:ref("resources"),control:ref("control")}});
    const scope={id:`${id}:scope`,runId:id,recipientId:"task",purpose:ref("task"),compositionDigest:composition.digest,owner};
    let original;
    if(seed){
      const definition={name:"Write_a1",description:"Write one synthetic file",inputSchema:{type:"object",properties:{path:{type:"string"}},required:["path"],additionalProperties:false}};
      const base={scope:activity.scope,protocol:model.OPENAI_RESPONSES,adapter:native.OPENAI_RESPONSES_ADAPTER,interpreter:helarc.HELARC_NATIVE_TASK_INTERPRETER,
        acceptance:ref(`${id}:purpose`),requestId:`${id}:request`,controllerRequestId:`${id}:decision`,operationId:`${id}:session:operation:1`,record:ref(`${id}:terminal`),
        catalog:[{definition,binding:{kind:"tool",callableName:"Write_a1",toolName:"Write",tool:{tool:{namespace:"fixture",name:"Write"},revision:"1"},
          binding:{kind:"operation",operation:{operation:{namespace:"fixture",name:"write"},revision:"1"},revision:"1"}}}],schemaMode:"responses-strict",hasPlan:false,
        planLimits:{maxSteps:20,maxStepLength:1000,maxExplanationLength:2000}};
      const binding={...base,catalogRevision:helarc.nativeTaskCatalog(base).revision};
      const socket=id==="socket";
      const prepared=native.prepareResponses({model:"fixture",input:[{role:"user",content:id}],purpose:ref("task"),stream:id!=="child",store:!socket,
        ...(socket?{transport:"websocket"}:{background:true}),tools:[definition]});
      const session={id:`${id}:session`,scopeId:scope.id,target:"original-target",prepared:{body:prepared.body,encoded:prepared.encoded,digest:prepared.digest},
        profile:{transport:socket?"websocket":"http",background:!socket,stream:id!=="child",store:!socket,temporaryRetention:!socket,
          continuity:socket?"connection_memory":"persistent_chain",connectionIncarnation:socket?"original-carrier":null},
        policy:{...native.DEFAULT_RESPONSES_OBSERVATION_POLICY,pollMinimumMs:10,pollMaximumMs:100,failureEpisodeMs:120000},createdAt:now,deadlineAt:now+600000,
        maximumBytes:32*1024*1024,maximumFrameBytes:8*1024*1024,maximumEvents:10000};
      original={format:"helarc.native-prepared-task.v1",binding,wire:{body:prepared.encoded,digest:prepared.digest},previous:null,session};
      const input=await content(`${id}:original`,id,original);
      await accept(`${id}:prepare`,"execution-coordinator",[jp("prepare",{activity,input}),jp("evidence_scope",{activityId:id,scope})],id);
    }
    let state=await journal.command({kind:"state",activityId:id});assert(state);
    if(state.fence.generation!==store.generation||state.fence.epoch===0){await accept(`${id}:claim:${store.generation}`,owner,[jp("claim",{activityId:id,expectedEpoch:state.fence.epoch})],id);state=await journal.command({kind:"state",activityId:id});}
    if(!original)original=JSON.parse((await runtime.readProtocolContent(journal,state.input,id,32*1024*1024,w=>work.push(w))).toString());
    const current=()=>journal.command({kind:"state",activityId:id});
    const custody=fence=>({id:original.session.id,journal,acceptance:store.sharedAcceptance,scope,fence,original:[state.input],maximumSegmentBytes:64*1024*1024,observe:w=>work.push(w)});
    return {id,activity,scope,original,current,custody,state};
  }
  const environment={now:()=>now,jitter:()=>0.5,target:"original-target",baseUrl:endpoint,headers:{"content-type":"application/json"},signal:new AbortController().signal,authorize:async()=>{}};
  async function advance(session){if(session.snapshot().dueAt)now=Math.max(now,session.snapshot().dueAt);return session.step(environment);}
  if(phase==="faults"){
    const entry=await setup("faults",true),base=entry.custody(entry.state.fence);let failed=false,lostAck=false,creates=0,reads=0;
    const terminal={id:"faults-response",object:"response",status:"completed",output:[]};
    const frame=(sequence_number,status)=>({type:`response.${status==="completed"?"completed":"created"}`,sequence_number,response:{...terminal,status}});
    const response=events=>{let index=0;return new Response(new ReadableStream({pull(controller){if(index===events.length)controller.close();else controller.enqueue(Buffer.from(`data: ${JSON.stringify(events[index++])}\n\n`));}},{highWaterMark:0}));};
    const fetch=async(url,options)=>{if(options.method==="POST"){creates++;return response([frame(0,"in_progress"),frame(1,"completed")]);}reads++;assert(String(url).includes("starting_after=0"));return response([frame(1,"completed")]);};
    const acceptance={query:id=>store.sharedAcceptance.query(id),accept:async proposal=>{
      const terminal=proposal.parts.some(p=>p.kind==="evidence"&&p.proposal.evidence.metadata.cursor===1);
      if(terminal&&!failed){failed=true;throw new Error("injected-checkpoint-write-failure");}
      const receipt=await store.sharedAcceptance.accept(proposal);
      if(terminal&&!lostAck&&receipt.outcome==="accepted"){lostAck=true;throw new Error("injected-lost-ack");}
      return receipt;
    }};
    const storage=new helarc.HelarcResponsesSessionStore({...base,acceptance});
    let session=await native.ResponsesSession.open(entry.original.session,storage);
    await assert.rejects(()=>session.step({...environment,fetch}),/injected-checkpoint-write-failure/);
    await assert.rejects(()=>session.step({...environment,fetch}),/reload_required/);
    assert.equal((await storage.observe()).metadata.cursor,0);
    session=await native.ResponsesSession.open(entry.original.session,storage);await session.step({...environment,fetch});now=session.snapshot().dueAt;
    await session.step({...environment,fetch});assert.equal(session.snapshot().disposition,"terminal");assert(failed&&lostAck);assert.equal(creates,1);assert.equal(reads,1);
    const race=await setup("cancel-race",true),raceBase=race.custody(race.state.fence);let cancelled=false;
    const racingAcceptance={query:id=>store.sharedAcceptance.query(id),accept:async proposal=>{
      if(!cancelled&&proposal.parts.some(p=>p.kind==="evidence"&&p.proposal.evidence.metadata.cursor===1)){
        cancelled=true;await accept("race-control","execution-coordinator",[jp("control",{activityId:race.id,expectedRevision:0,cancelled:true})],race.id);
      }
      return store.sharedAcceptance.accept(proposal);
    }};
    const racingStorage=new helarc.HelarcResponsesSessionStore({...raceBase,acceptance:racingAcceptance});
    const racingSession=await native.ResponsesSession.open(race.original.session,racingStorage);
    await assert.rejects(()=>racingSession.step({...environment,fetch:async()=>response([frame(0,"in_progress"),frame(1,"completed")])}),/fenced/);
    assert.equal((await racingStorage.observe()).metadata.cursor,0);
    const recorded=await journal.command({kind:"facts",runId:race.id,after:0,limit:128});
    assert(recorded.some(f=>f.kind==="observation"&&f.value.ref.id.includes(":late:")));assert.equal(await journal.command({kind:"acceptance",activityId:race.id}),null);
    await evidence({failedCheckpointReloaded:true,lostAckResolved:true,createCount:creates,resumedReads:reads,lateEvidenceRetained:true,cancelledHeadNotAdvanced:true});return;
  }
  if(phase==="socket"||phase==="socket-recovery"){
    const entry=await setup("socket",phase==="socket"),storage=new helarc.HelarcResponsesSessionStore(entry.custody(entry.state.fence));
    const session=await native.ResponsesSession.open(entry.original.session,storage);
    if(phase==="socket"){
      const socket=new native.ResponsesWebSocket(entry.scope.id,"original-carrier",{baseUrl:endpoint,headers:{}},{connectMs:1000,maximumFrameBytes:10000,maximumBufferedBytes:20000});
      try{await session.step({...environment,socket});}finally{await socket.close();}
      assert.equal(session.snapshot().head.responseId,"response-socket");
      await evidence({originalConnectionLost:true,retainedCursor:session.snapshot().head.cursor});return;
    }
    await advance(session);assert.equal(session.snapshot().disposition,"unresolved");assert.equal(session.snapshot().reason,"original_response_unavailable");
    assert.equal(await journal.command({kind:"acceptance",activityId:"socket"}),null);
    await evidence({connectionMemoryNotRecreated:true,partialCallsNotExecuted:true});return;
  }
  if(phase==="scale"){
    const measurements=[];
    for(const [events,bytes] of [[16,65536],[64,65536],[64,262144]]){
      const id=`scale-${events}-${bytes}`,entry=await setup(id,true),custody=entry.custody(entry.state.fence),storage=new helarc.HelarcResponsesSessionStore(custody);
      const text="x".repeat(bytes),item={id:"message",type:"message",role:"assistant",content:[{type:"output_text",text}]};
      const lines=[{type:"response.created",sequence_number:0,response:{id,object:"response",status:"in_progress",output:[]}},
        ...Array.from({length:events},(_,i)=>({type:"response.output_text.delta",sequence_number:i+1,item_id:"message",content_index:0,delta:text.slice(i*bytes/events,(i+1)*bytes/events)})),
        {type:"response.output_text.done",sequence_number:events+1,item_id:"message",content_index:0,text},
        {type:"response.completed",sequence_number:events+2,response:{id,object:"response",status:"completed",output:[item]}}];
      let index=0;
      const fetch=async()=>new Response(new ReadableStream({pull(controller){if(index===lines.length)controller.close();else controller.enqueue(Buffer.from(`data: ${JSON.stringify(lines[index++])}\n\n`));}},{highWaterMark:0}),{headers:{"content-type":"text/event-stream"}});
      const session=await native.ResponsesSession.open(entry.original.session,storage),start=performance.now(),before=work.length,reads=calls.content_read??0;
      await session.step({...environment,fetch});assert.equal(session.snapshot().disposition,"terminal");
      assert.equal(calls.content_read??0,reads,"Hot checkpoint progression must not reread accumulated content");
      const written=work.slice(before).filter(w=>w.operation==="retain").reduce((sum,w)=>sum+w.bytes,0);
      assert(written<bytes*12+events*10000,"Custody growth must remain linear in bytes and events");
      for(let i=0;i<10;i++)await storage.observe();assert.equal(calls.content_read??0,reads);
      const restored=await native.ResponsesSession.open(entry.original.session,storage);assert.deepEqual(restored.response(),session.response());
      measurements.push({events,bytes,writtenBytes:written,segments:session.snapshot().segments,elapsedMs:performance.now()-start,hotBodyReads:0});
    }
    assert(measurements[1].writtenBytes<measurements[0].writtenBytes*2);assert(measurements[2].writtenBytes<measurements[1].writtenBytes*4.5);
    await evidence({measurements});return;
  }
  if(phase==="seed"){
    const child=await setup("child",true),childStore=new helarc.HelarcResponsesSessionStore(child.custody(child.state.fence));
    const childSession=await native.ResponsesSession.open(child.original.session,childStore);await advance(childSession);
    const root=await setup("root",true),custody=root.custody(root.state.fence);
    const acceptance={query:id=>store.sharedAcceptance.query(id),accept:async proposal=>{
      const receipt=await store.sharedAcceptance.accept(proposal);
      if(receipt.outcome==="accepted"&&proposal.parts.some(p=>p.kind==="evidence"&&p.proposal.evidence.metadata.cursor===2)){
        await evidence({lostAck:"stream-checkpoint",cursor:2,receiptId:receipt.id});app.exit(73);return new Promise(()=>{});
      }
      return receipt;
    }};
    const session=await native.ResponsesSession.open(root.original.session,new helarc.HelarcResponsesSessionStore({...custody,acceptance}));await advance(session);
    throw new Error("expected stream checkpoint crash");
  }
  const root=await setup("root"),rootStore=new helarc.HelarcResponsesSessionStore(root.custody(root.state.fence));
  const session=await native.ResponsesSession.open(root.original.session,rootStore);
  if(phase==="resume"){
    assert.equal(session.snapshot().head.cursor,2);assert.equal(session.snapshot().head.keepalives,1);
    await advance(session);await advance(session);assert.equal(session.snapshot().disposition,"terminal");assert.equal(session.snapshot().head.duplicates,1);
    assert.equal(session.response().output[0].encrypted_content,"terminal-opaque");
    assert.deepEqual(session.continuationItems()[0].source,{kind:"output_item_done",sequence:3});
    assert.equal(session.continuationItems()[0].item.encrypted_content,"item-done-opaque");
    await rootStore.retainTerminal(session,root.original.binding.record);
    const proposal=await helarc.recoverHelarcNativeTask({journal,activity:root.activity,observation:root.original.binding.record,
      interpret:helarc.interpretHelarcResponses,validateOriginalInput:helarc.validateHelarcResponsesTaskInput});
    assert.equal(proposal.kind,"advance");assert.equal(proposal.calls.length,1);
    const result=await content("root:purpose-result","root",proposal),call=proposal.calls[0].call;
    await accept("root:purpose",helarc.HELARC_NATIVE_TASK_INTERPRETER.id,[jp("purpose",{fence:root.state.fence,acceptance:{evidence:proposal.evidence,result,effects:[{call,owner:"file-executor"}],deliveries:[]}})],"root");
    await accept("root:dispatch","file-executor",[jp("effect_dispatch",{fence:root.state.fence,callId:call.modelCallRef.id})],"root");
    await appendFile(join(directory,"effect-count"),"1\n");await writeFile(join(directory,"one.txt"),"one original effect");
    const output=await content("root:effect-result","root",{written:true});
    await accept("root:confirm","file-executor",[jp("effect_confirmation",{activityId:"root",callId:call.modelCallRef.id,dispatchBasis:"intent_recorded",confirmation:ref("root:confirmed"),result:output,deliveries:[]})],"root");
    const child=await setup("child");
    await accept("child:cancel","execution-coordinator",[jp("control",{activityId:"child",expectedRevision:child.state.fence.controlRevision,cancelled:true})],"child");
    const controlled=await child.current(),childCustody=child.custody(controlled.fence),childStore=new helarc.HelarcResponsesSessionStore(childCustody);
    const childSession=await native.ResponsesSession.open(child.original.session,childStore);await childSession.cancel("child:cancel");await advance(childSession);
    assert.equal(childSession.snapshot().cancelEpisode.failures,1);
    const handoff=await helarc.handoffHelarcResponses(childCustody,childSession.snapshot(),childSession.snapshot().cancelEpisode.deadlineAt);
    const stale=await store.sharedAcceptance.accept({id:"stale-producer",actor:owner,scope:"child",parts:[jp("record",{fence:controlled.fence,
      record:{ref:ref("stale-producer"),activityId:"child",operationId:"local",kind:"owner_checkpoint",content:controlled.input,source:null,dependencies:[]}})]});
    assert.equal(stale.outcome,"rejected");
    assert.match(stale.rejection.code,/fenced/);
    await evidence({lostAck:"handoff",handoff,terminal:true,effectCount:1});app.exit(73);return new Promise(()=>{});
  }
  assert.equal(session.snapshot().disposition,"terminal");
  assert.equal(session.response().output[0].encrypted_content,"terminal-opaque");
  assert.equal(session.continuationItems()[0].item.encrypted_content,"item-done-opaque");
  assert.deepEqual(session.continuationItems()[0].source,{kind:"output_item_done",sequence:3});
  const accepted=await journal.command({kind:"acceptance",activityId:"root"});assert(accepted);
  const callId=accepted.effects[0].call.modelCallRef.id;
  const repeat=await store.sharedAcceptance.accept({id:`repeat:${phase}`,actor:"file-executor",scope:"root",parts:[jp("effect_dispatch",{fence:root.state.fence,callId})]});
  assert.equal(repeat.outcome,"rejected");assert.equal(await readFile(join(directory,"effect-count"),"utf8"),"1\n");
  if(phase==="followup"){
    const handoffs=await journal.command({kind:"reconciliation_list",receiver:owner,after:null,limit:10});assert.equal(handoffs.length,1);
    const child=await setup("child"),custody=child.custody(child.state.fence),storage=new helarc.HelarcResponsesSessionStore(custody);
    const childSession=await native.ResponsesSession.open(child.original.session,storage);assert.equal(childSession.snapshot().cancelEpisode.failures,1);
    await childSession.followUp(handoffs[0].id,handoffs[0].expiresAt);await advance(childSession);
    assert.equal(childSession.snapshot().head.status,"completed");assert.equal(childSession.snapshot().cancelAcknowledged,true);
    await storage.retainTerminal(childSession,child.original.binding.record);
    const proposal=await helarc.recoverHelarcNativeTask({journal,activity:child.activity,observation:child.original.binding.record,
      interpret:helarc.interpretHelarcResponses,validateOriginalInput:helarc.validateHelarcResponsesTaskInput});
    const result=await content("child:late-purpose","child",proposal);
    const receipt=await store.sharedAcceptance.accept({id:"late-purpose",actor:helarc.HELARC_NATIVE_TASK_INTERPRETER.id,scope:"child",
      parts:[jp("purpose",{fence:child.state.fence,acceptance:{evidence:proposal.evidence,result,effects:proposal.calls.map(c=>({call:c.call,owner:"file-executor"})),deliveries:[]}})]});
    assert.equal(receipt.outcome,"rejected");assert.match(receipt.rejection.code,/fenced/);
    await helarc.closeHelarcResponsesHandoff(custody,childSession.snapshot());
    assert.deepEqual(await journal.command({kind:"reconciliation_list",receiver:owner,after:null,limit:10}),[]);
    await evidence({handoffClosed:true,lateCallsRejected:true,cancelAttempts:2});return;
  }
  const reads=calls.content_read??0;
  for(let i=0;i<32;i++){await rootStore.observe();await journal.command({kind:"state",activityId:"root"});await journal.command({kind:"reconciliation_list",receiver:owner,after:null,limit:10});}
  assert.equal(calls.content_read??0,reads);
  const child=await setup("child");await assert.rejects(()=>runtime.readProtocolContent(journal,root.state.input,"child",32*1024*1024));
  const offers=[],recorder={ref:(owner,kind,id,runId,revision="1")=>({sourceId:"fixture",datasetId:"fixture",owner,kind,id,runId,revision}),offer:value=>offers.push(value)};
  const inspector=new ProtocolJournalInspectionAdapter(recorder);
  for(const runId of ["root","child"])await inspector.replay((after,limit)=>journal.command({kind:"facts",runId,after,limit}));
  assert(offers.some(o=>o.payload.name==="execution.reconciliation_handoff"));
  assert(offers.some(o=>o.payload.name==="execution.reconciliation_closed"));
  assert(offers.some(o=>o.payload.name==="execution.reconciliation_intent"));
  assert(offers.some(o=>o.contents?.some(c=>c.value?.kind==="transport"&&c.value.metadata.cursor===4)));
  const head=await rootStore.observe();
  const Database=require("better-sqlite3"),db=new Database(join(directory,"execution/execution.sqlite"));
  const version=db.prepare("SELECT version FROM store").get().version;assert.equal(version,46);
  db.prepare("UPDATE protocol_content_chunks SET bytes=? WHERE id=? AND offset=0").run(Buffer.from("corrupt"),head.content.id);db.close();
  await assert.rejects(()=>rootStore.load());
  await evidence({metadataBodyReads:0,effectCount:1,scopeIsolation:true,inspectorRecords:offers.length,corruptionRejected:true,schemaVersion:version});
}
app.whenReady().then(main).then(async()=>{await store?.close();app.exit(0);}).catch(async error=>{
  await mkdir(directory,{recursive:true});await writeFile(join(directory,`failure-${phase}.txt`),error.stack??String(error));try{await store?.close();}finally{app.exit(1);}
});
