const assert=require("node:assert/strict");
const {readFile}=require("node:fs/promises");
const {join}=require("node:path");

exports.verifyAdoption=async function({app,store,provider,registry,work,processor,signal,now,directory,phase,candidate,body,target,template,lineage}) {
  const {ContextInputPreparationWork,PreparedInputExecution}=await import("@agent-anything/agent-runtime/context-representation");
  const {composeModelInput,organizeOriginalInput,modelInputValueDigest:digest}=await import("@agent-anything/model-interaction/input");
  const a=command=>store.activityHandoffs.command(command),c=command=>store.materialCustody.command(command);
  const accept=async proposal=>{const result=await store.sharedAcceptance.accept(proposal);assert.equal(result.outcome,"accepted",JSON.stringify(result));};
  const allFacts=async()=>{const facts=[];for(let after=0;;){const page=await store.contextFoundationFacts("parent",after,256);facts.push(...page);if(page.length<256)return facts;after=page.at(-1).sequence;}};
  const recipient={runId:"parent",recipient:"parent-agent",purpose:"task"};
  const base=JSON.parse(await readFile(join(directory,"request.json"),"utf8"));
  const intent=id=>({id,runId:"parent",permissionBasis:"isolated-method-permission",resourceScope:id,maximumStages:128,maximumAttempts:128,maximumConcurrent:1,deadlineAt:"2030-01-01T00:00:00.000Z"});
  const preparation=new ContextInputPreparationWork(store.activityHandoffs,registry,{provider,materials:store.materialCustody,now,authorize:async path=>assert.equal(path.intent.permissionBasis,"isolated-method-permission")});
  const purpose=registry.register({ref:{id:"parent-after-method",revision:"1"},inputOwner:"context-representation",executionOwner:"model-access",interpretationOwner:"parent-agent",acceptanceOwner:"context-representation",recoveryOwner:"parent-agent",stageKinds:["model"],capabilities:["model-access"],continuationKinds:[]},
    new PreparedInputExecution({provider,selections:store.contextSelections,inputId:()=>"parent-input",now,authorize:async()=>{},interpret:async(_path,stage)=>{
      assert.equal(stage.result.value.kind,"succeeded",JSON.stringify(stage.result));
      return {progress:{responseId:stage.result.id},next:[],participants:[{owner:"context_delivery",kind:"accept",proposal:{inputId:"parent-input",responseId:stage.result.id,detailHolds:["parent-detail-0","parent-detail-1"]}}]};
    }}));
  if(phase==="adopt") {
    const descriptor=await c({kind:"describe",holdId:candidate.access.holdId,recipient:candidate.access.recipient});
    const representation=await store.representations.command({kind:"read",ref:candidate.representation});
    const dependencies=[];
    for(const holdId of representation.holds)dependencies.push(await c({kind:"describe",holdId,recipient:candidate.access.recipient}));
    await c({kind:"grant",grant:{id:"parent-candidate-grant",instanceId:descriptor.hold.instanceId,recipient,range:candidate.access.range,revision:0,allowed:true,basis:"explicit parent result access"},expectedRevision:null});
    await c({kind:"hold",hold:{id:"parent-candidate-preparation",instanceId:descriptor.hold.instanceId,consumer:recipient,responsibility:"preparation",range:candidate.access.range,basis:"parent preparation",releaseCondition:"explicit release"}});
    const source={owner:"context-representation",kind:"representation",id:candidate.representation.id,revision:candidate.representation.revision};
    const taskLineage={...lineage,auxiliary:null};
    for(const key of ["instructionBinding","agent","instructions","instructionRelease","instructionResolver","instructionContent","activeContext","contextProjection","projectionManifest","toolSelection","toolExposureContent","toolExposureBasis","toolExposureProof","toolGuidance","controllerControlGuidance","callableDefinitions","protocol","policy"])taskLineage[key]={owner:"isolated-host",kind:"record",id:key,revision:"1"};
    const composition=composeModelInput({id:"parent-final-input",providerId:provider.descriptor.id,model:provider.modelContext.target.model,interaction:{kind:"text_generation"},lineage:taskLineage,composedAt:"2026-10-29T00:00:00.000Z",sections:[
      {id:"parent-objective",source:{owner:"user",kind:"task",id:"parent-task",revision:"1"},kind:"task",role:"user",necessity:"mandatory",content:{kind:"text",text:"Based on the Child reports, state the radius for images 5 and 6, the alpha rule, the TARGET value, and whether the version is verified. Do not process images."}},
      {id:"child-reports",source,kind:"evidence",role:"user",necessity:"mandatory",content:{kind:"text",text:`Derived representation of Child 0 and Child 1 reports; exact original reports remain accessible.\n${body}`}}]});
    const taskTemplate={...template,requestId:composition.id,purpose:"task",composition,instructions:composition.instructions,messages:composition.messages,interaction:composition.interaction};
    const demand=organizeOriginalInput({demand:{id:"parent-demand",runId:"parent",recipient:"parent-agent",purpose:"task",targetRevision:target,historyBoundary:"both-child-reports-v1",deliveryIds:base.deliveryIds,dependencies:{candidate:digest(candidate.representation)},maximumCombinations:4,maximumExternalMeasurements:0,maximumReadBytes:100000},composition,
      groups:[{id:"objective",owner:"parent-agent",revision:"1",sectionIds:["parent-objective"],duties:["objective"],deliveryIds:[]},{id:"reports",owner:"context-representation",revision:"1",sectionIds:["child-reports"],duties:["evidence","new_information"],deliveryIds:base.deliveryIds}]});
    await preparation.submit(intent("parent-preparation"),{kind:"context_input_preparation",demand,template:taskTemplate,limits:[],reservations:[],policy:{...base.capacity.policy,purpose:"task"},allowExternalMeasurement:false,deliveryMode:"buffered",localMeasurements:[],sharedCapacity:null,materialAccesses:[{...candidate.access,id:"parent-candidate-access",recipient,holdId:"parent-candidate-preparation"}]});
    for(let i=0;i<30&&(await preparation.result("parent-preparation")).kind==="pending";i++)await processor.drain("parent",signal);
    const result=await preparation.result("parent-preparation");assert.equal(result.kind,"prepared",JSON.stringify(result));const prepared=result.prepared;
    assert.equal(prepared.request.instructions.content.length,0);
    const scope={...recipient,id:"parent-input-scope",continuity:"parent-original-thread",owner:"context-representation",target,authorityBasis:"isolated-method-permission"};
    await store.contextSelections.command({kind:"scope",scope});
    const request={...base,method:"check_combination",combinationDigest:digest(prepared),combination:{prepared,scope,subjects:[candidate.representation]},sources:[...base.sources,{alias:"candidate",role:"candidate",access:candidate.access,representation:candidate.representation,order:2,label:"Candidate for Parent",originalRole:"derived_representation",indivisibleGroup:"candidate"}],combine:"keep",dependencyAccesses:dependencies.map(d=>({id:`combination-dependency:${d.hold.id}`,holdId:d.hold.id,recipient:candidate.access.recipient,range:d.hold.range}))};
    // The optional fixture stresses generation with a narrower delegated transport
    // allowance; whole-input checking still obeys the same actual Provider target.
    // Without this option the narrow whole-evidence check must report its gap.
    if(process.env.ACTIVITY_WHOLE_CHECK_TARGET)request.capacity={...base.capacity,limits:base.capacity.limits.filter(l=>l.id!=="layered-fixture-transport")};
    await work.submit(intent("combination-check"),request);
    for(let i=0;i<200&&(await work.result("combination-check")).kind==="pending";i++)await processor.drain("parent",signal);
    const check=await work.result("combination-check");assert.equal(check.kind,"ready",JSON.stringify(check));
    const facts=await allFacts();
    assert(!facts.some(f=>f.owner==="context_delivery"&&f.kind==="accepted"),"auxiliary check consumed Parent delivery");
    const ranges=[...new Map([{range:candidate.access.range,instanceId:descriptor.hold.instanceId},...dependencies.map(d=>({range:d.hold.range,instanceId:d.hold.instanceId}))].map(r=>[digest(r),r])).values()];
    for(let i=0;i<ranges.length;i++)await c({kind:"grant",grant:{id:`parent-dependency-grant-${i}`,instanceId:ranges[i].instanceId,recipient,range:ranges[i].range,revision:0,allowed:true,basis:"explicit retained result dependency transfer"},expectedRevision:null});
    const holds=responsibility=>ranges.map((r,i)=>({id:`parent-${responsibility}-${i}`,instanceId:r.instanceId,consumer:recipient,responsibility,range:r.range,basis:responsibility==="selection"?"parent-selection":"parent-input",releaseCondition:"parent response settled"}));
    for(let i=0;i<base.sources.length;i++)await c({kind:"hold",hold:{id:`parent-detail-${i}`,instanceId:`source-${i}`,consumer:recipient,responsibility:"detail",range:base.sources[i].access.range,basis:"parent task detail",releaseCondition:"explicit parent release"}});
    await a({kind:"open_path",intent:{...intent("parent-model"),owner:purpose.contract.acceptanceOwner,purpose}});
    const proposal=await work.prepareAdoption("combination-check",{id:"parent-adoption",scope,expectedSelectionId:null,expectedControlRevision:0,selection:{id:"parent-selection",representations:[candidate.representation],judgmentIds:check.progress.assessments.at(-1).judgmentIds,holds:holds("selection")},retainedSelectionId:null,prepared,inputId:"parent-input",activityId:"parent-model",stageRequestId:"parent-model-call",stageKind:"model",capabilities:["model-access"],inputHolds:holds("input"),releaseHolds:[]});
    await accept(proposal);await accept(proposal);
    app.exit(73);return;
  }
  if(phase==="sent") {
    for(let i=0;i<10;i++){if((await a({kind:"read_stage",requestId:"parent-model-call"})).status==="raw_result"){app.exit(73);return;}await processor.drain("parent",signal);}
    throw new Error("Parent response not saved");
  }
  await processor.drain("parent",signal);
  assert.equal((await a({kind:"read_stage",requestId:"parent-model-call"})).status,"accepted");
  const binding=await store.contextSelections.command({kind:"binding",inputId:"parent-input",checkCurrentControl:true});
  assert.equal(binding.input.deliveries.length,2);
  const facts=await allFacts();
  const deliveries=facts.filter(f=>f.owner==="context_delivery"&&f.kind==="accepted");
  assert.deepEqual(deliveries.map(f=>f.subject).sort(),["delivery-0","delivery-1"]);
  const check=await work.result("combination-check");assert.equal(check.kind,"ready");
  await work.releaseInputs("combination-check");
  return {additionalProviderCalls:check.progress.modelCalls+1,acceptedInputDigest:digest(binding.input.exactInput),factCount:facts.length};
};
