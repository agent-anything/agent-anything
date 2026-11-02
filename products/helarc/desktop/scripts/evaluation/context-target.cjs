const {app}=require("electron");
const {join}=require("node:path");
const {pathToFileURL}=require("node:url");
const {readFile,writeFile,appendFile}=require("node:fs/promises");
const {createHash}=require("node:crypto");
const [directory,mode,endpoint]=process.argv.slice(2);
app.setPath("userData",join(directory,"electron"));app.disableHardwareAcceleration();
const cancel=new AbortController();process.on("message",message=>{if(message?.kind==="cancel")cancel.abort();});
process.on("disconnect",()=>cancel.abort());
let store,inspection,execution;
const json=async name=>JSON.parse(await readFile(join(directory,name),"utf8"));
let save=async(name,value)=>writeFile(join(directory,name),JSON.stringify(value,null,2));
async function main(){
  await app.whenReady();
  const projection=await json("target-input.json"),spec=projection.input,runId=projection.branch.activityNamespace;
  const load=path=>import(pathToFileURL(join(__dirname,"../../dist/main",path)));
  const {HelarcExecutionStore}=await load("execution-storage/HelarcExecutionStore.js");
  const {SerializedAtomicFile}=await load("persistence/SerializedAtomicFile.js");
  save=(name,value)=>new SerializedAtomicFile(join(directory,name)).transact(tx=>tx.replaceText(JSON.stringify(value,null,2)));
  const {bindHelarcRepresentationMethods}=await load("context/HelarcRepresentationMethods.js");
  const {bindHelarcContextExecution}=await load("context/HelarcContextExecution.js");
  const {HelarcInspection}=await load("inspection/HelarcInspection.js");
  const {ActivityPurposeRegistry}=await import("@agent-anything/agent-runtime/activity");
  const {OllamaProvider}=await import("@agent-anything/provider-integrations/ollama");
  const {composeModelInput,modelInputValueDigest:digest}=await import("@agent-anything/model-interaction/input");
  inspection=await HelarcInspection.create(join(directory,"inspection-settings.json"),spec.inspectionRoot??join(directory,"inspection"));
  store=await HelarcExecutionStore.open(join(directory,"execution"),undefined,inspection.evidenceObserver,inspection.fileMaterialObserver,undefined,undefined,inspection.contextMaterialObserver,inspection.activityObserver,inspection.contextFoundationObserver);
  const recordingIdentity={sourceId:inspection.recorder.source.sourceId,datasetId:inspection.recorder.manifest.datasetId};
  await appendFile(join(directory,"recordings.jsonl"),JSON.stringify({...recordingIdentity,phase:"opened"})+"\n");
  // This declared continuation has no Product Run admission. Its target owns the
  // diagnostic chain; do not fabricate an admission or weaken Product checks.
  const registrationFile=new SerializedAtomicFile(join(directory,"recording-registration.json"));
  const binding=createHash("sha256").update(JSON.stringify(projection)).digest("hex");
  await inspection.registerExecutionRecording(runId,mode!=="prepare",{
    registerRecording:current=>registrationFile.transact(async tx=>{
      const text=await tx.readText(),prior=text?JSON.parse(text):null;
      if(prior&&(prior.binding!==binding||prior.generation>=store.generation||prior.current.runId!==runId))throw new Error("recording_owner_binding_conflict");
      const next={current,previous:prior?.current??null,binding,generation:store.generation};
      await tx.replaceText(JSON.stringify(next));return next;
    }),activityHandoffs:store.activityHandoffs,
    contextFoundationFacts:store.contextFoundationFacts.bind(store),
  });
  const now=()=>new Date().toISOString(),a=command=>store.activityHandoffs.command(command),c=command=>store.materialCustody.command(command);
  const accept=async proposal=>{const result=await store.sharedAcceptance.accept(proposal);if(result.outcome!=="accepted")throw new Error(JSON.stringify(result));return result;};
  const provider=new OllamaProvider({baseUrl:endpoint,model:spec.model,think:false,timeoutMs:120000,nativeToolInteraction:{supported:true},
    runtime:{contextWindowTokens:32768},requestBodyTransportLimit:{maximumBytes:1000000,source:"host_configured",revision:"1"}});
  const registry=new ActivityPurposeRegistry(),recipient={runId,recipient:"context-representation",purpose:"fixed-context-continuation"};
  const authorize=async path=>{if(path.intent.permissionBasis!==projection.branch.authorityId)throw new Error("target_authority_mismatch");return {kind:"allowed"};};
  const work=bindHelarcRepresentationMethods({store,provider,registry,now,authorize});
  execution=bindHelarcContextExecution({store,registry,now,purposeIds:["context.representation-method","context.input-materialization","context.input-preparation","evaluation.fixed-continuation"]});
  const processor=execution.processor,signal=cancel.signal;
  const reference={owner:"case-author",kind:"source",id:"declared-source-boundary",revision:"1"};
  const lineage={auxiliary:{purpose:"context_generation",method:reference,basis:reference},instructionBinding:null,agent:null,instructions:null,instructionRelease:null,instructionResolver:null,instructionContent:null,
    instructionModel:{providerId:provider.modelContext.target.providerId,model:provider.modelContext.target.model},instructionBlocks:[],activeContext:null,contextProjection:null,projectionManifest:null,
    toolSelection:null,toolExposureContent:null,toolExposureBasis:null,toolExposureProof:null,toolGuidance:null,controllerControlGuidance:null,callableDefinitions:null,modelQualification:null,interactionHistory:null,protocol:reference,policy:reference};
  const composition=composeModelInput({id:"method-template",providerId:provider.descriptor.id,model:provider.modelContext.target.model,interaction:{kind:"text_generation"},lineage,composedAt:spec.createdAt,
    sections:[{id:"objective",source:reference,kind:"task",role:"user",necessity:"mandatory",content:{kind:"text",text:"Representation method template"}}]});
  const template={requestId:composition.id,purpose:recipient.purpose,correlation:{controllerRequestId:"method",branchId:runId},instructions:composition.instructions,messages:composition.messages,interaction:composition.interaction,composition,
    modelContext:{requestedOutput:provider.modelContext.requestedOutput,headroom:{unit:"tokens",amount:0,policy:{id:"declared-continuation",revision:"1"}},assessment:null},continuation:null,metadata:{}};
  const target=provider.encodeInput(template,"buffered").targetDigest;
  const intent=id=>({id,runId,permissionBasis:projection.branch.authorityId,resourceScope:`${projection.branch.activityNamespace}:${id}`,maximumStages:256,maximumAttempts:256,maximumConcurrent:1,deadlineAt:spec.deadlineAt});
  async function publish(id,text,role,representation=null){
    const bytes=Buffer.from(text),range={materialId:id,version:"1",coordinate:"bytes",start:0,end:bytes.length},instanceId=`${id}:instance`;
    const hold={id:`${id}:hold`,instanceId,consumer:recipient,responsibility:"checkpoint",range,basis:"declared-start",releaseCondition:"explicit trial settlement"};
    if(!(await store.querySharedAcceptance(`publish:${id}`))){
      await c({kind:"begin",intent:{id:`${id}:capture`,instanceId,activityId:`${id}:source`,owner:"case-author",maximumBytes:bytes.length,
        version:{ref:{materialId:id,version:"1"},origin:{runId,owner:"case-author",recordId:id,revision:"1",occurredAt:spec.createdAt},label:id,format:"utf8",mediaType:"text/plain",bytes:bytes.length,
          digest:`sha256:${createHash("sha256").update(bytes).digest("hex")}`,capture:"complete",limitations:[]}}});
      await c({kind:"append",id:`${id}:chunk`,intentId:`${id}:capture`,offset:0,bytesBase64:bytes.toString("base64")});await c({kind:"complete",intentId:`${id}:capture`});
      await accept({id:`publish:${id}`,scope:runId,actor:"case-author",parts:[{owner:"material_custody",kind:"publish",proposal:{intentId:`${id}:capture`,holds:[hold],
        grants:[{id:`${id}:grant`,instanceId,recipient,range,revision:0,allowed:true,basis:projection.branch.authorityId}]}}]});
    }
    return {alias:id,role,access:{id:`${id}:access`,holdId:hold.id,recipient,range},representation,order:Number(id.replace(/\D/g,""))||0,label:id,originalRole:role==="candidate"?"derived_representation":"user_statement",indivisibleGroup:id};
  }
  const sources=[];for(let i=0;i<spec.sources.length;i++)sources.push(await publish(`source-${i}`,spec.sources[i],"source"));
  let candidate;
  if(spec.fixedCandidate!==null){
    const source=await publish("fixed-candidate",spec.fixedCandidate,"candidate",{id:"fixed-candidate-representation",revision:"1"});
    await store.representations.command({kind:"record",record:{ref:source.representation,owner:recipient.recipient,runId,purpose:recipient.purpose,target,form:spec.arm==="original"?"original":"summary",body:source.access.range,
      inputs:sources.map(s=>({role:"source",material:s.access.range,representation:null})),declaredCoverage:sources.map(s=>s.access.range),details:sources.map(s=>s.access.range),
      holds:[source.access.holdId,...sources.map(s=>s.access.holdId)],requirements:[],losses:[],restorations:[],method:null}});
    candidate={id:source.alias,representation:source.representation,access:source.access};
  }
  const base={kind:"representation_method",method:spec.method,methodRevision:"1",recipient,objective:spec.objective,sources,requirements:spec.requirements,relationships:spec.relationships,
    sourceBoundary:digest(sources),deliveryIds:[],combinationDigest:null,combine:"merge",omission:null,search:null,template,targetRevision:target,
    capacity:{limits:[],reservations:[],policy:{id:"isolated-continuation",revision:"1",purpose:recipient.purpose,basis:"Declared 32k deployment; exact tokenization unavailable",allowEstimatedFit:true,allowUnknown:true},maximumCombinations:8,maximumMeasurements:0},
    bounds:{readBytes:2000000,storedBytes:2000000,modelCalls:12,repairs:1,levels:4,pageBytes:65536,ranges:64}};
  const boundary={boundary:projection.startingState.boundary,runId,sources:sources.map(s=>s.access),candidate:candidate??null,generation:store.generation,target};
  if(mode==="prepare") {await save("starting-receipt.json",boundary);await finish({kind:"prepared"});return;}
  const {consumeCandidate,foregroundEvent}=require("./context-continuation.cjs");
  const context={store,provider,registry,work,processor,signal,now,runId,recipient,target,template,lineage,base,intent,authorize,accept,projection,publish};
  context.schedule=async(id,reason)=>{
    if(spec.comparison!=="C03")return intent(id);
    const pool={id:`${runId}:model-pool`,revision:"1",authority:projection.branch.authorityId,capacity:1},workId=`${id}:scheduled-work`;
    await a({kind:"bind_resource_pool",pool});
    if(!(await a({kind:"read_schedule",workId})))await a({kind:"schedule_work",expectedRevision:0,intent:{id:`${id}:scheduling`,workId,runId,scopeId:runId,owner:"context-representation",allowedPathIds:[id],
      decisionId:`declared-${spec.arm}-arrangement:${id}`,policyRevision:"case-timing-arrangement:1",reason,delayImpact:"Declared isolated timing comparison; not a default policy decision",timing:{kind:"unknown"},
      resources:["model-access","model-measurement"].map(capability=>({poolId:pool.id,capability,units:1}))}});
    return {...intent(id),scheduledWorkId:workId};
  };
  async function foreground(){
    const fact=await foregroundEvent(context);await save("foreground-event.json",fact);process.send?.({kind:"condition",fact});
  }
  if(spec.comparison==="C03"&&spec.arm==="deferred")await foreground();
  if(!candidate){
    if(!(await a({kind:"read_path",pathId:"method"})))await work.submit(await context.schedule("method",spec.arm==="early"?"opportunity":"necessary"),base);
    if(spec.comparison==="C03"&&spec.arm==="early")await foreground();
    let result;
    for(let i=0;i<512;i++){
      signal.throwIfAborted();result=await work.result("method");if(result.kind!=="pending")break;
      await processor.drain(runId,signal);
    }
    await save("method-outcome.json",result);
    if(result?.kind!=="ready"){await finish({kind:"method_unavailable",method:result});return;}
    candidate=result.progress.candidates.filter(c=>result.progress.resultIds.includes(c.id));
    if(!candidate.length)throw new Error("Method did not deliver a candidate");
    if(mode==="interrupt-after-method"){await finish({kind:"interrupted",method:result});return;}
  }
  let prompt=spec.prompt;
  if(spec.comparison==="C03"){
    for(;;){signal.throwIfAborted();const released=await json("released-stimulus.json").catch(e=>{if(e.code==="ENOENT")return null;throw e;});if(released){prompt=released.input.prompt;break;}await new Promise(resolve=>setTimeout(resolve,25));}
  }
  const use=await consumeCandidate({...context,candidates:Array.isArray(candidate)?candidate:[candidate],prompt});
  await finish({kind:use.kind,method:await work.result("method").catch(()=>null),use});
  async function finish(outcome){
    if(mode!=="prepare"&&outcome.kind!=="interrupted")for(const id of ["method","subsequent:check"]){
      if(await a({kind:"read_path",pathId:id})){const parts=await work.prepareClosure(id,"isolated continuation settled");if(parts.length)await accept({id:`${id}:closure`,scope:runId,actor:"context-representation",parts});}
    }
    const facts=[];for(let after=0;;){const page=await store.contextFoundationFacts(runId,after,256);facts.push(...page);if(page.length<256)break;after=page.at(-1).sequence;}
    await inspection.activityObserver.replay(runId,store.activityHandoffs);await inspection.contextFoundationObserver.replay(runId,store.contextFoundationFacts.bind(store));
    await inspection.close();const health=inspection.recorder.health();
    await appendFile(join(directory,"recordings.jsonl"),JSON.stringify({...recordingIdentity,phase:"closed",health})+"\n");
    const snapshot={outcome,runId,generation:store.generation,facts,recording:{sourceId:inspection.recorder.source.sourceId,datasetId:inspection.recorder.manifest.datasetId,health}};
    await save(mode==="prepare"?"construction.json":outcome.kind==="interrupted"?"interruption.json":"target-result.json",snapshot);
    inspection=null;execution.close();execution=null;await store.close();store=null;app.exit(outcome.kind==="interrupted"?73:0);
  }
}
main().catch(async error=>{const describe=e=>e?{name:e.name,message:e.message,stack:e.stack,code:e.code,details:e.details,cause:e.cause?describe(e.cause):null}:null;
  await save("target-failure.json",describe(error)).catch(()=>{});execution?.close();if(inspection)await inspection.close().catch(()=>{});if(store)await store.close().catch(()=>{});app.exit(1);});
