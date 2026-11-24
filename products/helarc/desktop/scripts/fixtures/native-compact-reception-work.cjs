const assert=require("node:assert/strict"),{join}=require("node:path"),{pathToFileURL}=require("node:url");

module.exports=async function({store,h,input,history,method,activity,at,phase,checkpoint}){
  const {modelInputValueDigest:digest}=await import("@agent-anything/model-interaction/input");
  const {ActivityChangeWait,activityFactSourceId}=await import("@agent-anything/agent-runtime/activity");
  const {inputSupplyRegistration,inputSupplyResponsibility,InputSupplyExitWork}=await import("@agent-anything/agent-runtime/context-representation");
  const {HelarcActivityService}=await import(pathToFileURL(join(__dirname,"../../dist/main/context/HelarcActivityService.js")));
  const {registry}=method,scope=input.scope,a=c=>store.activityHandoffs.command(c),signal=AbortSignal.timeout(30000);
  const authorize=async path=>{assert.equal(path.intent.permissionBasis,scope.authorityBasis);return {kind:"allowed"};};
  const accept=async p=>{const r=await store.sharedAcceptance.accept(p);assert.equal(r.outcome,"accepted",JSON.stringify(r));return r;};
  const intent=id=>({id,runId:scope.runId,permissionBasis:scope.authorityBasis,resourceScope:id,
    maximumStages:3,maximumAttempts:3,maximumConcurrent:1,deadlineAt:"2030-01-01T00:00:00Z"});
  const schedule=(id,paths)=>({id:id+":schedule",workId:id,runId:scope.runId,scopeId:"compact-tree",owner:scope.owner,allowedPathIds:paths,
    decisionId:id,policyRevision:"1",reason:"necessary",delayImpact:"Check the original complete native input",timing:{kind:"unknown"},
    resources:[{poolId:"compact-local",capability:"material-read",units:1}]});
  await a({kind:"bind_resource_pool",pool:{id:"compact-local",capacity:1,revision:"1",authority:"fixture"}});
  const ports={activities:store.activityHandoffs,materials:store.materialCustody,representations:store.representations,authorize,now:()=>at};
  const demand=new h.HelarcNativeInputDemandWork({...ports,selections:store.contextSelections},registry);
  const original=new h.HelarcNativeOriginalInputWork(ports,registry);
  const receiver=new h.HelarcResponsesCompactReceptionWork({...ports,original,methods:method.methods,journal:store.protocolJournal},registry);
  const exit=new InputSupplyExitWork({activities:store.activityHandoffs,responsibilities:store.inputSupplies,receivers:receiver});
  const demandId="compact-task-input-demand",originalId="compact-original-preparation",receiverId="compact-durable-reception";
  const inputNeed={kind:"native_input_need",revision:"1",needId:demandId+":need",scope,
    consumer:{activityId:input.activityId,protocol:activity.composition.composition.protocol,compositionDigest:activity.composition.digest}};
  const prepared={format:"helarc.native-prepared-task.v1",binding:{scope:activity.scope,protocol:activity.composition.composition.protocol},previous:null,
    sourceDigest:input.original.manifest.selection.boundary,wire:input.original.wire,workingSources:input.original.workingSources,results:[],delivery:[]};
  const demandPlan={revision:"1",activity,prepared,inputNeed,capacity:input.capacity};
  let failure;
  const service=new HelarcActivityService({store,purposes:registry,purposeIds:[demand,original,receiver].map(w=>w.purpose.contract.ref.id),rediscoveryMs:10,
    reconsideration:(owner,sub)=>sub.id===receiverId+":reception"?receiver:sub.id===inputNeed.needId+":supply"?{prepare:async()=>{
      const current=await demand.result(demandId);
      if(current.kind!=="ready")return {decision:{owner:scope.owner,kind:"explicit_reception_pending",id:sub.id,revision:"1"},
        participants:[],close:false,observeSources:[activityFactSourceId("progress",demandId)]};
      const returned=await a({kind:"read_stage",requestId:current.need.stage.id});
      return exit.prepare({need:current.need,consumer:current.path,sourceStage:current.source},sub.id,returned,signal);
    }}:null,
    report:async cycle=>{failure??=cycle.runs.flatMap(r=>r.result.failures)[0]?.error??cycle.failures[0]?.error??cycle.reconsiderations.flatMap(r=>r.result.failures)[0]?.error;}});
  const wake=new ActivityChangeWait({subscribe:listener=>store.onActivityChange(listener)},signal);
  const until=async check=>{for(;;){signal.throwIfAborted();service.assertAvailable();if(failure)throw failure;
    const version=wake.version,result=await check();if(result)return result;service.wake();await wake.wait(version,100);}};
  try{
    if(!await a({kind:"read_path",pathId:demandId}))await accept({id:demandId+":start",scope:scope.runId,actor:scope.owner,
      parts:demand.prepareSubmission(intent(demandId),demandPlan)});
    const demanded=await until(async()=>{const r=await demand.result(demandId);return r.kind==="needed"?r:null;});
    assert.deepEqual(demanded.plan,demandPlan);
    const inputSupply={needId:inputNeed.needId,runId:scope.runId,owner:scope.owner,consumerPathId:demandId,
      source:{stageId:demanded.source.request.id,requestDigest:digest(demanded.source.request)},configuration:activity.composition.composition.configuration.configuration};
    const supplySchedule=schedule("compact-original-supply",[originalId]);
    const historyReader={runId:scope.runId,recipient:scope.recipient,purpose:scope.purpose};
    const historyHold={...history.hold,id:history.hold.id+":task",consumer:historyReader,basis:inputSupply.needId};
    await accept({id:historyHold.id+":admit",scope:scope.runId,actor:scope.owner,parts:[{owner:"material_custody",kind:"admit_access",proposal:{
      source:{id:historyHold.id+":source",holdId:history.hold.id,recipient:history.hold.consumer,range:history.hold.range},hold:historyHold,
      grant:{id:historyHold.id+":grant",instanceId:historyHold.instanceId,recipient:historyReader,range:historyHold.range,revision:0,allowed:true,basis:scope.authorityBasis}}}]});
    const originalPlan={revision:"1",inputSupply,scope,history:{record:history.record,hold:historyHold},inputId:"compact-original-option",selectionId:"compact-original-selection",
      continuity:input.original.continuity,maximumReadBytes:input.maximumReadBytes};
    const parts=original.prepareSubmission({...intent(originalId),scheduledWorkId:supplySchedule.workId},originalPlan);
    if(!await a({kind:"read_path",pathId:originalId}))await accept({id:originalId+":start",scope:scope.runId,actor:scope.owner,parts:[
      {owner:"activity",kind:"scheduling_acceptance",proposal:{kind:"schedule_work",intent:supplySchedule,expectedRevision:0}},...parts,
      inputSupplyRegistration({binding:inputSupply,scheduling:supplySchedule,expectedRevision:0,expectedConsumerControlRevision:0,
        responsibilities:[inputSupplyResponsibility("input_preparation",parts[0].proposal)]})]});
    const retained=await until(async()=>{const r=await original.result(originalId);return r.kind==="prepared"?r:null;});
    const sourcePath=await a({kind:"read_path",pathId:method.pathId}),workId=receiverId+":work";
    const recipe={...input,original:retained.value.selected};
    const plan={revision:"1",input:recipe,inputSupply,inputNeed,originalInputPathId:originalId,
      binding:{revision:"1",pathId:receiverId,workId,scope,boundary:recipe.original.manifest.selection.boundary,
        requirementsDigest:digest(h.helarcNativeInputRequirements(recipe.original.workingSources.groups)),
        members:[{pathId:method.pathId,workId:sourcePath.intent.scheduledWorkId,requestDigest:digest(method.result.request)}]}};
    const opening=receiver.prepareSubmission({...intent(receiverId),scheduledWorkId:workId},plan);
    if(!await a({kind:"read_path",pathId:receiverId}))await accept({id:receiverId+":start",scope:scope.runId,actor:scope.owner,parts:[
      {owner:"activity",kind:"scheduling_acceptance",proposal:{kind:"schedule_work",intent:schedule(workId,[receiverId]),expectedRevision:0}},...opening,
      inputSupplyRegistration({binding:inputSupply,scheduling:supplySchedule,expectedRevision:1,expectedConsumerControlRevision:0,
        responsibilities:[inputSupplyResponsibility("method_reception",opening[0].proposal)]})]});
    assert.deepEqual(await receiver.readPlan(receiverId),plan);
    const received=await until(async()=>{const r=await receiver.result(receiverId);if(r.kind==="gap")throw new Error(JSON.stringify(r.outcome));return r.kind==="checked"?r:null;});
    const stage=await a({kind:"read_stage",requestId:receiverId+":stage:1"});assert.equal(stage.attemptCount,1);assert.equal(retained.stage.attemptCount,1);
    if(phase==="receive")await checkpoint({lostAcknowledgement:"durable native reception",receiverId,receipt:stage.receipt.id,originalInputReceipt:retained.stage.receipt.id});
    const adoption=await receiver.prepareAdoption(receiverId,{id:"adopted-input:accept",need:demanded.need,expectedSelectionId:null,expectedControlRevision:0},signal);
    // Reject atomically; receiving work cannot make the original native cancellation guard optional.
    const invalid=structuredClone(adoption);invalid.id+="-invalid-native-control";
    invalid.parts.find(p=>p.kind==="require_accepted_result").proposal.controlRevision++;
    assert.equal((await store.sharedAcceptance.accept(invalid)).outcome,"rejected");
    await assert.rejects(()=>store.contextSelections.command({kind:"binding",inputId:input.inputId,checkCurrentControl:false}),/input_binding_missing/);
    const receipt=await accept(adoption);
    await until(async()=>{const r=await demand.result(demandId);return r.kind==="ready"?r:null;});
    await until(async()=>{const exited=await store.inputSupplies.query({kind:"exit",needId:inputNeed.needId});return exited?.status==="closed"&&
      (await a({kind:"read_schedule",workId})).settlementConfirmed&&(await a({kind:"read_schedule",workId:supplySchedule.workId})).settlementConfirmed;});
    assert.equal((await a({kind:"read_path",pathId:method.pathId})).cancelled,false);
    assert.equal((await a({kind:"read_schedule",workId:sourcePath.intent.scheduledWorkId})).settlementConfirmed,false);
    assert.deepEqual((await store.contextSelections.command({kind:"binding",inputId:input.inputId,checkCurrentControl:true})).input.exactInput,received.value.selected);
    return {reception:received.value,adoption,receipt,verification:{receiverId,receipt:stage.receipt.id,attempts:stage.attemptCount,
      originalInputReceipt:retained.stage.receipt.id,cleanupClosed:true,independentProducerOpen:true}};
  }finally{wake.close();await service.close();}
};
