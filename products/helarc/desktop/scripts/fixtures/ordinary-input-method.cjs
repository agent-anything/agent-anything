const {app}=require("electron");
const assert=require("node:assert/strict");
const {join}=require("node:path");
const {pathToFileURL}=require("node:url");
const {readFile,writeFile}=require("node:fs/promises");
const [directory,phase,endpoint]=process.argv.slice(2);
app.setPath("userData",join(directory,"electron"));app.disableHardwareAcceleration();
let store,service,inspection,queries;
async function main(){
  await app.whenReady();
  const load=path=>import(pathToFileURL(join(__dirname,"../../dist/main",path)));
  const {HelarcExecutionStore}=await load("execution-storage/HelarcExecutionStore.js");
  const {HelarcActivityService}=await load("context/HelarcActivityService.js");
  const {bindHelarcMethodInputSupply}=await load("context/HelarcMethodInputSupply.js");
  const {OllamaProvider}=await import("@agent-anything/provider-integrations/ollama");
  const {OpenAICompatibleProvider}=await import("@agent-anything/provider-integrations/openai-compatible");
  const providerOptions={model:"controlled",timeoutMs:60000,nativeToolInteraction:{supported:true},requestBodyTransportLimit:{maximumBytes:1000000,source:"host_configured",revision:"1"}};
  const provider=process.env.ACTIVITY_OPENAI?new OpenAICompatibleProvider({...providerOptions,baseUrl:endpoint+"/v1",apiKey:"local"}):
    new OllamaProvider({...providerOptions,baseUrl:endpoint,think:false,runtime:{contextWindowTokens:32768}});
  const {ActivityPurposeRegistry}=await import("@agent-anything/agent-runtime/activity");
  const runtime=await import("@agent-anything/agent-runtime/context-representation");
  const {composeModelInput,organizeOriginalInput,modelInputValueDigest:digest}=await import("@agent-anything/model-interaction/input");
  const built=await require("./task-input-source.cjs")(provider,null,{prompt:"Based on the Child reports, state the radius for images 5 and 6, the alpha rule, the TARGET value, and whether the version is verified. Do not process images."});
  const ref=id=>({owner:"isolated-source",kind:"record",id,revision:"1"});
  const history={id:"original-report",source:ref("report"),kind:"interaction_history",role:"assistant",necessity:"mandatory",
    content:{kind:"text",text:"User agreement: images 2-5 radius 3, images 6-10 radius 5; preserve alpha. TARGET: 7391. Version is unverified.\n"+"Read-only investigation found no changes.\n".repeat(200)},
    preservation:{obligations:[{id:"agreement",requirement:"account",basis:"Preserve the corrected image scope, exact radii, alpha condition, TARGET and unverified status."}],relationships:[]}};
  const composition=composeModelInput({...built.request.composition,sections:[...built.request.composition.sections,history],composedAt:"2026-10-31T00:00:00.000Z"});
  const request={...built.request,composition,instructions:composition.instructions,messages:composition.messages};
  const groups=composition.sections.map((section,position)=>({id:`source:${section.id}`,owner:"isolated-source",revision:digest(section),occurrences:[{position,section}],
    duties:section.id===history.id?["continuity","evidence"]:["objective"],sources:[section.source],deliveries:[]}));
  const sources={id:"original-input",owner:"isolated-source",runId:"root",originalSourceId:"source-record",boundary:"H1",request,groups};
  const recipient={runId:"root",recipient:built.agent.id,purpose:request.purpose},target=provider.encodeInput(request,"buffered").targetDigest;
  const scope={...recipient,id:"ordinary-input-scope",owner:"context-representation",continuity:"task",target,authorityBasis:"isolated"};
  const now=()=>new Date().toISOString(),signal=new AbortController().signal;
  store=await HelarcExecutionStore.open(join(directory,"execution"));const a=command=>store.activityHandoffs.command(command);
  await a({kind:"bind_resource_pool",pool:{id:"recipient-model",revision:"1",authority:"isolated-host",capacity:1}});
  const accept=async proposal=>{const receipt=await store.sharedAcceptance.accept(proposal);assert.equal(receipt.outcome,"accepted",JSON.stringify(receipt));};
  const registry=new ActivityPurposeRegistry(),authorize=async path=>{assert.equal(path.intent.permissionBasis,"isolated");return {kind:"allowed"};};
  const publication=new runtime.SourceMaterialPublicationWork(store.activityHandoffs,registry,{materials:store.materialCustody,authorize,now});
  const preparation=new runtime.ContextInputPreparationWork(store.activityHandoffs,registry,{provider,materials:store.materialCustody,authorize,now});
  const methods=new runtime.RepresentationMethodWork({provider,materials:store.materialCustody,representations:store.representations,selections:store.contextSelections,activities:store.activityHandoffs,authorize,now},registry);
  const {supply,consumer}=bindHelarcMethodInputSupply({store,registry,preparation,methods,authorize,now});
  const reception=new runtime.OriginalInputRepresentationReception({activities:store.activityHandoffs,materials:store.materialCustody,inputs:supply,consumers:consumer,methods});
  const intent=id=>({id,runId:"root",permissionBasis:"isolated",resourceScope:id,maximumStages:128,maximumAttempts:128,maximumConcurrent:1,deadlineAt:"2030-01-01T00:00:00.000Z"});
  const task=registry.register({ref:{id:"ordinary-after-method",revision:"1"},inputOwner:"context-representation",executionOwner:"model-access",interpretationOwner:"isolated-agent",acceptanceOwner:"context-representation",recoveryOwner:"isolated-agent",stageKinds:["model"],capabilities:["model-access"],continuationKinds:[]},
    new runtime.PreparedInputExecution({provider,selections:store.contextSelections,inputId:()=>"ordinary-final-input",now,authorize,interpret:async(_path,stage)=>{
      assert.equal(stage.result.value.kind,"succeeded");
      return {progress:{responseId:stage.result.id},next:[],participants:[]};}}));
  const purposes={resolve:(binding,owner)=>{
    const handler=registry.resolve(binding,owner);
    return {authorize:handler.authorize.bind(handler),execute:handler.execute.bind(handler),reconcile:handler.reconcile.bind(handler),settle:handler.settle.bind(handler),
      interpret:async(path,stage,...args)=>{
        if(phase==="generated"&&binding.contract.ref.id===methods.purpose.contract.ref.id&&stage.request.stageKind==="model"||
          phase==="materialize"&&binding.contract.ref.id==="context.input-materialization"&&stage.request.stageKind==="read"||
          phase==="sent"&&binding.contract.ref.id===task.contract.ref.id&&stage.request.stageKind==="model"){
          await writeFile(join(directory,`${phase}.json`),JSON.stringify({stageId:stage.request.id,attemptId:stage.attempt.id,resultId:stage.result.id}));app.exit(73);return new Promise(()=>{});
        }
        return handler.interpret(path,stage,...args);
      }};
  }};
  const failures=[];
  service=new HelarcActivityService({store,purposes,purposeIds:[publication.purpose.contract.ref.id,preparation.purpose.contract.ref.id,methods.purpose.contract.ref.id,"context.input-materialization",task.contract.ref.id],rediscoveryMs:10,
    reconsideration:(_owner,subscription)=>subscription.binding?.kind==="activity_path"?consumer:null,
    report:async cycle=>{const found=[...cycle.failures,...cycle.runs.flatMap(r=>r.result.failures),...cycle.reconsiderations.flatMap(r=>[...r.result.failures,...r.result.rejected])];
      if(found.length)await writeFile(join(directory,"failures.json"),JSON.stringify(found,(_key,value)=>value instanceof Error?{name:value.name,message:value.message,stack:value.stack,...value}:value,2));failures.push(...found);}});
  const wait=async(read,label)=>{const deadline=Date.now()+60000;while(Date.now()<deadline){service.assertAvailable();assert.equal(failures.length,0,failures.map(f=>f.error?.stack??JSON.stringify(f)).join("\n"));const result=await read();if(result)return result;await new Promise(r=>setTimeout(r,15));}throw new Error(`Unsettled ${label}`);};
  const planPublications=()=>runtime.planOriginalInputPublications({sources,recipient,target,observedAt:"2026-10-31T00:00:00.000Z",maximumSourceBytes:1000000,activities:store.activityHandoffs,signal});
  for(const p of await planPublications())if(p.state==="new")await accept({id:`${p.pathId}:accept`,scope:"root",actor:"material-source",parts:publication.prepareSubmission(intent(p.pathId),p.request)});
  const publications=await wait(async()=>{const result=await planPublications();return result.every(p=>p.published)?result:null;},"source publication");
  const accountScopes=runtime.originalInputAccountScopes({sources,maximum:16,backgroundGroupIds:groups.filter(g=>g.id!=="source:original-report").map(g=>g.id)});
  assert.equal(accountScopes.scopes.length,1);
  const capacity={limits:[],reservations:[],policy:{id:"isolated",revision:"1",purpose:recipient.purpose,basis:"Provider encoding with explicit uncertain capacity admission",allowEstimatedFit:true,allowUnknown:true},maximumCombinations:4,maximumMeasurements:0};
  const bounds={readBytes:1000000,storedBytes:1000000,modelCalls:8,repairs:1,levels:2,pageBytes:65536,ranges:64};
  const offer=runtime.supplyOriginalInputAccountMethod({sources,scope:accountScopes.scopes[0],publications,sourceRecipient:recipient,target,authorizationBasis:"isolated",capacity,bounds,limits:{maximumStages:128,maximumAttempts:128},addresses:[]});
  const methodId=offer.consumerId;
  if(!await a({kind:"read_path",pathId:methodId}))await accept({id:"ordinary-method",scope:"root",actor:"context-representation",parts:[...offer.materialAdmissions.map(proposal=>({owner:"material_custody",kind:"admit_access",proposal})),...methods.prepareSubmission(intent(methodId),offer.request)]});
  if(phase==="start"){app.exit(73);return;}
  const produced=await wait(async()=>{const result=await methods.result(methodId);if(result.kind==="gap")throw new Error(JSON.stringify(result.progress.gap));return result.kind==="ready"?result:null;},"original method");
  assert.deepEqual(produced.progress.request,offer.request);
  const demand=organizeOriginalInput({composition,demand:{id:"original-demand",...recipient,targetRevision:target,historyBoundary:sources.boundary,deliveryIds:[],dependencies:{source:sources.id},maximumCombinations:4,maximumExternalMeasurements:0,maximumReadBytes:1000000},
    groups:groups.map(g=>({id:g.id,owner:g.owner,revision:g.revision,sectionIds:g.occurrences.map(o=>o.section.id),duties:g.duties,deliveryIds:[]}))});
  const receptionBasis={sources,supply:offer,scope,producerPathId:methodId,
    preparation:{kind:"context_input_preparation",demand,template:request,limits:[],reservations:[],policy:capacity.policy,allowExternalMeasurement:false,deliveryMode:"buffered",localMeasurements:[],sharedCapacity:null,materialAccesses:publications.map(p=>p.published.access)}};
  const consumerId=reception.id(receptionBasis);
  const consumerWorkId=`${consumerId}:work`;
  const scheduling={id:`${consumerId}:scheduling`,workId:consumerWorkId,runId:"root",scopeId:"root",owner:"context-representation",
    decisionId:"ordinary-policy",policyRevision:"1",reason:"opportunity",delayImpact:"original recipient input",timing:{kind:"unknown"},resources:[{poolId:"recipient-model",capability:"model-access",units:1}]};
  const start=await reception.prepareStart(receptionBasis,{intent:{...intent(consumerId),scheduledWorkId:consumerWorkId},scheduling,
    checkCapacity:{...capacity,policy:{...capacity.policy,purpose:offer.request.recipient.purpose}},checkBounds:bounds},signal);
  if(start.participants.length)await accept({id:"ordinary-consumer-start",scope:"root",actor:"context-representation",parts:start.participants});
  const plan=await supply.readPlan(consumerId);assert(plan);
  if(phase==="adopt"){
    const checked=await wait(async()=>{const result=await reception.inspect(receptionBasis,signal);if(result.kind==="unavailable")throw new Error(JSON.stringify(result));return result.kind==="checked"?result:null;},"complete input check");
    assert.equal(checked.prepared.request.instructions.content.length,0);
    assert.deepEqual(checked.prepared.request.interaction,request.interaction);
    assert(checked.prepared.encoded.body.includes("TARGET: 7391"));assert(!checked.prepared.encoded.body.includes("Read-only investigation found no changes.\\nRead-only investigation"));
    await a({kind:"open_path",intent:{...intent("ordinary-task"),owner:task.contract.acceptanceOwner,purpose:task}});
    const adoption=await reception.prepareAdoption(receptionBasis,{id:"ordinary-adoption",expectedSelectionId:null,expectedControlRevision:0,
      publications,selectionId:"ordinary-selection",inputId:"ordinary-final-input",releaseHolds:[],
      need:{id:"ordinary-need",supplier:scope.owner,stage:{id:"ordinary-model",pathId:"ordinary-task",stageKind:"model",capabilities:["model-access"],dependencies:[]}}},signal);
    await accept(adoption);app.exit(73);return;
  }
  if(phase==="generated"||phase==="materialize"||phase==="sent")await wait(async()=>false,`expected ${phase} interruption`);
  assert.equal(phase,"finish");
  const final=await wait(async()=>{const stage=await a({kind:"read_stage",requestId:"ordinary-model"});return stage?.status==="accepted"?stage:null;},"task response");
  assert(JSON.stringify(final.result.value.response).includes("7391"));
  for(const name of ["generated","materialize","sent"]){const original=JSON.parse(await readFile(join(directory,`${name}.json`),"utf8")),stage=await a({kind:"read_stage",requestId:original.stageId});assert.equal(stage.result.id,original.resultId);assert.equal(stage.attempt.id,original.attemptId);}
  await wait(async()=>(await a({kind:"read_reconsideration",subscriptionId:`${consumerId}:consumer`,limit:128})).state.closed,"consumer closure");
  const settledSchedule=await a({kind:"read_schedule",workId:consumerWorkId});assert.equal(settledSchedule.closed,true);
  assert.deepEqual(settledSchedule.intent.allowedPathIds,[consumerId,`${consumerId}:organization`,`${consumerId}:combination`]);
  assert.equal((await a({kind:"read_path",pathId:methodId})).cancelled,false);
  const {HelarcInspection}=await load("inspection/HelarcInspection.js");inspection=await HelarcInspection.create(join(directory,"inspection-settings.json"),join(directory,"inspection"));
  await inspection.activityObserver.replay("root",store.activityHandoffs);await inspection.contextFoundationObserver.replay("root",store.contextFoundationFacts.bind(store));
  const {InspectionQueryService}=await import("@agent-anything/inspection/query");queries=new InspectionQueryService(join(directory,"inspection"));
  await require("./inspection-settlement.cjs").settleInspection(inspection.recorder,queries);
  const health=inspection.recorder.health();assert.equal(health.dropped,0);assert.equal(health.rejected,0);
  const finalCheck=await methods.describe(plan.check.intent.id);
  for(const pathId of [plan.materialization.intent.id,plan.materialization.request.preparationIntent.id,plan.check.intent.id]){
    const path=await a({kind:"read_path",pathId});assert.equal(path.intent.resourceScope,consumerId);
    assert.deepEqual(path.intent.resourceLimits,plan.materialization.intent.resourceLimits);
  }
  await writeFile(join(directory,"verification.json"),JSON.stringify({electron:process.versions.electron,sourceGroups:groups.length,
    totalProviderCalls:produced.progress.modelCalls+finalCheck.used.modelCalls+1,originalResultsResumed:true,originalCatalogPreserved:true,consumerClosed:true,
    inspection:{coverage:health.coverage,dropped:health.dropped,rejected:health.rejected}},null,2));
  await queries.close();queries=null;await inspection.close();inspection=null;await service.close();service=null;await store.close();store=null;app.exit(0);
}
main().catch(async error=>{console.error(error.stack??error);await service?.close().catch(()=>{});await queries?.close().catch(()=>{});await inspection?.close().catch(()=>{});await store?.close().catch(()=>{});app.exit(1);});
