const assert=require("node:assert/strict");
const {readFile,writeFile}=require("node:fs/promises");
const {join}=require("node:path");
const {pathToFileURL}=require("node:url");

exports.verifyJointInput=async function({app,store,provider,registry,work,processor,signal,now,directory,phase,candidate,target,template,lineage}) {
  const {ContextInputPreparationWork,PreparedInputExecution}=await import("@agent-anything/agent-runtime/context-representation");
  const {bindHelarcMethodInputSupply}=await import(pathToFileURL(join(__dirname,"../../dist/main/context/HelarcMethodInputSupply.js")));
  const {HelarcActivityService}=await import(pathToFileURL(join(__dirname,"../../dist/main/context/HelarcActivityService.js")));
  const {composeModelInput,organizeOriginalInput,modelInputValueDigest:digest}=await import("@agent-anything/model-interaction/input");
  const {declareModelResultTextSlot}=await import("@agent-anything/model-interaction/input");
  const {createModelCallRef,createNativeToolTurnInteraction}=await import("@agent-anything/model-interaction");
  const native=!!process.env.ACTIVITY_JOINT_RESULT_TEXT;
  const a=command=>store.activityHandoffs.command(command),c=command=>store.materialCustody.command(command);
  const accept=async proposal=>{const result=await store.sharedAcceptance.accept(proposal);assert.equal(result.outcome,"accepted",JSON.stringify(result));};
  const base=JSON.parse(await readFile(join(directory,"request.json"),"utf8"));
  const intent=id=>({id,runId:"parent",permissionBasis:"isolated-method-permission",resourceScope:id,maximumStages:128,maximumAttempts:128,maximumConcurrent:1,deadlineAt:"2030-01-01T00:00:00.000Z"});
  const secondRequest={...base,sources:[base.sources[1]],relationships:[],requirements:[{...base.requirements[0],description:"Preserve the later scoped correction and its unresolved version claim."}],sourceBoundary:"second-report-v1",deliveryIds:["delivery-1"]};
  if(!await a({kind:"read_path",pathId:"second-producer"}))await work.submit(intent("second-producer"),secondRequest);
  for(let i=0;i<200;i++) {
    const second=await work.result("second-producer");assert.notEqual(second.kind,"gap",JSON.stringify(second));
    if(second.kind==="ready")break;
    if(phase==="second-generated")for(const pending of await a({kind:"pending",runId:"parent",after:0,limit:256})) {
      const stage=await a({kind:"read_stage",requestId:pending.requestId});
      if(stage.request.pathId==="second-producer"&&stage.request.stageKind==="model"&&stage.status==="raw_result") {
        await writeFile(join(directory,"joint-original-raw.json"),JSON.stringify({requestId:stage.request.id,resultId:stage.result.id,attemptId:stage.attempt.id}));app.exit(73);return;
      }
    }
    await processor.drain("parent",signal);
  }
  const second=await work.result("second-producer");assert.equal(second.kind,"ready");
  const original=JSON.parse(await readFile(join(directory,"joint-original-raw.json"),"utf8")),settled=await a({kind:"read_stage",requestId:original.requestId});
  assert.equal(settled.status,"accepted");assert.equal(settled.result.id,original.resultId);assert.equal(settled.attempt.id,original.attemptId);
  const candidates=[candidate,second.progress.candidates.find(c=>second.progress.resultIds.includes(c.id))];assert(candidates[1]);
  const paths=["method-path","second-producer"],recipient={runId:"parent",recipient:"parent-agent",purpose:"task"};
  const preparation=new ContextInputPreparationWork(store.activityHandoffs,registry,{provider,materials:store.materialCustody,now,authorize:async()=>({kind:"allowed"})});
  const {supply,consumer}=bindHelarcMethodInputSupply({store,registry,preparation,methods:work,now,authorize:async()=>({kind:"allowed"})});
  const settleConsumer=async closed=>{
    const failures=[],service=new HelarcActivityService({store,purposes:registry,purposeIds:["context.representation-method","context.input-materialization","context.input-preparation"],rediscoveryMs:25,
      reconsideration:(owner,subscription)=>owner==="context-representation"&&subscription.binding?.kind==="activity_path"&&subscription.binding.id==="joint-materialization"?consumer:null,
      report:async cycle=>failures.push(...cycle.failures,...cycle.runs.flatMap(r=>r.result.failures),...cycle.reconsiderations.flatMap(r=>[...r.result.failures,...r.result.rejected]))});
    try {
      const deadline=Date.now()+120000;
      while(Date.now()<deadline) {
        service.assertAvailable();assert.equal(failures.length,0,failures.map(f=>f.error?.stack??JSON.stringify(f)).join("\n"));
        const snapshot=await a({kind:"read_reconsideration",subscriptionId:"joint-materialization:consumer",limit:128});
        if(closed?snapshot.state.closed:snapshot.state.observedSources.length===1&&snapshot.state.observedSources[0]==="activity-source:control:joint-materialization")return;
        await new Promise(resolve=>setTimeout(resolve,25));
      }
      throw new Error("Joint consumer did not settle its own responsibility");
    } finally {assert.equal((await service.close()).localExecutionsFinished,true);}
  };
  const purpose=registry.register({ref:{id:"parent-after-method",revision:"1"},inputOwner:"context-representation",executionOwner:"model-access",interpretationOwner:"parent-agent",acceptanceOwner:"context-representation",recoveryOwner:"parent-agent",stageKinds:["model"],capabilities:["model-access"],continuationKinds:[]},
    new PreparedInputExecution({provider,selections:store.contextSelections,inputId:()=>"joint-input",now,authorize:async()=>({kind:"allowed"}),interpret:async(_path,stage)=>({progress:{responseId:stage.result.id},next:[],participants:[{owner:"context_delivery",kind:"accept",proposal:{inputId:"joint-input",responseId:stage.result.id,detailHolds:[]}}]})}));
  let plan=await supply.readPlan("joint-materialization");
  if(!plan) {
    const admissions=[];
    for(const [i,candidate] of candidates.entries()) {
      const descriptor=await c({kind:"describe",holdId:candidate.access.holdId,recipient:candidate.access.recipient});
      admissions.push({source:candidate.access,
        grant:{id:`joint-grant-${i}`,instanceId:descriptor.hold.instanceId,recipient,range:candidate.access.range,revision:0,allowed:true,basis:"isolated-method-permission"},
        hold:{id:`joint-preparation-${i}`,instanceId:descriptor.hold.instanceId,consumer:recipient,responsibility:"preparation",range:candidate.access.range,basis:"joint-materialization",releaseCondition:"explicit recipient settlement"}});
    }
    const taskLineage={...lineage,auxiliary:null};
    for(const key of ["instructionBinding","agent","instructions","instructionRelease","instructionResolver","instructionContent","activeContext","contextProjection","projectionManifest","toolSelection","toolExposureContent","toolExposureBasis","toolExposureProof","toolGuidance","controllerControlGuidance","callableDefinitions","protocol","policy"])taskLineage[key]={owner:"isolated-host",kind:"record",id:key,revision:"1"};
    const composition=composeModelInput({id:"joint-parent-request",providerId:provider.descriptor.id,model:provider.modelContext.target.model,interaction:native?createNativeToolTurnInteraction([{name:"CollectReports",description:"Collect the original reports",inputSchema:{type:"object",properties:{},additionalProperties:false}}]):{kind:"text_generation"},lineage:taskLineage,composedAt:"2026-10-29T00:00:00.000Z",sections:[
      {id:"objective",source:{owner:"user",kind:"task",id:"joint-task",revision:"1"},kind:"task",role:"user",necessity:"mandatory",content:{kind:"text",text:"Based on the Child reports, state the radius for images 5 and 6, the alpha rule, TARGET and whether the version is verified."}}]});
    const taskTemplate={...template,requestId:composition.id,purpose:"task",composition,instructions:composition.instructions,messages:composition.messages,interaction:composition.interaction};
    const originalDemand=organizeOriginalInput({demand:{id:"joint-demand",runId:"parent",recipient:"parent-agent",purpose:"task",targetRevision:target,historyBoundary:"both-child-reports-v1",deliveryIds:[],dependencies:{producers:digest(paths)},maximumCombinations:4,maximumExternalMeasurements:0,maximumReadBytes:100000},composition,
      groups:[{id:"objective",owner:"parent-agent",revision:"1",sectionIds:["objective"],duties:["objective"],deliveryIds:[]}]});
    let demand={...originalDemand,deliveryIds:base.deliveryIds,contributions:[...originalDemand.contributions,...candidates.map((candidate,i)=>({id:`report-${i}`,owner:"context-representation",sourceRevision:candidate.representation.revision,deliveryIds:[`delivery-${i}`],currentOptionId:"candidate",localBudget:{dimension:"input_tokens",grant:null,ceiling:null},options:[{
      id:"candidate",revision:candidate.representation.revision,sections:[{position:i+1,section:{id:`report-${i}`,source:{owner:"context-representation",kind:"representation",...candidate.representation},kind:"evidence",role:"user",necessity:"mandatory",content:{kind:"retained_text",access:{...candidate.access,id:`joint-access-${i}`,recipient,holdId:admissions[i].hold.id},prefix:`Child ${i} derived report: `,suffix:""}}}],
      duties:["evidence","new_information"],requirements:[],findings:[],requires:[],excludes:[],preference:0,estimatedCost:null,omissionBasis:null}]}))]};
    if(native) {
      const modelCallRef=createModelCallRef({providerRequestId:"original-task-request",controllerRequestId:"original-controller",turnId:"original-turn",contentBlockOrdinal:0,branchId:"parent"});
      const message={role:"tool",content:[{kind:"model_tool_result",result:{modelCallRef,providerCallRef:null,name:"CollectReports",settlement:"failed",
        presentation:{presenter:{id:"reports",revision:"1"},disposition:"complete",failureCode:null},sourceRefs:[{owner:"reports",kind:"result",id:"original-reports",revision:"1"}],
        content:{reports:["Original first report","Original second report"],status:"failed",effect_status:"partial",failure:{code:"verification_unavailable"}}}}]};
      const source={owner:"reports",kind:"result",id:"original-reports",revision:"1",runId:"parent"},section=(id,role,content)=>({id,source,kind:"history",role,necessity:"mandatory",content,
        provenance:{purpose:"accepted_exchange",recipientRunId:"parent",author:"reports",sources:[source],presenter:{owner:"reports",kind:"presenter",id:"original-report-group",revision:"1"},coverage:["original-reports@1"],limitations:[]}});
      const replacements=candidates.map((candidate,i)=>({access:{...candidate.access,id:`joint-access-${i}`,recipient,holdId:admissions[i].hold.id},
        slot:declareModelResultTextSlot(message,modelCallRef.id,["reports",i]),prefix:`Child ${i} derived report: `,suffix:""}));
      demand={...demand,contributions:[...originalDemand.contributions,{id:"original-native-group",owner:"reports",sourceRevision:"1",deliveryIds:base.deliveryIds,
        currentOptionId:"joined-bodies",localBudget:{dimension:"input_tokens",grant:null,ceiling:null},options:[{id:"joined-bodies",revision:"1",duties:["continuity","evidence","new_information"],
          requirements:[],findings:[],requires:[],excludes:[],preference:0,estimatedCost:null,omissionBasis:null,
          resultTextBindings:replacements.map((r,i)=>({sectionId:"original-native-result",slot:r.slot,source,representation:{owner:"context-representation",kind:"representation",...candidates[i].representation}})),
          sections:[{position:1,section:section("original-native-call","assistant",{kind:"model_message",message:{role:"assistant",content:[{kind:"model_tool_call",call:{modelCallRef,providerCallRef:null,name:"CollectReports",input:{},ordinal:0}}]}})},
            {position:2,section:section("original-native-result","tool",{kind:"retained_result_text",message,replacements})}]}]}]};
    }
    const scope={...recipient,id:"joint-scope",continuity:"parent-original-thread",owner:"context-representation",target,authorityBasis:"isolated-method-permission"};
    await store.contextSelections.command({kind:"scope",scope});
    plan={revision:"5",scheduling:null,producers:paths.map((pathId,i)=>({pathId,candidateIds:[candidates[i].id]})),scope,materialAdmissions:admissions,
      materialization:{intent:intent("joint-materialization"),request:{kind:"context_input_materialization",demand,pageBytes:64,preparationIntent:intent("joint-preparation"),
        preparation:{kind:"context_input_preparation",template:taskTemplate,limits:[],reservations:[],policy:{...base.capacity.policy,purpose:"task"},allowExternalMeasurement:false,deliveryMode:"buffered",localMeasurements:[],sharedCapacity:null,materialAccesses:[]}}},
      check:{template:base.template,intent:intent("joint-check"),sourceBasis:"qualified_when_covered",objective:"Check the complete Parent input against both independently preserved reports; retain the scoped correction without presenting conflicting current rules.",bounds:base.bounds,capacity:base.capacity}};
    const parts=await consumer.prepareStart(plan,signal);await accept({id:"joint-start",scope:"parent",actor:"context-representation",parts});
  }
  if(phase==="materialize") {
    for(let i=0;i<10;i++) {const first=await a({kind:"read_stage",requestId:"joint-materialization:stage:1"});if(first.status==="raw_result"){app.exit(73);return;}await processor.drain("parent",signal);}
    throw new Error("Joint materialization did not retain its original page");
  }
  if(process.env.ACTIVITY_INPUT_UNAVAILABLE) {
    await settleConsumer(true);
    assert.equal(await a({kind:"read_path",pathId:"joint-model"}),null);
    const check=await a({kind:"read_path",pathId:"joint-check"});assert(check.cancelled);assert.equal(check.progress.method.state,"gap");
    assert.equal(check.progress.method.gap.code,"representation_preservation_unconfirmed");
    for(const [i,pathId] of paths.entries()) {
      assert.equal((await work.result(pathId)).kind,"ready");assert.equal((await a({kind:"read_path",pathId})).cancelled,false);
      assert((await c({kind:"describe",holdId:candidates[i].access.holdId,recipient:candidates[i].access.recipient})).hold);
      await assert.rejects(c({kind:"describe",holdId:`joint-preparation-${i}`,recipient}),/material_unavailable/);
    }
    assert.equal((await store.contextSelections.command({kind:"pending_deliveries",recipient,after:0,through:null,limit:128})).entries.length,2);
    if(phase==="limitation"){app.exit(73);return;}
    return {joint:true,rejected:true,additionalProviderCalls:second.progress.modelCalls+check.progress.method.modelCalls,producers:paths,judgment:check.progress.method.assessments.at(-1).judgmentIds[0],consumerClosed:true};
  }
  if(phase==="adopt") {
    const first=await a({kind:"read_stage",requestId:"joint-materialization:stage:1"});assert.equal(first.status,"raw_result");
    await assert.rejects(supply.prepare({...plan,producers:[plan.producers[0]],materialAdmissions:[plan.materialAdmissions[0]]},signal),/method_input_original_binding_changed/);
    await settleConsumer(false);
    const supplied=await supply.prepare(plan,signal);
    assert.equal(supplied.kind,"checked",JSON.stringify(supplied));
    const firstAfter=await a({kind:"read_stage",requestId:first.request.id});assert.equal(firstAfter.result.id,first.result.id);assert.equal(firstAfter.attempt.id,first.attempt.id);
    assert.deepEqual(supplied.progress.request.combination.producers.map(p=>p.pathId),paths);
    assert.equal(supplied.progress.request.combination.inheritedChecks.length,2);
    assert.deepEqual(supplied.progress.request.requirements.map(r=>r.id),["producer_0:agreement","producer_1:agreement"]);
    for(const [i,candidate] of candidates.entries()) {
      const page=await c({kind:"read",access:candidate.access,offset:0,length:candidate.access.range.end});
      if(!native)assert.equal(supplied.prepared.request.composition.sections.find(s=>s.id===`report-${i}`).content.text,`Child ${i} derived report: ${page.text}`);
      else {
        const actual=supplied.prepared.request.composition.sections.find(s=>s.id==="original-native-result").content.message;
        const source=plan.materialization.request.demand.contributions[1].options[0].sections[1].section.content;
        const expected=structuredClone(source.message);
        for(const [j,part] of source.replacements.entries()) {
          const body=await c({kind:"read",access:part.access,offset:0,length:part.access.range.end});
          expected.content[0].result.content.reports[j]=part.prefix+body.text+part.suffix;
        }
        assert.deepEqual(actual,expected,"Every unchanged envelope, outcome and correlation must survive both replacements");
        assert.deepEqual(supplied.prepared.request.composition.sections.find(s=>s.id==="original-native-call"),plan.materialization.request.demand.contributions[1].options[0].sections[0].section);
      }
    }
    const ranges=new Map();
    for(const candidate of candidates) {
      const record=await store.representations.command({kind:"read",ref:candidate.representation});
      for(const holdId of new Set([candidate.access.holdId,...record.holds])) {
        const descriptor=await c({kind:"describe",holdId,recipient:candidate.access.recipient});
        ranges.set(digest({range:descriptor.hold.range,instanceId:descriptor.hold.instanceId}),{range:descriptor.hold.range,instanceId:descriptor.hold.instanceId,source:{id:`joint-source-${holdId}`,holdId,recipient:candidate.access.recipient,range:descriptor.hold.range}});
      }
    }
    const retained=[...ranges.values()],holds=responsibility=>retained.map((r,i)=>({id:`joint-${responsibility}-${i}`,instanceId:r.instanceId,consumer:recipient,responsibility,range:r.range,basis:responsibility==="selection"?"joint-selection":"joint-input",releaseCondition:"explicit recipient completion"}));
    const admissions=retained.map((r,i)=>({source:r.source,hold:holds("selection")[i],grant:{id:`joint-selection-grant-${i}`,instanceId:r.instanceId,recipient,range:r.range,revision:0,allowed:true,basis:plan.scope.authorityBasis}}));
    await a({kind:"open_path",intent:{...intent("joint-model"),owner:purpose.contract.acceptanceOwner,purpose}});
    const adoption=await work.prepareAdoption("joint-check",{id:"joint-adoption",scope:plan.scope,expectedSelectionId:null,expectedControlRevision:0,selection:{id:"joint-selection",representations:candidates.map(c=>c.representation),judgmentIds:supplied.progress.assessments.at(-1).judgmentIds,holds:holds("selection")},retainedSelectionId:null,prepared:supplied.prepared,inputId:"joint-input",activityId:"joint-model",stageRequestId:"joint-model-call",stageKind:"model",capabilities:["model-access"],inputHolds:holds("input"),materialAdmissions:admissions,releaseHolds:[]});
    const closure=await consumer.prepareClosure("joint-materialization",adoption.id,signal);
    assert(!closure.some(p=>p.kind==="path_cancellation"&&paths.includes(p.proposal.pathId)));
    const bad=supplied.conditions.map(p=>p.proposal.pathId!=="second-producer"?p:{...p,proposal:{...p.proposal,expected:{...p.proposal.expected,controlRevision:p.proposal.expected.controlRevision+1}}});
    const rejected=await store.sharedAcceptance.accept({...adoption,id:"joint-stale-control",parts:[...bad,...adoption.parts,...closure]});assert.equal(rejected.outcome,"rejected");
    assert.equal(await a({kind:"read_stage",requestId:"joint-model-call"}),null);
    const proposal={...adoption,parts:[...supplied.conditions,...adoption.parts,...closure]};await accept(proposal);await accept(proposal);
    app.exit(73);return;
  }
  if(phase==="sent") {
    for(let i=0;i<20;i++){if((await a({kind:"read_stage",requestId:"joint-model-call"})).status==="raw_result"){app.exit(73);return;}await processor.drain("parent",signal);}
    throw new Error("Joint Parent response not retained");
  }
  await processor.drain("parent",signal);
  await settleConsumer(true);
  const response=await a({kind:"read_stage",requestId:"joint-model-call"});assert.equal(response.status,"accepted");
  const binding=await store.contextSelections.command({kind:"binding",inputId:"joint-input",checkCurrentControl:true});assert.equal(binding.input.deliveries.length,2);
  if(native) {
    const {createSelectedResultPresentationReceipt,snapshotSelectedResultPresentationReceipt,applySelectedResultPresentations}=await import("@agent-anything/agent-runtime/decision");
    const prepared=binding.input.exactInput,originalMessage=plan.materialization.request.demand.contributions[1].options[0].sections[1].section.content.message;
    const composition=composeModelInput({...prepared.request.composition,id:"original-joint-task",sections:prepared.request.composition.sections.map(section=>section.id!=="original-native-result"?section:
      {...section,content:{kind:"model_message",message:originalMessage}})});
    const originalRequest={...prepared.request,requestId:composition.id,composition,instructions:composition.instructions,messages:composition.messages};
    const receipt=createSelectedResultPresentationReceipt({originalRequest,binding,response:response.result.value.response,rawResultId:response.result.id,responseAcceptanceId:response.receipt.id});
    assert.equal(receipt.presentations.length,1);assert.equal(receipt.presentations[0].bindings.length,2);
    const restored=snapshotSelectedResultPresentationReceipt(JSON.parse(JSON.stringify(receipt)));
    const rebuilt=applySelectedResultPresentations(restored,composition.sections,"parent",prepared.request.requestId,prepared.request.correlation.controllerRequestId);
    assert.deepEqual(rebuilt.find(s=>s.id==="original-native-result").content,prepared.request.composition.sections.find(s=>s.id==="original-native-result").content);
  }
  assert.equal((await store.contextSelections.command({kind:"current",scopeId:plan.scope.id})).id,"joint-selection");
  assert.equal((await store.contextSelections.command({kind:"pending_deliveries",recipient,after:0,through:null,limit:128})).entries.length,0);
  const facts=[];
  for(let after=0;;) {const page=await store.contextFoundationFacts("parent",after,256);facts.push(...page);if(page.length<256)break;after=page.at(-1).sequence;}
  assert.deepEqual(facts.filter(f=>f.owner==="context_delivery"&&f.kind==="accepted").map(f=>f.subject).sort(),["delivery-0","delivery-1"]);
  const snapshot=await a({kind:"read_reconsideration",subscriptionId:"joint-materialization:consumer",limit:128});assert(snapshot.state.closed);
  for(const [i,pathId] of paths.entries()) {assert.equal((await a({kind:"read_path",pathId})).cancelled,false);assert((await c({kind:"describe",holdId:candidates[i].access.holdId,recipient:candidates[i].access.recipient})).hold);}
  const check=await a({kind:"read_path",pathId:"joint-check"});assert(check.cancelled);assert.equal(check.progress.method.state,"ready");
  for(const hold of binding.input.holds)assert((await c({kind:"describe",holdId:hold.id,recipient})).hold);
  return {joint:true,nativeResultText:native,additionalProviderCalls:second.progress.modelCalls+check.progress.method.modelCalls+1,producers:paths,judgment:check.progress.method.assessments.at(-1).judgmentIds[0],acceptedInputDigest:digest(binding.input.exactInput),consumerClosed:true,finalText:response.result.value.response.output};
};
