const {app}=require("electron");
const assert=require("node:assert/strict");
const {join}=require("node:path");
const {pathToFileURL}=require("node:url");
const {writeFile,readFile,appendFile,mkdir}=require("node:fs/promises");
const {existsSync}=require("node:fs");
const {createHash}=require("node:crypto");
const {admitComponentRun,commitComponentRun}=require("./admit-component-run.cjs");
const [directory,scenario,phase]=process.argv.slice(2);
app.setPath("userData",join(directory,"electron"));app.disableHardwareAcceleration();
const stores=[],observed=[],timings=[];
const ref=id=>({id,revision:"1"});
const hash=value=>`sha256:${createHash("sha256").update(value).digest("hex")}`;
const crash=async point=>{if(phase==="seed"&&scenario===point){app.exit(73);await new Promise(()=>{});}};
let HelarcExecutionStore,protocol,model,activity,completeMaterialDeliveryHandoff,Inspector;
async function open(name){
  const store=await HelarcExecutionStore.open(join(directory,name),undefined,undefined,undefined,{performance:event=>timings.push(event)},undefined,undefined,undefined,undefined,
    {observe:fact=>{observed.push(fact);throw new Error("optional-inspector-unavailable");}});
  stores.push(store);return store;
}
async function accept(store,id,actor,parts,scope="root"){
  const result=await store.sharedAcceptance.accept({id,scope,actor,parts});assert.equal(result.outcome,"accepted",JSON.stringify(result));return result;
}
const jp=(kind,proposal)=>({owner:"protocol_execution",kind,proposal});
const mp=(kind,proposal)=>({owner:"material_delivery",kind,proposal});
async function rejected(store,id,actor,parts,pattern,scope="root"){
  const result=await store.sharedAcceptance.accept({id,scope,actor,parts});assert.equal(result.outcome,"rejected",JSON.stringify(result));assert.match(result.rejection.code,pattern);return result;
}
async function body(store,id,bytes,activityId="native-activity",partial=false){
  bytes=Buffer.from(bytes);const content={id,activityId,bytes:bytes.length,digest:hash(bytes)};
  await store.protocolJournal.command({kind:"content_begin",content});
  for(let offset=0;offset<bytes.length;offset+=65536){
    await store.protocolJournal.command({kind:"content_append",content,offset,bytesBase64:bytes.subarray(offset,offset+65536).toString("base64")});
    if(partial&&offset===0){app.exit(73);await new Promise(()=>{});}
  }
  await store.protocolJournal.command({kind:"content_complete",content});return content;
}
async function readBody(store,content){
  let offset=0;const parts=[];
  do{const page=await store.protocolJournal.command({kind:"content_read",content,activityId:content.activityId,offset,length:65536});parts.push(Buffer.from(page.bytesBase64,"base64"));offset=page.next;}while(offset!==null);
  const bytes=Buffer.concat(parts);assert.equal(hash(bytes),content.digest);return bytes;
}
function fixture(runId="root",activityId="native-activity"){
  const participant=id=>({implementation:ref(id),protocol:protocol.OPENAI_RESPONSES});
  const composition=protocol.bindModelAgentComposition({agent:ref("agent"),protocol:protocol.OPENAI_RESPONSES,
    configuration:{configuration:ref("config"),protocol:protocol.OPENAI_RESPONSES,model:"fixture-model",connectionBinding:ref("original-connection")},
    adapter:participant("adapter"),task:{purpose:ref("task"),interpreter:participant("task-interpreter"),input:participant("task-input")},auxiliary:[]});
  const scope={runId,activityId,recipientId:"task",purpose:ref("task"),compositionDigest:composition.digest};
  const original=activity.bindProtocolModelActivity({composition,scope,conditions:{input:ref(`${activityId}:input`),authority:ref("authority"),resources:ref("resources"),control:ref("control")}});
  const source={scope,protocol:protocol.OPENAI_RESPONSES,interpretation:ref("adapter"),operationId:"create-response",record:ref(`${activityId}:response`),position:{format:"json-pointer",value:"/output/0"},nativeIdentity:{kind:"response",id:"same-remote-id"}};
  const evidence={scope,interpreter:ref("task-interpreter"),acceptance:ref(`${activityId}:purpose`),sources:[source]};
  const call={modelCallRef:model.createNativeModelCallRef({providerRequestId:"request",controllerRequestId:"decision",branchId:runId,contentBlockOrdinal:0,nativeSource:source,purposeAcceptance:evidence.acceptance}),providerCallRef:null,name:"Write",input:{path:"test-only.txt"},ordinal:0};
  return {original,source,evidence,call};
}
function checkpoint(original,evidence,call,claimRunCall=false){
  const revision=original.state.revision+1,run=original.state.run;
  const modelItems=[{id:"native-evidence",kind:"native_purpose_evidence",evidence,metadata:{}},
    ...(claimRunCall?[{id:call.modelCallRef.id,kind:"model_tool_call",call,metadata:{}}]:[])];
  const item={ref:{id:"native-item",run,sequence:original.state.items.length+1},committedInRevision:revision,createdAt:new Date().toISOString(),
    payload:{kind:"controller_turn",turn:{id:"decision",run,sequence:1},status:"decided",decisionKind:"continue_with_feedback",
      instructionBinding:original.control.instructionBinding.ref,
      toolExposure:{proofId:"fixture-proof",controllerRequestId:"decision",manifestId:"fixture-manifest",selectionRevision:"1",
        contentRevision:"1",basisRevision:"1",catalogRevision:"1",exposedTools:[],exposedToolCount:0,omittedToolCount:0,omissionReasons:[]},
      modelItems,failure:null}};
  return {...original,id:`root:commit:${revision}`,expectedRevision:original.state.revision,admission:null,
    state:{...original.state,revision,items:[...original.state.items,item]},
    control:{...original.control,controllerCheckpoints:[...original.control.controllerCheckpoints,["native",{activityId:"native-activity",source:evidence.sources[0]}]]}};
}
async function journal(){
  const store=await open("execution"),q=store.protocolJournal.command;
  const cancelledBeforeDispatch=scenario==="cancel-before-dispatch";
  const {original,source,evidence,call}=fixture();
  const input=await body(store,"native-activity:input",JSON.stringify({input:[{role:"user",content:"Write once, then report."}],tools:[],instructions:null}));
  if(!await store.readLatestRun("root")){
    await rejected(store,"missing-run","execution-coordinator",[jp("prepare",{activity:original,input})],/native_run_admission_closed/);
    assert.equal(await q({kind:"state",activityId:"native-activity"}),null);
    await admitComponentRun(store,directory);
  }
  await accept(store,"prepare","execution-coordinator",[jp("prepare",{activity:original,input})]);
  await crash("input");
  let state=await q({kind:"state",activityId:"native-activity"});const oldFence=state.fence;
  if(state.fence.generation!==store.generation||state.fence.epoch===0){
    await accept(store,`claim:${store.generation}`,"adapter",[jp("claim",{activityId:"native-activity",expectedEpoch:state.fence.epoch})]);
    state=await q({kind:"state",activityId:"native-activity"});
  }
  const fence=state.fence,dispatch={ref:ref("dispatch"),activityId:"native-activity",operationId:"create-response",kind:"dispatch_intent",content:input,source:null,dependencies:[]};
  if(!await q({kind:"record",activityId:"native-activity",ref:dispatch.ref}))await accept(store,"dispatch","adapter",[jp("record",{record:dispatch,fence})]);
  // The independent file is the controlled remote peer. Recovery retrieves it, never recreates work.
  if(!existsSync(join(directory,"remote-response.json"))){
    await appendFile(join(directory,"provider-creates"),"create\n");
    await writeFile(join(directory,"remote-response.json"),JSON.stringify({id:"same-remote-id",output:[{call:"Write",content:"original native evidence ".repeat(30000)}]}));
  }
  await crash("dispatch");
  const responseBytes=await readFile(join(directory,"remote-response.json"));
  const response=await body(store,"response-body",responseBytes,"native-activity",phase==="seed"&&scenario==="partial");
  const record={ref:source.record,activityId:"native-activity",operationId:"create-response",kind:"observation",content:response,source,dependencies:[dispatch.ref]};
  await accept(store,"response","adapter",[jp("record",{record,fence:null})]);
  await crash("response");
  const result=await body(store,"purpose-body",JSON.stringify({action:"execute",call:call.modelCallRef.id}));
  const acceptance={evidence,result,effects:[{call,owner:"file-executor"}],deliveries:[{id:"purpose-delivery",recipient:{runId:"root",id:"task-consumer",purpose:"task"},content:result}]};
  if(!await q({kind:"acceptance",activityId:"native-activity"}))await accept(store,"purpose","task-interpreter",[jp("purpose",{fence,acceptance})]);
  await crash("acceptance");
  assert.deepEqual(await q({kind:"acceptance",activityId:"native-activity"}),acceptance);
  if((await store.readLatestRun("root")).state.revision===0){
    const admitted=await store.readLatestRun("root");
    // This fixture's effect is owned by file-executor, not by Run local coordination.
    await assert.rejects(()=>commitComponentRun(store,checkpoint(admitted,evidence,call,true)),/protocol_run_call_owner_invalid/);
    assert.equal((await store.readLatestRun("root")).state.revision,0);
    await commitComponentRun(store,checkpoint(admitted,evidence,call));
  }
  let effect=await q({kind:"effect",activityId:"native-activity",callId:call.modelCallRef.id});
  if(cancelledBeforeDispatch){
    await accept(store,"cancel","execution-coordinator",[jp("control",{activityId:"native-activity",expectedRevision:0,cancelled:true})]);
    await rejected(store,`cancel-prevents-dispatch:${store.generation}`,"file-executor",[jp("effect_dispatch",{fence,callId:call.modelCallRef.id})],/fenced/);
  }else{
  if(!effect.dispatched)await accept(store,"effect-dispatch","file-executor",[jp("effect_dispatch",{fence,callId:call.modelCallRef.id})]);
  await crash("effect-dispatch");
  // An actual local side effect is independently reconciled after ambiguous dispatch.
  if(!existsSync(join(directory,"effects")))await appendFile(join(directory,"effects"),"write\n");
  await crash("effect-applied");
  }
  const output=await body(store,"effect-output",cancelledBeforeDispatch?"cancelled before execution":"file written once");
  const confirmation={activityId:"native-activity",callId:call.modelCallRef.id,dispatchBasis:cancelledBeforeDispatch?"not_started":"intent_recorded",confirmation:ref("file-result"),result:output,
    deliveries:[{id:"effect-delivery",recipient:{runId:"root",id:"task-consumer",purpose:"task"},content:output}]};
  await rejected(store,`wrong-confirmation-basis:${store.generation}`,"file-executor",[jp("effect_confirmation",{...confirmation,dispatchBasis:cancelledBeforeDispatch?"intent_recorded":"not_started"})],/basis_invalid/);
  await accept(store,"effect-confirm","file-executor",[jp("effect_confirmation",confirmation)]);
  await crash("effect-confirmed");
  await crash("cancel-before-dispatch");
  assert.deepEqual((await q({kind:"effect",activityId:"native-activity",callId:call.modelCallRef.id})).deliveries,confirmation.deliveries);
  await accept(store,"receive-purpose","task-consumer",[jp("received",{activityId:"native-activity",deliveryId:"purpose-delivery",receipt:ref("purpose-received"),recipient:acceptance.deliveries[0].recipient})]);
  const delivery=await q({kind:"delivery",activityId:"native-activity",id:"effect-delivery"});
  if(!delivery.receipt)await accept(store,"receive-effect","task-consumer",[jp("received",{activityId:"native-activity",deliveryId:"effect-delivery",receipt:ref("effect-received"),recipient:confirmation.deliveries[0].recipient})]);
  await crash("received");
  if(cancelledBeforeDispatch)assert.equal(existsSync(join(directory,"effects")),false);
  else assert.equal(await readFile(join(directory,"effects"),"utf8"),"write\n");
  assert.equal(await readFile(join(directory,"provider-creates"),"utf8"),"create\n");
  assert.deepEqual(await readBody(store,response),responseBytes);
  assert.equal((await store.readLatestRun("root")).state.items.find(item=>item.ref.id==="native-item").payload.modelItems[0].evidence.acceptance.id,evidence.acceptance.id);
  assert.deepEqual((await store.readLatestRun("root")).control.controllerCheckpoints.find(([name])=>name==="native")[1].source,source);
  if(phase==="resume"){
    await rejected(store,"stale-purpose","task-interpreter",[jp("purpose",{fence:oldFence,acceptance})],/fenced/);
    await rejected(store,"duplicate-dispatch","file-executor",[jp("effect_dispatch",{fence,callId:call.modelCallRef.id})],/not_eligible|fenced/);
    await rejected(store,"changed-purpose","task-interpreter",[jp("purpose",{fence,acceptance:{...acceptance,deliveries:[]}})],/conflict|fenced/);
    await accept(store,"repeat-observation","adapter",[jp("record",{record,fence:null})]);
    await accept(store,"repeat-effect-confirm","file-executor",[jp("effect_confirmation",confirmation)]);
    await assert.rejects(()=>q({kind:"content_read",content:response,activityId:"child",offset:0,length:10}));
    await assert.rejects(()=>q({kind:"content_read",content:response,activityId:"native-activity",offset:0,length:65537}));
    const changed=activity.bindProtocolModelActivity({...original,conditions:{...original.conditions,authority:ref("new")}});
    await rejected(store,"changed-original","execution-coordinator",[jp("prepare",{activity:changed,input})],/conflict/);
    await rejected(store,"cross-child","task-consumer",[jp("received",{activityId:"native-activity",deliveryId:"effect-delivery",receipt:ref("bad"),recipient:{runId:"child",id:"task-consumer",purpose:"task"}})],/activity_scope/,"child");
    const child=fixture("child","child-activity"),childInput=await body(store,"child-input","independent Child input","child-activity");
    // Independent admitted scope for storage isolation; not an Agent delegation test.
    await admitComponentRun(store,directory,"child");
    await accept(store,"child-prepare","execution-coordinator",[jp("prepare",{activity:child.original,input:childInput})],"child");
    assert.equal(await q({kind:"acceptance",activityId:"child-activity"}),null);
    await accept(store,"cancel","execution-coordinator",[jp("control",{activityId:"native-activity",expectedRevision:0,cancelled:true})]);
    const lateSource={...source,record:{...source.record,revision:"2"}};
    await accept(store,"late-observation","adapter",[jp("record",{record:{...record,ref:lateSource.record,source:lateSource},fence:null})]);
    await rejected(store,"cancelled-acceptance","task-interpreter",[jp("purpose",{fence,acceptance})],/fenced/);
    const facts=await q({kind:"facts",runId:"root",after:0,limit:128});
    assert.equal(facts.filter(f=>f.kind==="purpose_accepted").length,1);assert.equal(facts.filter(f=>f.kind==="effect_confirmed").length,1);
    assert.equal(facts.filter(f=>f.kind==="delivery_received").length,2);assert(facts.some(f=>f.kind==="observation"&&f.value.ref.revision==="2"));
    assert(JSON.stringify(facts).length<50000,"Facts must not clone large native bodies");
    const offers=[],recorder={ref:(owner,kind,id,runId,revision="1")=>({sourceId:"fixture",datasetId:"fixture",owner,kind,id,runId,revision}),offer:r=>offers.push(r)};
    const inspector=new Inspector(recorder);await inspector.replay(async(after,limit)=>await q({kind:"facts",runId:"root",after,limit}));
    assert(offers.some(o=>o.payload.name==="model.purpose_evidence_accepted"));assert(offers.some(o=>o.payload.name==="execution.observation"));
    assert(!JSON.stringify(offers).includes("original native evidence"));
    if(scenario==="input"){
      const Database=require("better-sqlite3"),tampered=new Database(join(directory,"execution","execution.sqlite"));
      try{
        tampered.prepare("UPDATE protocol_effects SET id=? WHERE id=?").run("wrong-effect",call.modelCallRef.id);
        await assert.rejects(()=>q({kind:"effect",activityId:"native-activity",callId:"wrong-effect"}));
        tampered.prepare("UPDATE protocol_effects SET id=? WHERE id=?").run(call.modelCallRef.id,"wrong-effect");
        tampered.prepare("UPDATE protocol_deliveries SET id=? WHERE id=?").run("wrong-delivery","effect-delivery");
        await assert.rejects(()=>q({kind:"delivery",activityId:"native-activity",id:"wrong-delivery"}));
        tampered.prepare("UPDATE protocol_deliveries SET id=? WHERE id=?").run("effect-delivery","wrong-delivery");
        tampered.prepare("UPDATE protocol_acceptances SET activity_id=? WHERE activity_id=?").run("wrong-activity","native-activity");
        await assert.rejects(()=>q({kind:"acceptance",activityId:"wrong-activity"}));
        tampered.prepare("UPDATE protocol_acceptances SET activity_id=? WHERE activity_id=?").run("native-activity","wrong-activity");
      }finally{tampered.close();}
      const {InspectionRecorder}=await import("@agent-anything/inspection/recording");
      const {InspectionQueryService}=await import("@agent-anything/inspection/query");
      const root=join(directory,"inspection"),real=await InspectionRecorder.create({root,application:"protocol-journal-verification",name:"Protocol journal",
        policy:{revision:"1",enabled:true,definition:true,agent:true,provider:true,execution:true}}),reader=new InspectionQueryService(root);
      try{
        const adapter=new Inspector(real);adapter.bindContentReader(store.protocolJournal,store.contextSelections);
        await adapter.replay(async(after,limit)=>await q({kind:"facts",runId:"root",after,limit}));
        await real.flush();assert.equal(real.health().rejected,0);
        const subject=real.ref("runtime","event",evidence.acceptance.id,"root","1");
        const selection=(await reader.query({kind:"get_snapshot",sourceId:subject.sourceId,datasetId:subject.datasetId})).selection;
        const saved=(await reader.query({kind:"get_subject",...selection,subject})).records;
        assert.equal(saved.length,1);assert.equal(saved[0].payload.name,"model.purpose_evidence_accepted");
        const content=(await reader.query({kind:"get_content",...selection,contentId:saved[0].contents[0].id})).content;
        assert.equal(JSON.parse(content.text).scope.activityId,"native-activity");
        assert(saved[0].links.some(link=>link.kind==="binding"));
      }finally{await reader.close();await real.flush(true);}
    }
    const checkpointRecord={...record,ref:ref("native-release-basis"),kind:"native_checkpoint",source:null};
    const current=await q({kind:"state",activityId:"native-activity"});
    await rejected(store,"unowned-release-basis","adapter",[jp("record",{record:checkpointRecord,fence:null})],/acceptance_fenced/);
    await rejected(store,"stale-release-basis","adapter",[jp("record",{record:checkpointRecord,fence:oldFence})],/acceptance_fenced/);
    await accept(store,"native-release-basis","adapter",[jp("record",{record:checkpointRecord,fence:current.fence})]);
    await accept(store,"release-native-retention","adapter",[jp("release_retention",{fence:current.fence,nativeBasis:checkpointRecord.ref})]);
    assert(!(await store.listRetentionPins()).some(pin=>pin.ownerId==="root"&&pin.reason==="protocol_evidence"));
    assert((await store.listRetentionPins()).some(pin=>pin.ownerId==="child"&&pin.reason==="protocol_evidence"));
    assert.deepEqual(await q({kind:"acceptance",activityId:"native-activity"}),acceptance);
    assert(timings.some(t=>t.stage==="storage.worker.protocol_journal.content_read"));
    await writeFile(join(directory,"verification.json"),JSON.stringify({scenario,electron:process.versions.electron,generation:store.generation,providerCreates:1,effects:cancelledBeforeDispatch?0:1,acceptedPurposes:1,deliveries:2,nativeBytes:response.bytes,facts: facts.length,inspectorOffers:offers.length,observerFailureIsolated:observed.length>0,timing:timings.filter(t=>t.stage.startsWith("storage.worker.protocol_journal"))},null,2));
  }
}
function obligation(id,recipient,range,holdId){return {ref:ref(id),contract:{ref:ref(`${id}:contract`),owner:"delivery-owner",confirmation:"host-receipt"},recipient,range,holdId};}
async function publish(store,id,recipient,holds){
  const bytes=Buffer.from("material original bytes ".repeat(8)),range={materialId:"material",version:"1",coordinate:"bytes",start:0,end:bytes.length};
  const intent={id,instanceId:id,activityId:"capture",owner:"capture-owner",maximumBytes:4096,
    version:{ref:{materialId:"material",version:"1"},origin:{runId:recipient.runId,owner:"capture-owner",recordId:"original-result",revision:"1",occurredAt:"2026-11-09T00:00:00Z"},label:"Original material",format:"utf8",mediaType:"text/plain",bytes:bytes.length,digest:hash(bytes),capture:"complete",limitations:[]}};
  const grant={id:`${id}:grant`,instanceId:id,recipient,range,revision:0,allowed:true,basis:"host-permission"};
  await store.materialCustody.command({kind:"begin",intent});
  await store.materialCustody.command({kind:"append",id:`${id}:chunk`,intentId:id,offset:0,bytesBase64:bytes.toString("base64")});
  await store.materialCustody.command({kind:"complete",intentId:id});
  await accept(store,`${id}:publish`,"capture-owner",[{owner:"material_custody",kind:"publish",proposal:{intentId:id,holds:holds(range),grants:[grant]}}],recipient.runId);
  return {range,grant};
}
async function material(){
  const source=await open("sender"),receiver=await open("receiver");
  const sender={runId:"child",recipient:"child-delivery",purpose:"result"},parent={runId:"root",recipient:"parent-host",purpose:"result"};
  const hold=(id,instanceId,consumer,range,responsibility="delivery")=>({id,instanceId,consumer,range,responsibility,basis:id,releaseCondition:"original obligation discharged"});
  const {range}=await publish(source,"source-material",sender,r=>[hold("sender-hold","source-material",sender,r),hold("audit-hold","source-material",sender,r,"audit")]);
  const sourceObligation=obligation("source-obligation",sender,range,"sender-hold");
  await accept(source,"register-source","delivery-owner",[mp("register",{obligation:sourceObligation,handoff:null})],"child");
  const receiverPublication=await publish(receiver,"receiver-material",parent,r=>[hold("receiver-first","receiver-material",parent,{...r,end:50}),hold("receiver-rest","receiver-material",parent,{...r,start:50})]);
  const first=obligation("first",parent,{...range,end:50},"receiver-first"),rest=obligation("rest",parent,{...range,start:50},"receiver-rest");
  const sourceStore=await source.materialDeliveries.query({kind:"store_identity"}),receiverStore=await receiver.materialDeliveries.query({kind:"store_identity"});
  const handoff={id:"transfer-first",sourceStore,source:sourceObligation,receiverStore,successor:first};
  await accept(receiver,"receiver-accept-first","delivery-owner",[mp("register",{obligation:first,handoff})]);
  if(scenario!=="material-source")await crash(scenario);
  if(phase==="seed"&&scenario==="material-source"){
    const interrupted={...receiver,materialDeliveries:receiver.materialDeliveries,materialCustody:receiver.materialCustody,
      sharedAcceptance:{...receiver.sharedAcceptance,accept:async proposal=>{if(proposal.parts.some(p=>p.kind==="acknowledge_transfer")){app.exit(73);await new Promise(()=>{});}return receiver.sharedAcceptance.accept(proposal);}}};
    await completeMaterialDeliveryHandoff(source,interrupted,"transfer-first",ref("discharge-first"));
  }
  if(scenario==="material-receiver"){
    const guard=await receiver.materialDeliveries.query({kind:"guard",ref:first.ref});
    await rejected(receiver,"inbound-pin","delivery-owner",[mp("disposition",{ref:ref("premature"),expectedObligation:first,expectedSelectionRevision:guard.revision,
      disposition:{kind:"fulfilled",obligation:first.ref,contract:first.contract.ref,receipt:ref("unavailable")}})],/protected/);
    await receiver.materialCustody.command({kind:"grant",expectedRevision:0,grant:{...receiverPublication.grant,revision:1,allowed:false,basis:"revoked"}});
    await assert.rejects(()=>completeMaterialDeliveryHandoff(source,receiver,"transfer-first",ref("discharge-first")));
    assert.equal(await source.materialDeliveries.query({kind:"accepted",ref:ref("discharge-first")}),null);
    await receiver.materialCustody.command({kind:"grant",expectedRevision:1,grant:{...receiverPublication.grant,revision:2,basis:"restored"}});
  }
  const firstResult=await completeMaterialDeliveryHandoff(source,receiver,"transfer-first",ref("discharge-first"));
  assert.equal(firstResult.discharged[0].range.end,50);
  assert.deepEqual(await completeMaterialDeliveryHandoff(source,receiver,"transfer-first",ref("discharge-first")),firstResult);
  await assert.rejects(()=>source.materialCustody.command({kind:"release",holdId:"sender-hold",basis:"too-early"}));
  if(scenario==="material-mixed"){
    await accept(source,"remaining-received","delivery-owner",[mp("evidence",{ref:ref("remaining-receipt"),obligation:sourceObligation.ref,kind:"receipt",basis:ref("host-retained-remainder")}),
      mp("disposition",{ref:ref("remaining-received"),expectedObligation:sourceObligation,expectedSelectionRevision:(await source.materialDeliveries.query({kind:"guard",ref:sourceObligation.ref})).revision,
        disposition:{kind:"fulfilled",obligation:sourceObligation.ref,contract:sourceObligation.contract.ref,receipt:ref("remaining-receipt")}})],"child");
    const remainder=await source.materialDeliveries.query({kind:"accepted",ref:ref("remaining-received")});assert.equal(remainder.discharged.length,1);assert.equal(remainder.discharged[0].range.start,50);
  }else{
    const restHandoff={id:"transfer-rest",sourceStore,source:sourceObligation,receiverStore,successor:rest};
    await accept(receiver,"receiver-accept-rest","delivery-owner",[mp("register",{obligation:rest,handoff:restHandoff})]);
    await completeMaterialDeliveryHandoff(source,receiver,"transfer-rest",ref("discharge-rest"));
  }
  await source.materialCustody.command({kind:"release",holdId:"sender-hold",basis:"transferred"});
  await assert.rejects(()=>source.materialCustody.command({kind:"seal",instanceId:"source-material",cleanupId:"cleanup"}));
  assert(await source.materialCustody.command({kind:"describe",holdId:"audit-hold",recipient:sender}));
  await source.materialCustody.command({kind:"release",holdId:"audit-hold",basis:"audit-finished"});
  await source.materialCustody.command({kind:"seal",instanceId:"source-material",cleanupId:"cleanup"});
  await source.materialCustody.command({kind:"delete",instanceId:"source-material",cleanupId:"cleanup",maximumChunks:32});
  assert.equal((await source.materialCustody.command({kind:"state",intentId:"source-material"})).state,"deleted");
  const receiverData=await receiver.materialCustody.command({kind:"read",access:{id:"read",holdId:first.holdId,recipient:parent,range:first.range},offset:0,length:50});assert.equal(receiverData.end,50);
  const guard=await receiver.materialDeliveries.query({kind:"guard",ref:first.ref});
  await accept(receiver,"unknown-inflight","delivery-owner",[mp("protect",{obligation:first.ref,expectedRevision:0,selected:false,inFlight:"unknown",basis:ref("send-may-have-started")})]);
  const fulfilled={ref:ref("first-fulfill"),expectedObligation:first,expectedSelectionRevision:guard.revision,disposition:{kind:"fulfilled",obligation:first.ref,contract:first.contract.ref,receipt:ref("host-received")}};
  await rejected(receiver,"stale-disposition","delivery-owner",[mp("disposition",fulfilled)],/protected/);
  await assert.rejects(()=>receiver.materialCustody.command({kind:"release",holdId:first.holdId,basis:"unknown-not-failed"}));
  await accept(receiver,"known-inflight","delivery-owner",[mp("protect",{obligation:first.ref,expectedRevision:1,selected:false,inFlight:"none",basis:ref("host-local-processing-confirmed")})]);
  fulfilled.expectedSelectionRevision=(await receiver.materialDeliveries.query({kind:"guard",ref:first.ref})).revision;
  await rejected(receiver,"missing-receipt","delivery-owner",[mp("disposition",fulfilled)],/evidence_missing/);
  const receiptPart=mp("evidence",{ref:ref("host-received"),obligation:first.ref,kind:"receipt",basis:ref("host-commit")});
  await rejected(receiver,"selection-race","delivery-owner",[receiptPart,mp("disposition",fulfilled),{owner:"context_selection",kind:"scope",proposal:{id:"new-scope",...parent,
    continuity:"original",owner:"delivery-owner",target:"model",authorityBasis:"authority"}}],/identity_conflict/);
  assert.equal(await receiver.contextSelections.command({kind:"lookup_scope",scopeId:"new-scope"}),null);
  await accept(receiver,"host-received","delivery-owner",[receiptPart,mp("disposition",fulfilled)]);
  await receiver.materialCustody.command({kind:"release",holdId:first.holdId,basis:"host-received"});
  if(scenario!=="material-mixed"){
  const nonDelivery={ref:ref("rest-nondelivery"),expectedObligation:rest,expectedSelectionRevision:(await receiver.materialDeliveries.query({kind:"guard",ref:rest.ref})).revision,
    disposition:{kind:"non_delivery",obligation:rest.ref,contract:rest.contract.ref,authorization:ref("cancel-authorized"),inFlightResolution:ref("no-inflight")}};
  await rejected(receiver,"non-delivery-without-authorization","delivery-owner",[mp("disposition",nonDelivery)],/evidence_missing/);
  await accept(receiver,"cancel-rest","delivery-owner",[mp("evidence",{ref:ref("cancel-authorized"),obligation:rest.ref,kind:"authorization",basis:ref("host-cancel")}),
    mp("evidence",{ref:ref("no-inflight"),obligation:rest.ref,kind:"in_flight_resolution",basis:ref("owner-confirmed")}),mp("disposition",nonDelivery)]);
  }
  await receiver.materialCustody.command({kind:"release",holdId:rest.holdId,basis:"cancel-rest"});
  assert((await receiver.materialDeliveryFacts("root",0,128)).some(f=>f.kind==="material_delivery.disposition"));
  await receiver.materialCustody.command({kind:"seal",instanceId:"receiver-material",cleanupId:"receiver-cleanup"});
  await receiver.materialCustody.command({kind:"delete",instanceId:"receiver-material",cleanupId:"receiver-cleanup",maximumChunks:32});
  assert.equal((await receiver.materialCustody.command({kind:"state",intentId:"receiver-material"})).state,"deleted");
  await writeFile(join(directory,"verification.json"),JSON.stringify({scenario,electron:process.versions.electron,generations:[source.generation,receiver.generation],partialTransfers:scenario==="material-mixed"?1:2,hostOnlyReceipt:true,unknownInFlightProtected:true,selectionRaceRejected:true,independentAuditRetained:true,sourceAndReceiverCleaned:true},null,2));
}
async function integrity(){
  const Database=require("better-sqlite3");
  const {PROTOCOL_EXECUTION_OBJECTS,PROTOCOL_RECONCILIATION_OBJECTS,PROTOCOL_ADMISSION_OBJECTS}=await import(pathToFileURL(join(__dirname,"../../dist/main/execution-storage/ProtocolExecutionDatabase.js")));
  const {MATERIAL_DELIVERY_OBJECTS,MATERIAL_DELIVERY_ACCESS_OBJECTS}=await import(pathToFileURL(join(__dirname,"../../dist/main/execution-storage/MaterialDeliveryDatabase.js")));
  const {PROTOCOL_EVIDENCE_OBJECTS,PROTOCOL_USAGE_ACCESS_OBJECTS}=await import(pathToFileURL(join(__dirname,"../../dist/main/execution-storage/ProtocolEvidenceDatabase.js")));
  const {CONTEXT_SELECTION_ACCESS_OBJECTS}=await import(pathToFileURL(join(__dirname,"../../dist/main/execution-storage/ContextSelectionDatabase.js")));
  const first=await open("migration");
  await first.contextPreparations.open({id:"old-work",runId:"old-run",basis:"old-basis",predecessor:null,deadlineAt:"2030-01-01T00:00:00Z",stages:["source"]});
  await first.contextPreparations.write("old-work","source",{text:"retained old work"});await first.close();
  const path=join(directory,"migration","execution.sqlite"),legacy=new Database(path);
  const added=[...PROTOCOL_USAGE_ACCESS_OBJECTS,...MATERIAL_DELIVERY_ACCESS_OBJECTS,...CONTEXT_SELECTION_ACCESS_OBJECTS,
    "activity_reconsiderations_run",...PROTOCOL_ADMISSION_OBJECTS,"execution_admission_fences","protocol_effects_activity","protocol_deliveries_activity",
    "run_tree_members_root",...PROTOCOL_RECONCILIATION_OBJECTS,...PROTOCOL_EVIDENCE_OBJECTS,...PROTOCOL_EXECUTION_OBJECTS,...MATERIAL_DELIVERY_OBJECTS];
  const objects=added.map(name=>{const object=legacy.prepare("SELECT type FROM sqlite_schema WHERE name=?").get(name);
    assert(object&&["index","table"].includes(object.type));return {name,type:object.type};});
  for(const object of objects.sort((a,b)=>a.type.localeCompare(b.type)))legacy.exec(`DROP ${object.type} ${object.name}`);
  legacy.prepare("UPDATE store SET version=43").run();const old=legacy.prepare("SELECT * FROM execution_content ORDER BY id").all();
  const originalIndex=legacy.prepare("SELECT sql FROM sqlite_schema WHERE name='action_records_owner'").get().sql;
  legacy.exec("DROP INDEX action_records_owner; CREATE INDEX action_records_owner ON action_records(action_id,sequence)");legacy.close();
  await assert.rejects(()=>open("migration"));
  const rejectedSchema=new Database(path);assert.equal(rejectedSchema.prepare("SELECT version FROM store").get().version,43);
  assert.equal(rejectedSchema.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name LIKE 'protocol_%'").get().n,0);
  rejectedSchema.exec("DROP INDEX action_records_owner");rejectedSchema.exec(originalIndex);rejectedSchema.close();
  await assert.rejects(()=>HelarcExecutionStore.open(join(directory,"migration"),pathToFileURL(join(__dirname,"protocol-migration-failure.mjs"))));
  const rolledBack=new Database(path);assert.equal(rolledBack.prepare("SELECT version FROM store").get().version,43);
  assert.equal(rolledBack.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name LIKE 'protocol_%'").get().n,0);
  assert.deepEqual(rolledBack.prepare("SELECT * FROM execution_content ORDER BY id").all(),old);rolledBack.close();
  const migrated=await open("migration");assert.deepEqual(await migrated.contextPreparations.read("old-work","source"),{text:"retained old work"});await migrated.close();
  const checked=new Database(path);assert.equal(checked.prepare("SELECT version FROM store").get().version,50);assert.deepEqual(checked.prepare("SELECT * FROM execution_content ORDER BY id").all(),old);checked.close();
  const malformed=await open("malformed-schema");await malformed.close();
  const wrongSchema=new Database(join(directory,"malformed-schema","execution.sqlite"));
  wrongSchema.exec("DROP INDEX protocol_facts_run; CREATE INDEX protocol_facts_run ON protocol_facts(activity_id,sequence)");wrongSchema.close();
  await assert.rejects(()=>open("malformed-schema"));
  const store=await open("corruption");const content=await body(store,"body","original");
  await admitComponentRun(store,directory);
  const corrupt=new Database(join(directory,"corruption","execution.sqlite"));corrupt.prepare("UPDATE protocol_content_chunks SET bytes=? WHERE id=?").run(Buffer.from("changed!"),content.id);
  await assert.rejects(()=>readBody(store,content));corrupt.close();
  const incomplete={id:"incomplete",activityId:"native-activity",bytes:7,digest:hash("missing")};await store.protocolJournal.command({kind:"content_begin",content:incomplete});
  await rejected(store,"incomplete-prepare","execution-coordinator",[jp("prepare",{activity:fixture().original,input:incomplete})],/content_incomplete/);
  const before=await store.protocolJournal.command({kind:"state",activityId:"native-activity"});assert.equal(before,null);
  await assert.rejects(()=>store.protocolJournal.command({kind:"content_complete",content:incomplete}));
  const valid=await body(store,"valid-body","valid-input"),lock=new Database(join(directory,"corruption","execution.sqlite"));
  lock.exec("BEGIN IMMEDIATE");
  const proposal={id:"locked-save",scope:"root",actor:"execution-coordinator",parts:[jp("prepare",{activity:fixture().original,input:valid})]};
  await assert.rejects(()=>store.sharedAcceptance.accept(proposal));lock.exec("ROLLBACK");lock.close();
  assert.equal(await store.sharedAcceptance.query(proposal.id),null);assert.equal(await store.protocolJournal.command({kind:"state",activityId:"native-activity"}),null);
  assert.equal((await store.sharedAcceptance.accept(proposal)).outcome,"accepted");
  const atomic=fixture("root","atomic"),atomicInput=await body(store,"atomic-input","atomic","atomic");
  await rejected(store,"atomic-reject","execution-coordinator",[jp("prepare",{activity:atomic.original,input:atomicInput}),jp("control",{activityId:"atomic",expectedRevision:99,cancelled:true})],/control_conflict/);
  assert.equal(await store.protocolJournal.command({kind:"state",activityId:"atomic"}),null);
  assert(!(await store.protocolJournal.command({kind:"facts",runId:"root",after:0,limit:128})).some(f=>f.activityId==="atomic"));
  await writeFile(join(directory,"verification.json"),JSON.stringify({scenario,electron:process.versions.electron,migration:"43-to-50",migrationFailureRolledBack:true,oldContentUnchanged:true,schemaMismatchRejected:true,corruptionRejected:true,incompleteContentNotAccepted:true,failedWriteRecovered:true,atomicRejectionRolledBack:true},null,2));
}
async function main(){
  await app.whenReady();
  ({HelarcExecutionStore}=await import(pathToFileURL(join(__dirname,"../../dist/main/execution-storage/HelarcExecutionStore.js"))));
  protocol=await import("@agent-anything/model-interaction/protocol");model=await import("@agent-anything/model-interaction");activity=await import("@agent-anything/agent-runtime/model-access");
  ({completeMaterialDeliveryHandoff}=await import(pathToFileURL(join(__dirname,"../../dist/main/execution-storage/MaterialDeliveryHandoff.js"))));
  ({ProtocolJournalInspectionAdapter:Inspector}=await import(pathToFileURL(join(__dirname,"../../dist/main/inspection/ProtocolJournalInspectionAdapter.js"))));
  if(scenario==="timeout-isolation"){
    const store=await open("execution");await body(store,"armed","owned by the expiring fixture");
    await writeFile(join(directory,"armed.json"),JSON.stringify({pid:process.pid,generation:store.generation}));
    while(!existsSync(join(directory,"release-late")))await new Promise(done=>setTimeout(done,20));
    await appendFile(join(directory,"late-effect"),"late\n");await body(store,"late","released after timeout");
    throw new Error("expired fixture processed a late callback");
  }
  if(scenario==="timeout"){await open("execution");await writeFile(join(directory,"started"),"ready");await new Promise(()=>{});}
  else if(scenario.startsWith("material"))await material();
  else if(scenario==="integrity")await integrity();
  else await journal();
  for(const store of stores)await store.close();app.exit(0);
}
main().catch(async error=>{await writeFile(join(directory,"failure.txt"),error.stack??String(error));for(const store of stores)await store.close().catch(()=>{});app.exit(1);});
