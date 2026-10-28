const {app}=require("electron");
const assert=require("node:assert/strict");
const {join}=require("node:path");
const {pathToFileURL}=require("node:url");
const {writeFile}=require("node:fs/promises");
const {createHash}=require("node:crypto");
const [directory,phase,endpoint]=process.argv.slice(2);
app.setPath("userData",join(directory,"electron"));app.disableHardwareAcceleration();
let store,inspection,queries;
async function main(){
  await app.whenReady();
  const {HelarcExecutionStore}=await import(pathToFileURL(join(__dirname,"../../dist/main/execution-storage/HelarcExecutionStore.js")));
  const {ActivityPurposeRegistry,ActivityHandoffProcessor}=await import("@agent-anything/agent-runtime/activity");
  const {CustodyMaterialAccess}=await import("@agent-anything/context/custody");
  const {modelInputValueDigest:digest}=await import("@agent-anything/model-interaction/input");
  store=await HelarcExecutionStore.open(join(directory,"execution"));
  const c=command=>store.materialCustody.command(command),s=command=>store.contextSelections.command(command),a=command=>store.activityHandoffs.command(command);
  const accept=async(id,parts,scope="parent",actor="parent-agent")=>{
    const receipt=await store.sharedAcceptance.accept({id,parts,scope,actor});assert.equal(receipt.outcome,"accepted",JSON.stringify(receipt));return receipt;
  };
  const recipient={runId:"parent",recipient:"parent-agent",purpose:"task"};
  const sibling={runId:"sibling",recipient:"sibling-agent",purpose:"task"};
  const body=Buffer.from("retained child evidence\n".repeat(3000)+"TARGET: 7391\n");
  const range={materialId:"child-report",version:"1",coordinate:"bytes",start:0,end:body.length};
  const intent={id:"capture",instanceId:"physical:1",activityId:"child-output",owner:"child-agent",maximumBytes:body.length,
    version:{ref:{materialId:range.materialId,version:range.version},origin:{runId:"child",owner:"child-agent",recordId:"child-result",revision:"1",occurredAt:"2026-10-28T00:00:00Z"},
      label:"Child evidence",format:"utf8",mediaType:"text/plain",bytes:body.length,digest:`sha256:${createHash("sha256").update(body).digest("hex")}`,capture:"complete",limitations:[]}};
  const hold=(id,consumer,responsibility,basis)=>({id,instanceId:intent.instanceId,consumer,responsibility,range,basis,releaseCondition:"explicit responsibility settlement"});
  const preparation=hold("preparation",recipient,"preparation","candidate");
  const details=hold("details",recipient,"detail","delivery");
  const siblingHold=hold("sibling-hold",sibling,"detail","sibling-delivery");
  const deliveryHold=hold("delivery-hold",recipient,"delivery","delivery");
  const grant=(id,who)=>({id,instanceId:intent.instanceId,recipient:who,range,revision:0,allowed:true,basis:"explicit host delegation"});
  const exactInput=process.env.ACTIVITY_LIVE_MODEL?{model:process.env.ACTIVITY_LIVE_MODEL,think:false,stream:false,messages:[{role:"user",content:"Child reported TARGET: 7391. Reply with the single word READY."}]}:{childResult:"TARGET: 7391"};
  const registry=new ActivityPurposeRegistry();
  const purpose=registry.register({ref:{id:"parent-task",revision:"1"},inputOwner:"parent-agent",executionOwner:"model-access",interpretationOwner:"parent-agent",acceptanceOwner:"parent-agent",recoveryOwner:"parent-agent",stageKinds:["model"],capabilities:["model-access"],continuationKinds:[]},{
    authorize:async(_path,stage)=>{const binding=await s({kind:"binding",inputId:"input:1",checkCurrentControl:true});assert.deepEqual(stage.request.input,binding.input.exactInput);},
    execute:async(_path,stage,attempt,signal)=>{
      assert.equal(phase,"accept-and-expand","Saved Provider response must not be sent again");
      await s({kind:"sent",inputId:"input:1",attemptId:attempt.id});
      const response=await fetch(endpoint,{method:"POST",body:JSON.stringify(stage.request.input),signal});assert(response.ok);
      return {id:"raw:1",attemptId:attempt.id,completeness:"complete",outcome:"returned",value:await response.json(),usage:{calls:1},recordedAt:new Date().toISOString()};
    },
    reconcile:async()=>{throw new Error("Complete saved raw response was lost");},
    interpret:async(_path,stage,_signal,acceptance)=>({progress:{delivered:stage.result.id},next:[],participants:[
      {owner:"context_delivery",kind:"accept",proposal:{inputId:"input:1",responseId:stage.result.id,detailHolds:[details.id]}},
      {owner:"representation",kind:"record",proposal:{ref:{id:"accepted-evidence",revision:"1"},owner:recipient.recipient,runId:recipient.runId,purpose:"task",target:"fixture",form:"original",body:range,
        inputs:[{role:"source",material:range,representation:null}],declaredCoverage:[range],details:[range],holds:[details.id],requirements:[],losses:[],restorations:[],
        method:{id:"controlled-evidence-registration",revision:"1",activityId:stage.request.pathId,rawResultId:stage.result.id,acceptanceId:acceptance.id}}},
    ]}),
  });
  const processor=new ActivityHandoffProcessor(store.activityHandoffs,registry,store.activityJournal.executor,()=>new Date().toISOString());
  const signal=new AbortController().signal;
  if(phase==="save-raw"){
    await c({kind:"begin",intent});await c({kind:"append",id:"first-chunk",intentId:intent.id,offset:0,bytesBase64:body.subarray(0,12000).toString("base64")});
    assert.equal((await c({kind:"state",intentId:intent.id})).bytes,12000);app.exit(73);return;
  }
  if(phase==="accept-and-expand"){
    assert.equal((await c({kind:"state",intentId:intent.id})).bytes,12000);
    await c({kind:"append",id:"first-chunk",intentId:intent.id,offset:0,bytesBase64:body.subarray(0,12000).toString("base64")});
    await c({kind:"append",id:"last-chunk",intentId:intent.id,offset:12000,bytesBase64:body.subarray(12000).toString("base64")});await c({kind:"complete",intentId:intent.id});
    await accept("publish",[{owner:"material_custody",kind:"publish",proposal:{intentId:intent.id,holds:[preparation,details,siblingHold,deliveryHold],grants:[grant("parent-grant",recipient),grant("sibling-grant",sibling)]}}],"child","child-agent");
    await accept("delivery",[{owner:"context_delivery",kind:"publish",proposal:{id:"delivery",sourceRunId:"child",sourceId:"child-result",recipient,material:range,instanceId:intent.instanceId,holdId:deliveryHold.id,detailHoldId:details.id}}]);
    const representation={ref:{id:"representation",revision:"1"},owner:recipient.recipient,runId:recipient.runId,purpose:"task",target:"fixture",form:"original",body:range,
      inputs:[{role:"source",material:range,representation:null}],declaredCoverage:[range],details:[range],holds:[preparation.id],requirements:[],losses:[],restorations:[],method:null};
    await store.representations.command({kind:"record",record:representation});
    await store.representations.command({kind:"judge",judgment:{id:"combination",owner:recipient.recipient,kind:"combination",subjects:[representation.ref],inputs:[range],purpose:"task",target:"fixture",methodRevision:"fixture:1",dependencies:{inputDigest:digest(exactInput)},coverage:[range],conclusion:"supported",limitations:["controlled preservation test, not semantic evaluation"],basis:"independent fixture facts"}});
    await s({kind:"scope",scope:{...recipient,id:"scope",continuity:"conversation",owner:recipient.recipient,target:"fixture",authorityBasis:"host:1"}});
    await a({kind:"open_path",intent:{id:"path",runId:"parent",owner:"parent-agent",purpose,permissionBasis:"host:1",resourceScope:"path",maximumStages:1,maximumAttempts:1,maximumConcurrent:1,deadlineAt:"2030-01-01T00:00:00Z"}});
    const selectionHold=hold("selection-hold",recipient,"selection","selection:1"),inputHold=hold("input-hold",recipient,"input","input:1");
    await accept("select",[
      {owner:"material_custody",kind:"holds",proposal:{acquire:[selectionHold,inputHold],release:[],basis:"select"}},
      {owner:"context_selection",kind:"selection_input",proposal:{id:"select",scopeId:"scope",expectedSelectionId:null,expectedControlRevision:0,selection:{id:"selection:1",representations:[representation.ref],judgmentIds:["combination"],holds:[selectionHold]},
        input:{id:"input:1",activityId:"path",stageRequestId:"model-request",scopeId:"scope",selectionId:"selection:1",exactInput,target:"fixture",deliveries:[{id:"delivery",position:"user:0"}],holds:[inputHold],combinationJudgmentId:"combination"},releaseHolds:[]}},
      {owner:"context_delivery",kind:"select",proposal:{inputId:"input:1",scopeId:"scope",deliveryIds:["delivery"]}},
      {owner:"activity",kind:"stage_submission",proposal:{id:"model-request",pathId:"path",stageKind:"model",input:exactInput,dependencies:[],capabilities:["model-access"]}},
    ]);
    await processor.drain("parent",signal);await processor.drain("parent",signal);
    assert.equal((await a({kind:"read_stage",requestId:"model-request"})).status,"raw_result");app.exit(73);return;
  }
  assert.deepEqual((await s({kind:"binding",inputId:"input:1",checkCurrentControl:true})).input.exactInput,exactInput);
  await processor.drain("parent",signal);
  assert.equal((await a({kind:"read_path",pathId:"path"})).progressRevision,1);
  assert.deepEqual(await a({kind:"pending",runId:"parent",after:0,limit:32}),[]);
  await s({kind:"retire_input",inputId:"input:1",basis:"response accepted"});
  await c({kind:"release",holdId:"input-hold",basis:"response accepted"});await c({kind:"release",holdId:deliveryHold.id,basis:"delivered"});
  await s({kind:"withdraw",scopeId:"scope",expectedSelectionId:"selection:1",expectedControlRevision:0,basis:"task ended"});
  await c({kind:"release",holdId:"selection-hold",basis:"task ended"});await c({kind:"release",holdId:preparation.id,basis:"preparation ended"});
  const publicAccess=store.createCustodyMaterialAccess(recipient);
  const reference=new CustodyMaterialAccess(store.materialCustody,recipient).reference(await c({kind:"describe",holdId:details.id,recipient}));
  const matches=await publicAccess.search("parent",{query:"TARGET",references:[reference]},signal,"search-detail");
  assert.equal(matches.matches.length,1);assert.equal(matches.exhausted,true);
  const page=await publicAccess.read("parent",{reference,offset:matches.matches[0].byteStart},signal,"read-detail");assert.equal(page.text,"TARGET: 7391\n");
  await c({kind:"grant",grant:{...grant("sibling-grant",sibling),revision:1,allowed:false},expectedRevision:0});
  await assert.rejects(new CustodyMaterialAccess(store.materialCustody,sibling).read("sibling",{reference},signal,"denied"));
  assert.equal((await publicAccess.read("parent",{reference,offset:page.byteStart},signal,"still-readable")).text,page.text);
  const {HelarcInspection}=await import(pathToFileURL(join(__dirname,"../../dist/main/inspection/HelarcInspection.js")));
  const {InspectionQueryService}=await import("@agent-anything/inspection/query");
  inspection=await HelarcInspection.create(join(directory,"inspection-settings.json"),join(directory,"inspection"));
  for(const run of ["child","parent","sibling"]){await inspection.activityObserver.replay(run,store.activityHandoffs);await inspection.contextFoundationObserver.replay(run,store.contextFoundationFacts.bind(store));}
  await inspection.recorder.flush();assert.equal(inspection.recorder.health().rejected,0);
  queries=new InspectionQueryService(join(directory,"inspection"));
  const selected=(await queries.query({kind:"get_snapshot",sourceId:inspection.recorder.source.sourceId,datasetId:inspection.recorder.manifest.datasetId})).selection;
  const records=await queries.query({...selected,kind:"list_records",recordKind:"event"});
  assert(records.records.some(record=>record.payload.name==="context_delivery.accepted"));
  assert(records.records.some(record=>record.payload.name==="material_custody.content_completed"));
  assert(records.records.some(record=>record.links.some(link=>link.kind==="delivers"&&link.to.id==="input:1")));
  assert(records.records.some(record=>record.links.some(link=>link.kind==="transforms"&&link.from.id==="raw:1")));
  await writeFile(join(directory,"verification.json"),JSON.stringify({electron:process.versions.electron,storageGeneration:store.generation,
    bytes:body.length,recovery:"partial custody, atomic selection, complete raw response",providerCalls:1,progressRevision:1,detailsReadableAfterDelivery:true,independentRecipientRevocation:true,inspectionEvents:records.records.length},null,2));
  await queries.close();queries=null;await inspection.close();inspection=null;await store.close();store=null;app.exit(0);
}
main().catch(async error=>{console.error(error);if(queries)await queries.close().catch(()=>{});if(inspection)await inspection.close().catch(()=>{});if(store)await store.close().catch(()=>{});app.exit(1);});
