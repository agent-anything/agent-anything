const {app}=require("electron");
const assert=require("node:assert/strict");
const {join}=require("node:path");
const {pathToFileURL}=require("node:url");
const {readFile,writeFile}=require("node:fs/promises");
const [directory,phase,endpoint]=process.argv.slice(2);
const inputUnavailable=!!process.env.ACTIVITY_INPUT_UNAVAILABLE;
const resupply=!!process.env.ACTIVITY_METHOD_RESUPPLY;
const multiple=!!process.env.ACTIVITY_MULTIPLE_SOURCES;
const inputRejection=!!process.env.ACTIVITY_TASK_REJECTION;
app.setPath("userData",join(directory,"electron"));app.disableHardwareAcceleration();
let store,service,inspection,queries;
async function main(){
  await app.whenReady();
  const load=path=>import(pathToFileURL(join(__dirname,"../../dist/main",path)));
  const {HelarcExecutionStore}=await load("execution-storage/HelarcExecutionStore.js");
  const {HelarcActivityService}=await load("context/HelarcActivityService.js");
  const {createHelarcTaskPreparation}=await load("context/HelarcTaskPreparation.js");
  const {createHelarcTaskResponseExecution}=await load("context/HelarcTaskResponseExecution.js");
  const {bindHelarcMethodInputSupply}=await load("context/HelarcMethodInputSupply.js");
  const {bindHelarcContextSettings}=await load("context/HelarcContextRunBinding.js");
  const {createHelarcProviderProfile,createDefaultHelarcContextSettings}=await import("@agent-anything/helarc/configuration");
  const {OllamaProvider}=await import("@agent-anything/provider-integrations/ollama");
  const {OpenAICompatibleProvider}=await import("@agent-anything/provider-integrations/openai-compatible");
  const openai=!!process.env.ACTIVITY_OPENAI;
  const providerOptions={model:"controlled",timeoutMs:60000,nativeToolInteraction:{supported:true},requestBodyTransportLimit:{maximumBytes:inputRejection?500000:65000,source:"host_configured",revision:"1"}};
  const provider=openai?new OpenAICompatibleProvider({...providerOptions,baseUrl:endpoint+"/v1",apiKey:"local"}):
    new OllamaProvider({...providerOptions,baseUrl:endpoint,think:false,runtime:{contextWindowTokens:32768}});
  const profile=createHelarcProviderProfile({id:"isolated",providerKind:openai?"openai-compatible":"ollama",displayName:"Isolated",baseUrl:endpoint,model:"controlled",timeoutMs:60000,
    ollamaRuntime:openai?null:{contextWindowTokens:32768},credentialStatus:openai?"present":"empty_allowed"});assert(profile.ok,JSON.stringify(profile));
  const context=bindHelarcContextSettings(createDefaultHelarcContextSettings(),profile.profile);
  const {ActivityPurposeRegistry}=await import("@agent-anything/agent-runtime/activity");
  const runtime=await import("@agent-anything/agent-runtime/context-representation");
  const {retainTaskDecisionSource,retainInputPresentation}=await import("@agent-anything/agent-runtime/decision");
  const {createExactModelWorkingView,modelInputFromSections}=await import("@agent-anything/model-interaction/input");
  const catalog={delegation:true,questionSchemaDescription:"This interaction does not inspect files, change the workspace, or perform delegated work. ".repeat(multiple?150:100).trim()};
  const build=require("./task-input-source.cjs"),base=await build(provider,null,{...catalog,prompt:"Based on the Child reports, state the radius for images 5 and 6, the alpha rule, TARGET, and whether the version is verified. Do not process images."});
  let history={id:"original-report",source:{owner:"isolated-source",kind:"record",id:"report",revision:"1"},kind:"interaction_history",role:"assistant",necessity:"mandatory",
    content:{kind:"text",text:"User agreement: images 2-5 radius 3, images 6-10 radius 5; preserve alpha. TARGET: 7391. Version is unverified.\n"+"Read-only investigation found no changes.\n".repeat(multiple?880:resupply?960:1000)},
    preservation:{obligations:[{id:"agreement",requirement:"account",basis:"Preserve corrected image scope, exact radii, alpha, TARGET and unverified status."}],relationships:[]}};
  history={...history,content:{kind:"model_message",message:modelInputFromSections([history]).messages[0]},provenance:{purpose:"accepted_exchange",recipientRunId:"root",author:"model",
    sources:[history.source],presenter:{owner:"isolated-source",kind:"presenter",id:"historical-report",revision:"1"},coverage:["report@1"],limitations:[]}};
  const note=(id,text)=>({...history,id,source:{...history.source,id},content:{kind:"model_message",message:{role:"assistant",content:[{kind:"text",text}]}},
    preservation:{obligations:[{id,requirement:"account",basis:"Preserve this separately reported finding"}],relationships:[]},
    provenance:{...history.provenance,sources:[{...history.source,id}],coverage:[`${id}@1`]}});
  const protectedBoundary={...note("protected-boundary","The second report is independent. Preserve both reports and the actual unverified status."),
    role:"user",content:{kind:"model_message",message:{role:"user",content:[{kind:"text",text:"The second report is independent; retain both."}]}},
    preservation:{obligations:[{id:"original-order",requirement:"exact",basis:"Do not change the original user instruction."}],relationships:[]},
    provenance:{...history.provenance,author:"user"}};
  const histories=[history,...resupply?[note("scope-anchor","The original TARGET is 7391 and remains unverified.")]:[],
    ...multiple?[protectedBoundary,note("independent-report","SECOND_SCOPE: 9021. Version is unverified.\n"+"Second read-only inspection made no changes.\n".repeat(800))]:[]];
  const source={...base.source,iteration:2,interaction:{...base.source.interaction,revision:"2",
    workingView:createExactModelWorkingView({sections:histories,recipientRunId:"root",boundary:"history"}),
    historyPresentations:histories.map(retainInputPresentation),messages:modelInputFromSections(histories).messages}};
  const built=await build(provider,source,catalog);assert(provider.encodeInput(built.request,"buffered").body.length>65000);
  store=await HelarcExecutionStore.open(join(directory,"execution"));
  const a=command=>store.activityHandoffs.command(command),now=()=>new Date().toISOString(),registry=new ActivityPurposeRegistry();
  const authorize=async path=>{assert.equal(path.intent.permissionBasis,"isolated");return {kind:"allowed"};};
  const publications=new runtime.SourceMaterialPublicationWork(store.activityHandoffs,registry,{materials:store.materialCustody,selections:store.contextSelections,authorize,now});
  const preparation=new runtime.ContextInputPreparationWork(store.activityHandoffs,registry,{provider,materials:store.materialCustody,authorize,now});
  const methods=new runtime.RepresentationMethodWork({provider,materials:store.materialCustody,representations:store.representations,selections:store.contextSelections,activities:store.activityHandoffs,authorize,now},registry);
  const diagnostic=async()=>{
    const facts=[];for(let after=0;;){const page=await a({kind:"facts",runId:"root",after,limit:256});facts.push(...page);if(page.length<256)break;after=page.at(-1).sequence;}
    const ids=[...new Set(facts.map(f=>f.pathId))],paths=[];
    for(const id of ids){const path=await a({kind:"read_path",pathId:id});if(path)paths.push({id,progress:path.progress,resourceUse:path.resourceUse});}
    const stages=[];for(const id of [...new Set(facts.map(f=>f.requestId).filter(Boolean))])stages.push(await a({kind:"read_stage",requestId:id}));
    await writeFile(join(directory,"stage-diagnostic.json"),JSON.stringify(stages,null,2));
    await writeFile(join(directory,"progress-diagnostic.json"),JSON.stringify(paths,null,2));
    const judgments=[];for(const path of paths)for(const assessment of path.progress?.method?.assessments??[])
      for(const id of assessment.judgmentIds)judgments.push(await store.representations.command({kind:"read_judgment",id}));
    await writeFile(join(directory,"judgment-diagnostic.json"),JSON.stringify(judgments,null,2));
    console.error(JSON.stringify(paths.map(p=>({id:p.id,state:p.progress?.state??p.progress?.method?.state,gap:p.progress?.gap??p.progress?.method?.gap}))));
  };
  if(phase==="inspect"){
    await diagnostic();
    const {validateInspectionInput,snapshotInspectionJson}=await import(pathToFileURL(join(__dirname,"../../../../../harness/inspection/dist/records/InspectionValidation.js")));
    const invalid=[],recorder={ref:(owner,kind,id,runId=null,revision=null)=>({sourceId:"d".repeat(64),datasetId:"d".repeat(36),owner,kind,id,runId,revision}),
      offer:input=>{try{const {contents,...structure}=input;validateInspectionInput(snapshotInspectionJson(structure));return true;}
        catch(error){invalid.push({error:error.message,input});return false;}}};
    const {ActivityHandoffInspectionAdapter}=await load("inspection/ActivityHandoffInspectionAdapter.js"),
      {ContextFoundationInspectionAdapter}=await load("inspection/ContextFoundationInspectionAdapter.js");
    await new ActivityHandoffInspectionAdapter(recorder).replay("root",store.activityHandoffs);
    await new ContextFoundationInspectionAdapter(recorder).replay("root",store.contextFoundationFacts.bind(store));
    await writeFile(join(directory,"invalid-inspection.json"),JSON.stringify(invalid,null,2));
    console.log(JSON.stringify(invalid.map(v=>({error:v.error,subject:v.input.subject,links:v.input.links?.length}))));
    await store.close();store=null;app.exit(0);return;
  }
  const reception=bindHelarcMethodInputSupply({store,registry,preparation,methods,authorize,now});
  const task=createHelarcTaskResponseExecution({provider,purposes:registry,activities:store.activityHandoffs,acceptance:store.sharedAcceptance,selections:store.contextSelections,authorize,now,
    rediscoveryMs:10,settlementWaitMs:5000,host:{assertAvailable:()=>service.assertAvailable(),subscribe:l=>store.onActivityChange(l),wake:()=>service.wake()},
    preparations:{resume:async()=>service.wake()},arrange:()=>{throw new Error("Original input is retained before recovery");}},built.binding);
  const supply=createHelarcTaskPreparation({provider,activities:store.activityHandoffs,responsibilities:store.inputSupplies,publications,preparation,authorize:async b=>{await authorize(b.consumer);},
    binding:async()=>({context,treeScopeId:"tree",modelPoolId:"model",localPoolId:"local",deliveryMode:"buffered"}),
    decisions:store.contextPolicy,selections:store.contextSelections,materials:store.materialCustody,methods,methodInputs:reception.supply,methodConsumers:reception.consumer});
  const limitations=[];
  const purposes={resolve:(binding,scope)=>{
    const handler=registry.resolve(binding,scope);
    return {authorize:handler.authorize.bind(handler),execute:handler.execute.bind(handler),reconcile:handler.reconcile.bind(handler),settle:handler.settle.bind(handler),
      interpret:async(path,stage,...args)=>{
        if(phase==="second-generated"&&binding.contract.ref.id===methods.purpose.contract.ref.id&&stage.request.stageKind==="model") {
          const original=JSON.parse(await readFile(join(directory,"generated.json"),"utf8"));
          if(stage.request.pathId!==original.pathId){
            await writeFile(join(directory,"second-generated.json"),JSON.stringify({stageId:stage.request.id,attemptId:stage.attempt.id,resultId:stage.result.id,pathId:stage.request.pathId}));app.exit(73);return new Promise(()=>{});
          }
        }
        if(phase==="generated"&&binding.contract.ref.id===methods.purpose.contract.ref.id&&stage.request.stageKind==="model"||
          phase==="materialize"&&binding.contract.ref.id==="context.input-materialization"&&stage.request.stageKind==="read"||
          phase==="sent"&&binding.contract.ref.id===task.work.purpose.contract.ref.id&&stage.request.stageKind==="model"||
          phase==="limitation"&&stage.request.stageKind==="input-unavailable"){
          await writeFile(join(directory,`${phase}.json`),JSON.stringify({stageId:stage.request.id,attemptId:stage.attempt.id,resultId:stage.result.id,pathId:stage.request.pathId}));app.exit(73);return new Promise(()=>{});
        }
        const result=await handler.interpret(path,stage,...args);
        if(result.progress?.method?.state==="gap")limitations.push({pathId:path.intent.id,gap:result.progress.method.gap});
        return result;
      }};
  }};
  if(multiple){
    const original=store.sharedAcceptance.accept.bind(store.sharedAcceptance);
    store.sharedAcceptance.accept=async proposal=>{
      const part=proposal.parts.find(p=>p.owner==="context_preparation_policy"&&p.kind==="decision");
      const proposed=part?runtime.decideContextPreparation(part.proposal.input):null;
      if(proposed?.investment.kind==="propose"&&part.proposal.input.options.find(o=>o.id===proposed.investment.optionId)?.extendsReception){
        const forged=structuredClone(proposal);forged.id+="-unconfirmed-gap";
        const altered=forged.parts.find(p=>p.owner==="context_preparation_policy").proposal;
        for(const reception of altered.input.inputReceptions)if(reception.inputGap)reception.inputGap.gap.reason="invented_reason";
        if(inputRejection){
          for(const rejected of altered.input.rejectedInputs)rejected.evidence.revision="forged-acceptance";
          for(const received of altered.input.inputReceptions)if(received.providerRejection)received.providerRejection.evidence.revision="forged-acceptance";
          for(const option of altered.input.options)if(option.extendsReception)option.extendsReception.evidence.revision="forged-acceptance";
        }
        const decision=runtime.decideContextPreparation(altered.input);
        for(const p of forged.parts)if(p.owner==="activity"&&p.kind==="scheduling_acceptance")p.proposal.intent.decisionId=decision.id;
        for(const p of forged.parts)if(p.owner==="activity"&&p.kind==="reconsideration_acceptance"){
          p.proposal.id=forged.id;p.proposal.decision.id=decision.id;
        }
        const rejected=await original(forged);
        assert.equal(rejected.outcome,"rejected");assert.equal(rejected.rejection.code,inputRejection?"provider_input_rejection_scope_changed":"reception_extension_gap_unconfirmed");
        await writeFile(join(directory,"forged-gap-rejection.json"),JSON.stringify(rejected));
      }
      return original(proposal);
    };
  }
  if(phase==="adopt"){
    const original=store.sharedAcceptance.accept.bind(store.sharedAcceptance);
    store.sharedAcceptance.accept=async proposal=>{
      const receipt=await original(proposal);
      if(receipt.outcome==="accepted"&&proposal.parts.some(p=>p.owner==="context_selection"&&p.kind==="selection_input")){
        await writeFile(join(directory,"adopt.json"),JSON.stringify(receipt));app.exit(73);return new Promise(()=>{});
      }
      return receipt;
    };
  }
  if(phase==="start"){
    for(const [id,capacity] of [["model",1],["local",2]])await a({kind:"bind_resource_pool",pool:{id,capacity,revision:"1",authority:"isolated"}});
    const intent={id:"ordinary-task",runId:"root",permissionBasis:"isolated",resourceScope:"ordinary-task",scheduledWorkId:"ordinary-task",maximumStages:8,maximumAttempts:8,maximumConcurrent:1,deadlineAt:"2030-01-01T00:00:00.000Z"};
    const receipt=await store.sharedAcceptance.accept({id:"ordinary-source",scope:"root",actor:"task-decision",parts:[{owner:"activity",kind:"scheduling_acceptance",proposal:{kind:"schedule_work",expectedRevision:0,
      intent:{id:"ordinary-schedule",workId:intent.id,runId:"root",scopeId:"tree",owner:"task-decision",reason:"task",decisionId:"ordinary-source",policyRevision:"isolated:1",delayImpact:"Task response",timing:{kind:"unknown"},allowedPathIds:[intent.id],resources:[{capability:"model-request",poolId:"model",units:1}]}}},
      ...task.work.prepareSubmission(intent,{kind:"task_model_source",record:retainTaskDecisionSource(built.source),request:built.request,protocol:{kind:"native_tool_turn"}})]});
    assert.equal(receipt.outcome,"accepted",JSON.stringify(receipt));app.exit(73);return;
  }
  const failures=[];
  service=new HelarcActivityService({store,purposes,purposeIds:[publications.purpose.contract.ref.id,preparation.purpose.contract.ref.id,methods.purpose.contract.ref.id,"context.input-materialization",task.work.purpose.contract.ref.id],rediscoveryMs:10,
    reconsideration:(owner,subscription)=>owner===task.work.purpose.contract.acceptanceOwner?task.work.lifecycle:owner==="material-source"?publications.deliveries:subscription.binding?.kind==="input_need"?supply:subscription.binding?.kind==="activity_path"?reception.consumer:null,
    report:async cycle=>{const found=[...cycle.failures,...cycle.runs.flatMap(r=>r.result.failures),...cycle.reconsiderations.flatMap(r=>[...r.result.failures,...r.result.rejected])];
      if(found.length)await writeFile(join(directory,"failures.json"),JSON.stringify(found,(_key,v)=>v instanceof Error?{name:v.name,message:v.message,stack:v.stack,...v}:v,2));failures.push(...found);}});
  const deadline=Date.now()+90000;
  if(phase==="resupply-start"||phase==="resupply-finish"){
    const original=await store.contextSelections.command({kind:"binding",inputId:"ordinary-task:model:input",checkCurrentControl:false});
    const before=await store.contextPolicy.investments({scopeId:original.scope.id,afterWorkId:null,limit:64});assert.equal(before.length,1);
    const accepted=before[0],originalOption=accepted.input.options.find(o=>o.id===accepted.decision.investment.optionId);assert(originalOption);
    const laterHistory=[...histories,note("later-finding","Later finding: SOURCE_MARKER 9012. This is distinct from the original TARGET 7391.")];
    const laterSource={...source,iteration:3,interaction:{...source.interaction,revision:"3",
      workingView:createExactModelWorkingView({sections:laterHistory,recipientRunId:"root",boundary:"history"}),
      historyPresentations:laterHistory.map(retainInputPresentation),messages:modelInputFromSections(laterHistory).messages}};
    const laterBuilt=await build(provider,laterSource,catalog);
    const {createHelarcTaskInputSources}=await import("@agent-anything/helarc/prompt");
    const currentSources=createHelarcTaskInputSources(retainTaskDecisionSource(laterBuilt.source),laterBuilt.request);
    const enumerated=runtime.originalInputAccountScopes({sources:currentSources,maximum:context.policy.maximumOptions,
      backgroundGroupIds:currentSources.groups.filter(g=>g.duties.some(d=>["objective","behavior","new_information"].includes(d))).map(g=>g.id)});
    assert(!enumerated.scopes.some(s=>s.id===originalOption.stableScope.id),"Old interval must no longer be a newly enumerated opportunity");
    if(phase==="resupply-start"){
      const intent={id:"later-task",runId:"root",permissionBasis:"isolated",resourceScope:"later-task",scheduledWorkId:"later-task",maximumStages:8,maximumAttempts:8,maximumConcurrent:1,deadlineAt:"2030-01-01T00:00:00.000Z"};
      const receipt=await store.sharedAcceptance.accept({id:"later-source",scope:"root",actor:"task-decision",parts:[{owner:"activity",kind:"scheduling_acceptance",proposal:{kind:"schedule_work",expectedRevision:0,
        intent:{id:"later-schedule",workId:intent.id,runId:"root",scopeId:"tree",owner:"task-decision",reason:"task",decisionId:"later-source",policyRevision:"isolated:1",delayImpact:"Later task response",timing:{kind:"unknown"},allowedPathIds:[intent.id],resources:[{capability:"model-request",poolId:"model",units:1}]}}},
        ...task.work.prepareSubmission(intent,{kind:"task_model_source",record:retainTaskDecisionSource(laterBuilt.source),request:laterBuilt.request,protocol:{kind:"native_tool_turn"}})]});
      assert.equal(receipt.outcome,"accepted",JSON.stringify(receipt));app.exit(73);return;
    }
    let final;
    while(Date.now()<deadline){service.assertAvailable();assert.equal(failures.length,0,JSON.stringify(failures));final=await a({kind:"read_stage",requestId:"later-task:model"});if(final?.status==="accepted")break;await new Promise(r=>setTimeout(r,20));}
    assert.equal(final?.status,"accepted","Original result must supply the later complete input");
    const later=await store.contextSelections.command({kind:"binding",inputId:"later-task:model:input",checkCurrentControl:true});
    const latest=await store.contextPolicy.query({kind:"latest",scopeId:later.scope.id});
    assert.equal(later.scope.id,original.scope.id);assert.equal(latest.input.current.kind,"gap");assert.equal(latest.decision.foreground.adoption,"propose");
    assert.equal(latest.input.reuseOptions.length,1);assert.equal(latest.input.reuseOptions[0].pathId,accepted.investment.pathId);
    assert(!latest.input.options.some(o=>o.stableScope.id===originalOption.stableScope.id));
    assert.deepEqual(await store.contextPolicy.investments({scopeId:later.scope.id,afterWorkId:null,limit:64}),before,"No new generation or changed original acceptance");
    assert(later.input.exactInput.encoded.body.includes("SOURCE_MARKER 9012"));assert(later.input.exactInput.encoded.body.includes("TARGET: 7391"));
    assert(!later.input.exactInput.encoded.body.includes("Read-only investigation found no changes.\\nRead-only investigation"));
    assert.deepEqual(later.input.exactInput.request.interaction,laterBuilt.request.interaction);
    const firstCheck=await store.representations.command({kind:"read_judgment",id:original.input.combinationJudgmentId});
    const laterCheck=await store.representations.command({kind:"read_judgment",id:later.input.combinationJudgmentId});
    assert.notEqual(firstCheck.id,laterCheck.id);assert.equal(firstCheck.dependencies["inheritedJudgment:0"],laterCheck.dependencies["inheritedJudgment:0"]);
    const originalReuse=latest.input.reuseOptions[0];
    const changedOption={...originalReuse.option,request:{...originalReuse.option.request,objective:"Unaccepted replacement objective"}};
    const changed={...latest.input,options:[],alternatives:[],inputReceptions:[],reuseOptions:[{...originalReuse,option:changedOption}],
      inFlight:latest.input.inFlight.map(work=>work.workId===originalReuse.workId?{...work,preparationKey:runtime.contextPreparationWorkKey(latest.input.scope,changedOption.request)}:work)};
    assert.throws(()=>runtime.decideContextPreparation(changed),/context_policy_reception_binding_invalid/,
      "Changing original work cannot silently change the complete reception option's request binding");
    assert.deepEqual(await store.contextPolicy.query({kind:"latest",scopeId:later.scope.id}),latest);
    const {HelarcInspection}=await load("inspection/HelarcInspection.js");inspection=await HelarcInspection.create(join(directory,"inspection-settings.json"),join(directory,"inspection"));
    await inspection.activityObserver.replay("root",store.activityHandoffs);await inspection.contextFoundationObserver.replay("root",store.contextFoundationFacts.bind(store));
    const {InspectionQueryService}=await import("@agent-anything/inspection/query");queries=new InspectionQueryService(join(directory,"inspection"));
    const {selection}=await require("./inspection-settlement.cjs").settleInspection(inspection.recorder,queries);
    const subject=inspection.recorder.ref("context-representation","contribution",latest.decision.id,"root");
    const detail=await queries.query({kind:"get_data_flow",...selection,subject});
    assert(detail.graph.links.some(l=>l.kind==="observes"&&l.to.id===accepted.investment.pathId));
    const recorded=await queries.query({kind:"get_subject",...selection,subject});
    const content=recorded.records.flatMap(r=>r.contents).find(c=>c.name==="Owner-declared context evidence");assert.equal(content.availability,"present");
    const body=await queries.query({kind:"get_content",...selection,contentId:content.id});
    assert(JSON.parse(body.content.text).methodSupplyReport.originalWork.some(w=>w.pathId===accepted.investment.pathId&&w.available));
    const health=inspection.recorder.health();assert.equal(health.dropped,0);assert.equal(health.rejected,0);
    await writeFile(join(directory,"verification.json"),JSON.stringify({electron:process.versions.electron,totalProviderCalls:6,originalIntervalNotEnumerated:true,
      originalGenerationReused:true,originalAcceptanceUnchanged:true,newCompleteInputChecked:true,newFindingRetained:true,changedOriginalResupplyRejected:true,
      inspection:{coverage:health.coverage,dropped:health.dropped,rejected:health.rejected}},null,2));
    await queries.close();queries=null;await inspection.close();inspection=null;await service.close();service=null;await store.close();store=null;app.exit(0);return;
  }
  const {readCurrentModelInputNeed,readModelInputRejections}=await import("@agent-anything/agent-runtime/model-access");
  let final,currentNeed;
  while(Date.now()<deadline){service.assertAvailable();assert.equal(failures.length,0,JSON.stringify(failures));if(limitations.length&&!inputUnavailable){await diagnostic();throw new Error(JSON.stringify(limitations));}
    currentNeed=await readCurrentModelInputNeed(store.activityHandoffs,await a({kind:"read_path",pathId:"ordinary-task"}),"ordinary-task:input-need","ordinary-task:source");
    final=currentNeed?await a({kind:"read_stage",requestId:inputUnavailable?currentNeed.unavailableStage.id:currentNeed.stage.id}):null;
    if(final?.status==="accepted"&&final.receipt.progress.kind!=="model_input_recovery")break;await new Promise(r=>setTimeout(r,20));}
  if(final?.status!=="accepted")await diagnostic();
  assert.equal(phase,"finish","Required interrupted stage was not reached");assert.equal(final?.status,"accepted","Normal policy did not deliver the prepared input");
  for(const name of ["generated","materialize",inputUnavailable?"limitation":"sent",...multiple?["second-generated"]:[]]){const original=JSON.parse(await readFile(join(directory,`${name}.json`),"utf8")),stage=await a({kind:"read_stage",requestId:original.stageId});assert.equal(stage.result.id,original.resultId);assert.equal(stage.attempt.id,original.attemptId);}
  if(inputUnavailable){
    assert.equal(await a({kind:"read_stage",requestId:"ordinary-task:model"}),null);
    const {createTaskModelResponseHandoff,readTaskModelResponseHandoff}=await import("@agent-anything/agent-runtime/decision");
    const original=await a({kind:"read_stage",requestId:"ordinary-task:source"});
    const observed=await readTaskModelResponseHandoff(store.activityHandoffs,createTaskModelResponseHandoff("ordinary-task",original.request.input));
    assert.equal(observed.kind,"input_unavailable");assert.equal(observed.progress.limitation.reason,"input_reception_requires_bounded_revision");
    const subscription=await a({kind:"read_reconsideration",subscriptionId:"ordinary-task:input-need:supply",limit:64});
    assert.equal(subscription.state.closed,true);
    const decision=await store.contextPolicy.query({kind:"decision",id:observed.progress.limitation.evidence.at(-1).id});
    assert.equal(decision.decision.foreground.kind,"limited");
    const receiver=decision.input.inputReceptions[0];assert(receiver);
    let settled;
    while(Date.now()<deadline){service.assertAvailable();assert.equal(failures.length,0,JSON.stringify(failures));
      settled=await a({kind:"read_reconsideration",subscriptionId:`${receiver.pathId}:consumer`,limit:64});
      if(settled.state.closed)break;await new Promise(r=>setTimeout(r,20));}
    assert.equal(settled.state.closed,true,"Independent recipient cleanup must not be abandoned when the original need closes");
    const plan=await reception.supply.readPlan(receiver.pathId),producer=await methods.result(plan.producers[0].pathId);
    assert(plan.scheduling);assert.equal((await a({kind:"read_schedule",workId:plan.scheduling.workId})).closed,true);
    assert.equal(producer.kind,"ready");
    for(const admission of plan.materialAdmissions){
      await assert.rejects(store.materialCustody.command({kind:"describe",holdId:admission.hold.id,recipient:admission.hold.consumer}),/material_unavailable/);
      assert(await store.materialCustody.command({kind:"describe",holdId:admission.source.holdId,recipient:admission.source.recipient}));
    }
    const check=await methods.result(plan.check.intent.id);assert.equal(check.kind,"cancelled");
    const checkedPath=await a({kind:"read_path",pathId:plan.check.intent.id});
    assert.equal(checkedPath.progress.method.state,"gap");
    assert.equal(checkedPath.progress.method.assessments.at(-1).supported,false);
    const {HelarcInspection}=await load("inspection/HelarcInspection.js");inspection=await HelarcInspection.create(join(directory,"inspection-settings.json"),join(directory,"inspection"));
    await inspection.activityObserver.replay("root",store.activityHandoffs);await inspection.contextFoundationObserver.replay("root",store.contextFoundationFacts.bind(store));
    const {InspectionQueryService}=await import("@agent-anything/inspection/query");queries=new InspectionQueryService(join(directory,"inspection"));
    await require("./inspection-settlement.cjs").settleInspection(inspection.recorder,queries);
    const health=inspection.recorder.health();assert.equal(health.dropped,0);assert.equal(health.rejected,0);
    const selection=(await queries.query({kind:"get_snapshot",sourceId:inspection.recorder.source.sourceId,datasetId:inspection.recorder.manifest.datasetId})).selection;
    const detail=await queries.query({kind:"get_subject",...selection,subject:inspection.recorder.ref("activity","contribution",final.request.id,"root")});
    assert(detail.records.flatMap(r=>r.links).some(l=>l.kind==="observes"&&l.to.id===observed.progress.limitation.evidence.at(-1).id));
    assert(!detail.records.flatMap(r=>r.links).some(l=>l.kind==="delivers"||l.to.kind==="request"));
    await writeFile(join(directory,"verification.json"),JSON.stringify({electron:process.versions.electron,totalProviderCalls:3,
      inputUnavailable:true,originalResultsResumed:true,taskRequestNotSent:true,needClosed:true,independentConsumerClosed:true,originalProducerRetained:true,
      inspection:{coverage:health.coverage,dropped:health.dropped,rejected:health.rejected}},null,2));
    await queries.close();queries=null;await inspection.close();inspection=null;await service.close();service=null;await store.close();store=null;app.exit(0);return;
  }
  const selected=await store.contextSelections.command({kind:"binding",inputId:`${final.request.id}:input`,checkCurrentControl:true});
  const latest=await store.contextPolicy.query({kind:"latest",scopeId:selected.scope.id});
  assert.equal(latest.decision.foreground.adoption,"propose");assert.equal(latest.decision.investment.kind,"none");assert.equal(latest.input.current.kind,inputRejection?"prepared":"gap");
  assert.equal(selected.acceptanceId,latest.acceptanceId);assert.equal(selected.input.exactInput.request.instructions.content.length,0);
  assert.deepEqual(selected.input.exactInput.request.interaction,built.request.interaction);
  assert(selected.input.exactInput.encoded.body.includes("TARGET: 7391"));assert(!selected.input.exactInput.encoded.body.includes("Read-only investigation found no changes.\\nRead-only investigation"));
  assert.equal((await a({kind:"read_path",pathId:"ordinary-task"})).progress.proposal.kind,"propose_completion");
  const investments=await store.contextPolicy.investments({scopeId:selected.scope.id,afterWorkId:null,limit:64});assert.equal(investments.length,multiple?2:1);
  if(multiple){
    assert(selected.input.exactInput.encoded.body.includes("SECOND_SCOPE: 9021"));
    const extension=investments.find(i=>i.input.options.find(o=>o.id===i.decision.investment.optionId)?.extendsReception);assert(extension);
    const gap=extension.input.inputReceptions.find(r=>r.inputGap||r.providerRejection);
    if(inputRejection){assert(gap.providerRejection);assert.equal(gap.state,"unavailable");
      assert.equal(gap.reason,"provider_input_previously_rejected");
      assert.equal(await a({kind:"read_path",pathId:`${gap.pathId}:combination`}),null,"Rejected bytes must not trigger another semantic check");}
    else {assert(gap.inputGap.gap.capacity.some(c=>!c.allowed));assert.equal((await a({kind:"read_path",pathId:gap.pathId})).cancelled,true);}
    assert(latest.input.receptionOptions.some(r=>r.members.length===2));
    assert.equal(JSON.parse(await readFile(join(directory,"forged-gap-rejection.json"),"utf8")).rejection.code,inputRejection?"provider_input_rejection_scope_changed":"reception_extension_gap_unconfirmed");
  }
  if(inputRejection){
    const path=await a({kind:"read_path",pathId:"ordinary-task"}),rejected=await readModelInputRejections(store.activityHandoffs,path,currentNeed,"ordinary-task:source");
    assert.equal(rejected.length,2);assert.equal(new Set(rejected.map(r=>r.bodyDigest)).size,2);
    assert(rejected.every(r=>r.bodyDigest!==selected.input.exactInput.encoded.bodyDigest));
    const {createTaskModelResponseHandoff,readTaskModelResponseHandoff}=await import("@agent-anything/agent-runtime/decision");
    const original=await a({kind:"read_stage",requestId:"ordinary-task:source"});
    const received=await readTaskModelResponseHandoff(store.activityHandoffs,createTaskModelResponseHandoff("ordinary-task",original.request.input));
    assert.equal(received.kind,"accepted");assert.equal(received.progress.proposal.kind,"propose_completion");
    assert.equal(latest.input.observationReport.window.inputs.length,1);assert.equal(latest.input.observationReport.window.inputs[0].inputRevision,2);
  }
  const combined=await store.representations.command({kind:"read_judgment",id:selected.input.combinationJudgmentId});
  assert(combined.dependencies["inheritedJudgment:0"],"The original preservation check must be retained, not rerun or bypassed");
  const originalCheck=await store.representations.command({kind:"read_judgment",id:combined.dependencies["inheritedJudgment:0"]});
  assert.equal(originalCheck.conclusion,"supported");
  const originalStage=await a({kind:"read_stage",requestId:originalCheck.dependencies.stage}),combinationStage=await a({kind:"read_stage",requestId:combined.dependencies.stage});
  assert.equal(originalStage.receipt.id,originalCheck.dependencies.acceptance);
  assert.equal(originalStage.result.id,originalCheck.dependencies.rawResult);
  assert.equal(combinationStage.receipt.id,combined.dependencies.acceptance);
  const originalBytes=Buffer.byteLength(provider.encodeInput(built.request,"buffered").body),
    preservedCheckBytes=Buffer.byteLength(originalStage.request.input.encoded.body),combinationCheckBytes=Buffer.byteLength(combinationStage.request.input.encoded.body),
    selectedBytes=Buffer.byteLength(selected.input.exactInput.encoded.body);
  assert(originalBytes>65000&&preservedCheckBytes<=(inputRejection?500000:65000)&&combinationCheckBytes<=(inputRejection?500000:65000)&&selectedBytes<=65000);
  const contextFacts=[];
  for(let after=0;;){const page=await store.contextFoundationFacts("root",after,128);contextFacts.push(...page);if(page.length<128)break;after=page.at(-1).sequence;}
  const receivingFact=contextFacts.findLast(f=>f.owner==="context_preparation_policy"&&f.details.decision?.investment.kind==="reuse_input");
  assert(receivingFact,"Normal policy must observe the already accepted recipient work separately from the producer");
  const receiving=await store.contextPolicy.query({kind:"decision",id:receivingFact.details.decision.id}),head=await store.contextSelections.command({kind:"lookup_scope",scopeId:selected.scope.id});
  const receivedPath=receiving.decision.investment.pathId,receivedPlan=await reception.supply.readPlan(receivedPath);assert(receivedPlan.scheduling);
  let receiverClosed=false;
  while(Date.now()<deadline){service.assertAvailable();assert.equal(failures.length,0,JSON.stringify(failures));
    receiverClosed=(await a({kind:"read_reconsideration",subscriptionId:`${receivedPath}:consumer`,limit:64})).state.closed;
    if(receiverClosed)break;await new Promise(r=>setTimeout(r,20));}
  assert(receiverClosed);assert.equal((await a({kind:"read_schedule",workId:receivedPlan.scheduling.workId})).closed,true);
  assert.equal((await a({kind:"read_path",pathId:receivedPlan.producers[0].pathId})).cancelled,false);
  const stale=runtime.contextPreparationAcceptance({id:"stale-reception-probe",input:receiving.input,expectedDecisionId:latest.decision.id,
    expectedControlRevision:head.control.revision,reconsideration:null,execution:null,methods});
  const refused=await store.sharedAcceptance.accept(stale.acceptance);
  assert.equal(refused.outcome,"rejected");assert.equal(refused.rejection.code,"input_reception_binding_changed");
  const {HelarcInspection}=await load("inspection/HelarcInspection.js");inspection=await HelarcInspection.create(join(directory,"inspection-settings.json"),join(directory,"inspection"));
  await inspection.activityObserver.replay("root",store.activityHandoffs);await inspection.contextFoundationObserver.replay("root",store.contextFoundationFacts.bind(store));
  const {InspectionQueryService}=await import("@agent-anything/inspection/query");queries=new InspectionQueryService(join(directory,"inspection"));
  await require("./inspection-settlement.cjs").settleInspection(inspection.recorder,queries);
  const health=inspection.recorder.health();assert.equal(health.dropped,0);assert.equal(health.rejected,0);
  await writeFile(join(directory,"verification.json"),JSON.stringify({electron:process.versions.electron,totalProviderCalls:inputRejection?9:multiple?6:4,originalResultsResumed:true,
    capacityRecoveryInOriginalWork:inputRejection,
    ...(multiple?{multipleSourceExtension:true,settledCapacityGapPreserved:true,unconfirmedGapRejected:true,firstGenerationNotRepeated:true,completeJointInputChecked:true}:{}),
    normalPolicyAdopted:true,originalCatalogPreserved:true,originalCheckInherited:true,staleReceptionRejected:true,originalBytes,preservedCheckBytes,combinationCheckBytes,selectedBytes,
    inspection:{coverage:health.coverage,dropped:health.dropped,rejected:health.rejected}},null,2));
  await queries.close();queries=null;await inspection.close();inspection=null;await service.close();service=null;await store.close();store=null;app.exit(0);
}
main().catch(async error=>{console.error(error.stack??error);await service?.close().catch(()=>{});await queries?.close().catch(()=>{});await inspection?.close().catch(()=>{});await store?.close().catch(()=>{});app.exit(1);});
