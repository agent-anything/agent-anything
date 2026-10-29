const assert=require("node:assert/strict");

exports.acceptNormalPreparation=async function({store,provider,registry,work,processor,signal,now,request,texts,intent}) {
  const {ContextInputPreparationWork,contextPreparationAcceptance,quoteRepresentationMethod}=await import("@agent-anything/agent-runtime/context-representation");
  const {composeModelInput,organizeOriginalInput,modelInputValueDigest:digest}=await import("@agent-anything/model-interaction/input");
  const a=command=>store.activityHandoffs.command(command);
  const reference=id=>({owner:"isolated-host",kind:"fact",id,revision:"1"});
  const recipient={runId:"parent",recipient:"parent-agent",purpose:"task"};
  const source=request.template.composition;
  const lineage={...source.lineage,auxiliary:null};
  for(const key of ["instructionBinding","agent","instructions","instructionRelease","instructionResolver","instructionContent","activeContext","contextProjection","projectionManifest","toolSelection","toolExposureContent","toolExposureBasis","toolExposureProof","toolGuidance","controllerControlGuidance","callableDefinitions","protocol","policy"])lineage[key]={owner:"isolated-host",kind:"record",id:key,revision:"1"};
  const composition=composeModelInput({id:"normal-original",providerId:source.providerId,model:source.model,interaction:{kind:"text_generation"},
    lineage,composedAt:now(),sections:[
      {id:"objective",source:reference("objective"),kind:"task",role:"user",necessity:"mandatory",content:{kind:"text",text:"Use the Child reports to preserve the image-processing agreement and correction."}},
      ...texts.map((text,i)=>({id:`report-${i}`,source:{owner:`child-${i}`,kind:"report",id:`report-${i}`,revision:"1"},kind:"evidence",role:"user",necessity:"mandatory",content:{kind:"text",text}}))]});
  const template={...request.template,requestId:composition.id,purpose:"task",instructions:composition.instructions,messages:composition.messages,interaction:composition.interaction,composition};
  const demand=organizeOriginalInput({demand:{id:"normal-demand",...recipient,targetRevision:request.targetRevision,historyBoundary:request.sourceBoundary,
    deliveryIds:request.deliveryIds,dependencies:{reports:digest(request.sources)},maximumCombinations:32,maximumExternalMeasurements:0,maximumReadBytes:1000000},composition,
    groups:[{id:"objective",owner:"parent-agent",revision:"1",sectionIds:["objective"],duties:["objective"],deliveryIds:[]},
      ...texts.map((_,i)=>({id:`report-${i}`,owner:`child-${i}`,revision:"1",sectionIds:[`report-${i}`],duties:["evidence"],deliveryIds:[`delivery-${i}`]}))]});
  const preparation=new ContextInputPreparationWork(store.activityHandoffs,registry,{provider,materials:store.materialCustody,authorize:async()=>{},now});
  await preparation.submit({...intent,id:"normal-input-preparation",resourceScope:"normal-task-input"},{kind:"context_input_preparation",demand,template,limits:[],reservations:[],policy:{...request.capacity.policy,purpose:"task"},
    allowExternalMeasurement:false,deliveryMode:"buffered",localMeasurements:[],sharedCapacity:null,materialAccesses:[]});
  for(let i=0;i<16&&(await preparation.result("normal-input-preparation")).kind==="pending";i++)await processor.drain("parent",signal);
  const prepared=await preparation.result("normal-input-preparation");assert.equal(prepared.kind,"prepared");
  const scope={...recipient,id:"normal-policy-scope",continuity:"original-parent",owner:"context-representation",target:request.targetRevision,authorityBasis:"isolated-method-permission"};
  await store.contextSelections.command({kind:"scope",scope});
  const quote=quoteRepresentationMethod(request);
  const input={scope,boundary:request.sourceBoundary,requirementsDigest:digest(request.requirements),current:{kind:"prepared",prepared:prepared.prepared,evidence:reference("original-prepared")},
    currentRejectedInputId:null,alternatives:[],pressure:[{kind:"growth_scenario",evidence:{...reference("subsequent-large-reports"),kind:"estimate"},timing:null}],
    options:[{id:"source-preserving-method",request,stableScope:reference("both-child-reports-complete"),addresses:["subsequent-large-reports"],
      entries:quote.phases.map(p=>({phase:p.kind,state:"unknown",evidence:reference(`entry:${p.kind}`)})),limits:{maximumStages:intent.maximumStages,maximumAttempts:intent.maximumAttempts},capability:[],comparisons:[]}],
    inFlight:[],explorationHistory:[],optionalInFlight:0,autoPrepare:true,consumerActive:true};
  const pool={id:"helarc:model-execution",revision:"1",authority:"isolated-host",capacity:1};
  await a({kind:"bind_resource_pool",pool});
  await a({kind:"register_fact_source",source:{id:"normal-input-facts",runId:"parent",owner:"context-representation"}});
  await a({kind:"publish_fact",fact:{id:"normal-input-ready",sourceId:"normal-input-facts",ref:{owner:"context-representation",kind:"prepared_input",id:prepared.prepared.preparationStageId,revision:"1"}}});
  await a({kind:"subscribe_reconsideration",subscription:{id:"normal-policy-watch",runId:"parent",owner:"context-representation",sources:["normal-input-facts"]}});
  const boundary=await a({kind:"read_reconsideration",subscriptionId:"normal-policy-watch",limit:16});
  const proposal=contextPreparationAcceptance({id:"normal-policy-accept",input,expectedDecisionId:null,expectedControlRevision:0,reconsideration:boundary,methods:work,
    execution:{path:intent,workId:"original-normal-preparation",timing:{kind:"unknown"},resources:["model-access","model-measurement"].map(capability=>({poolId:pool.id,capability,units:1}))}});
  assert.equal(proposal.decision.foreground.kind,"continue");assert.equal(proposal.decision.investment.kind,"propose");assert.equal(proposal.decision.investment.reason,"opportunity");
  // A failed participant must leave neither consumed B nor a scheduled/partially opened method.
  const rejected=await store.sharedAcceptance.accept({...proposal.acceptance,id:"invalid-normal-policy-accept",parts:proposal.acceptance.parts.map(p=>p.owner==="context_preparation_policy"?{...p,proposal:{...p.proposal,expectedControlRevision:99}}:p)});
  assert.equal(rejected.outcome,"rejected");assert.equal(await a({kind:"read_path",pathId:intent.id}),null);
  assert.equal((await a({kind:"read_reconsideration",subscriptionId:"normal-policy-watch",limit:16})).facts.length,1);
  const accepted=await store.sharedAcceptance.accept(proposal.acceptance);assert.equal(accepted.outcome,"accepted",JSON.stringify(accepted));
  assert.deepEqual(await store.sharedAcceptance.accept(proposal.acceptance),accepted);
  const schedule=await a({kind:"read_schedule",workId:"original-normal-preparation"});assert.equal(schedule.service,"guaranteed");
  assert.equal((await store.contextPolicy.query({kind:"latest",scopeId:scope.id})).decision.id,proposal.decision.id);
  assert.equal((await a({kind:"read_reconsideration",subscriptionId:"normal-policy-watch",limit:16})).facts.length,0);
  await verifyAdmissionLimitation({store,work,signal,input,intent,pool});
};

