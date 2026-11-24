const assert=require("node:assert/strict");

module.exports=async function({store,load,ports,runtime,structured,protocol,inputSupply=false,shared,ordinary=false}){
  const {ActivityPurposeRegistry,ActivityChangeWait}=await import("@agent-anything/agent-runtime/activity");
  const {HelarcNativeObservation}=await load("context/HelarcNativeObservation.js");
  const {HelarcActivityService}=await load("context/HelarcActivityService.js");
  const {nativeActivityPurposes,frozenNativePurposes,nativeDiscoveryPurposeIds}=await load("context/HelarcNativeActivityPurposes.js");
  const {ActivityHandoffInspectionAdapter}=await load("inspection/ActivityHandoffInspectionAdapter.js");
  const records=[],inspector=new ActivityHandoffInspectionAdapter({
    ref:(owner,kind,id,runId,revision=null)=>({sourceId:"scheduled-native",datasetId:"original",owner,kind,id,runId,revision}),
    offer:record=>{records.push(record);return true;}});
  const registry=shared?.registry??new ActivityPurposeRegistry(),direct=ports.observe;
  let service,failure,active=0,maximumActive=0;
  const original=async runId=>{
    const commit=await store.readRunCommit(`${runId}:commit:0`);assert(commit?.admission);assert.equal(commit.admission.lineage.root.id,"root");return commit;
  };
  const host={assertAvailable(){if(failure)throw failure;service.assertAvailable();},wake:()=>service.wake(),
    subscribe:(listener,interest)=>store.onActivityChange(listener,interest)};
  const authorize=async(path,_stage,signal)=>{signal.throwIfAborted();await original(path.intent.runId);assert.equal(path.intent.permissionBasis,"isolated-tree");return {kind:"allowed"};};
  const work=new HelarcNativeObservation({store,registry,host,now:()=>new Date().toISOString(),rediscoveryMs:50,settlementWaitMs:2000,
    authorize,
    arrange:async state=>{
      const root=await original(state.activity.scope.runId),id=`${state.activity.scope.activityId}:scheduled-observation`;
      return {identity:{id,runId:state.activity.scope.runId,permissionBasis:"isolated-tree",resourceScope:id,scheduledWorkId:id,
        maximumStages:1,maximumAttempts:1,maximumConcurrent:1,deadlineAt:new Date(Date.parse(root.state.startedAt)+root.admission.config.limits.maxDurationMs).toISOString()},
        schedule:{id:`${id}:schedule`,workId:id,runId:state.activity.scope.runId,scopeId:"root-native-model",owner:"model-access",reason:"task",decisionId:id,
          policyRevision:"1",delayImpact:"Original task response",timing:{kind:"unknown"},resources:[{poolId:"native-model",capability:"model-request",units:1}]}};
    },
    observe:async(state,request,mode,signal,preview)=>{
      active++;maximumActive=Math.max(maximumActive,active);assert(active<=1,"Shared model pool must admit one physical task observation");
      try{return await direct(state,request,mode,{cancellation:{signal}},preview);}finally{active--;}
    },
    interrupt:async(state,request)=>{await direct(state,request,"interrupt",{cancellation:{signal:new AbortController().signal}});}
  });
  await store.activityHandoffs.command({kind:"bind_resource_pool",pool:{id:"native-model",revision:"1",authority:"isolated-tree",capacity:1}});
  let inputs=null,methods=null,publications=null;
  if(inputSupply){
    const {bindHelarcNativeContextMethods}=await load("context/HelarcNativeContextMethods.js"),{bindHelarcNativeTaskInputs}=await load("context/HelarcNativeTaskInputs.js");
    const {SourceMaterialPublicationWork}=await import("@agent-anything/agent-runtime/context-representation");
    publications=shared?.publications??new SourceMaterialPublicationWork(store.activityHandoffs,registry,{materials:store.materialCustody,selections:store.contextSelections,authorize,now:()=>new Date().toISOString()});
    await store.activityHandoffs.command({kind:"bind_resource_pool",pool:{id:"native-local",revision:"1",authority:"isolated-tree",capacity:2}});
    methods=bindHelarcNativeContextMethods({store,registry,authorize,now:()=>new Date().toISOString(),model:structured.methodParticipant});
    inputs=bindHelarcNativeTaskInputs({store,registry,methods,publications,host,authorize,purposes:frozenNativePurposes(nativeActivityPurposes(protocol,"2")),now:()=>new Date().toISOString(),rediscoveryMs:25,settlementWaitMs:5000,
      authorizeDemand:async(demand,signal)=>{signal.throwIfAborted();await original(demand.plan.activity.scope.runId);assert.equal(demand.path.intent.permissionBasis,"isolated-tree");},
      conditions:async(arranged,input)=>{
        const scope=arranged.activity.scope,configuration=arranged.activity.composition.composition.configuration,authority="isolated-tree";
        // The synthetic Root with its long Beta result exceeds these limits; its shorter lawful replacement fits.
        const capacity={limits:[{id:"complete-body",targetRevision:`${configuration.configuration.id}:${configuration.configuration.revision}`,dimension:"request_bytes",maximum:ordinary?(configuration.protocol.id==="openai.responses"?50000:44000):1000000,source:"host"}],
          reservations:[],policy:{id:"controlled-native-input",revision:"1",purpose:scope.purpose.id,basis:"Complete bytes; token capacity unknown",allowUnknown:true,allowEstimatedFit:false},maximumCombinations:4,maximumMeasurements:0};
        return {revision:"1",settingsRevision:"controlled:1",sequence:input.iteration,inputRevision:0,representationContinuity:scope.runId,autoPrepare:ordinary,
          maximumSourceBytes:2000000,maximumReadBytes:2000000,capacity,methodCapacity:{...capacity,limits:capacity.limits.map(l=>({...l,maximum:1000000})),policy:{...capacity.policy,purpose:"context_representation"}},
          bounds:{readBytes:2000000,storedBytes:100000,modelCalls:6,repairs:1,levels:3,pageBytes:4096,ranges:16},limits:{maximumStages:128,maximumAttempts:128},
          schedulingScopeId:"root-native-model",resources:[...["material-read","material-write"].map(capability=>({poolId:"native-local",capability,units:1})),
            ...["model-access","model-measurement"].map(capability=>({poolId:"native-model",capability,units:1}))],
          continuity:configuration.protocol.id==="openai.responses"?{kind:"responses",policy:"native_replay",previous:null,
            conditions:{basis:"original",authorized:true,disclosureRevision:authority,remoteStorage:false,targetSupport:"established",predecessor:"unavailable",reestablish:false,policyChange:false}}:{kind:"explicit"}};
      }});
    ports.inputPreparation={select:(...args)=>inputs.waiting.select(...args),restore:(...args)=>inputs.waiting.restore(...args),interrupt:(...args)=>inputs.waiting.interrupt(...args)};
  }
  const options={store,purposes:registry,purposeIds:inputSupply?nativeDiscoveryPurposeIds:[runtime.PROTOCOL_OBSERVATION_PURPOSE.ref.id],rediscoveryMs:10,
    reconsideration:(owner,sub)=>owner==="model-access"&&sub.binding?.kind==="activity_path"?work.work.lifecycle:
      owner==="material-source"&&publications?(sub.id===`${sub.binding?.id}:source-lifecycle`?publications.lifecycle:publications.deliveries):
        inputs?.reconsideration(owner,sub)??methods?.reconsideration(owner,sub)??null,
    report:async cycle=>{failure??=cycle.runs.flatMap(r=>r.result.failures)[0]?.error??cycle.failures[0]?.error??cycle.reconsiderations.flatMap(r=>r.result.failures)[0]?.error;}};
  ports.observe=(...args)=>work.observe(...args);
  return {host,activate(){assert(!service);service=new HelarcActivityService(options);},close:()=>service?.close(),verify:async tree=>{
    const wake=new ActivityChangeWait(host,AbortSignal.timeout(5000));let paths=0,inputPaths=0;
    try{for(const member of tree.members)for(const item of member.head.state.items){
      if(item.payload.kind!=="controller_turn")continue;
      const evidence=item.payload.modelItems.find(m=>m.kind==="native_purpose_evidence")?.evidence;if(!evidence)continue;
      const id=`${evidence.scope.activityId}:scheduled-observation`;
      for(;;){const version=wake.version;host.assertAvailable();const schedule=await store.activityHandoffs.command({kind:"read_schedule",workId:id});
        assert(schedule);if(schedule.settlementConfirmed)break;await wake.wait(version,50);}
      const path=await store.activityHandoffs.command({kind:"read_path",pathId:id}),stage=await store.activityHandoffs.command({kind:"read_stage",requestId:`${id}:observe`});
      assert.equal(stage.status,"accepted");assert.equal(stage.attemptCount,1);assert.equal(path.progress.kind,"protocol_observation_result");
      assert.equal(path.progress.activityId,evidence.scope.activityId);
      inspector.observeStage(path,stage);
      if(inputs){
        const demandId=`${evidence.scope.activityId}:input-demand`,needId=`${demandId}:need`;
        for(;;){const version=wake.version;host.assertAvailable();
          if((await store.inputSupplies.query({kind:"exit",needId}))?.status==="closed")break;await wake.wait(version,25);}
        const ready=await inputs.demand.result(demandId);assert.equal(ready.kind,"ready");
        const selected=await store.contextSelections.command({kind:"binding",inputId:ready.value.inputId,checkCurrentControl:true});
        assert.equal(selected.input.activityId,evidence.scope.activityId);assert.equal(ready.source.attemptCount,1);
        const waiting=await store.activityHandoffs.command({kind:"read_schedule",workId:demandId});assert.equal(waiting.settlementConfirmed,true);
        inspector.observeStage(ready.path,ready.source);inputPaths++;
      }
      const links=records.flatMap(record=>record.links??[]);
      assert(links.some(l=>l.from.id===stage.request.id&&l.to.id===evidence.scope.activityId&&l.to.owner==="protocol-execution"&&l.to.kind==="model-activity"&&l.to.runId===member.head.state.run.id));
      assert(links.some(l=>l.from.id===stage.request.id&&l.to.id===path.progress.observation.id&&l.to.owner==="protocol-execution"));
      assert(links.some(l=>l.from.id===stage.request.input.input.id&&l.from.owner==="protocol-content"&&l.to.id===stage.request.id));
      paths++;
    }}finally{wake.close();}
    assert.equal(active,0);assert(records.every(r=>r.subject.kind!=="turn"));
    return {paths,maximumActive,sharedPoolCapacity:1,inspectedNativeDelegations:paths,inputDemands:inputPaths};
  }};
};
