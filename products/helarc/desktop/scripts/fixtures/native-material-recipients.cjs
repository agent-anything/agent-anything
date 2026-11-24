const {app}=require("electron");
const assert=require("node:assert/strict"),{join}=require("node:path"),{pathToFileURL}=require("node:url"),{createHash}=require("node:crypto");
const {writeFile}=require("node:fs/promises");
const [directory,phase,fanoutText="3"]=process.argv.slice(2),fanout=Number(fanoutText);
assert(Number.isSafeInteger(fanout)&&fanout>1&&fanout<=32);
app.setPath("userData",join(directory,"recipient-electron"));app.disableHardwareAcceleration();
const stores=[];
async function main(){
  const load=p=>import(pathToFileURL(join(__dirname,"../../dist/main",p)));
  const {HelarcExecutionStore}=await load("execution-storage/HelarcExecutionStore.js"),timings=[];
  const {completeMaterialDeliveryHandoff}=await load("execution-storage/MaterialDeliveryHandoff.js");
  const {modelInputValueDigest:digest}=await import("@agent-anything/model-interaction/input");
  const {materialViewReference}=await import("@agent-anything/context/custody");
  const {HELARC_CONTROLLER_CAPABILITY}=await import("@agent-anything/helarc/controller");
  const open=async path=>{const s=await HelarcExecutionStore.open(path,undefined,undefined,undefined,{record(){},performance(e){
    if(e.kind==="finished"&&e.stage==="storage.worker.command")timings.push(e);}});stores.push(s);return s;};
  const source=await open(join(directory,"execution")),receiver=await open(join(directory,"recipient-execution"));
  const ref=id=>({id,revision:"1"}),mp=(kind,proposal)=>({owner:"material_delivery",kind,proposal});
  const accept=async(s,id,scope,actor,parts)=>{const r=await s.sharedAcceptance.accept({id,scope,actor,parts});assert.equal(r.outcome,"accepted",JSON.stringify(r));return r;};
  const root=await source.readLatestRun("root"),taskRecipient={runId:"root",recipient:root.state.activeAgent.id,purpose:HELARC_CONTROLLER_CAPABILITY};
  const result=root.state.items.find(i=>i.payload.kind==="model_call_settlement"&&i.payload.result.content?.output?.report?.status==="retained_material");assert(result);
  const originalRef=result.payload.result.content.output.report.reference;
  const original=await source.materialCustody.command({kind:"resolve_reference",reference:originalRef,recipient:taskRecipient});
  const childId=original.version.origin.runId;assert.notEqual(childId,"root");
  const child=await source.readLatestRun(childId);assert.equal(child.state.status,"completed");
  const sibling=root.control.descendantTransfers.find(t=>t.childRunId!==childId);assert(sibling);
  const siblingRun=await source.readLatestRun(sibling.childRunId);
  const sourceAccess={id:"actual-child-source",holdId:original.hold.id,recipient:taskRecipient,range:original.hold.range};
  if(phase==="receiver-accepted")await require("./native-material-boundaries.cjs")({store:source,directory,origin:original.version.origin});
  const host={runId:"root",recipient:"test-host",purpose:"retained-report"};
  const sourceHold={...original.hold,id:"actual-child-host-delivery",consumer:host,responsibility:"delivery",basis:"explicit host delivery",releaseCondition:"host contract or accepted transfer"};
  const obligation=(id,recipient,hold)=>({ref:ref(id),contract:{ref:ref(`${id}:contract`),owner:"delivery-owner",confirmation:"host-retained-content"},recipient,range:hold.range,holdId:hold.id});
  const pending=obligation("actual-child-host",host,sourceHold);
  if(phase==="receiver-accepted"){
    const none={runId:sibling.childRunId,recipient:siblingRun.state.activeAgent.id,purpose:HELARC_CONTROLLER_CAPABILITY};
    await assert.rejects(()=>source.materialCustody.command({kind:"resolve_reference",reference:originalRef,recipient:none}));
    for(let i=0;i<fanout;i++){
      const recipient=i===0?none:{...none,purpose:`independent-reader-${i}`};
      const hold={...original.hold,id:`forward-${i}:hold`,consumer:recipient,responsibility:"detail",basis:`forward-${i}`};
      const grant={id:`forward-${i}:grant`,instanceId:hold.instanceId,recipient,range:hold.range,revision:0,allowed:true,basis:"explicit onward authorization"};
      const proposal={id:`forward-${i}`,scope:recipient.runId,actor:"host",parts:[{owner:"material_custody",kind:"admit_access",proposal:{source:sourceAccess,hold,grant}}]};
      const first=await source.sharedAcceptance.accept(proposal);assert.equal(first.outcome,"accepted");assert.deepEqual(await source.sharedAcceptance.accept(proposal),first);
      const view=materialViewReference(hold.range,original.version);
      const resolved=await source.materialCustody.command({kind:"resolve_reference",reference:view,recipient});assert.equal(resolved.version.digest,original.version.digest);
      await source.materialCustody.command({kind:"grant",expectedRevision:0,grant:{...grant,revision:1,allowed:false,basis:"explicit withdrawal"}});
      await assert.rejects(()=>source.materialCustody.command({kind:"resolve_reference",reference:view,recipient}));
    }
    await accept(source,"actual-host-admit","root","host",[{owner:"material_custody",kind:"admit_access",proposal:{source:sourceAccess,hold:sourceHold,
      grant:{id:"actual-host-grant",instanceId:sourceHold.instanceId,recipient:host,range:sourceHold.range,revision:0,allowed:true,basis:"explicit host delivery"}}}]);
    await accept(source,"actual-host-register","root","delivery-owner",[mp("register",{obligation:pending,handoff:null})]);
    const intent={id:"received-child",instanceId:"received-child",activityId:"child-transfer",owner:"delivery-owner",maximumBytes:original.version.bytes,version:original.version};
    await receiver.materialCustody.command({kind:"begin",intent});
    const hash=createHash("sha256");let offset=0;
    while(offset<original.version.bytes){
      const page=await source.materialCustody.command({kind:"read",access:sourceAccess,offset,length:Math.min(65536,original.version.bytes-offset)});
      const bytes=Buffer.from(page.text);assert.equal(bytes.length,page.end-page.start);hash.update(bytes);
      await receiver.materialCustody.command({kind:"append",id:`received-child:${offset}`,intentId:intent.id,offset,bytesBase64:bytes.toString("base64")});offset=page.end;
    }
    assert.equal(`sha256:${hash.digest("hex")}`,original.version.digest);
    await receiver.materialCustody.command({kind:"complete",intentId:intent.id});
    const split=Math.floor(original.version.bytes/2),holds=[{...sourceHold,id:"received-first",instanceId:intent.instanceId,range:{...sourceHold.range,end:split}},
      {...sourceHold,id:"received-rest",instanceId:intent.instanceId,range:{...sourceHold.range,start:split}}];
    await accept(receiver,"received-child-publish",childId,"delivery-owner",[{owner:"material_custody",kind:"publish",proposal:{intentId:intent.id,holds,
      grants:[{id:"receiver-grant",instanceId:intent.instanceId,recipient:host,range:sourceHold.range,revision:0,allowed:true,basis:"host accepts same immutable child version"}]}}]);
    const sourceStore=await source.materialDeliveries.query({kind:"store_identity"}),receiverStore=await receiver.materialDeliveries.query({kind:"store_identity"});
    for(const [i,hold]of holds.entries()){
      const successor=obligation(`received-${i}`,host,hold),handoff={id:`actual-transfer-${i}`,sourceStore,source:pending,receiverStore,successor};
      await accept(receiver,`actual-receive-${i}`,"root","delivery-owner",[mp("register",{obligation:successor,handoff})]);
    }
    await writeFile(join(directory,"recipient-seed.json"),JSON.stringify({childId,origin:original.version.origin,digest:original.version.digest,bytes:original.version.bytes,fanout}));
    app.exit(73);return;
  }
  for(let i=0;i<fanout;i++){
    const recipient={runId:sibling.childRunId,recipient:siblingRun.state.activeAgent.id,purpose:i===0?HELARC_CONTROLLER_CAPABILITY:`independent-reader-${i}`};
    await assert.rejects(()=>source.materialCustody.command({kind:"resolve_reference",reference:originalRef,recipient}));
  }
  if(phase==="source-accepted"){
    await assert.rejects(()=>source.materialCustody.command({kind:"release",holdId:sourceHold.id,basis:"unconfirmed receiver"}));
    const interrupted={materialDeliveries:receiver.materialDeliveries,materialCustody:receiver.materialCustody,sharedAcceptance:{
      query:receiver.sharedAcceptance.query.bind(receiver.sharedAcceptance),accept:async p=>{if(p.parts.some(x=>x.kind==="acknowledge_transfer")){app.exit(73);return new Promise(()=>{});}return receiver.sharedAcceptance.accept(p);}}};
    await completeMaterialDeliveryHandoff(source,interrupted,"actual-transfer-0",ref("actual-dispose-0"));
    assert.fail("Expected interruption after source acceptance");
  }
  assert.equal(phase,"finish");
  for(let i=0;i<2;i++){
    const first=await completeMaterialDeliveryHandoff(source,receiver,`actual-transfer-${i}`,ref(`actual-dispose-${i}`));
    assert.deepEqual(await completeMaterialDeliveryHandoff(source,receiver,`actual-transfer-${i}`,ref(`actual-dispose-${i}`)),first);
    if(i===0)await assert.rejects(()=>source.materialCustody.command({kind:"release",holdId:sourceHold.id,basis:"only first half transferred"}));
  }
  await source.materialCustody.command({kind:"release",holdId:sourceHold.id,basis:"both halves transferred"});
  await assert.rejects(()=>source.materialCustody.command({kind:"seal",instanceId:sourceHold.instanceId,cleanupId:"premature"}));
  const before=timings.length;
  for(let i=0;i<2;i++){
    const state=await receiver.materialDeliveries.query({kind:"obligation",ref:ref(`received-${i}`)}),o=state.obligation;
    assert(state.handoffAcknowledged);assert.equal(state.discharged.length,0);
    const guard=await receiver.materialDeliveries.query({kind:"guard",ref:o.ref});
    await accept(receiver,`received-ack-${i}`,"root","delivery-owner",[mp("evidence",{ref:ref(`receipt-${i}`),obligation:o.ref,kind:"receipt",basis:ref("host-retained-original-bytes")}),
      mp("disposition",{ref:ref(`fulfilled-${i}`),expectedObligation:o,expectedSelectionRevision:guard.revision,disposition:{kind:"fulfilled",obligation:o.ref,contract:o.contract.ref,receipt:ref(`receipt-${i}`)}})]);
    await receiver.materialCustody.command({kind:"release",holdId:o.holdId,basis:"host receipt"});
  }
  await receiver.readRunTreeMembers("root");
  assert(timings.slice(before).every(t=>(t.counters?.["custody.chunkReads"]??0)===0),"Disposition must not reread material bodies");
  await receiver.materialCustody.command({kind:"seal",instanceId:"received-child",cleanupId:"receiver-done"});
  let deleted;do{deleted=await receiver.materialCustody.command({kind:"delete",instanceId:"received-child",cleanupId:"receiver-done",maximumChunks:4});}while(deleted.state!=="deleted");
  const remaining=await source.materialCustody.command({kind:"read",access:sourceAccess,offset:0,length:128});assert(remaining.text.includes("8422"));
  await source.readRunTreeMembers("root");
  assert(timings.some(t=>(t.counters?.["custody.chunkReads"]??0)>0&& (t.counters?.["custody.bytesRead"]??0)>0),"Actual detail reads must produce positive custody counters");
  const {ProtocolJournalInspectionAdapter}=await load("inspection/ProtocolJournalInspectionAdapter.js"),offers=[];
  const inspector=new ProtocolJournalInspectionAdapter({ref:(owner,kind,id,runId,revision="1")=>({sourceId:"fixture",datasetId:"fixture",owner,kind,id,runId,revision}),offer:r=>offers.push(r)});
  await inspector.replay((after,limit)=>source.materialDeliveryFacts("root",after,limit));
  await inspector.replay((after,limit)=>receiver.materialDeliveryFacts("root",after,limit));
  assert(offers.some(o=>o.payload.name==="execution.material_delivery.disposition"));
  assert.equal(digest((await source.readLatestRun("root")).state.items),digest(root.state.items));
  await writeFile(join(directory,"recipient-verification.json"),JSON.stringify({fanout,sourceChild:childId,bytes:original.version.bytes,
    generations:[source.generation,receiver.generation],sourceIdentityPreserved:true,revocationsPreserved:true,partialTransfers:2,hostOnlyReceipts:2,
    repeatedCalls:0,remainingSourceReadable:true,receiverDeleted:true,dispositionBodyReads:0,inspectorRecords:offers.length},null,2));
}
app.whenReady().then(main).then(async()=>{for(const s of stores)await s.close();app.exit(0);}).catch(async e=>{
  const {captureExecutionError}=await import(pathToFileURL(join(__dirname,"../../dist/main/diagnostics/ExecutionErrorDetails.js")));
  await writeFile(join(directory,`recipient-failure-${phase}.txt`),JSON.stringify(captureExecutionError(e),null,2));for(const s of stores)await s.close().catch(()=>{});app.exit(1);
});