async function verifyAdmissionLimitation({store,work,signal,input,intent,pool}) {
  const {contextPreparationReconsideration}=await import("@agent-anything/agent-runtime/context-representation");
  const {ActivityReconsiderationProcessor}=await import("@agent-anything/agent-runtime/activity");
  const a=command=>store.activityHandoffs.command(command),scope={...input.scope,id:"limited-policy-scope",continuity:"limited-parent"};
  await store.contextSelections.command({kind:"scope",scope});
  await a({kind:"register_fact_source",source:{id:"limited-input-facts",runId:"parent",owner:"context-representation"}});
  await a({kind:"publish_fact",fact:{id:"limited-input-ready",sourceId:"limited-input-facts",ref:{owner:"context-representation",kind:"prepared_input",id:input.current.prepared.preparationStageId,revision:"1"}}});
  await a({kind:"subscribe_reconsideration",subscription:{id:"limited-policy-watch",runId:"parent",owner:"context-representation",sources:["limited-input-facts"]}});
  let proposals=0;
  const handler=contextPreparationReconsideration({decisions:store.contextPolicy,activities:store.activityHandoffs,methods:work,resolve:async()=>({policy:{...input,scope},expectedControlRevision:0,
    execution:()=>{proposals++;return {path:{...intent,id:"unadmitted-method"},workId:"unadmitted-work",timing:{kind:"unknown"},resources:[{poolId:pool.id,capability:"model-access",units:2}]};}})});
  const processor=new ActivityReconsiderationProcessor(store.activityHandoffs,store.sharedAcceptance,
    (owner,subscription)=>owner==="context-representation"&&subscription.id==="limited-policy-watch"?handler:null);
  const result=await processor.scan("parent",signal);
  assert.deepEqual(result.failures,[]);assert.equal(result.rejected[0].code,"activity_schedule_resource_unavailable");assert.deepEqual(result.accepted,["limited-policy-watch"]);
  assert.equal((await store.contextPolicy.query({kind:"latest",scopeId:scope.id})).decision.investment.reason,"admission_rejected:activity_schedule_resource_unavailable");
  assert.equal(await a({kind:"read_path",pathId:"unadmitted-method"}),null);
  await a({kind:"publish_fact",fact:{id:"limited-unrelated-notification",sourceId:"limited-input-facts",ref:{owner:"context-representation",kind:"observation",id:"unchanged-arrangement",revision:"1"}}});
  const again=await processor.scan("parent",signal);assert.deepEqual(again.failures,[]);assert.equal(proposals,1,"The same rejected arrangement must not be reapplied");
}

