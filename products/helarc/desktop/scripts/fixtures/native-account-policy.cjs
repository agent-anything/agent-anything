const assert=require("node:assert/strict"),{writeFile}=require("node:fs/promises"),{join}=require("node:path"),{pathToFileURL}=require("node:url");
module.exports=async function(p){
  const {app,store,registry,processor,methods,phase,protocolName,composition,signal,now,authorize,intent,accept,h,publications,
    originalItems,originalSources,schedule,resources,directory,supply,keep=false,originalResult=null}=p;
  const {modelInputValueDigest:digest}=await import("@agent-anything/model-interaction/input");
  const {ActivityReconsiderationProcessor,activityFactSourceId}=await import("@agent-anything/agent-runtime/activity");
  const a=c=>store.activityHandoffs.command(c),scope={id:"native-normal-policy",runId:"root",recipient:"agent",purpose:"task",owner:"context-representation",
    continuity:"task",target:"original:1",authorityBasis:"original-disclosure"};
  const capacity={...supply.request.capacity,policy:{...supply.request.capacity.policy,purpose:scope.purpose},
    limits:[{id:"body-limit",targetRevision:scope.target,dimension:"request_bytes",maximum:keep?100000:3000,source:"host"}]};
  const {bindProtocolModelActivity}=await import("@agent-anything/agent-runtime/model-access");
  const activity=bindProtocolModelActivity({composition,scope:{runId:"root",recipientId:"agent",activityId:"original-native-task",purpose:composition.composition.task.purpose,compositionDigest:composition.digest},
    conditions:{input:{id:"original-task-source",revision:"1"},authority:{id:"original-disclosure",revision:"1"},resources:{id:"bounded",revision:"1"},control:{id:"active",revision:"1"}}});
  const bodyValue={model:composition.composition.configuration.model,[protocolName==="responses"?"input":"messages"]:originalItems,...(protocolName==="responses"?{store:false}:{})};
  const prepared={format:"helarc.native-prepared-task.v1",binding:{scope:activity.scope,protocol:composition.composition.protocol},previous:null,
    sourceDigest:"original-task-source",wire:{body:JSON.stringify(bodyValue),digest:digest(bodyValue)},workingSources:originalSources,
    results:originalResult?[{callId:originalResult.modelCallRef.id,position:`/${protocolName==="responses"?"input":"messages"}/2`,contentDigest:digest(originalItems[2])}]:[],delivery:[]};
  const continuity=protocolName==="responses"?{kind:"responses",policy:"native_replay",previous:null,conditions:{basis:"original",authorized:true,disclosureRevision:scope.authorityBasis,remoteStorage:false,
    targetSupport:"established",predecessor:"unavailable",reestablish:false,policyChange:false}}:{kind:"explicit"};
  const demandId="original-native-input-demand",inputNeed={kind:"native_input_need",revision:"1",needId:demandId+":need",scope,
    consumer:{activityId:"original-native-task",protocol:composition.composition.protocol,compositionDigest:composition.digest}};
  const demand=new h.HelarcNativeInputDemandWork({activities:store.activityHandoffs,selections:store.contextSelections,authorize,now},registry);
  const demandPlan={revision:"1",activity,prepared,inputNeed,capacity,...originalResult?{resultSources:{runId:"root",results:[originalResult]}}:{}};
  if(!await a({kind:"read_path",pathId:demandId}))await accept({id:demandId+":start",scope:"root",actor:scope.owner,parts:demand.prepareSubmission(intent(demandId),demandPlan)});
  let originalDemand;
  for(let n=0;n<4;n++){originalDemand=await demand.result(demandId);if(originalDemand.kind!=="pending")break;assert.deepEqual((await processor.drain("root",signal)).failures,[]);}
  assert(["needed","ready"].includes(originalDemand.kind));
  const inputSupply={needId:inputNeed.needId,runId:"root",owner:scope.owner,consumerPathId:demandId,
    source:{stageId:originalDemand.source.request.id,requestDigest:digest(originalDemand.source.request)},configuration:{id:"original",revision:"1"}};
  const original=new h.HelarcNativeOriginalInputWork({activities:store.activityHandoffs,materials:store.materialCustody,representations:store.representations,authorize,now},registry);
  const originalId="original-native-preparation",supplySchedule={...schedule("original-supply-work"),delegatedPathOwners:["material-source"]};
  const receiver=new h.HelarcNativeAccountReceptionWork({activities:store.activityHandoffs,methods,materials:store.materialCustody,representations:store.representations,authorize,now},registry);
  const resultReceiver=new h.HelarcNativeResultReceptionWork({activities:store.activityHandoffs,methods,materials:store.materialCustody,representations:store.representations,authorize,now},registry);
  const receivingOwner=async pathId=>{const path=await a({kind:"read_path",pathId});
    const owner=[receiver,resultReceiver].find(r=>r.purpose.digest===path?.intent.purpose.digest);assert(owner,"Original receiving owner required");return owner;};
  const policy=new h.HelarcNativeInputPreparation({activities:store.activityHandoffs,decisions:store.contextPolicy,selections:store.contextSelections,
    responsibilities:store.inputSupplies,methods:new h.HelarcNativePreparationMethods({activities:store.activityHandoffs,local:methods,compact:null}),original});
  const basis=(arrangement)=>({originalPathId:originalId,autoPrepare:!keep,rejectedInputs:[],observation:{settingsRevision:"fixed",sequence:0,inputRevision:0,representationContinuity:"original"},
    supply:{items:originalItems,sources:originalSources,publications:arrangement.groups,sourceRecipient:{runId:"root",recipient:"agent",purpose:"task"},target:scope.target,
      authorizationBasis:scope.authorityBasis,composition,backgroundGroupIds:["goal"],capacity:supply.request.capacity,bounds:supply.request.bounds,limits:supply.option.limits,addresses:[]},
    reception:{input:{activity,prepared,scope,publications:arrangement.groups,history:arrangement.preparation.plan.history,continuity,capacity,maximumReadBytes:1000000},inputNeed,inputSupply,
      checkConditions:{capacity:{...supply.request.capacity,policy:{...supply.request.capacity.policy,purpose:"context_representation"}},bounds:supply.request.bounds}},
    execution:(id,limits)=>({path:{...intent(id),...limits},workId:id+":work",schedulingScopeId:"tree",resources,timing:{kind:"unknown"}})});
  const subscriptionId=inputNeed.needId+":supply";
  const handler=new h.HelarcNativeInputSupply({activities:store.activityHandoffs,responsibilities:store.inputSupplies,demand,publications,original,
    receivers:{prepareClosure:async(pathId,basis,signal)=>(await receivingOwner(pathId)).prepareClosure(pathId,basis,signal)},
    authorize:async current=>{assert.equal(current.path.intent.permissionBasis,"original-disclosure");},
    resolve:async(current,origin,signal)=>{
      assert.deepEqual(origin,inputSupply);
      const planned=await h.planHelarcNativeInputPublications({demand:current,activities:store.activityHandoffs,maximumSourceBytes:1000000,signal});
      const resultSources=await h.planHelarcNativeResultPublications({demand:current,activities:store.activityHandoffs,materials:store.materialCustody,maximumSourceBytes:1000000,signal});
      let preparation=null;
      if(planned.history.published){
        const published=planned.history.published,description=await store.materialCustody.command({kind:"describe",holdId:published.access.holdId,recipient:published.access.recipient});
        preparation={intent:{...intent(originalId),scheduledWorkId:supplySchedule.workId},plan:{revision:"1",inputSupply,scope,history:{record:published.representation,hold:description.hold},
          inputId:"original-native-option",selectionId:"original-native-selection",continuity,maximumReadBytes:1000000}};
      }
      return {...planned,resultSources,publications:[...planned.publications,...resultSources.publications],scheduling:supplySchedule,preparation};
    },
    decide:(current,arrangement,snapshot,signal)=>{
      const source=basis(arrangement);
      const supplies=[h.helarcNativeAccountPreparationSupply(source,{activities:store.activityHandoffs,methods,receiver})];
      if(originalResult)supplies.push(h.helarcNativeResultPreparationSupply({methods:{activity,authorizationBasis:scope.authorityBasis,
        capacity:supply.request.capacity,bounds:supply.request.bounds,limits:supply.option.limits},sources:arrangement.resultSources.sources,exclusions:arrangement.resultSources.exclusions,
        reception:{input:{activity,prepared,scope,input:demandPlan.resultSources,history:arrangement.preparation.plan.history,continuity,capacity,maximumReadBytes:1000000},inputNeed,inputSupply},rejectedInputs:[]},
        {activities:store.activityHandoffs,methods,receiver:resultReceiver}));
      return policy.prepare({...source,inputSupply,demand:current,supplies},snapshot,signal);
    }});
  const review=new ActivityReconsiderationProcessor(store.activityHandoffs,store.sharedAcceptance,(_owner,s)=>s.id===subscriptionId?handler:
    s.id.endsWith(":production-lifecycle")?methods.lifecycle:s.id.endsWith(":reception")?{prepare:async(snapshot,signal)=>(await receivingOwner(s.binding.id)).prepare(snapshot,signal)}:null);
  const originalAccept=store.sharedAcceptance.accept.bind(store.sharedAcceptance);
  store.sharedAcceptance.accept=async proposal=>{
    const result=await originalAccept(proposal);
    if(result.outcome==="accepted"&&(phase==="purpose"||phase==="combination")&&proposal.parts.some(p=>p.owner==="protocol_execution"&&p.kind==="purpose")){
      app.exit(73);await new Promise(()=>{});
    }
    if(result.outcome==="accepted"&&phase==="readiness"&&proposal.parts.some(p=>p.owner==="context_input_supply"&&p.kind==="native_input_return")){
      app.exit(73);await new Promise(()=>{});
    }
    return result;
  };
  for(let n=0;n<128;n++){
    const progress=await processor.drain("root",signal);assert.deepEqual(progress.failures,[]);
    if(phase==="ready"){
      const accepted=await store.contextPolicy.investments({scopeId:scope.id,afterWorkId:null,limit:16});
      if(accepted.length&&(await methods.result(accepted[0].investment.pathId)).kind==="ready"){app.exit(73);await new Promise(()=>{});}
    }
    const checked=await review.scan("root",signal);assert.deepEqual(checked.failures,[]);assert.deepEqual(checked.rejected,[]);
    const finished=await store.inputSupplies.query({kind:"exit",needId:inputNeed.needId});
    if(finished?.status==="closed"){
      if(keep)break;
      const latest=await store.contextPolicy.query({kind:"latest",scopeId:scope.id});
      const receptionId=latest.input.inputReceptions[0].pathId;
      if((await a({kind:"read_reconsideration_state",subscriptionId:receptionId+":reception"})).closed)break;
    }
  }
  assert.equal(phase,"verify");const ready=await demand.result(demandId);assert.equal(ready.kind,"ready");
  const captured=await h.planHelarcNativeInputPublications({demand:{...ready,kind:"needed"},activities:store.activityHandoffs,maximumSourceBytes:1000000,signal});
  const historyStage=await a({kind:"read_stage",requestId:captured.history.pathId+":capture"});
  const historyCapture={stageId:historyStage.request.id,receipt:historyStage.receipt.id,result:historyStage.result.id,attempt:historyStage.attempt.id};
  const bodies=await h.planHelarcNativeResultPublications({demand:{...ready,kind:"needed"},activities:store.activityHandoffs,materials:store.materialCustody,maximumSourceBytes:1000000,signal});
  const sourceReceipts=[];
  for(const source of [...captured.publications,...bodies.publications]){
    const stage=await a({kind:"read_stage",requestId:source.pathId+":capture"});
    assert.equal(stage.attemptCount,1);sourceReceipts.push({stageId:stage.request.id,receipt:stage.receipt.id,result:stage.result.id,attempt:stage.attempt.id});
  }
  const originalPreparation=await a({kind:"read_stage",requestId:originalId+":stage:1"});assert.equal(originalPreparation.status,"accepted");assert.equal(originalPreparation.result.value.readiness.allowed,keep);
  const selected=await store.contextSelections.command({kind:"binding",inputId:ready.value.inputId,checkCurrentControl:true});
  const body=JSON.parse(selected.input.exactInput.wire.body),items=body.input??body.messages;
  if(keep)assert.deepEqual(items,originalItems);
  else if(originalResult){
    assert.equal(items.length,originalItems.length);assert.deepEqual(items.slice(0,2),originalItems.slice(0,2));
    const output=JSON.parse(items[2][protocolName==="responses"?"output":"content"]),expected=structuredClone(originalResult.content);
    assert(output.result.output.summary.includes("7391")&&output.result.output.summary.includes("unconfirmed"));
    expected.output.summary=output.result.output.summary;assert.deepEqual(output,{settlement:originalResult.settlement,result:expected});
    assert.equal(selected.input.exactInput.workingSources.groups.find(g=>g.id==="result").protection.includes("first_delivery"),true);
  }else{assert.equal(items.length,2);assert.deepEqual(items[0],originalItems[0]);assert(items[1].content.includes("7391"));}
  const latest=await store.contextPolicy.query({kind:"latest",scopeId:scope.id}),investments=await store.contextPolicy.investments({scopeId:scope.id,afterWorkId:null,limit:16});
  assert.equal(investments.length,keep?0:1);if(!keep)assert.equal(investments[0].decision.investment.reason,"necessary");assert.equal(latest.decision.foreground.adoption,keep?"keep":"propose");
  const receive=latest.input.inputReceptions[0],realized=receive?await a({kind:"read_stage",requestId:receive.pathId+":stage:1"}):null;
  assert.equal((await store.inputSupplies.query({kind:"exit",needId:inputNeed.needId})).status,"closed");
  for(const entry of investments){
    const work=await a({kind:"read_schedule",workId:entry.investment.workId});
    assert.equal(work.settlementConfirmed,false,"An exited consumer cannot close independent production");
    assert.equal((await a({kind:"read_path",pathId:entry.investment.pathId})).cancelled,false);
  }
  await a({kind:"publish_fact",fact:{id:"fixture-lifetime:root:closed",sourceId:"fixture-lifetime:root",
    ref:{owner:"fixture-scope",kind:"scope_closed",id:"root",revision:"1"}}});
  for(let n=0;n<16;n++){
    assert.deepEqual((await processor.drain("root",signal)).failures,[]);
    const reviewed=await review.scan("root",signal);assert.deepEqual(reviewed.failures,[]);assert.deepEqual(reviewed.rejected,[]);
  }
  for(const entry of investments)assert.equal((await a({kind:"read_schedule",workId:entry.investment.workId})).settlementConfirmed,true);
  const load=path=>import(pathToFileURL(join(__dirname,"../../dist/main",path)));
  const {HelarcInspection}=await load("inspection/HelarcInspection.js"),{InspectionQueryService}=await import("@agent-anything/inspection/query");
  const inspection=await HelarcInspection.create(join(directory,"inspection-settings.json"),join(directory,"inspection")),queries=new InspectionQueryService(join(directory,"inspection"));
  let health;
  try{await inspection.activityObserver.replay("root",store.activityHandoffs);await inspection.contextFoundationObserver.replay("root",store.contextFoundationFacts.bind(store));
    await require("./inspection-settlement.cjs").settleInspection(inspection.recorder,queries);health=inspection.recorder.health();assert.equal(health.dropped,0);assert.equal(health.rejected,0);
  }finally{await queries.close();await inspection.close();}
  const calls=keep?0:originalResult?4:5;
  const facts=await store.protocolJournal.command({kind:"facts",runId:"root",after:0,limit:128});assert.equal(facts.filter(f=>f.kind==="purpose_accepted").length,calls);
  await writeFile(join(directory,"verification.json"),JSON.stringify({protocol:protocolName,generation:store.generation,normalPolicy:true,
    completeOriginalInputDisallowed:!keep,nativeCapacityEvidence:true,automaticInvestments:investments.length,modelCalls:calls,accepted:calls,optionalInstructions:false,
    declaredResultBody:!!originalResult,firstDeliveryPreserved:!!originalResult,
    productionLifetime:{consumerExitDidNotCancelProducer:true,scopeExitSettledProducers:investments.map(i=>i.investment)},
    ...(keep?{originalPreparation:{pathId:originalId,receipt:originalPreparation.receipt.id,body:selected.input.exactInput.wire.body,originalDemandReceipt:originalDemand.source.receipt.id}}:{}),
    originalSourceRetained:true,sourceReceipts,syntheticGenericRequests:0,combination:{historyCapture,readiness:{inputId:ready.value.inputId},
      ...(receive?{reception:{pathId:receive.pathId,realizationReceipt:realized.receipt.id,originalDemandReceipt:originalDemand.source.receipt.id,cleanupClosed:true}}:{})},inspection:health},null,2));
};
