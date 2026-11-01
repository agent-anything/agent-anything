const assert=require("node:assert/strict");
const {readFile,writeFile}=require("node:fs/promises");
const {join}=require("node:path");
const {pathToFileURL}=require("node:url");

exports.verifyAdoption=async function({app,store,provider,registry,work,processor,signal,now,directory,phase,candidate,body,target,template,lineage}) {
  const {ContextInputPreparationWork,PreparedInputExecution,contextDeliveryFactSource,readContextMethodCostObservation}=await import("@agent-anything/agent-runtime/context-representation");
  const {bindHelarcMethodInputSupply}=await import(pathToFileURL(join(__dirname,"../../dist/main/context/HelarcMethodInputSupply.js")));
  const {HelarcActivityService}=await import(pathToFileURL(join(__dirname,"../../dist/main/context/HelarcActivityService.js")));
  const {composeModelInput,organizeOriginalInput,modelInputValueDigest:digest}=await import("@agent-anything/model-interaction/input");
  const a=command=>store.activityHandoffs.command(command),c=command=>store.materialCustody.command(command);
  const accept=async proposal=>{const result=await store.sharedAcceptance.accept(proposal);assert.equal(result.outcome,"accepted",JSON.stringify(result));};
  const allFacts=async()=>{const facts=[];for(let after=0;;){const page=await store.contextFoundationFacts("parent",after,256);facts.push(...page);if(page.length<256)return facts;after=page.at(-1).sequence;}};
  const recipient={runId:"parent",recipient:"parent-agent",purpose:"task"};
  await a({kind:"subscribe_reconsideration",subscription:{id:"parent-delivery-observation",runId:"parent",owner:"parent-agent",sources:[contextDeliveryFactSource(recipient).id]}});
  const deliveryFacts=async()=>(await a({kind:"read_reconsideration",subscriptionId:"parent-delivery-observation",limit:128})).facts;
  const base=JSON.parse(await readFile(join(directory,"request.json"),"utf8"));
  const intent=id=>({id,runId:"parent",permissionBasis:"isolated-method-permission",resourceScope:id,maximumStages:128,maximumAttempts:128,maximumConcurrent:1,deadlineAt:"2030-01-01T00:00:00.000Z"});
  const preparation=new ContextInputPreparationWork(store.activityHandoffs,registry,{provider,materials:store.materialCustody,now,authorize:async path=>{assert.equal(path.intent.permissionBasis,"isolated-method-permission");return {kind:"allowed"};}});
  const {materialization,supply,consumer}=bindHelarcMethodInputSupply({store,registry,preparation,methods:work,now,authorize:async path=>{assert.equal(path.intent.permissionBasis,"isolated-method-permission");return {kind:"allowed"};}});
  const settleConsumer=async()=>{
    const failures=[];
    const service=new HelarcActivityService({store,purposes:registry,purposeIds:["context.representation-method","context.input-materialization","context.input-preparation"],rediscoveryMs:25,
      reconsideration:(_owner,subscription)=>subscription.binding?.kind==="activity_path"&&subscription.binding.id==="parent-materialization"?consumer:null,
      report:async cycle=>failures.push(...cycle.failures,...cycle.runs.flatMap(r=>r.result.failures),...cycle.reconsiderations.flatMap(r=>[...r.result.failures,...r.result.rejected]))});
    try {
      const deadline=Date.now()+30000;let closed=false;
      while(Date.now()<deadline) {
        service.assertAvailable();assert.equal(failures.length,0,failures.map(f=>f.error?.stack??JSON.stringify(f)).join("\n"));
        closed=(await a({kind:"read_reconsideration",subscriptionId:"parent-materialization:consumer",limit:128})).state.closed;
        if(closed)break;await new Promise(resolve=>setTimeout(resolve,25));
      }
      assert(closed,"Retained consumer closure did not settle");
    } finally {assert.equal((await service.close()).localExecutionsFinished,true);}
  };
  if(process.env.ACTIVITY_CANCEL_CONSUMER&&["cancel","finish"].includes(phase)) {
    const first=await a({kind:"read_stage",requestId:"parent-materialization:stage:1"});
    assert.equal(first.status,"raw_result");
    if(phase==="cancel") {
      const proposal={id:"cancel-recipient",scope:"parent",actor:"context-representation",parts:await consumer.prepareClosure("parent-materialization","recipient-no-longer-needed",signal)};
      await accept(proposal);await accept(proposal);
      assert((await c({kind:"describe",holdId:"parent-candidate-preparation",recipient})).hold,"Unsettled original result still needs protection");
      await writeFile(join(directory,"cancelled-consumer.json"),JSON.stringify({attempt:first.attempt.id,result:first.result.id}));
      app.exit(73);return;
    }
    const original=JSON.parse(await readFile(join(directory,"cancelled-consumer.json"),"utf8"));
    assert.equal(first.attempt.id,original.attempt);assert.equal(first.result.id,original.result);
    await settleConsumer();
    const settled=await a({kind:"read_stage",requestId:first.request.id});
    assert.equal(settled.status,"settled");assert.equal(settled.result.id,original.result);assert.equal(settled.attempt.id,original.attempt);
    assert.equal((await a({kind:"read_path",pathId:"parent-materialization"})).progressRevision,0);
    assert.equal(await a({kind:"read_path",pathId:"parent-preparation"}),null);assert.equal(await a({kind:"read_path",pathId:"combination-check"}),null);
    assert.equal((await a({kind:"read_path",pathId:"method-path"})).cancelled,false);
    await assert.rejects(c({kind:"describe",holdId:"parent-candidate-preparation",recipient}),/material_unavailable/);
    assert((await c({kind:"describe",holdId:candidate.access.holdId,recipient:candidate.access.recipient})).hold);
    assert.deepEqual((await deliveryFacts()).map(f=>f.ref.kind),base.deliveryIds.map(()=>"published"));
    return {additionalProviderCalls:0,consumerCancelled:true,consumerClosed:true,originalResult:original.result};
  }
  const purpose=registry.register({ref:{id:"parent-after-method",revision:"1"},inputOwner:"context-representation",executionOwner:"model-access",interpretationOwner:"parent-agent",acceptanceOwner:"context-representation",recoveryOwner:"parent-agent",stageKinds:["model"],capabilities:["model-access"],continuationKinds:[]},
    new PreparedInputExecution({provider,selections:store.contextSelections,inputId:()=>"parent-input",now,authorize:async()=>({kind:"allowed"}),interpret:async(_path,stage)=>{
      assert.equal(stage.result.value.kind,"succeeded",JSON.stringify(stage.result));
      return {progress:{responseId:stage.result.id},next:[],participants:[{owner:"context_delivery",kind:"accept",proposal:{inputId:"parent-input",responseId:stage.result.id,detailHolds:base.sources.map((_,i)=>`parent-detail-${i}`)}}]};
    }}));
  if(phase==="materialize"||phase==="adopt") {
    const descriptor=await c({kind:"describe",holdId:candidate.access.holdId,recipient:candidate.access.recipient});
    const representation=await store.representations.command({kind:"read",ref:candidate.representation});
    const dependencies=[];
    for(const holdId of representation.holds)dependencies.push(await c({kind:"describe",holdId,recipient:candidate.access.recipient}));
    const candidateAdmission={source:candidate.access,
      grant:{id:"parent-candidate-grant",instanceId:descriptor.hold.instanceId,recipient,range:candidate.access.range,revision:0,allowed:true,basis:"isolated-method-permission"},
      hold:{id:"parent-candidate-preparation",instanceId:descriptor.hold.instanceId,consumer:recipient,responsibility:"preparation",range:candidate.access.range,basis:"parent-materialization",releaseCondition:"explicit consumer settlement"}};
    const source={owner:"context-representation",kind:"representation",id:candidate.representation.id,revision:candidate.representation.revision};
    const taskLineage={...lineage,auxiliary:null};
    for(const key of ["instructionBinding","agent","instructions","instructionRelease","instructionResolver","instructionContent","activeContext","contextProjection","projectionManifest","toolSelection","toolExposureContent","toolExposureBasis","toolExposureProof","toolGuidance","controllerControlGuidance","callableDefinitions","protocol","policy"])taskLineage[key]={owner:"isolated-host",kind:"record",id:key,revision:"1"};
    const composition=composeModelInput({id:"parent-final-input",providerId:provider.descriptor.id,model:provider.modelContext.target.model,interaction:{kind:"text_generation"},lineage:taskLineage,composedAt:"2026-10-29T00:00:00.000Z",sections:[
      {id:"parent-objective",source:{owner:"user",kind:"task",id:"parent-task",revision:"1"},kind:"task",role:"user",necessity:"mandatory",content:{kind:"text",text:process.env.ACTIVITY_SIMPLE?
        "Based on the Child reports, state the current staging port and the superseded port. Do not configure a server.":
        "Based on the Child reports, state the radius for images 5 and 6, the alpha rule, the TARGET value, and whether the version is verified. Do not process images."}}]});
    const taskTemplate={...template,requestId:composition.id,purpose:"task",composition,instructions:composition.instructions,messages:composition.messages,interaction:composition.interaction};
    const originalDemand=organizeOriginalInput({demand:{id:"parent-demand",runId:"parent",recipient:"parent-agent",purpose:"task",targetRevision:target,historyBoundary:"both-child-reports-v1",deliveryIds:[],dependencies:{candidate:digest(candidate.representation)},maximumCombinations:4,maximumExternalMeasurements:0,maximumReadBytes:100000},composition,
      groups:[{id:"objective",owner:"parent-agent",revision:"1",sectionIds:["parent-objective"],duties:["objective"],deliveryIds:[]}]});
    const access={...candidate.access,id:"parent-candidate-access",recipient,holdId:"parent-candidate-preparation"};
    const demand={...originalDemand,deliveryIds:base.deliveryIds,contributions:[...originalDemand.contributions,{id:"reports",owner:"context-representation",sourceRevision:candidate.representation.revision,deliveryIds:base.deliveryIds,currentOptionId:"candidate",localBudget:{dimension:"input_tokens",grant:null,ceiling:null},options:[{
      id:"candidate",revision:candidate.representation.revision,sections:[{position:1,section:{id:"child-reports",source,kind:"evidence",role:"user",necessity:"mandatory",content:{kind:"retained_text",access,prefix:"Derived representation of Child 0 and Child 1 reports; exact original reports remain accessible.\n",suffix:""}}}],
      duties:["evidence","new_information"],requirements:[],findings:[],requires:[],excludes:[],preference:0,estimatedCost:null,omissionBasis:null}]}]};
    const scope={...recipient,id:"parent-input-scope",continuity:"parent-original-thread",owner:"context-representation",target,authorityBasis:"isolated-method-permission"};
    await store.contextSelections.command({kind:"scope",scope});
    const proposedPlan={revision:"5",scheduling:null,producers:[{pathId:"method-path",candidateIds:[candidate.id]}],scope,materialAdmissions:[candidateAdmission],
      materialization:{intent:intent("parent-materialization"),request:{kind:"context_input_materialization",demand,pageBytes:64,preparationIntent:intent("parent-preparation"),
        preparation:{kind:"context_input_preparation",template:taskTemplate,limits:[],reservations:[],policy:{...base.capacity.policy,purpose:"task"},allowExternalMeasurement:false,deliveryMode:"buffered",localMeasurements:[],sharedCapacity:null,materialAccesses:[]}}},
      check:{template:base.template,intent:intent("combination-check"),objective:"Check the entire Parent input against original Child reports and the stated requirements.",bounds:base.bounds,
        capacity:process.env.ACTIVITY_WHOLE_CHECK_TARGET?{...base.capacity,limits:base.capacity.limits.filter(l=>l.id!=="layered-fixture-transport")}:base.capacity}};
    const originalPlan=await supply.readPlan("parent-materialization"),plan=originalPlan??proposedPlan;
    if(!originalPlan) {
      await assert.rejects(c({kind:"describe",holdId:candidateAdmission.hold.id,recipient}),/material_unavailable/);
      const parts=await consumer.prepareStart(plan,signal);assert(parts.length);
      const rejected=await store.sharedAcceptance.accept({id:"parent-materialization-invalid",scope:"parent",actor:"context-representation",
        parts:[...parts,{owner:"material_custody",kind:"holds",proposal:{acquire:[],release:["missing-hold"],basis:"controlled rejection"}}]});
      assert.equal(rejected.outcome,"rejected");assert.equal(await a({kind:"read_path",pathId:plan.materialization.intent.id}),null);
      await assert.rejects(c({kind:"describe",holdId:candidateAdmission.hold.id,recipient}),/material_unavailable/);
      const accepted={id:"parent-materialization-start",scope:"parent",actor:"context-representation",parts};
      await accept(accepted);await accept(accepted);
    }
    if(phase==="materialize") {
      for(let i=0;i<10;i++) {
        const first=await a({kind:"read_stage",requestId:"parent-materialization:stage:1"});
        if(first.status==="raw_result") {assert.equal(first.result.value.kind,"page");app.exit(73);return;}
        await processor.drain("parent",signal);
      }
      throw new Error("Material page not durably retained");
    }
    const firstBefore=await a({kind:"read_stage",requestId:"parent-materialization:stage:1"});
    assert.equal(firstBefore.status,"raw_result","Resume the original saved page, not a recreated request");
    await assert.rejects(supply.prepare({...plan,check:{...plan.check,objective:"Changed configuration must not replace original consumer work"}},signal),/method_input_original_binding_changed/);
    let supplied;const failures=[];
    const service=new HelarcActivityService({store,purposes:registry,purposeIds:["context.representation-method","context.input-materialization","context.input-preparation"],rediscoveryMs:25,
      reconsideration:(owner,subscription)=>owner==="context-representation"&&subscription.binding?.kind==="activity_path"&&subscription.binding.id===plan.materialization.intent.id?consumer:null,
      report:async cycle=>{failures.push(...cycle.failures,...cycle.runs.flatMap(r=>r.result.failures),...cycle.reconsiderations.flatMap(r=>[...r.result.failures,...r.result.rejected]));}});
    try {
      const deadline=Date.now()+120000;
      while(Date.now()<deadline) {
        service.assertAvailable();assert.equal(failures.length,0,failures.map(f=>f.error?.stack??JSON.stringify(f)).join("\n"));
        const status=await a({kind:"read_reconsideration",subscriptionId:"parent-materialization:consumer",limit:128});
        if(status.state.closed) {
          const check=await a({kind:"read_path",pathId:plan.check.intent.id});
          assert.fail(`Consumer closed without a checked input: ${JSON.stringify({state:check?.progress?.method?.state,gap:check?.progress?.method?.gap})}`);
        }
        if(status.state.observedSources.length===1&&status.state.observedSources[0]==="activity-source:control:parent-materialization") {
          assert.equal(status.state.closed,false,"Checked work keeps a durable owner until adoption or disposal");
          supplied=await supply.prepare(plan,signal);break;
        }
        await new Promise(resolve=>setTimeout(resolve,25));
      }
    } finally {assert.equal((await service.close()).localExecutionsFinished,true);}
    assert.equal(supplied?.kind,"checked",JSON.stringify(supplied));
    const consumerFacts=[];for(let after=0;;) {const page=await a({kind:"facts",runId:"parent",after,limit:256});consumerFacts.push(...page);if(page.length<256)break;after=page.at(-1).sequence;}
    assert.equal(consumerFacts.filter(f=>f.kind==="fact_published"&&f.details.fact.ref.kind==="method_input_checked").length,1);
    assert.deepEqual(await materialization.result("parent-materialization"),{kind:"organized",preparationPathId:"parent-preparation"});
    const firstAfter=await a({kind:"read_stage",requestId:"parent-materialization:stage:1"});
    assert.equal(firstAfter.result.id,firstBefore.result.id);assert.equal(firstAfter.attempt.id,firstBefore.attempt.id);
    const prepared=supplied.prepared;
    assert.equal(prepared.request.composition.sections.find(s=>s.id==="child-reports").content.text,`Derived representation of Child 0 and Child 1 reports; exact original reports remain accessible.\n${body}`);
    assert.equal(prepared.request.instructions.content.length,0);
    const check={progress:supplied.progress};
    const facts=await allFacts();
    assert(!facts.some(f=>f.owner==="context_delivery"&&f.kind==="accepted"),"auxiliary check consumed Parent delivery");
    assert.deepEqual((await deliveryFacts()).map(f=>f.ref.kind),base.deliveryIds.map(()=>"published"),"Auxiliary reads and checking do not acknowledge the recipient");
    const ranges=[...new Map([{range:candidate.access.range,instanceId:descriptor.hold.instanceId,source:candidate.access},
      ...dependencies.map(d=>({range:d.hold.range,instanceId:d.hold.instanceId,source:{id:`parent-source:${d.hold.id}`,holdId:d.hold.id,recipient:candidate.access.recipient,range:d.hold.range}}))]
      .map(r=>[digest({range:r.range,instanceId:r.instanceId}),r])).values()];
    const holds=responsibility=>ranges.map((r,i)=>({id:`parent-${responsibility}-${i}`,instanceId:r.instanceId,consumer:recipient,responsibility,range:r.range,basis:responsibility==="selection"?"parent-selection":"parent-input",releaseCondition:"parent response settled"}));
    const details=base.sources.map((s,i)=>({id:`parent-detail-${i}`,instanceId:`source-${i}`,consumer:recipient,responsibility:"detail",range:s.access.range,basis:"parent task detail",releaseCondition:"explicit parent release"}));
    const materialAdmissions=ranges.map((r,i)=>({source:r.source,hold:holds("selection")[i],
      grant:{id:`parent-dependency-grant-${i}`,instanceId:r.instanceId,recipient,range:r.range,revision:0,allowed:true,basis:scope.authorityBasis}}));
    if(process.env.ACTIVITY_NORMAL_POLICY)await a({kind:"schedule_work",expectedRevision:0,intent:{id:"parent-task-scheduling",workId:"parent-task-work",runId:"parent",scopeId:"parent",owner:"parent-agent",delegatedPathOwners:[purpose.contract.acceptanceOwner],
      decisionId:"parent-task-request",policyRevision:"isolated-host:1",reason:"task",delayImpact:"Parent input is ready for its task decision",timing:{kind:"unknown"},resources:[{poolId:"helarc:model-execution",capability:"model-access",units:1}]}});
    await a({kind:"open_path",intent:{...intent("parent-model"),owner:purpose.contract.acceptanceOwner,purpose,
      ...(process.env.ACTIVITY_NORMAL_POLICY?{scheduledWorkId:"parent-task-work"}:{})}});
    const adoption=await work.prepareAdoption("combination-check",{id:"parent-adoption",scope,expectedSelectionId:null,expectedControlRevision:0,selection:{id:"parent-selection",representations:[candidate.representation],judgmentIds:check.progress.assessments.at(-1).judgmentIds,holds:holds("selection")},retainedSelectionId:null,prepared,inputId:"parent-input",activityId:"parent-model",stageRequestId:"parent-model-call",stageKind:"model",capabilities:["model-access"],inputHolds:holds("input"),materialAdmissions,releaseHolds:[]});
    const proposal={...adoption,parts:[...supplied.conditions,{owner:"material_custody",kind:"holds",proposal:{acquire:details,release:[],basis:adoption.id}},...adoption.parts,
      ...await consumer.prepareClosure("parent-materialization",adoption.id,signal)]};
    const acceptedProposal=process.env.ACTIVITY_NORMAL_POLICY?await require("./normal-context-policy.cjs").prepareNormalAdoption({store,work,prepared,scope,proposal}):proposal;
    await accept(acceptedProposal);await accept(acceptedProposal);
    app.exit(73);return;
  }
  if(phase==="sent") {
    await settleConsumer();
    await assert.rejects(c({kind:"describe",holdId:"parent-candidate-preparation",recipient}),/material_unavailable/);
    for(let i=0;i<10;i++){if((await a({kind:"read_stage",requestId:"parent-model-call"})).status==="raw_result"){app.exit(73);return;}await processor.drain("parent",signal);}
    throw new Error("Parent response not saved");
  }
  await processor.drain("parent",signal);
  const settled=await a({kind:"read_stage",requestId:"parent-model-call"});assert.equal(settled.status,"accepted");
  const finalText=settled.result.value.response.output;assert.equal(typeof finalText,"string");
  if(process.env.ACTIVITY_SIMPLE)assert(finalText.includes("7542")&&finalText.includes("7431"),finalText);
  else assert(finalText.includes("7391")&&finalText.toLowerCase().includes("alpha"),finalText);
  const binding=await store.contextSelections.command({kind:"binding",inputId:"parent-input",checkCurrentControl:true});
  assert.equal(binding.input.deliveries.length,base.deliveryIds.length);
  const facts=await allFacts();
  const deliveries=facts.filter(f=>f.owner==="context_delivery"&&f.kind==="accepted");
  assert.deepEqual(deliveries.map(f=>f.subject).sort(),[...base.deliveryIds].sort());
  const observedDeliveries=await deliveryFacts();
  for(const id of base.deliveryIds)assert.deepEqual(observedDeliveries.filter(f=>f.ref.id===id).map(f=>f.ref.kind),["published","selected","accepted"]);
  assert.equal((await store.contextSelections.command({kind:"pending_deliveries",recipient,after:0,through:null,limit:128})).entries.length,0);
  const checkPath=await a({kind:"read_path",pathId:"combination-check"});
  assert(checkPath.cancelled);const check={progress:checkPath.progress.method};assert.equal(check.progress.state,"ready");
  let cost=null;
  for(let page=0;page<16&&!cost?.caughtUpAtRead;page++)
    cost=await readContextMethodCostObservation({runId:"parent",pathId:"method-path",activities:store.activityHandoffs,previous:cost},signal);
  assert(cost.caughtUpAtRead);assert(cost.reported.providerElapsedMs.samples>=2);
  const repeated=await readContextMethodCostObservation({runId:"parent",pathId:"method-path",activities:store.activityHandoffs,previous:cost},signal);
  assert.deepEqual(repeated,cost,"Restored cost facts cannot count original Provider results twice");
  await settleConsumer();
  await assert.rejects(c({kind:"describe",holdId:"parent-candidate-preparation",recipient}),/material_unavailable/);
  assert.equal((await a({kind:"read_path",pathId:"method-path"})).cancelled,false,"A consumer cannot cancel its producer");
  assert((await c({kind:"describe",holdId:candidate.access.holdId,recipient:candidate.access.recipient})).hold);
  assert.equal((await store.contextSelections.command({kind:"current",scopeId:binding.scope.id})).id,"parent-selection");
  for(const hold of binding.input.holds)assert((await c({kind:"describe",holdId:hold.id,recipient})).hold);
  for(const input of check.progress.acceptedInputs) {
    assert.equal(await store.contextSelections.command({kind:"current",scopeId:input.scopeId}),null);
    for(const holdId of input.holds)await assert.rejects(c({kind:"describe",holdId,recipient:check.progress.request.recipient}),/material_unavailable/);
  }
  return {additionalProviderCalls:check.progress.modelCalls+1,acceptedInputDigest:digest(binding.input.exactInput),factCount:facts.length,recipientFactsRestored:true,consumerClosed:true,cost,finalText};
};