exports.verifyNormalReconsideration=async function({store,work,signal}) {
  const {contextPreparationReconsideration}=await import("@agent-anything/agent-runtime/context-representation");
  const {ActivityReconsiderationProcessor}=await import("@agent-anything/agent-runtime/activity");
  const records=await store.contextPolicy.investments({scopeId:"normal-policy-scope",afterWorkId:null,limit:64});
  assert.equal(records.length,1);const original=records[0];
  const status=await work.describe(original.investment.pathId);
  assert.equal(status.state,"ready");assert(status.confirmed.candidates.length);assert(status.used.modelCalls>=2);
  const a=command=>store.activityHandoffs.command(command);
  await a({kind:"publish_fact",fact:{id:"normal-method-ready",sourceId:"normal-input-facts",ref:{owner:"context-representation",kind:"method_result",id:original.investment.pathId,revision:String(status.revision)}}});
  let consultations=0;
  const handler=contextPreparationReconsideration({decisions:store.contextPolicy,activities:store.activityHandoffs,methods:work,resolve:async()=>{
    consultations++;return {policy:original.input,expectedControlRevision:0,execution:()=>{throw new Error("Ready work must not be generated again");}};
  }});
  const rechecks=new ActivityReconsiderationProcessor(store.activityHandoffs,store.sharedAcceptance,
    (owner,subscription)=>owner==="context-representation"&&subscription.id==="normal-policy-watch"?handler:null);
  const first=await rechecks.scan("parent",signal);assert.deepEqual(first.failures,[]);assert.deepEqual(first.rejected,[]);
  const head=await store.contextPolicy.query({kind:"latest",scopeId:"normal-policy-scope"});
  assert.equal(head.decision.investment.kind,"defer");assert.equal(head.decision.investment.reason,"retained_result_requires_recipient_input_organization");
  assert.equal(head.decision.foreground.kind,"continue");
  const count=consultations;await rechecks.scan("parent",signal);assert.equal(consultations,count,"No new facts must not trigger another professional decision");
  assert.equal((await store.contextPolicy.investments({scopeId:"normal-policy-scope",afterWorkId:null,limit:64})).length,1);
};

