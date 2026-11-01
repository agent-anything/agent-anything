const {app}=require("electron");
const assert=require("node:assert/strict");
const {join}=require("node:path");
const {pathToFileURL}=require("node:url");
const {writeFile,readFile}=require("node:fs/promises");
const [directory,phase,endpoint]=process.argv.slice(2);
app.setPath("userData",join(directory,"electron"));app.disableHardwareAcceleration();
let store,service,inspection,queries;
const taskRunner=process.env.ACTIVITY_TASK_RUNNER==="1",interruptTask=process.env.ACTIVITY_INTERRUPT_TASK==="1";
const taskPreparation=process.env.ACTIVITY_TASK_PREPARATION;
const multipleTurns=process.env.ACTIVITY_TASK_MULTIPLE_TURNS==="1";
const unavailableSource=process.env.ACTIVITY_SOURCE_UNAVAILABLE==="1";
const taskAuthorization=process.env.ACTIVITY_TASK_AUTHORIZATION==="1";
const authorizationPhases=["need","materials","restricted-preparation","selected","restricted-dispatch","response","restricted-interpretation","finish"];
const authorizationRestrictions={
  "restricted-preparation":{pathId:"input-preparation",requestId:"input-preparation:stage:1",stageKind:"organize",action:"execution",
    refusal:{kind:"temporary",code:"fixture_preparation_execution_pending",message:"Original input preparation execution authority is temporarily unavailable"}},
  "restricted-dispatch":{pathId:"task",requestId:"task:model",stageKind:"model",action:"execution",
    refusal:{kind:"temporary",code:"fixture_task_execution_pending",message:"Original task execution authority is temporarily unavailable"}},
  "restricted-interpretation":{pathId:"task",requestId:"task:model",stageKind:"model",action:"interpretation",
    refusal:{kind:"temporary",code:"fixture_task_interpretation_pending",message:"Original task response interpretation authority is temporarily unavailable"}},
};
let runnerHandle,runnerResult;
async function main() {
  await app.whenReady();
  if(taskAuthorization){assert(authorizationPhases.includes(phase));assert(!taskRunner&&!interruptTask&&!taskPreparation&&!multipleTurns&&!unavailableSource&&!process.env.ACTIVITY_LIVE_MODEL);}
  const load=path=>import(pathToFileURL(join(__dirname,"../../dist/main",path)));
  const {HelarcExecutionStore}=await load("execution-storage/HelarcExecutionStore.js");
  const {HelarcActivityService}=await load("context/HelarcActivityService.js");
  const {createHelarcTaskResponseExecution}=await load("context/HelarcTaskResponseExecution.js");
  const {supplyHelarcTaskMethodInput}=await load("context/HelarcTaskInputSupply.js");
  const {ActivityPurposeRegistry}=await import("@agent-anything/agent-runtime/activity");
  const {retainTaskDecisionSource,createTaskModelResponseHandoff,readTaskModelResponseHandoff,projectModelInteraction,createControllerInputDeliveryReceipt}=await import("@agent-anything/agent-runtime/decision");
  const {SourceMaterialPublicationWork,ContextInputPreparationWork,TaskInputSupply,planOriginalInputPublications,prepareOriginalInputSelection,contextPreparationReconsideration,quoteRepresentationMethod,readContextPreparationHistory,RepresentationMethodWork,recipientContextDeliveryId}=await import("@agent-anything/agent-runtime/context-representation");
  const {createHelarcTaskInputSources}=await import("@agent-anything/helarc/prompt");
  const {modelInputValueDigest:digest,organizeOriginalInput}=await import("@agent-anything/model-interaction/input");
  const {OllamaProvider}=await import("@agent-anything/provider-integrations/ollama");
  const provider=new OllamaProvider({model:process.env.ACTIVITY_LIVE_MODEL??"controlled",baseUrl:endpoint,timeoutMs:60000,think:false,
    nativeToolInteraction:{supported:true},runtime:{contextWindowTokens:16384},requestBodyTransportLimit:{maximumBytes:1000000,source:"host_configured",revision:"1"}});
  store=await HelarcExecutionStore.open(join(directory,"execution"));
  const a=command=>store.activityHandoffs.command(command),now=()=>new Date().toISOString(),registry=new ActivityPurposeRegistry();
  const deliveryLifetime={source:{id:"fixture-scope:root",runId:"root",owner:"fixture-host"},closedFactId:"fixture-scope:root:closed"};
  await a({kind:"register_fact_source",source:deliveryLifetime.source});
  const authorize=async(path,stage,_signal,action)=>{
    assert.equal(path.intent.permissionBasis,"isolated-host");
    const restriction=taskAuthorization?authorizationRestrictions[phase]:null;
    if(restriction&&path.intent.id===restriction.pathId&&stage?.request.stageKind===restriction.stageKind&&action===restriction.action) {
      assert.equal(stage.request.id,restriction.requestId);return restriction.refusal;
    }
    return {kind:"allowed"};
  };
  const activityFacts=async pathId=>{
    const facts=[];
    for(let after=0;;) {
      const page=await a({kind:"facts",runId:"root",pathId,after,limit:128});facts.push(...page);
      if(page.length<128)return facts;after=page.at(-1).sequence;
    }
  };
  const readAuthorizationState=async()=>{
    const source=await a({kind:"read_stage",requestId:"task:source"}),need=await a({kind:"read_input_need",id:"task:input-need"});
    const preparation=await a({kind:"read_stage",requestId:"input-preparation:stage:1"}),task=await a({kind:"read_stage",requestId:"task:model"});
    const taskPath=await a({kind:"read_path",pathId:"task"}),preparationPath=await a({kind:"read_path",pathId:"input-preparation"});
    const selection=task?await store.contextSelections.command({kind:"binding",inputId:"task:model:input",checkCurrentControl:true}):null;
    const restrictions=[];
    for(const path of [taskPath,preparationPath])if(path)restrictions.push(...(await activityFacts(path.intent.id)).filter(f=>f.kind==="authorization_restricted"));
    restrictions.sort((a,b)=>a.sequence-b.sequence);
    return {source,need,preparation,task,taskPath,preparationPath,selection,restrictions};
  };
  const readAuthorizationCheckpoint=async name=>JSON.parse(await readFile(join(directory,`authorization-${name}.json`),"utf8"));
  const saveAuthorizationCheckpoint=async()=>{
    const state=await readAuthorizationState();assert.equal(state.source.status,"accepted");assert(state.need);
    const checkpoint={phase,generation:store.generation,state,restriction:authorizationRestrictions[phase]??null};
    await writeFile(join(directory,`authorization-${phase}.json`),JSON.stringify(checkpoint));return checkpoint;
  };
  const built=await require("./task-input-source.cjs")(provider);
  const original={kind:"task_model_source",record:retainTaskDecisionSource(built.source),request:built.request,protocol:{kind:"native_tool_turn"}};
  const publications=new SourceMaterialPublicationWork(store.activityHandoffs,registry,{materials:store.materialCustody,selections:store.contextSelections,now,authorize:async(path,stage,signal,action)=>{
    const authorized=await authorize(path,stage,signal,action);if(authorized.kind!=="allowed")return authorized;
    if(unavailableSource)return {kind:"denied",code:"source_denied",message:"Original source publication is not authorized",
      decision:{owner:"fixture-host",id:"original-source-denial",revision:"1"}};
    return authorized;
  }});
  const preparation=new ContextInputPreparationWork(store.activityHandoffs,registry,{provider,materials:store.materialCustody,authorize,now});
  const methods=new RepresentationMethodWork({provider,materials:store.materialCustody,representations:store.representations,selections:store.contextSelections,activities:store.activityHandoffs,authorize,now},registry);
  const path=(id,work)=>({id,runId:"root",permissionBasis:"isolated-host",resourceScope:id,scheduledWorkId:work,
    maximumStages:16,maximumAttempts:16,maximumConcurrent:1,deadlineAt:"2030-01-01T00:00:00Z"});
  const schedule=(workId,owner,reason,resources,delegatedPathOwners=[])=>({id:`schedule:${workId}`,workId,runId:"root",scopeId:"scope",owner,reason,
    decisionId:`entrusted:${workId}`,policyRevision:"isolated:1",delayImpact:"Original consumer needs its exact input",timing:{kind:"unknown"},resources,delegatedPathOwners});
  const responseEvents=[];
  const execution=createHelarcTaskResponseExecution({provider,purposes:registry,activities:store.activityHandoffs,acceptance:store.sharedAcceptance,
    selections:store.contextSelections,authorize,now,rediscoveryMs:10,settlementWaitMs:5000,
    host:{assertAvailable:()=>service.assertAvailable(),subscribe:listener=>store.onActivityChange(listener),wake:()=>service.wake()},
    preparations:{resume:async()=>{service.assertAvailable();service.wake();}},
    arrange:source=>{
      assert(source.iteration===1?phase==="need":multipleTurns&&phase==="finish","Recovery must not reconstruct original Product input");
      const id=source.iteration===1?"task":`task:${source.iteration}`;
      return {identity:path(id,id),schedule:schedule(id,"task-decision","task",[{capability:"model-request",poolId:"model",units:1}])};
    }},{...built.binding,delivery:{mode:"buffered",observer:{observe:event=>{
      responseEvents.push(event);
      throw new Error("Deliberate presentation failure must not change execution");
    }}}});
  const task=execution.work;
  const supplySchedule=schedule("input-supply","context-representation","necessary",[
    {capability:"material-write",poolId:"local",units:1},{capability:"model-measurement",poolId:"model",units:1}],["material-source"]);
  const target=provider.encodeInput(original.request,"buffered").targetDigest;
  const recipient={runId:"root",recipient:built.agent.id,purpose:original.request.purpose};
  const methodRecipient={...recipient,recipient:"context-representation"};
  const scope={...recipient,id:"scope",continuity:"task",owner:"context-representation",target,authorityBasis:"isolated-host"};
  if(unavailableSource&&phase==="unavailable") {
    const accept=store.sharedAcceptance.accept.bind(store.sharedAcceptance);
    store.sharedAcceptance.accept=async proposal=>{
      const receipt=await accept(proposal);
      if(receipt.outcome==="accepted"&&proposal.parts.some(part=>part.kind==="stage_submission"&&part.proposal.id==="task:input-unavailable")){
        app.exit(73);return new Promise(()=>{});
      }
      return receipt;
    };
  }
  if(phase==="selected"&&taskPreparation){
    const originalAccept=store.sharedAcceptance.accept.bind(store.sharedAcceptance);
    store.sharedAcceptance.accept=async proposal=>{
      const adopting=proposal.parts.some(p=>p.owner==="context_selection"&&p.kind==="selection_input");
      if(adopting&&taskPreparation==="accepted"){
        const invalidId=`${proposal.id}:invalid-control`;
        const invalid={...proposal,id:invalidId,parts:proposal.parts.map(p=>p.owner==="context_preparation_policy"?{...p,proposal:{...p.proposal,expectedControlRevision:1}}:
          p.kind==="selection_input"||p.kind==="reconsideration_acceptance"?{...p,proposal:{...p.proposal,id:invalidId}}:p)};
        const rejected=await originalAccept(invalid);
        assert.equal(rejected.outcome,"rejected");assert.equal(rejected.rejection.code,"decision_control_changed");
        assert.equal(await store.contextPolicy.query({kind:"latest",scopeId:scope.id}),null);
        assert.equal(await a({kind:"read_stage",requestId:"task:model"}),null);
        assert.equal(await a({kind:"read_path",pathId:"background-preparation"}),null);
        assert.equal(await a({kind:"read_schedule",workId:"background-preparation-work"}),null);
        assert.equal(await store.representations.command({kind:"read_judgment",id:proposal.parts.find(p=>p.kind==="judge").proposal.id}),null);
        await assert.rejects(store.contextSelections.command({kind:"current_control",scopeId:scope.id}),/input_scope_missing/);
        await writeFile(join(directory,"rollback-verification.json"),JSON.stringify(rejected));
      }
      const receipt=await originalAccept(proposal);
      if(adopting&&receipt.outcome==="accepted"){
        assert.deepEqual(await originalAccept(proposal),receipt,"The same acceptance cannot duplicate input or background work");
        await writeFile(join(directory,"input-acceptance.json"),JSON.stringify(receipt));
        app.exit(73);return new Promise(()=>{});
      }
      return receipt;
    };
  }
  const supply=new TaskInputSupply({activities:store.activityHandoffs,responsibilities:store.inputSupplies,publications,preparation,authorize:async basis=>{await authorize(basis.consumer);},
    resolve:async(basis,signal)=>{
      assert.notEqual(phase,"cancel-unregistered","Exit must not rebuild an absent registration from current configuration");
      const suffix=basis.consumer.intent.id==="task"?"":`:${basis.consumer.intent.id}`;
      const supplyWork=suffix?{...supplySchedule,id:`${supplySchedule.id}${suffix}`,workId:`${supplySchedule.workId}${suffix}`}:supplySchedule;
      const sources=createHelarcTaskInputSources(basis.source.record,basis.source.request);
      const plans=await planOriginalInputPublications({sources,recipient,target,observedAt:"2026-10-30T00:00:00.000Z",maximumSourceBytes:1000000,activities:store.activityHandoffs,signal,deliveryLifetime});
      const demand=organizeOriginalInput({composition:sources.request.composition,demand:{id:`demand${suffix}`,runId:"root",recipient:recipient.recipient,purpose:recipient.purpose,
        targetRevision:target,historyBoundary:sources.boundary,deliveryIds:sources.groups.flatMap(g=>g.deliveries.map(d=>recipientContextDeliveryId(d.id,recipient))),dependencies:{source:sources.id},maximumCombinations:4,maximumExternalMeasurements:0,maximumReadBytes:1000000},
        groups:sources.groups.map(g=>({id:g.id,owner:g.owner,revision:g.revision,sectionIds:g.occurrences.map(o=>o.section.id),duties:g.duties,deliveryIds:g.deliveries.map(d=>recipientContextDeliveryId(d.id,recipient))}))});
      return {configuration:{id:"isolated-original",revision:"1"},sources,scope,schedule:supplyWork,publications:plans,preparation:path(`input-preparation${suffix}`,supplyWork.workId),
        input:{kind:"context_input_preparation",demand,template:sources.request,limits:[],reservations:[],policy:{id:"isolated",revision:"1",purpose:recipient.purpose,
          basis:"Original deployment and estimated token evidence; not exact tokenization",allowEstimatedFit:true,allowUnknown:true},
          allowExternalMeasurement:false,deliveryMode:"buffered",localMeasurements:[],sharedCapacity:null,materialAccesses:plans.flatMap(p=>p.published?[p.published.access]:[])}};
    },
    decide:async(basis,binding,result,snapshot,signal)=>{
      const suffix=basis.consumer.intent.id==="task"?"":`:${basis.consumer.intent.id}`;
      assert.equal(result.kind,"available");assert.equal(result.current.kind,"prepared");const prepared=result.current.prepared;
      assert.equal(prepared.request.instructions.content.length,0);
      const current={scope,boundary:prepared.demand.historyBoundary,requirementsDigest:"unchanged-original:1",current:result.current,currentRejectedInputId:null,
        alternatives:[],pressure:[],options:[],autoPrepare:true,consumerActive:true};
      const taskPublications=binding.publications.filter(p=>p.request.recipient.recipient===recipient.recipient);
      let materialAdmissions=[];
      if(taskPreparation&&!suffix){
        const evidence=id=>({id,owner:"context-representation",revision:"1",kind:"fact"});
        const specification={kind:"representation_method",method:"preserve",methodRevision:"1",recipient:methodRecipient,
          objective:"Retain an exact original representation for a controlled future preparation opportunity, without changing the current task input",
          requirements:[],relationships:[],combinationDigest:null,combine:"keep",omission:null,search:null,
          template:prepared.request,targetRevision:target,capacity:{limits:[],reservations:[],policy:binding.input.policy,maximumCombinations:4,maximumMeasurements:0},
          bounds:{readBytes:1000000,storedBytes:1000000,modelCalls:0,repairs:0,levels:1,pageBytes:65536,ranges:64}};
        const methodSupply=supplyHelarcTaskMethodInput(binding,{consumerId:"background-preparation",specification,
          groups:binding.sources.groups.map((g,i)=>({id:g.id,alias:`source_${i}`,role:"source"}))});
        const request=methodSupply.request;materialAdmissions=methodSupply.materialAdmissions;
        assert(request.sources.every(s=>taskPublications.some(p=>p.published.representation.ref.id===s.representation.id)),"Methods must use the retained original version, not republish it");
        assert(materialAdmissions.every(m=>m.source.recipient.recipient===recipient.recipient&&m.hold.consumer.recipient==="context-representation"));
        const another=supplyHelarcTaskMethodInput(binding,{consumerId:"different-method",specification,
          groups:binding.sources.groups.map((g,i)=>({id:g.id,alias:`source_${i}`,role:"source"}))});
        assert(another.materialAdmissions.every((a,i)=>a.hold.id!==materialAdmissions[i].hold.id),"Independent method consumers cannot share a release responsibility");
        assert.throws(()=>supplyHelarcTaskMethodInput(binding,{consumerId:"wrong",specification,
          groups:[{id:"missing-original",alias:"s",role:"source"}]}),/source_mismatch/);
        const quotation=quoteRepresentationMethod(request);
        current.pressure=[{kind:"growth_scenario",evidence:evidence("controlled-future-opportunity"),timing:null}];
        current.options=[{id:"retain-original",request,stableScope:evidence(current.boundary),addresses:["controlled-future-opportunity"],
          entries:quotation.phases.map(p=>({phase:p.kind,state:"supported",evidence:evidence(`entry:${p.kind}`)})),
          limits:{maximumStages:16,maximumAttempts:16},capability:[],comparisons:[]}];
      }
      const handler=contextPreparationReconsideration({decisions:store.contextPolicy,activities:store.activityHandoffs,methods,
        resolve:async()=>({policy:current,expectedControlRevision:0,
          execution:()=>({path:path("background-preparation","background-preparation-work"),workId:"background-preparation-work",schedulingScopeId:scope.runId,materialAdmissions,
            resources:[{capability:"material-read",poolId:taskPreparation==="rejected"?"unavailable-pool":"local",units:1}],timing:{kind:"unknown"}}),
          prepareInputAcceptance:async(id,decision)=>{
            assert.equal(decision.foreground.kind,"continue");
            const previous=suffix?await store.contextSelections.command({kind:"current",scopeId:scope.id}):null;
            return prepareOriginalInputSelection({id,scope,expectedSelectionId:previous?.id??null,expectedControlRevision:0,selectionId:`selected${suffix}`,prepared,
              sources:createHelarcTaskInputSources(basis.source.record,basis.source.request),publications:taskPublications,
              inputId:`${basis.need.stage.id}:input`,need:basis.need,releaseHolds:[]}).acceptance;
          }})});
      return handler.prepare(snapshot,signal);
    }});
  const accept=async proposal=>{const receipt=await store.sharedAcceptance.accept(proposal);assert.equal(receipt.outcome,"accepted",JSON.stringify(receipt));};
  if(phase==="need") {
    for(const [id,capacity] of [["model",1],["local",2]])await a({kind:"bind_resource_pool",pool:{id,capacity,revision:"1",authority:"isolated-host"}});
    const taskSchedule={...schedule("task","task-decision","task",[{capability:"model-request",poolId:"model",units:1}]),allowedPathIds:["task"]};
    if(!taskRunner)await accept({id:"task-admission",scope:"root",actor:"task-decision",parts:[{owner:"activity",kind:"scheduling_acceptance",proposal:{kind:"schedule_work",intent:taskSchedule,expectedRevision:0}},
      ...task.prepareSubmission(path("task","task"),original)]});
  }
  if(taskAuthorization&&phase!=="need") {
    const previous=await readAuthorizationCheckpoint(authorizationPhases[authorizationPhases.indexOf(phase)-1]);
    assert(store.generation>previous.generation,"Each boundary must reopen the original SQLite execution store");
    const restored=await readAuthorizationState();
    assert.deepEqual(restored,previous.state,"Recovery must read the exact original stages, restrictions, input and response before the service runs");
    const first=await readAuthorizationCheckpoint("need");
    assert.deepEqual(restored.source,first.state.source);assert.deepEqual(restored.need,first.state.need);
  }
  const purposes={resolve:(binding,scope)=>{
    const handler=registry.resolve(binding,scope);
    if(phase==="response"&&binding.contract.ref.id===task.purpose.contract.ref.id)return {authorize:handler.authorize.bind(handler),execute:handler.execute.bind(handler),
      reconcile:handler.reconcile.bind(handler),settle:handler.settle.bind(handler),interpret:async(path,stage,...args)=>{
        if(stage.request.stageKind==="model"){
          assert.equal(stage.result.value.kind,"succeeded");
          assert(responseEvents.length>0,"The original physical response must be observable");
          assert(responseEvents.every(event=>event.runId===path.intent.runId&&event.progress.requestId===stage.request.input.request.requestId));
          await writeFile(join(directory,"response-observations.json"),JSON.stringify(responseEvents));
          if(taskPreparation==="accepted")assert.equal((await a({kind:"read_path",pathId:"background-preparation"})).dispatchedAttempts,0,"Foreground response must not wait for the background producer");
          if(interruptTask){const result=await runnerHandle.steer({commandId:"changed-after-response",expectedRunRevision:runnerHandle.getSnapshot().runRevision,
            instruction:"Do not apply the old ending; report using the new objective.",attribution:{origin:"user",actorId:"fixture"},submittedAt:now()});assert.equal(result.status,"accepted_for_application");}
          if(taskAuthorization) {
            const {state}=await saveAuthorizationCheckpoint(),selected=await readAuthorizationCheckpoint("selected");
            assert.equal(state.task.status,"raw_result");assert.equal(state.task.receipt,null);
            assert.deepEqual(state.task.request,selected.state.task.request);assert.deepEqual(state.selection,selected.state.selection);
            assert.equal(state.task.result.completeness,"complete");assert.equal(state.task.result.outcome,"returned");
            assert.equal(state.task.result.attemptId,state.task.attempt.id);assert.equal(state.task.attempt.inputDigest,digest(state.task.request.input));
            assert.deepEqual(state.task.authorizationRestrictions,{});
          }
          app.exit(73);return new Promise(()=>{});}
        return handler.interpret(path,stage,...args);
      }};
    return handler;
  }};
  let finishing=false;
  if(phase==="cancel-unregistered")await a({kind:"cancel",pathId:"task",expectedControlRevision:0});
  service=new HelarcActivityService({store,purposes,purposeIds:taskAuthorization&&phase==="materials"?[publications.purpose.contract.ref.id]:
    ["selected","exiting",...(taskAuthorization?["restricted-preparation"]:[])].includes(phase)?[publications.purpose.contract.ref.id,preparation.purpose.contract.ref.id]:
    [task.purpose.contract.ref.id,publications.purpose.contract.ref.id,preparation.purpose.contract.ref.id,...(phase==="finish"&&taskPreparation==="accepted"?[methods.purpose.contract.ref.id]:[])],rediscoveryMs:10,
    reconsideration:(owner,subscription)=>owner===task.purpose.contract.acceptanceOwner?task.lifecycle:owner==="material-source"?publications.deliveries:subscription.binding?.kind==="input_need"?supply:null,
    diagnostics:{record:(_stage,_context,error)=>{console.error(error);app.exit(1);}},
    report:async cycle=>{
      assert.deepEqual(cycle.failures,[]);for(const r of cycle.runs)assert.deepEqual(r.result.failures,[]);
      for(const r of cycle.reconsiderations){assert.deepEqual(r.result.failures,[]);
        if(taskPreparation==="rejected")assert(r.result.rejected.every(value=>value.code==="activity_schedule_pool_missing"));else assert.deepEqual(r.result.rejected,[]);}
      const need=await a({kind:"read_input_need",id:"task:input-need"});
      if(phase==="need"&&need){if(taskAuthorization)await saveAuthorizationCheckpoint();app.exit(73);return;}
      const supplyExit=need?await store.inputSupplies.query({kind:"exit",needId:need.id}):null;
      if(phase==="cancel-unregistered"&&supplyExit?.status==="closed"&&!finishing) {
        finishing=true;assert.equal(supplyExit.membershipRevision,0);assert.equal(supplyExit.scheduling,null);
        assert.equal(supplyExit.basis.kind,"cancelled");
        assert.equal(await store.inputSupplies.query({kind:"head",needId:need.id}),null);
        assert.equal(await a({kind:"read_stage",requestId:"task:model"}),null);
        assert.equal(await a({kind:"read_path",pathId:"input-preparation"}),null);
        const {HelarcInspection}=await load("inspection/HelarcInspection.js");
        inspection=await HelarcInspection.create(join(directory,"inspection-settings.json"),join(directory,"inspection"));
        await inspection.activityObserver.replay("root",store.activityHandoffs);
        await inspection.contextFoundationObserver.replay("root",store.contextFoundationFacts.bind(store));
        const {InspectionQueryService}=await import("@agent-anything/inspection/query");queries=new InspectionQueryService(join(directory,"inspection"));
        await require("./inspection-settlement.cjs").settleInspection(inspection.recorder,queries);
        assert.equal(inspection.recorder.health().dropped,0);assert.equal(inspection.recorder.health().rejected,0);
        await writeFile(join(directory,"verification.json"),JSON.stringify({electron:process.versions.electron,generation:store.generation,
          unregisteredCancellationRecovered:true,exit:supplyExit,providerCalls:0,inspection:inspection.recorder.health()},null,2));
        setImmediate(async()=>{await service.close();await queries.close();queries=null;await inspection.close();inspection=null;await store.close();store=null;app.exit(0);});return;
      }
      if(phase==="exiting"&&supplyExit) {
        assert.equal(supplyExit.status,"closing");assert(supplyExit.scheduling);
        const work=await a({kind:"read_schedule",workId:supplyExit.scheduling.workId});
        assert.equal(work.pathsSealed,true);assert.equal(work.closed,false);
        await writeFile(join(directory,"supply-exit-boundary.json"),JSON.stringify(supplyExit));app.exit(73);return;
      }
      if(unavailableSource) {
        const stage=await a({kind:"read_stage",requestId:"task:input-unavailable"});
        if(phase==="unavailable"&&stage?.status==="submitted"){app.exit(73);return;}
        if(phase!=="finish"||finishing||stage?.status!=="accepted"||supplyExit?.status!=="closed"||(await a({kind:"pending_reconsiderations",runId:"root",afterId:null,limit:64})).length)return;
        finishing=true;
        const outcome=await readTaskModelResponseHandoff(store.activityHandoffs,createTaskModelResponseHandoff("task",original));
        assert.equal(outcome.kind,"input_unavailable");assert.equal(outcome.progress.limitation.reason,"original_source_unavailable");
        assert.equal(outcome.progress.limitation.supplier,"context-representation");
        assert.equal(outcome.progress.limitation.evidence[0].owner,"shared_acceptance");
        assert.equal((await store.sharedAcceptance.query(outcome.progress.limitation.evidence[0].id)).outcome,"accepted");
        assert.equal(await a({kind:"read_stage",requestId:"task:model"}),null);assert.equal(await a({kind:"read_path",pathId:"input-preparation"}),null);
        assert.equal(responseEvents.length,0);assert.equal((await a({kind:"read_path",pathId:"task"})).dispatchedAttempts,2);
        const {HelarcInspection}=await load("inspection/HelarcInspection.js");
        inspection=await HelarcInspection.create(join(directory,"inspection-settings.json"),join(directory,"inspection"));
        await inspection.activityObserver.replay("root",store.activityHandoffs);
        const {InspectionQueryService}=await import("@agent-anything/inspection/query");queries=new InspectionQueryService(join(directory,"inspection"));
        const {selection}=await require("./inspection-settlement.cjs").settleInspection(inspection.recorder,queries);
        const stopEvidence=outcome.progress.limitation.evidence[0],stopSubject=inspection.recorder.ref(stopEvidence.owner,"contribution",stopEvidence.id,"root");
        const stopRecord=await queries.query({...selection,kind:"get_subject",subject:stopSubject});
        assert(stopRecord.records.some(record=>record.contents.some(content=>content.name==="Stop scope and remaining execution responsibility")),"Unavailable evidence must resolve to its actual accepted stop");
        const flow=await queries.query({...selection,kind:"get_data_flow",subject:inspection.recorder.ref("activity","contribution","task:input-unavailable","root")});
        assert(flow.graph.links.some(link=>link.kind==="observes"&&digest(link.to)===digest(stopSubject)),"Supplier evidence must point to that same stop object");
        assert.equal(inspection.recorder.health().dropped,0);assert.equal(inspection.recorder.health().rejected,0);
        await writeFile(join(directory,"verification.json"),JSON.stringify({electron:process.versions.electron,generation:store.generation,
          originalNeedRecovered:true,sourceStopEvidence:outcome.progress.limitation.evidence,consumerResult:outcome.kind,providerCalls:0,inspection:inspection.recorder.health()},null,2));
        setImmediate(async()=>{await service.close();await queries.close();queries=null;await inspection.close();inspection=null;await store.close();store=null;app.exit(0);});
        return;
      }
      const preparedPath=await a({kind:"read_path",pathId:"input-preparation"});
      if(taskAuthorization&&phase==="materials"&&preparedPath) {
        const {state}=await saveAuthorizationCheckpoint();
        assert.equal(state.preparation.status,"submitted");assert.equal(state.preparation.attempt,null);assert.equal(state.preparation.result,null);
        assert.equal(state.preparationPath.dispatchedAttempts,0);assert.equal(state.task,null);
        assert(state.preparation.request.input.request.materialAccesses.length>0,"Original materials must already have been published");
        app.exit(73);return;
      }
      if(!taskAuthorization&&phase==="materials"&&preparedPath?.progress?.state==="prepared"){app.exit(73);return;}
      const stage=await a({kind:"read_stage",requestId:"task:model"});
      const restriction=taskAuthorization?authorizationRestrictions[phase]:null;
      if(restriction&&!finishing) {
        const blocked=await a({kind:"read_stage",requestId:restriction.requestId});
        assert(blocked,"The original restricted stage must survive restart");
        assert.equal(blocked.receipt,null,"A restricted action must not have been professionally accepted");
        if(restriction.action==="execution")assert.equal(blocked.attempt,null,"Execution restriction must precede any dispatch");
        if(!blocked.authorizationRestrictions[restriction.action])return;
        assert.deepEqual(blocked.authorizationRestrictions,{[restriction.action]:restriction.refusal});
        assert.equal(blocked.status,restriction.action==="interpretation"?"raw_result":"admitted");
        assert.equal(blocked.receipt,null);assert.equal(blocked.settlement,null);assert.equal(blocked.stop,null);
        const pending=await a({kind:"pending",runId:"root",pathId:restriction.pathId,after:0,limit:64});
        assert(pending.some(p=>p.requestId===restriction.requestId&&p.kind===restriction.action),"The refused action must remain durably pending");
        if(restriction.action==="execution") {
          assert.equal(blocked.attempt,null);assert.equal(blocked.result,null);assert.equal(blocked.rawEvidenceRevision,0);
          assert.equal((await a({kind:"read_path",pathId:restriction.pathId})).dispatchedAttempts,restriction.pathId==="task"?1:0);
          if(restriction.pathId==="input-preparation")assert.equal(stage,null,"Restricted preparation cannot supply the task model stage");
        } else {
          const response=await readAuthorizationCheckpoint("response");
          assert.deepEqual(blocked.request,response.state.task.request);assert.deepEqual(blocked.attempt,response.state.task.attempt);
          assert.deepEqual(blocked.result,response.state.task.result);assert.deepEqual(blocked.processing,response.state.task.processing);
          assert.equal(blocked.rawEvidenceRevision,response.state.task.rawEvidenceRevision);
          assert.equal(responseEvents.length,0,"A saved response must not be received again while interpretation is restricted");
        }
        const facts=(await activityFacts(restriction.pathId)).filter(f=>f.kind==="authorization_restricted"&&f.requestId===restriction.requestId&&f.details.action===restriction.action);
        assert.equal(facts.length,1);assert.deepEqual(facts[0].details.refusal,restriction.refusal);
        finishing=true;await saveAuthorizationCheckpoint();app.exit(73);return;
      }
      if(phase==="selected"&&stage?.status==="submitted"){
        const background=await a({kind:"read_path",pathId:"background-preparation"});
        if(taskPreparation==="accepted"){assert(background);assert.equal(background.dispatchedAttempts,0);}else assert.equal(background,null);
        if(taskAuthorization) {
          const {state}=await saveAuthorizationCheckpoint(),original=await readAuthorizationCheckpoint("materials");
          assert.equal(state.preparation.status,"accepted");assert.deepEqual(state.preparation.request,original.state.preparation.request);
          assert.deepEqual(state.preparation.authorizationRestrictions,{});assert.equal(state.preparationPath.dispatchedAttempts,1);
          assert.deepEqual(state.selection.input.exactInput,stage.request.input);assert.equal(stage.attempt,null);assert.equal(stage.result,null);
        }
        app.exit(73);return;}
      if(phase!=="finish"||finishing||!(stage?.status==="accepted"||interruptTask&&stage?.status==="settled")||taskRunner&&!runnerResult)return;
      if(supplyExit?.status!=="closed")return;
      assert.equal((await a({kind:"read_schedule",workId:supplyExit.scheduling.workId})).settlementConfirmed,true);
      if((await a({kind:"pending_reconsiderations",runId:"root",afterId:null,limit:1})).length)return;
      if(taskPreparation==="accepted"&&(await methods.result("background-preparation")).kind!=="ready")return;
      finishing=true;
      const taskPath=await a({kind:"read_path",pathId:"task"});
      const originalSource=taskRunner?(await a({kind:"read_stage",requestId:"task:source"})).request.input:original;
      const originalHandoff=createTaskModelResponseHandoff("task",originalSource);
      const accepted=await readTaskModelResponseHandoff(store.activityHandoffs,originalHandoff);
      assert.equal(accepted.kind,interruptTask?"settled_response":"accepted");
      if(!interruptTask)assert.deepEqual(accepted.progress,taskPath.progress);
      await assert.rejects(readTaskModelResponseHandoff(store.activityHandoffs,{...originalHandoff,sourceId:"another-source"}),/task_response_handoff_source_changed/);
      await assert.rejects(readTaskModelResponseHandoff(store.activityHandoffs,{...originalHandoff,runId:"another-run"}),/task_response_original_path_unavailable/);
      assert.equal(accepted.progress.state,"interpreted",JSON.stringify(accepted.progress));
      assert(multipleTurns?responseEvents.every(event=>event.progress.requestId!==stage.request.input.request.requestId):responseEvents.length===0,"Local recovery must not pretend to receive the physical response again");
      assert((JSON.parse(await readFile(join(directory,"response-observations.json"),"utf8"))).length>0);
      assert.equal(accepted.progress.proposal.kind,multipleTurns?"advance":"propose_completion");
      if(!multipleTurns)assert(accepted.progress.proposal.output.summary.includes("7391"));
      if(taskRunner){
        assert.equal(runnerResult.status,"completed",JSON.stringify(runnerResult.cause));
        const runState=(await store.readRunTree("root")).members[0].head.state;
        assert(accepted.progress.proposal.candidates.every(candidate=>candidate.kind==="state_transition"&&candidate.transition==="plan_update"),"No external operation may be requested in this response sample");
        assert.equal(runState.counters.runActions,interruptTask?0:multipleTurns?2:accepted.progress.proposal.candidates.length);
        const turns=runnerResult.items.filter(item=>item.payload.kind==="controller_turn");
        assert.equal(turns.length,interruptTask||multipleTurns?2:1);assert.equal(turns[0].payload.status,interruptTask?"interrupted":"decided");
        const history=projectModelInteraction({runId:"root",runRevision:runState.revision,items:runnerResult.items});
        assert.equal(history.unsettledCalls.length,0);assert.equal(history.messages.filter(m=>m.role==="assistant").length,multipleTurns?2:1);
        assert.equal(runnerResult.items.filter(item=>item.payload.kind==="model_call_settlement").length,
          multipleTurns?2:accepted.progress.proposal.modelItems.filter(item=>item.kind==="model_tool_call").length);
        if(interruptTask){assert.equal(taskPath.progress.kind,"task_input_needed");assert.equal(runnerResult.finalOutput.summary,"Fresh ending");}
      }
      assert.equal(taskPath.dispatchedAttempts,2);assert.equal(preparedPath.dispatchedAttempts,1);
      assert.deepEqual(await a({kind:"pending_reconsiderations",runId:"root",afterId:null,limit:64}),[]);
      const firstSelected=await store.contextSelections.command({kind:"binding",inputId:"task:model:input",checkCurrentControl:true});
      const selected=multipleTurns?await store.contextSelections.command({kind:"binding",inputId:"task:2:model:input",checkCurrentControl:true}):firstSelected;
      let authorization=null;
      const authorizationFacts=[];
      if(taskAuthorization) {
        const finished=await saveAuthorizationCheckpoint(),selectedBoundary=await readAuthorizationCheckpoint("selected"),response=await readAuthorizationCheckpoint("response");
        assert.deepEqual(finished.state.selection,selectedBoundary.state.selection);assert.deepEqual(firstSelected,selectedBoundary.state.selection);
        assert.deepEqual(stage.request,selectedBoundary.state.task.request);assert.deepEqual(stage.attempt,response.state.task.attempt);
        assert.deepEqual(stage.result,response.state.task.result);assert.equal(stage.rawEvidenceRevision,response.state.task.rawEvidenceRevision);
        assert.equal(stage.receipt.resultId,response.state.task.result.id);assert.deepEqual(stage.authorizationRestrictions,{});
        for(const field of ["request","attempt","result","receipt"])assert.deepEqual(finished.state.preparation[field],selectedBoundary.state.preparation[field]);
        assert.deepEqual(finished.state.preparation.authorizationRestrictions,{});
        const facts=[...await activityFacts("input-preparation"),...await activityFacts("task")].sort((a,b)=>a.sequence-b.sequence);
        authorizationFacts.push(...facts.filter(f=>f.kind==="authorization_restricted"));assert.equal(authorizationFacts.length,6);
        const restrictions=[];
        for(const [boundary,expected] of Object.entries(authorizationRestrictions)) {
          const saved=await readAuthorizationCheckpoint(boundary),blocked=expected.pathId==="task"?saved.state.task:saved.state.preparation;
          assert.deepEqual(blocked.authorizationRestrictions[expected.action],expected.refusal);
          const pair=authorizationFacts.filter(f=>f.pathId===expected.pathId&&f.requestId===expected.requestId&&f.details.action===expected.action);
          assert.equal(pair.length,2);assert.deepEqual(pair[0].details.refusal,expected.refusal);assert.equal(pair[1].details.refusal,null);
          assert(pair[0].sequence<pair[1].sequence);
          assert.deepEqual(saved.state.restrictions.find(f=>f.sequence===pair[0].sequence),pair[0]);
          const progressed=facts.filter(f=>f.requestId===expected.requestId&&f.kind===(expected.action==="execution"?"dispatched":"accepted"));
          assert.equal(progressed.length,1);assert(pair[1].sequence<progressed[0].sequence,"Current authorization must clear the restriction before the original action advances");
          restrictions.push({phase:boundary,requestId:expected.requestId,action:expected.action,restrictedSequence:pair[0].sequence,clearedSequence:pair[1].sequence});
        }
        for(const requestId of ["input-preparation:stage:1","task:model"]) {
          assert.equal(facts.filter(f=>f.requestId===requestId&&f.kind==="dispatched").length,1);
          assert.equal(facts.filter(f=>f.requestId===requestId&&f.kind==="raw_saved").length,1);
          assert.equal(facts.filter(f=>f.requestId===requestId&&f.kind==="accepted").length,1);
          assert.equal(facts.filter(f=>f.requestId===requestId&&f.kind==="professional_stopped").length,0);
        }
        authorization={recoveredBoundaries:authorizationPhases.length-1,restrictions,inspectedFacts:0};
      }
      const retainedDecision=await store.contextPolicy.query({kind:"latest",scopeId:scope.id});
      assert(retainedDecision,"Original normal-policy acceptance must survive restart");
      if(taskPreparation){
        const receipt=JSON.parse(await readFile(join(directory,"input-acceptance.json"),"utf8"));
        assert.equal(receipt.id,selected.acceptanceId);assert.deepEqual(await store.sharedAcceptance.query(receipt.id),receipt);
        if(taskPreparation==="accepted"){
          const rejected=JSON.parse(await readFile(join(directory,"rollback-verification.json"),"utf8"));
          assert.deepEqual(await store.sharedAcceptance.query(rejected.id),rejected);
        }
      }
      const restoredHistory=await readContextPreparationHistory({current:retainedDecision.input,decisions:store.contextPolicy,methods},new AbortController().signal);
      assert.equal(restoredHistory.previous.decision.id,retainedDecision.decision.id);
      assert.deepEqual(restoredHistory.basis.current,retainedDecision.input.current);
      assert.deepEqual(restoredHistory.basis.scope,retainedDecision.input.scope);
      if(taskPreparation==="accepted"){
        assert.equal(restoredHistory.basis.inFlight.length,1);assert.equal(restoredHistory.basis.inFlight[0].producerState,"ready");
        const background=await a({kind:"read_path",pathId:"background-preparation"});
        assert.equal(background.dispatchedAttempts,1);assert.equal(background.progress.method.modelCalls,0);
        assert.equal((await store.contextPolicy.investments({scopeId:scope.id,afterWorkId:null,limit:64})).length,1);
        assert.equal((await store.contextSelections.command({kind:"current",scopeId:scope.id})).id,selected.selection.id,
          "Background readiness must not replace the foreground selection; preserve may legitimately return the already selected original");
      }else {
        assert.deepEqual(restoredHistory.basis,retainedDecision.input);
        assert.equal(await a({kind:"read_schedule",workId:"background-preparation-work"}),null);
        if(taskPreparation==="rejected")assert.equal(retainedDecision.input.admissionLimitations.length,1);
      }
      await writeFile(join(directory,"encoded-request.json"),firstSelected.input.exactInput.encoded.body);
      if(multipleTurns){
        await writeFile(join(directory,"follow-up-request.json"),selected.input.exactInput.encoded.body);
        assert.notEqual(firstSelected.acceptanceId,selected.acceptanceId);
        assert.notEqual(firstSelected.selection.id,selected.selection.id);
        const common=firstSelected.selection.representations.filter(ref=>selected.selection.representations.some(next=>digest(next)===digest(ref)));
        const firstSources=createHelarcTaskInputSources(originalSource.record,originalSource.request);
        const nextSource=(await a({kind:"read_stage",requestId:"task:2:source"})).request.input;
        const nextSources=createHelarcTaskInputSources(nextSource.record,nextSource.request);
        const unchanged=firstSources.groups.filter(g=>nextSources.groups.some(next=>next.id===g.id&&next.revision===g.revision));
        assert.equal(common.length,unchanged.length,"Precisely unchanged source groups must reuse their original publications");
        await writeFile(join(directory,"source-reuse.json"),JSON.stringify({unchanged:unchanged.map(g=>g.id),
          before:firstSources.groups.map(g=>({id:g.id,revision:g.revision,sections:g.occurrences.map(o=>({id:o.section.id,kind:o.section.kind,source:o.section.source}))})),
          after:nextSources.groups.map(g=>({id:g.id,revision:g.revision,sections:g.occurrences.map(o=>({id:o.section.id,kind:o.section.kind,source:o.section.source}))}))},null,2));
        assert.equal((await a({kind:"read_path",pathId:"task:2"})).dispatchedAttempts,2);
      }
      const {HelarcInspection}=await load("inspection/HelarcInspection.js");
      inspection=await HelarcInspection.create(join(directory,"inspection-settings.json"),join(directory,"inspection"));
      await inspection.activityObserver.replay("root",store.activityHandoffs);
      await inspection.contextFoundationObserver.replay("root",store.contextFoundationFacts.bind(store));
      const {InspectionQueryService}=await import("@agent-anything/inspection/query");queries=new InspectionQueryService(join(directory,"inspection"));
      const {selection:inspectionSelection}=await require("./inspection-settlement.cjs").settleInspection(inspection.recorder,queries);
      for(const fact of authorizationFacts) {
        const subject=inspection.recorder.ref("activity","event",`${fact.runId}:handoff:${fact.sequence}`,fact.runId);
        const visible=await queries.query({...inspectionSelection,kind:"get_subject",subject});
        const record=visible.records.find(r=>r.payload.kind==="event"&&r.payload.name==="activity.authorization_restricted"&&r.payload.sequence===fact.sequence);
        assert(record,"Each original restriction and clearance must be visible as its exact durable activity event");
        const content=record.contents.find(c=>c.name==="Durable activity handoff");assert(content);
        const retained=await queries.query({...inspectionSelection,kind:"get_content",contentId:content.id});
        assert.deepEqual(JSON.parse(retained.content.text),fact,"Inspector must retain the original action, refusal or explicit clearance, and stage binding");
        const flow=await queries.query({...inspectionSelection,kind:"get_data_flow",subject});
        assert(flow.graph.links.some(l=>l.kind==="includes"&&l.from.id===fact.requestId&&l.to.id===subject.id));
        authorization.inspectedFacts++;
      }
      const decisionSubject=inspection.recorder.ref("context-representation","contribution",retainedDecision.decision.id,"root");
      const visible=await queries.query({...inspectionSelection,kind:"get_subject",subject:decisionSubject});
      assert(visible.records.some(record=>record.contents.some(content=>content.name==="Context policy decision and evidence")));
      const flow=await queries.query({...inspectionSelection,kind:"get_data_flow",subject:decisionSubject});
      const exitSubject=inspection.recorder.ref("context_input_supply","contribution",need.id,"root");
      const exitVisible=await queries.query({...inspectionSelection,kind:"get_subject",subject:exitSubject});
      assert(exitVisible.records.some(r=>r.payload?.status==="exit_completed"),"The independent exit must be visible, not inferred from delivery");
      const exitFlow=await queries.query({...inspectionSelection,kind:"get_data_flow",subject:exitSubject});
      assert(exitFlow.graph.links.some(l=>l.kind==="observes"&&l.to.id===need.stage.id));
      assert(exitFlow.graph.links.some(l=>l.kind==="observes"&&l.to.id===supplyExit.scheduling.workId));
      assert(flow.graph.links.some(link=>link.kind==="observes"&&link.to.id===selected.input.exactInput.encoded.id),"The decision must link the actual selected input");
      if(taskPreparation==="accepted") {
        const shared=await store.sharedAcceptance.query(selected.acceptanceId);
        const facts=[];
        for(let after=0;;) {
          const page=await store.contextFoundationFacts("root",after,256);facts.push(...page);
          if(page.length<256)break;after=page.at(-1).sequence;
        }
        const accesses=facts.filter(f=>f.kind==="access_admitted");
        assert(accesses.length>0);assert.equal(accesses.length,firstSelected.selection.representations.length);
        assert.equal(facts.filter(f=>f.kind==="published"&&f.owner==="material_custody").length,accesses.length,"Only original source instances should be published");
        for(const fact of accesses) {
          const grantSubject=inspection.recorder.ref("material_custody","contribution",fact.subject,"root");
          const accessFlow=await queries.query({...inspectionSelection,kind:"get_data_flow",subject:grantSubject});
          assert(accessFlow.graph.links.some(l=>l.kind==="observes"&&l.to.id===fact.details.source.holdId));
          assert(accessFlow.graph.links.some(l=>l.kind==="produces"&&l.to.id===fact.details.hold.id));
          assert(!accessFlow.graph.links.some(l=>l.kind==="delivers"),"Material access admission is not Parent receipt");
          assert.equal(shared.outcome,"accepted");
        }
      }
      assert(flow.graph.links.some(link=>link.kind==="observes"&&link.to.owner==="activity"&&link.to.id===retainedDecision.input.current.evidence.id),"Policy evidence must lead to its accepted preparation stage");
      const judgmentSubject=inspection.recorder.ref("representation","contribution",selected.input.combinationJudgmentId,"root");
      const judgment=await queries.query({...inspectionSelection,kind:"get_subject",subject:judgmentSubject});
      assert(judgment.records.some(record=>record.contents.some(content=>content.name==="Representation judgment")));
      const judgmentFlow=await queries.query({...inspectionSelection,kind:"get_data_flow",subject:judgmentSubject});
      assert(judgmentFlow.graph.links.some(link=>link.kind==="observes"&&link.to.id===selected.input.exactInput.encoded.id));
      assert(judgmentFlow.graph.links.some(link=>link.kind==="observes"&&link.to.owner==="material_custody"));
      const inputFlow=await queries.query({...inspectionSelection,kind:"get_data_flow",subject:inspection.recorder.ref("context_selection","contribution",selected.input.id,"root")});
      assert(inputFlow.graph.links.some(link=>link.kind==="observes"&&link.to.id===selected.input.combinationJudgmentId));
      if(taskPreparation==="accepted")assert(flow.graph.links.some(link=>link.kind==="produces"&&link.to.id==="background-preparation"));
      if(taskPreparation==="rejected"){
        const rejectionId=retainedDecision.input.admissionLimitations[0].acceptanceId;
        assert(flow.graph.links.some(link=>link.kind==="observes"&&link.to.id===rejectionId));
        const rejected=await queries.query({...inspectionSelection,kind:"get_subject",subject:inspection.recorder.ref("shared_acceptance","contribution",rejectionId,"root")});
        assert(rejected.records.some(record=>record.contents.some(content=>content.name==="Original preparation admission rejection")));
      }
      await queries.close();queries=null;
      assert.equal(inspection.recorder.health().rejected,0);assert.equal(inspection.recorder.health().dropped,0);
      await writeFile(join(directory,"verification.json"),JSON.stringify({electron:process.versions.electron,generation:store.generation,
        originalTaskSourceRestored:true,hostDrivenSupply:true,actualHelarcInterpretation:true,productTaskBinding:true,scopedResponseObservation:true,normalPreparationHistoryRestored:true,
        providerCalls:multipleTurns?2:1,taskKind:accepted.progress.proposal.kind,backgroundPreparation:taskPreparation??"not_requested",multipleTurns,
        inputAcceptanceAcknowledgementLost:!!taskPreparation,atomicRollbackVerified:taskPreparation==="accepted",inspectionPolicyLinksVerified:true,
        ...(authorization?{authorization}:{}),
        actualRunner:taskRunner,interruptedAfterRawResponse:interruptTask,runnerStatus:runnerResult?.status??null,
        selectedSourceCount:selected.selection.representations.length,inspection:inspection.recorder.health()},null,2));
      setImmediate(async()=>{await service.close();await inspection.close();inspection=null;await store.close();store=null;app.exit(0);});
    }});
  if(taskRunner){
    const {RunExecutionCoordinator}=await import("@agent-anything/agent-runtime/execution-coordinator");
    const {createTestContextProjection}=await import("@agent-anything/test-support");
    const {createInteractionProtocolRegistrySnapshot}=await import("@agent-anything/interaction/coordination");
    const {operations,config}=await require("./task-runner-config.cjs")(directory,built.registration);
    const activity=execution.taskDecisions;
    const decisions={resourceMetering:activity.resourceMetering,recover:activity.recover.bind(activity),interrupt:activity.interrupt.bind(activity),
      next:async(input,context)=>{
        if(input.iteration===1||multipleTurns)return activity.next(input,context);
        assert(interruptTask);assert.equal(input.interaction.unsettledCalls.length,0);assert(JSON.stringify(input.interaction.messages).includes("controller_decision_basis_stale"));
        return {kind:"propose_completion",candidates:[],completionSource:{kind:"controller"},output:{kind:"complete",summary:"Fresh ending",source:{kind:"product_status"}},modelItems:[],
          ...(input.inputDelivery?{inputDeliveryReceipt:createControllerInputDeliveryReceipt(input.inputDelivery,input.toolExposure.controllerRequestId)}:{})};
      }};
    const runner=new RunExecutionCoordinator({taskDecisions:decisions,preparations:execution.preparations,operations,contextProjection:createTestContextProjection(),createRunId:()=>"root",now,
      runTreeCommits:store,interactions:createInteractionProtocolRegistrySnapshot("empty",[])});
    runnerHandle=phase==="need"?runner.start(built.agent,{task:built.source.task,items:[],metadata:{}},config):await runner.recover("root",{async resolve(){return {agent:built.agent,config};}});
    runnerHandle.wait().then(result=>{
      runnerResult=result;
      if(result.status!=="completed"){console.error("Task fixture ended before its expected completion:",JSON.stringify(result.cause));app.exit(1);return;}
      service.wake();
    },error=>{console.error(error);app.exit(1);});
  }
}
main().catch(async error=>{console.error(error);if(service)await service.close(100);if(queries)await queries.close();if(inspection)await inspection.close();if(store)await store.close().catch(()=>{});app.exit(1);});
