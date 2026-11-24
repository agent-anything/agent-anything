const assert=require("node:assert/strict");
module.exports=async function({app,store,registry,processor,methods,producers,published,phase,protocolName,composition,signal,now,authorize,intent,accept,h,publications,originalItems,originalSources,schedule}){
  const {modelInputValueDigest:digest}=await import("@agent-anything/model-interaction/input");
  const {ActivityReconsiderationProcessor}=await import("@agent-anything/agent-runtime/activity");
  const {inputSupplyRegistration,inputSupplyResponsibility,InputSupplyExitWork,decideContextPreparation}=await import("@agent-anything/agent-runtime/context-representation");
  const a=c=>store.activityHandoffs.command(c);
  const scope={id:"native-combination",runId:"root",recipient:"agent",purpose:"task",owner:"context-representation",continuity:"task",target:"original:1",authorityBasis:"original-disclosure"};
  const {receptionInput,historyCapture}=await require("./native-account-reception.cjs")({store,publications,processor,producers,published,originalItems,originalSources,scope,inputId:"unused",composition,protocolName,intent,accept,signal,now});
  const requirements=producers.flatMap(p=>p.supply.request.requirements),supply=producers[0].supply;
  const demandId="original-native-input-demand";
  const inputNeed={kind:"native_input_need",revision:"1",needId:demandId+":need",scope,
    consumer:{activityId:"original-native-task",protocol:composition.composition.protocol,compositionDigest:composition.digest}};
  const demand=new h.HelarcNativeInputDemandWork({activities:store.activityHandoffs,selections:store.contextSelections,authorize,now},registry);
  const demandPlan={revision:"1",activity:receptionInput.activity,prepared:receptionInput.prepared,inputNeed,capacity:receptionInput.capacity};
  if(!await a({kind:"read_path",pathId:demandId}))await accept({id:demandId+":start",scope:"root",actor:scope.owner,
    parts:demand.prepareSubmission(intent(demandId),demandPlan)});
  let originalDemand;
  for(let n=0;n<4;n++){
    originalDemand=await demand.result(demandId);if(originalDemand.kind!=="pending")break;
    assert.deepEqual((await processor.drain("root",signal)).failures,[]);
  }
  assert(["needed","ready"].includes(originalDemand.kind));assert.deepEqual(originalDemand.plan,demandPlan);
  const inputSupply={needId:inputNeed.needId,runId:"root",owner:scope.owner,consumerPathId:demandId,
    source:{stageId:originalDemand.source.request.id,requestDigest:digest(originalDemand.source.request)},configuration:{id:"original",revision:"1"}};
  const originalWork=new h.HelarcNativeOriginalInputWork({activities:store.activityHandoffs,materials:store.materialCustody,representations:store.representations,authorize,now},registry);
  const originalId="original-native-preparation",supplySchedule=schedule("original-supply-work",[originalId]);
  const originalParts=originalWork.prepareSubmission({...intent(originalId),scheduledWorkId:supplySchedule.workId},{revision:"1",inputSupply,scope,history:receptionInput.history,
    inputId:"original-native-option",selectionId:"original-native-selection",continuity:receptionInput.continuity,maximumReadBytes:1000000});
  if(!await a({kind:"read_path",pathId:originalId}))await accept({id:originalId+":start",scope:"root",actor:scope.owner,parts:[
    {owner:"activity",kind:"scheduling_acceptance",proposal:{kind:"schedule_work",intent:supplySchedule,expectedRevision:0}},...originalParts,
    inputSupplyRegistration({binding:inputSupply,scheduling:supplySchedule,expectedRevision:0,expectedConsumerControlRevision:0,
      responsibilities:[inputSupplyResponsibility("input_preparation",originalParts[0].proposal)]})]});
  let originalResult;
  for(let n=0;n<4;n++){
    originalResult=await originalWork.result(originalId);if(originalResult.kind==="prepared")break;
    assert.deepEqual((await processor.drain("root",signal)).failures,[]);
  }
  assert.equal(originalResult.kind,"prepared");const originalOption=originalResult.value;
  assert.deepEqual(JSON.parse(originalOption.selected.wire.body),JSON.parse(receptionInput.prepared.wire.body));assert(originalOption.proposal);
  const current=originalOption.readiness;
  const unchangedDecision=decideContextPreparation({scope,boundary:receptionInput.prepared.sourceDigest,requirementsDigest:digest(requirements),
    current,currentRejectedInputId:null,alternatives:[],pressure:[],options:producers.map(p=>p.supply.option),inFlight:[],explorationHistory:[],optionalInFlight:0,autoPrepare:false,consumerActive:true});
  assert.equal(unchangedDecision.foreground.kind,"continue");assert.equal(unchangedDecision.foreground.preparedInputId,current.inputId);
  await assert.rejects(store.contextSelections.command({kind:"binding",inputId:current.inputId,checkCurrentControl:true}),/input_binding_missing/);
  const receiver=new h.HelarcNativeAccountReceptionWork({activities:store.activityHandoffs,methods,materials:store.materialCustody,representations:store.representations,authorize,now},registry);
  const catalog=new h.HelarcNativeAccountReceptionCatalog({activities:store.activityHandoffs,work:receiver});
  const {inputId:ignoredInput,selectionId:ignoredSelection,judgmentId:ignoredJudgment,...input}=receptionInput;
  const basis={input,inputNeed,inputSupply,checkConditions:{capacity:supply.request.capacity,bounds:supply.request.bounds}};
  const pathId=catalog.id(basis),inputId=pathId+":input",stageId=pathId+":stage:1",checkId=pathId+":combination-check",workId=pathId+":work";
  const review=new ActivityReconsiderationProcessor(store.activityHandoffs,store.sharedAcceptance,
    (_owner,subscription)=>subscription.id===pathId+":reception"?receiver:null);
  const started=await catalog.prepareStart(basis,{intent:{...intent(pathId),scheduledWorkId:workId},scheduling:schedule(workId,[pathId,checkId])},signal);
  if(started.participants.length){
    const opening=started.participants.find(p=>p.kind==="path_opening").proposal;
    await accept({id:pathId+":start",scope:"root",actor:scope.owner,parts:[...started.participants,
      inputSupplyRegistration({binding:inputSupply,scheduling:supplySchedule,expectedRevision:1,expectedConsumerControlRevision:0,
        responsibilities:[inputSupplyResponsibility("method_reception",opening)]})]});
  }
  const restored=await catalog.inspect(basis,signal);assert.notEqual(restored.kind,"not_started");
  assert.deepEqual(restored.plan.input.members,input.members.map(m=>({methodPathId:m.methodPathId,candidateId:m.candidateId,
    supply:{scope:m.supply.scope,request:m.supply.request}})).sort((a,b)=>a.methodPathId.localeCompare(b.methodPathId)),
    "Original receiver members survive restart independently of bounded enumeration");
  if(phase==="combination"){
    const original=store.sharedAcceptance.accept.bind(store.sharedAcceptance);
    store.sharedAcceptance.accept=async p=>{const r=await original(p);
      if(r.outcome==="accepted"&&p.parts.some(x=>x.owner==="protocol_execution"&&x.kind==="purpose")){app.exit(73);await new Promise(()=>{});}return r;};
  }
  let received;
  for(let i=0;i<128;i++){
    received=await receiver.result(pathId);if(received.kind==="gap")throw new Error(JSON.stringify(received.outcome));if(received.kind==="checked")break;
    const cycle=await processor.drain("root",signal);assert.deepEqual(cycle.failures,[]);
    const reconsidered=await review.scan("root",signal);assert.deepEqual(reconsidered.failures,[]);assert.deepEqual(reconsidered.rejected,[]);
  }
  assert.equal(received.kind,"checked");
  const {reception,judgment,native}=received,value=reception.preparation;
  const selected=JSON.parse(reception.selected.wire.body),items=selected.input??selected.messages;
  assert.equal(items.length,1+producers.length);assert.deepEqual(items[0],originalItems[0]);assert.equal(reception.selected.workingSources.groups[1].derivedFrom.length,2);
  const stage=await a({kind:"read_stage",requestId:stageId}),checked=await methods.result(checkId);
  assert.equal(checked.kind,"ready");assert.equal(checked.progress.modelCalls,1);
  assert.equal(judgment.dependencies.inputDigest,digest(value.exactInput));assert.equal(judgment.dependencies.capacityDigest,digest(value.capacity));
  assert.equal(judgment.dependencies.nativePreparationReceipt,stage.receipt.id);
  for(const id of [stageId,stage.result.id,stage.receipt.id])assert(judgment.evidenceSources.some(s=>s.id===id));
  const outcome=await a({kind:"read_stage",requestId:pathId+":assess"});assert.equal(outcome.status,"accepted");
  const adoption=await catalog.prepareAdoption(basis,{id:`${inputNeed.needId}:returned`,need:originalDemand.need,expectedSelectionId:null,expectedControlRevision:0},signal);
  const readiness=await require("./native-input-ready.cjs")({app,store,processor,native,judgment,inputNeed,phase,signal,accept,h,reception,originalDemand,adoption});
  assert.equal((await demand.result(demandId)).kind,"ready");
  const replayed=await receiver.result(pathId);assert.equal(replayed.kind,"checked");assert.deepEqual(replayed.outcome,received.outcome);
  const exit=new InputSupplyExitWork({activities:store.activityHandoffs,responsibilities:store.inputSupplies,receivers:receiver});
  const exitReview=new ActivityReconsiderationProcessor(store.activityHandoffs,store.sharedAcceptance,(_owner,subscription)=>
    subscription.id===pathId+":reception"?receiver:subscription.id===inputNeed.needId+":supply"?{prepare:async()=>{
      const current=await demand.result(demandId);assert.equal(current.kind,"ready");
      const returned=await a({kind:"read_stage",requestId:current.need.stage.id});
      return exit.prepare({need:current.need,consumer:current.path,sourceStage:current.source},subscription.id,returned,signal);
    }}:null);
  let closed;
  for(let i=0;i<16;i++){
    const cycle=await processor.drain("root",signal);assert.deepEqual(cycle.failures,[]);
    const reviewed=await exitReview.scan("root",signal);assert.deepEqual(reviewed.failures,[]);assert.deepEqual(reviewed.rejected,[]);
    closed=await a({kind:"read_reconsideration_state",subscriptionId:pathId+":reception"});
    if(closed.closed&&(await store.inputSupplies.query({kind:"exit",needId:inputNeed.needId}))?.status==="closed")break;
  }
  assert.equal(closed.closed,true);assert.equal((await a({kind:"read_schedule",workId})).settlementConfirmed,true);
  assert.equal((await store.inputSupplies.query({kind:"exit",needId:inputNeed.needId})).status,"closed");
  assert.equal((await a({kind:"read_schedule",workId:supplySchedule.workId})).settlementConfirmed,true);
  const originalRestored=await a({kind:"read_stage",requestId:originalId+":stage:1"});
  assert.equal(originalRestored.receipt.id,originalResult.stage.receipt.id);
  const retained=await store.contextSelections.command({kind:"binding",inputId,checkCurrentControl:true});
  assert.deepEqual(retained.input.exactInput,reception.selected,"Reception closure cannot retire the adopted task input");
  return {stageId,checkId,judgment:judgment.id,completeNativeInputChecked:true,readiness,historyCapture,
    unchangedOption:{nativeBodyIdentical:true,policyDecision:unchangedDecision.foreground.kind,implicitlyAdopted:false,
      preparationReceipt:originalResult.stage.receipt.id,readBytes:originalResult.stage.result.usage.readBytes,supplyWorkSettled:true},
    reception:{pathId,originalPlanRestored:true,realizationReceipt:stage.receipt.id,outcomeReceipt:outcome.receipt.id,kind:received.outcome.result.kind,
      cleanupClosed:true,adoptedInputRetained:true,producerCount:producers.length,originalDemandPath:demandId,originalDemandReceipt:originalDemand.source.receipt.id,sharedSupplyExitClosed:true}};
};