exports.prepareNormalAdoption=async function({store,work,prepared,scope,proposal}) {
  const {contextPreparationAdoption}=await import("@agent-anything/agent-runtime/context-representation");
  const a=command=>store.activityHandoffs.command(command);
  const sourceId="parent-adoption-facts",subscriptionId="parent-adoption-watch";
  await a({kind:"register_fact_source",source:{id:sourceId,runId:scope.runId,owner:"context-representation"}});
  await a({kind:"publish_fact",fact:{id:"parent-combination-prepared",sourceId,ref:{owner:"context-representation",kind:"prepared_input",id:prepared.preparationStageId,revision:"1"}}});
  await a({kind:"subscribe_reconsideration",subscription:{id:subscriptionId,runId:scope.runId,owner:"context-representation",sources:[sourceId]}});
  const boundary=await a({kind:"read_reconsideration",subscriptionId,limit:64});
  // A later ordinary fact does not mutate the prepared input or invalidate finite B.
  await a({kind:"publish_fact",fact:{id:"parent-later-fact",sourceId,ref:{owner:"context-representation",kind:"observation",id:"next-demand-only",revision:"1"}}});
  const input={scope,boundary:prepared.demand.historyBoundary,requirementsDigest:prepared.demand.id,
    current:{kind:"prepared",prepared,evidence:{owner:"context-representation",kind:"fact",id:prepared.preparationStageId,revision:"1"}},
    currentRejectedInputId:null,alternatives:[],pressure:[],options:[],inFlight:[],explorationHistory:[],optionalInFlight:0,autoPrepare:true,consumerActive:true};
  return contextPreparationAdoption({policy:{id:proposal.id,input,expectedDecisionId:null,expectedControlRevision:0,reconsideration:boundary,execution:null,methods:work},checkedInput:proposal});
};

exports.closeNormalPreparation=async function({store,work,signal}) {
  const {contextPreparationReconsideration}=await import("@agent-anything/agent-runtime/context-representation");
  const {ActivityReconsiderationProcessor}=await import("@agent-anything/agent-runtime/activity");
  const original=(await store.contextPolicy.investments({scopeId:"normal-policy-scope",afterWorkId:null,limit:64}))[0];
  const a=command=>store.activityHandoffs.command(command);
  await a({kind:"publish_fact",fact:{id:"normal-consumers-finished",sourceId:"normal-input-facts",ref:{owner:"context-representation",kind:"consumer_disposition",id:"all-consumers-settled",revision:"1"}}});
  const handler=contextPreparationReconsideration({decisions:store.contextPolicy,activities:store.activityHandoffs,methods:work,resolve:async()=>({policy:{...original.input,consumerActive:false,
    unusedProducers:[{...original.investment,evidence:{owner:"context-representation",kind:"fact",id:"all-consumers-settled",revision:"1"}}]},expectedControlRevision:0,execution:()=>{throw new Error("Closure cannot create work");}})});
  // Other subscriptions have their own owners/inputs; process this entrusted binding only.
  const processor=new ActivityReconsiderationProcessor(store.activityHandoffs,store.sharedAcceptance,
    (owner,subscription)=>owner==="context-representation"&&subscription.id==="normal-policy-watch"?handler:null);
  const result=await processor.scan("parent",signal);assert.deepEqual(result.failures,[]);assert.deepEqual(result.rejected,[]);
  assert.equal((await a({kind:"read_path",pathId:original.investment.pathId})).cancelled,true);
  assert.equal((await a({kind:"read_schedule",workId:original.investment.workId})).closed,true);
  assert.equal((await a({kind:"read_reconsideration",subscriptionId:"normal-policy-watch",limit:64})).state.closed,true);
  const remaining=await a({kind:"read_reconsideration",subscriptionId:"parent-adoption-watch",limit:64});
  assert.deepEqual(remaining.facts.map(f=>f.id),["parent-later-fact"]);
};
