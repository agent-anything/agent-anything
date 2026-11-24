const {app}=require("electron");
const assert=require("node:assert/strict"),{join}=require("node:path"),{pathToFileURL}=require("node:url"),{randomUUID}=require("node:crypto");
const {writeFile,readFile,mkdir}=require("node:fs/promises");
const [directory,phase,protocolName,endpoint]=process.argv.slice(2);
const settingsPath=process.env.HELARC_NATIVE_TREE_LIVE_SETTINGS;
require("node:fs").appendFileSync(join(directory,"launches.ndjson"),JSON.stringify({phase,pid:process.pid,live:!!settingsPath,electron:process.versions.electron,at:new Date().toISOString()})+"\n");
app.setPath("userData",join(directory,"electron"));app.disableHardwareAcceleration();
let store,reportService,provider,transport,conversion,scheduling;
async function main(){
  const load=path=>import(pathToFileURL(join(__dirname,"../../dist/main",path)));
  const {HelarcExecutionStore}=await load("execution-storage/HelarcExecutionStore.js");
  const model=await import("@agent-anything/model-interaction/protocol"),native=await import("@agent-anything/provider-integrations/native");
  const runtime=await import("@agent-anything/agent-runtime/model-access"),helarc=await import("@agent-anything/helarc/controller");
  const composition=await import("@agent-anything/helarc/composition");
  const {modelInputValueDigest:digest}=await import("@agent-anything/model-interaction/input");
  const {RunExecutionCoordinator}=await import("@agent-anything/agent-runtime/execution-coordinator");
  const {createTestContextProjection}=await import("@agent-anything/test-support");
  const {createInteractionProtocolRegistrySnapshot}=await import("@agent-anything/interaction/coordination");
  const profiles={responses:{protocol:model.OPENAI_RESPONSES,adapter:native.OPENAI_RESPONSES_ADAPTER,prepare:helarc.prepareHelarcResponsesTask,
    interpret:helarc.interpretHelarcResponses,validate:helarc.validateHelarcResponsesTaskInput,dispatch:native.dispatchResponses,read:native.readResponsesObservation},
    deepseek:{protocol:model.DEEPSEEK_CHAT_COMPLETIONS,adapter:native.DEEPSEEK_CHAT_ADAPTER,prepare:helarc.prepareHelarcDeepSeekTask,
      interpret:helarc.interpretHelarcDeepSeek,validate:helarc.validateHelarcDeepSeekTaskInput,dispatch:native.dispatchDeepSeekChat,read:native.readDeepSeekObservation},
    ollama:{protocol:model.OLLAMA_CHAT,adapter:native.OLLAMA_CHAT_ADAPTER,prepare:helarc.prepareHelarcOllamaTask,
      interpret:helarc.interpretHelarcOllama,validate:helarc.validateHelarcOllamaTaskInput,dispatch:native.dispatchOllamaChat,read:native.readOllamaChatObservation}};
  const profile=profiles[protocolName.split("-")[0]],successor=protocolName.includes("-successor"),material=protocolName.includes("-material"),failedChild=protocolName.includes("-failed-child");assert(profile);
  const nativeTransport=protocolName.includes("-transport"),converted=protocolName.includes("-converted"),live=!!settingsPath;
  const inputSupply=protocolName.includes("-inputs");
  const stopEnabled=protocolName.includes("-stop");
  const progressCase=protocolName.includes("-progress"),handles=new Map();
  const parentEnding=protocolName.includes("-progress-ending");
  const missingSource=protocolName.includes("-missing-source");
  const cancelMaterial=protocolName.includes("-cancel-material");
  const cancelConversion=protocolName.includes("-cancel-conversion");
  const cancelPublication=protocolName.includes("-cancel-publication");
  const cancelInput=protocolName.includes("-cancel-input");
  if(progressCase||cancelMaterial||cancelConversion||cancelPublication||cancelInput){
    const {ActiveRunHandle}=await import(pathToFileURL(join(__dirname,"../../node_modules/@agent-anything/agent-runtime/dist/execution-coordinator/RunHandle.js")));
    const bind=ActiveRunHandle.prototype.bindSuspend;
    ActiveRunHandle.prototype.bindSuspend=function(callback){handles.set(this.runId,this);return bind.call(this,callback);};
  }
  if(nativeTransport)provider=await require("./native-task-provider.cjs")(directory,phase,endpoint,load,protocolName,settingsPath);
  const facts=[],membershipTimings=[];
  store=await HelarcExecutionStore.open(join(directory,"execution"),undefined,undefined,undefined,{record(){},performance(e){
    if(e.kind==="finished"&&e.stage==="storage.worker.command"&&e.context.command==="read_run_tree_members")membershipTimings.push(e);
  }},undefined,undefined,undefined,undefined,{observe:f=>facts.push(f)});
  if(nativeTransport){
    const {HelarcResponsesPurposeObserver}=await load("provider/HelarcResponsesPurposeObserver.js");
    const {HelarcChatPurposeObserver}=await load("provider/HelarcChatPurposeObserver.js");
    transport=profile.protocol.id==="openai.responses"?new HelarcResponsesPurposeObserver(store,provider.service):new HelarcChatPurposeObserver(store,provider.service);
  }
  const {createHelarcMaterialAccess}=await load("context/HelarcMaterialAccess.js"),materialAccess=createHelarcMaterialAccess(store);
  const modelName=provider?.configuration.model??"controlled";
  const built=await require("./task-input-source.cjs")({descriptor:{id:profile.protocol.providerId},modelContext:{target:{providerId:profile.protocol.providerId,model:modelName}}},null,
    {nativeSource:true,delegation:true,nativeNarratives:helarc.createHelarcNativeNarrativeReader(store.protocolJournal),...(missingSource?{materialAccess}:{}),...(material?{materialAccess,reportHandoff:{publish:async(...args)=>reportService.handoff.publish(...args)}}:{}),
      prompt:live?"ROOT_CASE: This is a bounded delegation test, not a coding task. Delegate exactly two independent children using Agent in the same response. CHILD_ALPHA must delegate exactly one nested LEAF_CASE child whose only assignment is to return the number 7391; Alpha reports that child's result. CHILD_BETA's only assignment is to return the number 8422. Pass each child only its own self-contained assignment. Do not read or modify files, execute commands, or delegate more children. Once both children return, report both numbers in your final answer. No Plan is needed."+(material?
        " Additional Beta assignment: its final report must be between 18000 and 22000 characters long, with 180 numbered synthetic measurement records of approximately 110 characters each. Label them synthetic, not verified. Begin with 'Beta result: 8422'. End with 'DETAIL_CODE ' followed by a six-digit code chosen by Beta. Beta must return this whole report in final_result, not write a file. Root: when Beta's report is a retained material reference, call ContextMaterialSearch for DETAIL_CODE, then ContextMaterialRead at the returned byte position. Include that exact code in your final answer. Do not guess or treat a reference as full report receipt.":""):
        "ROOT_CASE: Delegate CHILD_ALPHA and CHILD_BETA independently. Alpha delegates LEAF_CASE. Report both results."});
  const sharedInputHost=inputSupply?{registry:new (await import("@agent-anything/agent-runtime/activity")).ActivityPurposeRegistry(),
    host:{assertAvailable:()=>scheduling.host.assertAvailable(),wake:()=>scheduling.host.wake(),subscribe:(listener,interest)=>store.onActivityChange(listener,interest)}}:null;
  if(material)reportService=await require("./native-report-service.cjs")(store,load,async runId=>{
    const head=await store.readLatestRun(runId);assert(head);return head.state.activeAgent.id;},helarc.HELARC_CONTROLLER_CAPABILITY,sharedInputHost);
  const ref=id=>({id,revision:"1"}),purpose=ref(helarc.HELARC_CONTROLLER_CAPABILITY);
  const compositions=new Map();
  const nativeModel={configuration:provider?{id:provider.configuration.id,revision:provider.configuration.revision}:ref("original-config"),
    protocol:profile.protocol,model:modelName,connectionBinding:ref(provider?.configuration.connectionBindingId??"isolated-http")};
  const journal=store.protocolJournal,acceptance=store.sharedAcceptance;
  const content=(id,activityId,value)=>runtime.retainProtocolContent(journal,id,activityId,Buffer.from(JSON.stringify(value)));
  async function accept(id,scope,actor,part){const result=await acceptance.accept({id,scope,actor,parts:[{owner:"protocol_execution",...part}]});assert.equal(result.outcome,"accepted",JSON.stringify(result));}
  async function checkpoint(label,activity){
    const tree=await store.readRunTree("root");
    await writeFile(join(directory,`${phase}.json`),JSON.stringify({label,pid:process.pid,generation:store.generation,activityId:activity.scope.activityId,
      members:tree.members.map(m=>({id:m.head.state.run.id,status:m.head.state.status}))}));app.exit(73);return new Promise(()=>{});
  }
  if(cancelInput&&phase==="input-cancel-control"){
    const originalAccept=acceptance.accept.bind(acceptance);
    acceptance.accept=async proposal=>{
      const receipt=await originalAccept(proposal);
      const captured=protocolName.includes("-ready")?proposal.parts.some(p=>p.kind==="native_input_return"):
        proposal.parts.some(p=>p.kind==="path_opening"&&p.proposal.purpose.contract.ref.id==="helarc.native-input-demand");
      if(captured&&receipt.outcome==="accepted"){
        assert.equal((await handles.get("root").cancel({origin:"user",reasonCode:"user_requested"})).status,"accepted");
        await checkpoint("Run cancelled before native dispatch",{scope:{activityId:"root:controller_turn:1:native-task"}});
      }
      return receipt;
    };
  }
  if(protocolName.includes("-inputs")&&["input-handoff","input-ready","ordinary-selected"].includes(phase)){
    const originalAccept=acceptance.accept.bind(acceptance);
    acceptance.accept=async proposal=>{
      const receipt=await originalAccept(proposal);
      const captured=phase==="input-handoff"?proposal.parts.some(p=>p.owner==="activity"&&p.kind==="path_opening"&&p.proposal.purpose.contract.ref.id==="helarc.native-input-demand"):
        proposal.parts.some(p=>p.owner==="context_input_supply"&&p.kind==="native_input_return"&&
          (phase!=="ordinary-selected"||!p.proposal.needId.includes("controller_turn:1:native-task")));
      if(receipt.outcome==="accepted"&&proposal.scope==="root"&&captured)await checkpoint("Original native input handoff retained before dispatch",{scope:{activityId:proposal.id}});
      return receipt;
    };
  }
  if(nativeTransport&&profile.protocol.id!=="openai.responses"&&protocolName.includes("-http-captured")&&phase==="root-response"){
    const originalAccept=acceptance.accept.bind(acceptance);
    acceptance.accept=async proposal=>{
      const receipt=await originalAccept(proposal);
      const captured=proposal.parts.find(p=>p.owner==="protocol_execution"&&p.kind==="record"&&p.proposal.record.ref.id.endsWith(":http-complete"));
      if(receipt.outcome==="accepted"&&captured)await checkpoint("Raw HTTP retained before original native parsing",{scope:{activityId:captured.proposal.record.activityId}});
      return receipt;
    };
  }
  if(cancelPublication&&phase==="publication-captured"){
    const command=store.materialCustody.command.bind(store.materialCustody);
    store.materialCustody.command=async value=>{
      const result=await command(value);
      if(value.kind==="complete"&&value.intentId.includes(":publication:")){
        await writeFile(join(directory,"publication-original.json"),JSON.stringify({pathId:result.intent.activityId,intentId:value.intentId}));
        assert.equal((await handles.get("root").cancel({origin:"user",reasonCode:"user_requested"})).status,"accepted");
        await checkpoint("Report capture retained before publication; Parent cancellation accepted",{scope:{activityId:result.intent.activityId}});
      }
      return result;
    };
  }
  if(cancelMaterial&&["cancel-clear","cancel-finish"].includes(phase)){
    await require("./native-report-cancellation.cjs")({store,transport,reportService,load,directory,phase,checkpoint,helarc,built});return;
  }
  if(phase==="child-admission"){
    const commit=store.commitRunTree.bind(store);
    store.commitRunTree=async value=>{
      const receipt=await commit(value),child=value.runs.find(r=>r.admission?.lineage.kind==="descendant");
      if(child)await checkpoint("original Child admission retained before launch acknowledgment",{scope:{activityId:child.id}});
      return receipt;
    };
  }
  if(nativeTransport&&protocolName.includes("-background")&&phase==="root-response"){
    const acceptOriginal=acceptance.accept.bind(acceptance);
    acceptance.accept=async proposal=>{
      const result=await acceptOriginal(proposal);
      const evidence=proposal.parts.find(p=>p.owner==="protocol_execution"&&p.kind==="evidence"&&p.proposal.evidence.metadata?.responseId);
      if(result.outcome==="accepted"&&evidence)await checkpoint("remote response known; restart must retrieve, never recreate",{scope:{activityId:evidence.proposal.evidence.activityId}});
      return result;
    };
  }
  if(material){
    const originalAccept=acceptance.accept.bind(acceptance);
    acceptance.accept=async proposal=>{
      if(phase==="receipt-failed"&&proposal.actor==="helarc.report-handoff"&&
        proposal.parts.some(p=>p.owner==="material_delivery"&&p.kind==="evidence"&&p.proposal.kind==="receipt"))
        throw new Error("Injected receipt storage failure after purpose acceptance");
      const result=await originalAccept(proposal);
      if(result.outcome==="accepted"&&proposal.actor==="helarc.report-handoff"&&
        (phase==="receipt-confirmed"&&proposal.parts.some(p=>p.owner==="material_delivery"&&p.kind==="evidence"&&p.proposal.kind==="receipt")||
         phase==="receipt-discharged"&&proposal.parts.some(p=>p.owner==="material_delivery"&&p.kind==="disposition"&&p.proposal.disposition.kind==="fulfilled")))
        await checkpoint(phase,{scope:{activityId:proposal.id}});
      return result;
    };
  }
  const structured=converted||stopEnabled||inputSupply?await require("./native-tree-structured.cjs")({store,transport,provider,compositions,checkpoint,phase,
    ...(inputSupply?{methodPurpose:"context_representation"}:{}),
    cancel:cancelConversion?async()=>{assert.equal((await handles.get("root").cancel({origin:"user",reasonCode:"user_requested"})).status,"accepted");}:null}):null;
  const convert=converted?await require("./native-child-result-conversion.cjs")({store,h:helarc,native,profile,structured,checkpoint,phase}):null;
  conversion=convert;
  const factory=protocolName.startsWith("responses")?composition.createHelarcResponsesTaskExecution:
    protocolName.startsWith("deepseek")?composition.createHelarcDeepSeekTaskExecution:composition.createHelarcOllamaTaskExecution;
  const taskPorts={journal,acceptance,generation:store.generation,contextSelections:store.contextSelections,
    ...(material?{deliveries:reportService.deliveries}:{}),
    metering:{modelInputTokens:"unavailable",modelOutputTokens:"unavailable",costUnits:"unavailable"},
    preparations:{resume:async()=>{}},
    auxiliary:structured?.participants??[],
    authorizeImport:async(seed,source)=>{const admission=await store.readRunCommit(`${source.runId}:commit:0`);
        assert.equal(admission.admission.delegationRequest.continuation.sourceChild.id,seed.sourceRunId);
        const original=(await store.readRunTree("root")).members.find(m=>m.head.state.run.id===seed.sourceRunId);assert.equal(original.head.state.status,"completed");},
    conditions:async input=>({input:ref(input.toolExposure.controllerRequestId),authority:ref("isolated-tree"),resources:ref("test-envelope"),control:ref("admitted")}),
    inputPreparation:{restore:async()=>null,interrupt:async()=>{},select:async(arranged,input,context)=>{
      const prepared=arranged.prepared,body=JSON.parse(prepared.wire.body),items=body.input??body.messages;
      helarc.validateHelarcNativeWorkingSources(prepared.workingSources,items[0]?.role==="system"?items.slice(1):items);
      assert(prepared.workingSources.groups.some(g=>g.duties.includes("objective")),"Original objective has no preservation responsibility");
      if(input.interaction.entries.some(e=>e.kind==="purpose")){
        assert(prepared.workingSources.groups.some(g=>g.acceptedBy),"Continued input lost its original acceptance");
        assert(prepared.workingSources.groups.some(g=>g.exchangeId&&g.protection.includes("active_exchange")),"Latest native exchange is not protected");
      }
      if(progressCase&&phase==="progress-boundary"&&input.runId==="root"&&arranged.prepared.wire.body.includes("suspended")&&arranged.prepared.wire.body.includes("7391"))
        await checkpoint("original Agent call settled with progress; final Child result not yet delivered",arranged.activity);
      return convert?convert(arranged,input,context):arranged;
    }},
    retainTransport:async selected=>transport?{...selected,prepared:await transport.prepare(selected.activity,selected.prepared,provider.configuration)}:selected,
    authorize:async(activity,mode,context)=>{
      assert.deepEqual(activity.composition,compositions.get(activity.composition.composition.agent.id));
      const admitted=await store.readRunCommit(`${activity.scope.runId}:commit:0`);assert(admitted?.admission);
      assert.equal(admitted.admission.lineage.root.id,"root");
      if(admitted.admission.lineage.kind==="descendant")assert.equal(activity.composition.composition.agent.id,built.delegatedAgent.id);
      if(mode!=="interrupt")context.cancellation.signal.throwIfAborted();
    },
    observe:async(state,prepared,mode,context,preview)=>{
      const b=prepared.binding,activityId=b.scope.activityId;
      if(mode==="interrupt"){
        if(transport)await transport.interrupt(state,prepared,`${activityId}:cancel`);
        return null;
      }
      if(cancelMaterial&&["cancel-control","cancel-selected"].includes(phase)&&b.scope.runId==="root"&&prepared.wire.body.includes("retained_material")){
        await writeFile(join(directory,"cancel-original.json"),JSON.stringify({activityId}));
        const receipt=await handles.get("root").cancel({origin:"user",reasonCode:"user_requested"});
        assert.equal(receipt.status,"accepted");
        if(phase==="cancel-control")await checkpoint("Run cancellation accepted before native handoff",state.activity);
        context.cancellation.signal.throwIfAborted();
        throw new Error("Cancellation was not propagated to the original task");
      }
      if(progressCase&&b.scope.runId!=="root"&&prepared.wire.body.includes("CHILD_BETA")){
        const child=handles.get(b.scope.runId);assert(child);
        if(phase==="progress-boundary"&&child.getSnapshot().status!=="suspended"){
          const receipt=await child.suspend({id:"beta-original-suspension",expectedRunRevision:child.getSnapshot().runRevision,origin:"host",reason:"Await an explicit Parent correction."});
          assert.equal(receipt.status,"accepted",JSON.stringify(receipt));
        }
        if(child.getSnapshot().status==="suspended")await new Promise((resolve,reject)=>{
          let unsubscribe=()=>{};
          const abort=()=>{unsubscribe();reject(context.cancellation.signal.reason);};
          unsubscribe=child.subscribe(snapshot=>{if(snapshot.status!=="suspended"){unsubscribe();context.cancellation.signal.removeEventListener("abort",abort);resolve();}});
          context.cancellation.signal.addEventListener("abort",abort,{once:true});
          if(context.cancellation.signal.aborted)abort();
        });
      }
      const saved=await journal.command({kind:"record",activityId,ref:b.record});if(saved)return saved;
      if(phase==="child-response"&&b.scope.runId==="root"&&prepared.wire.body.includes("7391"))await checkpoint("child settlements retained before parent dispatch",state.activity);
      if(transport){
        const record=await transport.observe(state,prepared,context.cancellation.signal,async()=>{
          context.cancellation.signal.throwIfAborted();assert.equal(state.activity.scope.runId,b.scope.runId);},preview);
        if(phase==="root-response"&&b.scope.runId==="root")await checkpoint("native session and original observation retained",state.activity);
        if(phase==="parent-response"&&b.scope.runId==="root"&&prepared.wire.body.includes("7391")){
          const accepted=JSON.parse((await runtime.readProtocolContent(journal,record.content,activityId,33554432)).toString());
          if(JSON.stringify(accepted).includes('"name":"final_result"'))await checkpoint("native final response retained",state.activity);
        }
        return record;
      }
      const intentRef=ref(`${b.operationId}:dispatch`),intent=await journal.command({kind:"record",activityId,ref:intentRef});
      if(intent)throw new Error("An unresolved original POST must not be repeated");
      await accept(`${activityId}:dispatch`,b.scope.runId,b.adapter.id,{kind:"record",proposal:{fence:state.fence,record:{ref:intentRef,activityId,
        operationId:b.operationId,kind:"dispatch_intent",content:state.input,source:null,dependencies:[]}}});
      const chunks=[];
      const wire={body:JSON.parse(prepared.wire.body),encoded:prepared.wire.body,digest:prepared.wire.digest,catalog:helarc.nativeTaskCatalog(b),format:null};
      const response=profile.read(await profile.dispatch(wire,{baseUrl:endpoint,apiKey:"synthetic"},{signal:context.cancellation.signal,retainChunk:async bytes=>{chunks.push(Buffer.from(bytes));}}));
      await content(`${activityId}:http`,activityId,{bytes:Buffer.concat(chunks).toString()});
      const raw=await content(`${activityId}:response-body`,activityId,response);
      const record={ref:b.record,activityId,operationId:b.operationId,kind:"observation",content:raw,source:{scope:b.scope,protocol:b.protocol,interpretation:b.adapter,
        operationId:b.operationId,record:b.record,position:{format:"json-pointer",value:""},nativeIdentity:response.id?{kind:"response",id:response.id}:null},dependencies:[intentRef]};
      await accept(`${activityId}:observe`,b.scope.runId,b.adapter.id,{kind:"record",proposal:{fence:null,record}});
      const body=JSON.stringify(wire.body),isRoot=b.scope.runId==="root";
      if(phase==="root-response"&&isRoot)await checkpoint("original observation retained",state.activity);
      if(phase==="parent-response"&&isRoot&&body.includes("7391")&&JSON.stringify(response).includes('"name":"final_result"'))await checkpoint("all child results delivered",state.activity);
      return record;
    }};
  if(protocolName.includes("-scheduled"))scheduling=await require("./native-task-scheduling.cjs")({store,load,ports:taskPorts,runtime,structured,protocol:nativeModel.protocol.id,inputSupply,shared:sharedInputHost,ordinary:protocolName.includes("-ordinary")});
  const nativeFactory=factory(taskPorts,provider?.configuration.protocol==="openai.responses"?{stream:provider.configuration.native.stream,store:provider.configuration.native.store,background:provider.configuration.native.background}:{stream:protocolName.includes("-stream")});
  const product=await require("./native-product-source.cjs")({directory,store,built,model:nativeModel,materialAccess,reportHandoff:reportService?.handoff,
    stopEvaluation:stopEnabled?structured.stopEvaluation:undefined,
    taskExecution:async binding=>{const result=await nativeFactory(binding);for(const c of result.compositions)compositions.set(c.composition.agent.id,c);return result;}});
  const task=product.taskDecisions;
  built.agent=product.agent;built.delegatedAgent=product.delegatedAgent;
  const {config}=await require("./task-runner-config.cjs")(directory,built.registration,built.contextAccess);
  const a=product.actions,operations={catalog:a.operationCatalog,bindings:a.operationBindings,toolInputSemanticValidators:a.toolInputSemanticValidators,
    resultContracts:a.resultContracts,resultPresenters:a.resultPresenters,internalHandlers:a.internalHandlers,composite:a.composite,availability:a.operationAvailability,delegation:product.delegation};
  const extraChildren=Number(process.env.HELARC_TEST_EXTRA_CHILDREN??0);
  config.tools=a.toolSelection;config.runTreeLimits={maxTotalDescendantRuns:8,maxActiveDescendantRuns:4+extraChildren,maxDescendantDepth:3};
  if(live){config.runTreeLimits.maxTotalDescendantRuns=3;config.runTreeResources.controllerTurns.maximum=12;config.runTreeResources.actions.maximum=12;}
  const agents={resolve:async ref=>{const agent=[built.agent,built.delegatedAgent].find(a=>a.id===ref.id&&a.revision===ref.revision);
    return {status:agent?"admitted":"unavailable",agent:agent??null,admissionEvidenceRef:agent?"isolated-agent":null,code:agent?null:"agent_unavailable"};}};
  const starting=!(await store.readLatestRun("root"));let root=starting;
  if(!starting){
    const {createRunTranscriptRecord}=await import("@agent-anything/agent-runtime/transcript");
    for(const member of (await store.readRunTree("root")).members){
      product.recordRunLineage(member.head.state.run.id,member.admission.lineage);
      for(const item of member.head.state.items)product.recordTranscript(createRunTranscriptRecord(item));
    }
    await product.flushPresentation();
  }
  // A new service starts dispatching immediately. Bind the original product first, including on recovery.
  if(scheduling){assert(compositions.has(built.agent.id)&&compositions.has(built.delegatedAgent.id));scheduling.activate();}
  const runner=new RunExecutionCoordinator({taskDecisions:task,extensions:product.extensions,preparations:product.preparations,operations,
    runObserver:{observe:value=>product.recordRunLineage(value.snapshot.runId,value.lineage)},
    runTranscriptObserver:{observe:record=>product.recordTranscript(record)},
    contextProjection:createTestContextProjection(),createRunId:()=>{if(root){root=false;return "root";}return randomUUID();},agents,runTreeCommits:store,
    interactions:createInteractionProtocolRegistrySnapshot("empty",[])});
  const handle=starting?runner.start(built.agent,{task:built.source.task,items:[],metadata:{}},config):
    await runner.recover("root",{resolve:async retained=>{const resolved=await agents.resolve(retained.head.state.activeAgent);assert(resolved.agent);
      return {agent:resolved.agent,config:{...retained.admission.config,permissions:{...retained.admission.config.permissions,reviewer:null,sessionAuthority:null,persistentPolicyAmendments:null}}};}});
  let result;
  try{result=await handle.wait();}catch(error){
    if(phase!=="receipt-failed")throw error;
    assert.equal(error.name,"ActivityCheckpointError");assert(error.key.endsWith(":input-delivery"));
    const retained=await store.readLatestRun("root");assert.notEqual(retained.state.status,"failed");
    await checkpoint("receipt failure preserved original native purpose and pending Run",{scope:{activityId:error.key}});
  }
  await product.flushPresentation();
  const display=product.getProductProjection().presentation;
  assert(!display.records.some(r=>r.content.title==="Response display unavailable"),"native Product capture must remain complete");
  assert(display.records.every(r=>!r.origin?.nativeSource||r.origin.turnId===null));
  assert.equal(new Set(display.records.map(r=>r.id)).size,display.records.length,"Product replay must not duplicate accepted sources");
  await writeFile(join(directory,`presentation-${phase}.json`),JSON.stringify({presentation:display,previews:product.getResponsePreviews()},null,2));
  await writeFile(join(directory,`result-${phase}.json`),JSON.stringify(result,null,2));
  if(cancelInput){
    assert.equal(result.status,"cancelled");assert.equal(handle.getSnapshot().runTree.settlement.complete,true);
    const activityId="root:controller_turn:1:native-task",demandId=`${activityId}:input-demand`;
    assert.equal(await journal.command({kind:"state",activityId}),null,"Input cancellation must not manufacture a native dispatch");
    const path=await store.activityHandoffs.command({kind:"read_path",pathId:demandId});assert(path.cancelled);
    const need=await store.activityHandoffs.command({kind:"read_input_need",id:`${demandId}:need`});
    if(need)assert.equal((await store.inputSupplies.query({kind:"exit",needId:need.id})).status,"closed");
    else assert.equal(await store.inputSupplies.query({kind:"head",needId:`${demandId}:need`}),null);
    assert.equal((await store.activityHandoffs.command({kind:"read_schedule",workId:demandId})).settlementConfirmed,true);
    await writeFile(join(directory,"verification.json"),JSON.stringify({profile:protocolName,generation:store.generation,nativeDispatches:0,
      demandCancelled:true,supplyExit:need?"closed":"not_opened",taskSettled:true},null,2));return;
  }
  if(cancelPublication&&phase==="publication-cancel"){
    assert.equal(result.status,"cancelled");assert.equal(handle.getSnapshot().runTree.settlement.complete,true);
    const {pathId,intentId}=JSON.parse(await readFile(join(directory,"publication-original.json"),"utf8"));
    const {ActivityChangeWait}=await import("@agent-anything/agent-runtime/activity");
    const wake=new ActivityChangeWait({subscribe:listener=>store.onActivityChange(listener)},new AbortController().signal);
    try{for(;;){const version=wake.version,s=await store.activityHandoffs.command({kind:"read_schedule",workId:pathId});
      if(s.settlementConfirmed)break;await wake.wait(version,100);}}finally{wake.close();}
    const path=await store.activityHandoffs.command({kind:"read_path",pathId});
    const stage=await store.activityHandoffs.command({kind:"read_stage",requestId:`${pathId}:capture`});
    assert(stage.status==="settled"||stage.status==="accepted");
    assert(await store.activityHandoffs.command({kind:"read_fact",id:`${pathId}:stop`}));
    const root=await store.readLatestRun("root"),report=root.control.descendantTransfers.find(t=>t.narrative?.source.recordId===path.intent.id.split(":publication:")[0]);
    assert(report?.narrative.text.includes("DETAIL_CODE"),"Original complete report retained even if publication was cancelled");
    const calls=root.state.items.filter(i=>i.payload.kind==="model_call_settlement");assert.equal(new Set(calls.map(i=>i.payload.result.modelCallRef.id)).size,calls.length);
    const state=await store.materialCustody.command({kind:"state",intentId});assert(state);
    await writeFile(join(directory,"verification.json"),JSON.stringify({profile:"publication-cancel",generation:store.generation,
      originalReportRetained:true,publicationStage:stage.status,sourceState:state.state,scheduleSettled:true,duplicateSettlements:0},null,2));return;
  }
  if(cancelConversion&&phase==="conversion-cancel"){
    assert.equal(result.status,"cancelled");assert.equal(handle.getSnapshot().runTree.settlement.complete,true);
    const {activityId}=JSON.parse(await readFile(join(directory,"conversion-observed.json"),"utf8"));
    const state=await journal.command({kind:"state",activityId});
    const original=JSON.parse((await runtime.readProtocolContent(journal,state.input,activityId,32*1024*1024)).toString());
    const methodId=original.source.id.slice(0,-":job:initial:method-source".length);
    await convert.settled(methodId);
    assert.equal((await journal.command({kind:"state",activityId})).cancelled,true);
    assert.equal(await journal.command({kind:"acceptance",activityId}),null,"Cancelled method must not accept its output");
    assert(await journal.command({kind:"record",activityId,ref:original.observation}),"Original generation observation retained");
    const path=await store.activityHandoffs.command({kind:"read_path",pathId:methodId});assert(path.cancelled);
    const report=(await store.readLatestRun("root")).state.items.find(i=>i.payload.kind==="model_call_settlement"&&i.payload.result.content?.output?.report)?.payload.result.content.output.report;
    assert(report);const recipient={runId:"root",recipient:built.agent.id,purpose:helarc.HELARC_CONTROLLER_CAPABILITY};
    const access=await store.materialCustody.command({kind:"resolve_reference",reference:report.reference,recipient});
    const page=await store.materialCustody.command({kind:"read",access:{id:"retained-after-conversion-cancel",holdId:access.hold.id,recipient,range:access.hold.range},offset:0,length:128});
    assert(page.text.includes("8422"));
    const tree=await store.readRunTree("root");assert.equal(tree.members.length,4);
    assert(tree.members.filter(m=>m.head.state.run.id!=="root").every(m=>m.head.state.status==="completed"));
    await writeFile(join(directory,"verification.json"),JSON.stringify({profile:"conversion-cancel",generation:store.generation,members:4,
      nativeGenerationRetained:true,methodAccepted:false,scheduleSettled:true,originalDetailRetained:true},null,2));return;
  }
  if(cancelMaterial&&phase==="cancel-selected"){
    assert.equal(result.status,"cancelled");assert.equal(handle.getSnapshot().runTree.settlement.complete,true);
    await checkpoint("Parent cancelled with the original selected report still protected",{scope:{activityId:JSON.parse(await readFile(join(directory,"cancel-original.json"),"utf8")).activityId}});
  }
  assert.equal(phase,"finish",JSON.stringify(result.cause));assert.equal(result.status,parentEnding?"failed":"completed",JSON.stringify(result.cause));
  if(!parentEnding){
    assert(result.finalOutput.summary.includes("7391")&&result.finalOutput.summary.includes("8422"));
    assert.equal(result.finalOutput.source.kind,"native_response");
  }else assert.equal(handle.getSnapshot().runTree.settlement.complete,true);
  const extra=Number(process.env.HELARC_TEST_EXTRA_CHILDREN??0);
  const memberIds=[];let cursor=null;
  do{const page=await store.readRunTreeMembers("root",cursor,2);memberIds.push(...page.runIds);cursor=page.next;}while(cursor);
  await store.readRunTreeMembers("root");
  assert.equal(memberIds.length,(successor?5:4)+extra-(missingSource?1:0));assert.equal(new Set(memberIds).size,memberIds.length);
  assert(membershipTimings.length>0);assert(membershipTimings.every(e=>(e.counters?.["content.reads"]??0)===0&&(e.counters?.["content.rootReads"]??0)===0));
  const tree=await store.readRunTree("root");assert.deepEqual([...memberIds].sort(),tree.members.map(m=>m.head.state.run.id).sort());
  assert.equal(tree.members.filter(m=>m.head.state.status==="failed").length,failedChild||parentEnding?1:0);
  assert(tree.members.every(m=>m.head.state.status==="completed"||(failedChild||parentEnding)&&m.head.state.status==="failed"||parentEnding&&m.head.state.status==="cancelled"));
  let accepted=0,settled=0;const offers=[],{ProtocolJournalInspectionAdapter}=await load("inspection/ProtocolJournalInspectionAdapter.js");
  const recorder={ref:(owner,kind,id,runId,revision="1")=>({sourceId:"fixture",datasetId:"fixture",owner,kind,id,runId,revision}),offer:r=>offers.push(r)};
  for(const member of tree.members){
    const items=member.head.state.items;
    assert(!items.some(i=>i.payload.kind==="controller_turn"&&i.payload.modelItems.some(m=>m.kind==="model_turn_finish")));
    const keys=items.filter(i=>i.payload.kind==="model_call_settlement").map(i=>i.payload.result.modelCallRef.id);assert.equal(new Set(keys).size,keys.length);settled+=keys.length;
    const native=items.flatMap(i=>i.payload.kind==="controller_turn"?i.payload.modelItems.filter(m=>m.kind==="native_purpose_evidence"):[]);accepted+=native.length;
    if(live){
      assert(native.length>0);
      for(const [index,item]of native.entries()){
        const activityId=item.evidence.scope.activityId,state=await journal.command({kind:"state",activityId});
        const original=JSON.parse((await runtime.readProtocolContent(journal,state.input,activityId,32*1024*1024)).toString());
        const body=JSON.parse(original.wire.body);assert(!body.instructions);
        assert(!body.input.some(i=>["system","developer"].includes(i.role)),"Disabled optional Instructions must not be restored");
        const text=body.input.filter(i=>i.role==="user").map(i=>i.content).join("\n");
        if(member.admission.lineage.kind==="root")assert(text.includes("ROOT_CASE:"));
        else{
          assert(!text.includes("ROOT_CASE:"));
          assert(text.includes(member.admission.delegationRequest.objective.text));
          if(index===0)assert(!body.input.some(i=>i.type==="function_call"||i.type==="function_call_output"),"New Child cannot inherit Parent Calls");
        }
        const calls=new Set(body.input.filter(i=>i.type==="function_call").map(i=>i.call_id));
        const outputs=body.input.filter(i=>i.type==="function_call_output");
        assert.equal(new Set(outputs.map(i=>i.call_id)).size,outputs.length);
        assert(outputs.every(i=>calls.has(i.call_id)),"Every replayed result has its original Call");
      }
    }
    for(const item of items)if(item.payload.kind==="model_call_settlement"){
      const call=item.payload.result.modelCallRef,effect=await journal.command({kind:"effect",activityId:call.nativeSource.scope.activityId,callId:call.id});
      const rejected=items.some(i=>i.payload.kind==="controller_turn"&&i.payload.modelItems.some(m=>m.kind==="native_rejected_call"&&m.call.modelCallRef.id===call.id));
      if(rejected){assert.equal(item.payload.result.settlement,"invalid");assert.equal(effect,null,"Rejected native Calls must not acquire execution effects");continue;}
      assert.equal(effect.confirmationBasis,"run_execution");assert.equal(effect.coordination.settledIn.id,item.ref.id);
      assert.equal(effect.dispatched,false,"Run coordination is not physical dispatch evidence");
    }
    await new ProtocolJournalInspectionAdapter(recorder).replay((after,limit)=>journal.command({kind:"facts",runId:member.head.state.run.id,after,limit}));
  }
  if(live){assert(accepted>=6&&accepted<=12);assert(settled>=7&&settled<=12);}
  else if(!progressCase){assert.equal(accepted,(successor||material||failedChild?8:6)+extra+(protocolName.includes("-oversized")?1:0)-(missingSource?1:0));
    assert.equal(settled,(failedChild?6:successor||material?9:7)+extra*2+(protocolName.includes("-oversized")?1:0)-(missingSource?1:0));}
  if(missingSource){
    assert(!tree.members.some(m=>m.admission.delegationRequest?.objective.text.includes("CHILD_BETA")));
    assert(tree.members.find(m=>m.head.state.run.id==="root").head.state.items.some(i=>i.payload.kind==="model_call_settlement"&&i.payload.result.content?.failure));
  }
  assert(offers.some(o=>o.payload.name==="model.purpose_evidence_accepted"));
  if(progressCase){
    const parent=tree.members.find(m=>m.head.state.run.id==="root");
    const observations=parent.head.state.observations??[];
    await writeFile(join(directory,"progress-records.json"),JSON.stringify({items:parent.head.state.items,observations},null,2));
    const progress=parent.head.state.items.filter(i=>i.payload.kind==="model_call_settlement"&&i.payload.result.content?.output?.status==="suspended");
    assert.equal(progress.length,1,"The original Agent Call has one progress settlement");
    const childId=progress[0].payload.result.content.childRunId;
    const child=tree.members.find(m=>m.head.state.run.id===childId);assert.equal(child.head.state.status,parentEnding?"cancelled":"completed");
    assert(JSON.stringify(parent.head.state.items).includes("descendant_result"),"Final delivery is retained separately");
    if(parentEnding)assert(JSON.stringify(child.head.state).includes("parent_run_ending"));
    else assert(JSON.stringify(child.head.state.items).includes("CORRECTION_CASE"));
  }
  if(converted){
    const root=tree.members.find(m=>m.head.state.run.id==="root");
    let last;
    for(const item of root.head.state.items.filter(i=>i.payload.kind==="controller_turn")){
      const e=item.payload.modelItems.find(m=>m.kind==="native_purpose_evidence")?.evidence;
      if(e&&(await journal.command({kind:"state",activityId:e.scope.activityId}))?.contextInput)last=item;
    }
    assert(last);
    const evidence=last.payload.modelItems.find(m=>m.kind==="native_purpose_evidence").evidence;
    const state=await journal.command({kind:"state",activityId:evidence.scope.activityId});assert(state.contextInput);
    const selected=await store.contextSelections.command({kind:"binding",inputId:state.contextInput.id,checkCurrentControl:true});
    assert.equal(selected.input.stageRequestId,null);assert.equal(await store.activityHandoffs.command({kind:"read_path",pathId:state.activity.scope.activityId}),null);
    assert(selected.input.exactInput.wire.body.includes("Beta result: 8422; measurements remain unverified."));
    const original=root.head.state.items.find(i=>i.payload.kind==="model_call_settlement"&&(material?i.payload.result.content?.output?.report?.status==="retained_material":i.payload.result.content?.output?.summary?.includes("SOURCE_DETAIL")));
    const originalText=material?tree.members.find(m=>m.head.state.finalOutput?.summary?.includes("DETAIL_CODE")).head.state.finalOutput.summary:original.payload.result.content.output.summary;
    assert(originalText.length>2000);assert(!selected.input.exactInput.wire.body.includes("SOURCE_DETAIL repeated measurements without independent confirmation.\\n".repeat(2)));
    const originalDescription=material?await store.materialCustody.command({kind:"resolve_reference",reference:original.payload.result.content.output.report.reference,
      recipient:{runId:"root",recipient:built.agent.id,purpose:helarc.HELARC_CONTROLLER_CAPABILITY}}):null;
    const hold=material?selected.input.holds.find(h=>digest(h.range)===digest(originalDescription.hold.range)):selected.input.holds.find(h=>h.range.materialId.endsWith(":original-body"));assert(hold);
    const page=await store.materialCustody.command({kind:"read",access:{id:"inspect-original-child",holdId:hold.id,recipient:hold.consumer,range:hold.range},offset:0,length:Math.min(65536,hold.range.end)});
    assert.equal(page.text,originalText);
    assert.equal((await store.sharedAcceptance.query(`${selected.input.id}:purpose-received`)).outcome,"accepted");
    assert(offers.some(o=>o.links.some(l=>JSON.stringify(l).includes(selected.input.id))));
    await convert.settled(`${selected.input.activityId}:result-conversion`);
  }
  if(failedChild){
    const failed=tree.members.find(m=>m.head.state.status==="failed"),parent=tree.members.find(m=>m.head.state.run.id==="root");
    const report=parent.head.control.descendantTransfers.find(t=>t.childRunId===failed.head.state.run.id).narrative;
    assert(report.text.includes("Beta attempt 3"));assert.equal(report.source.origins[0].kind,"native_task_text");
    assert(report.source.origins[0].id.includes(":native-task:accepted"));
  }
  if(material){
    const report=tree.members.find(m=>m.head.state.finalOutput?.summary?.includes("DETAIL_CODE"));assert(report);
    const reportText=report.head.state.finalOutput.summary,detailCode=reportText.match(/DETAIL_CODE\s*:?\s*(\d+)/)?.[1];assert(detailCode);
    assert(result.finalOutput.summary.includes(detailCode));
    assert(reportText.length>(live?16000:40000));
    const root=tree.members.find(m=>m.head.state.run.id==="root");
    const outcomes=root.head.state.items.filter(i=>i.payload.kind==="model_call_settlement").map(i=>i.payload.result.content);
    const ref=outcomes.find(o=>o.output?.report)?.output.report.reference;assert(ref);
    const {helarcReportDeliveryRef}=await load("context/HelarcNativeReportDelivery.js");
    const deliveryRef=helarcReportDeliveryRef(ref,{runId:"root",recipient:built.agent.id,purpose:helarc.HELARC_CONTROLLER_CAPABILITY});
    const delivered=await store.materialDeliveries.query({kind:"obligation",ref:deliveryRef});
    assert.equal(delivered.discharged.length,1);assert.equal(delivered.protection.inFlight,"none");
    const deliveryFacts=await store.materialDeliveryFacts("root",0,128);
    assert.equal(deliveryFacts.filter(f=>f.kind==="material_delivery.evidence"&&f.value.kind==="receipt").length,1);
    assert.equal(deliveryFacts.filter(f=>f.kind==="material_delivery.disposition").length,1);
    assert(deliveryFacts.some(f=>f.value?.obligation?.contract?.confirmation?.includes("not full-body receipt")));
    await new ProtocolJournalInspectionAdapter(recorder).replay((after,limit)=>store.materialDeliveryFacts("root",after,limit));
    const page=await materialAccess.read("root",{reference:ref,length:128},new AbortController().signal,"verify");assert(page.text.includes("8422"));
    const sibling=tree.members.find(m=>m.head.state.run.id!=="root"&&m.head.state.run.id!==report.head.state.run.id&&m.head.state.finalOutput?.summary?.includes("7391"));assert(sibling);
    await assert.rejects(()=>materialAccess.read(sibling.head.state.run.id,{reference:ref,length:128},new AbortController().signal,"forbidden"));
    if(live){
      const accessCalls=root.head.state.items.filter(i=>i.payload.kind==="model_call_settlement").map(i=>i.payload.result);
      const expectedPosition=Buffer.byteLength(reportText.slice(0,reportText.lastIndexOf("DETAIL_CODE")));
      assert(accessCalls.some(r=>r.content?.output?.matches?.some(m=>m.byteStart===expectedPosition&&m.excerpt==="DETAIL_CODE"&&m.description.reference.id===ref.id)),
        "Actual Parent search must locate the original marker in the correct material");
      assert(accessCalls.some(r=>r.content?.output?.coordinate==="utf8_view_bytes"&&r.content.output.byteStart===expectedPosition&&
        r.content.output.description.reference.id===ref.id&&r.content.output.text.includes(detailCode)),"Actual Parent read must receive the original detail at the search position");
    }
  }
  const scheduleEvidence=await scheduling?.verify(tree);
  await writeFile(join(directory,"verification.json"),JSON.stringify({protocol:protocolName,pid:process.pid,generation:store.generation,members:tree.members.length,accepted,settled,scheduleEvidence,
    live,model:modelName,originalFinalReply:!parentEnding,parentEnding,artificialTurns:0,inspectorRecords:offers.length,productComposition:true,stopEnabled,
    membership:{members:memberIds.length,pages:membershipTimings.length,bodyReads:0}},null,2));
}
app.whenReady().then(main).then(async()=>{await scheduling?.close();await conversion?.close();await transport?.close();await provider?.close();await reportService?.close();await store?.close();app.exit(0);}).catch(async error=>{
  const {captureExecutionError}=await import(pathToFileURL(join(__dirname,"../../dist/main/diagnostics/ExecutionErrorDetails.js")));
  await mkdir(directory,{recursive:true});await writeFile(join(directory,`failure-${phase}.txt`),JSON.stringify(captureExecutionError(error),null,2));try{await scheduling?.close();await conversion?.close();await transport?.close();await provider?.close();await reportService?.close();await store?.close();}finally{app.exit(1);}
});
