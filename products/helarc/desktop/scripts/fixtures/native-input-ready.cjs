const assert=require("node:assert/strict");

module.exports=async function({app,store,processor,native,judgment,inputNeed,phase,signal,accept,h,reception,originalDemand,adoption}){
  const {nativeInputReady,nativeInputSupplyReturnPart}=await import("@agent-anything/agent-runtime/context-representation");
  const {modelInputValueDigest:digest}=await import("@agent-anything/model-interaction/input");
  const a=c=>store.activityHandoffs.command(c),scope=native.value.scope;
  const need=originalDemand?.need??{id:inputNeed.needId,supplier:scope.owner,origin:{requestId:native.origin.stageId,receiptId:native.origin.receiptId},
    stage:{id:`${native.origin.pathId}:ready`,pathId:native.origin.pathId,stageKind:"ready",capabilities:[],dependencies:[]},
    unavailableStage:{id:`${native.origin.pathId}:unavailable`,pathId:native.origin.pathId,stageKind:"unavailable",capabilities:[],dependencies:[]}};
  if(!await a({kind:"read_input_need",id:need.id}))await accept({id:`${need.id}:accepted`,scope:scope.runId,actor:scope.owner,
    parts:[{owner:"activity",kind:"input_need",proposal:need}]});
  else assert.deepEqual(await a({kind:"read_input_need",id:need.id}),need);
  const returned={needId:need.id,origin:need.origin,inputId:native.value.inputId,inputDigest:digest(native.value.exactInput),readyStageId:need.stage.id};
  const selectionAcceptance=adoption??h.helarcNativeAccountReceptionAcceptance({id:`${need.id}:returned`,reception,judgment,expectedSelectionId:null,expectedControlRevision:0,
    activityId:inputNeed.consumer.activityId});
  const proposal=selectionAcceptance.parts.find(p=>p.owner==="context_selection"&&p.kind==="selection_input").proposal;
  const parts=adoption?.parts??[{owner:"context_selection",kind:"scope",proposal:scope},
    ...selectionAcceptance.parts,
    nativeInputSupplyReturnPart(returned),{owner:"activity",kind:"stage_submission",proposal:{...need.stage,input:nativeInputReady(returned)}}];
  const accepted=await accept({id:proposal.id,scope:scope.runId,actor:scope.owner,parts});
  assert.equal(accepted.outcome,"accepted");
  if(phase==="readiness"){app.exit(73);await new Promise(()=>{});}
  let ready;
  for(let n=0;n<4;n++){
    ready=await a({kind:"read_stage",requestId:need.stage.id});if(ready.status==="accepted")break;
    const cycle=await processor.drain(scope.runId,signal);assert.deepEqual(cycle.failures,[]);
  }
  assert.equal(ready.status,"accepted");assert.deepEqual(ready.request.input,nativeInputReady(returned));
  const selection=await store.contextSelections.command({kind:"binding",inputId:proposal.input.id,checkCurrentControl:true});
  assert.deepEqual(selection.input,proposal.input);assert.equal(selection.acceptanceId,proposal.id);
  assert.equal(await a({kind:"read_path",pathId:inputNeed.consumer.activityId}),null);
  assert.equal(await store.protocolJournal.command({kind:"state",activityId:inputNeed.consumer.activityId}),null);
  assert(!Object.hasOwn(ready.request.input,"exactInput"));
  return {needId:need.id,inputId:proposal.input.id,returnAcceptance:accepted.id,readyReceipt:ready.receipt.id,
    originalSelectionRestored:true,nativeDispatches:0,syntheticModelStages:0};
};
