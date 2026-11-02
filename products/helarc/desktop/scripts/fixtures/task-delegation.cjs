const {app}=require("electron");
const assert=require("node:assert/strict");
const {join}=require("node:path");
const {pathToFileURL}=require("node:url");
const {randomUUID}=require("node:crypto");
const {writeFile,readFile}=require("node:fs/promises");
const {createWriteStream}=require("node:fs");
const [directory,phase,endpoint]=process.argv.slice(2);
const continuation=process.env.TASK_DELEGATION_CONTINUATION==="1";
const largeResult=process.env.TASK_DELEGATION_LARGE_RESULT==="1";
const retainedReport=process.env.TASK_DELEGATION_RETAINED_REPORT==="1";
const redistribute=process.env.TASK_DELEGATION_REDISTRIBUTE==="1";
app.setPath("userData",join(directory,"electron"));app.disableHardwareAcceleration();
let store,service,inspection,queries;
async function main(){
  await app.whenReady();
  const load=path=>import(pathToFileURL(join(__dirname,"../../dist/main",path)));
  const {HelarcExecutionStore}=await load("execution-storage/HelarcExecutionStore.js");
  const {HelarcActivityService}=await load("context/HelarcActivityService.js");
  const {createHelarcTaskResponseExecution}=await load("context/HelarcTaskResponseExecution.js");
  const {createHelarcTaskPreparation}=await load("context/HelarcTaskPreparation.js");
  const {bindHelarcMethodInputSupply}=await load("context/HelarcMethodInputSupply.js");
  const {bindHelarcContextSettings}=await load("context/HelarcContextRunBinding.js");
  const {ActivityPurposeRegistry}=await import("@agent-anything/agent-runtime/activity");
  const {SourceMaterialPublicationWork,ContextInputPreparationWork,RepresentationMethodWork,contextPreparationReconsideration,prepareOriginalInputSelection,readContextPreparationEvidence}=await import("@agent-anything/agent-runtime/context-representation");
  const {createHelarcProviderProfile,createDefaultHelarcContextSettings}=await import("@agent-anything/helarc/configuration");
  const {modelInputValueDigest:digest}=await import("@agent-anything/model-interaction/input");
  const {OllamaProvider}=await import("@agent-anything/provider-integrations/ollama");
  const provider=new OllamaProvider({model:"controlled",baseUrl:endpoint,timeoutMs:60000,think:false,nativeToolInteraction:{supported:true},runtime:{contextWindowTokens:16384},
    requestBodyTransportLimit:{maximumBytes:largeResult?82000:1000000,source:"host_configured",revision:"1"}});
  const profile=createHelarcProviderProfile({id:"isolated",providerKind:"ollama",displayName:"Isolated",baseUrl:endpoint,model:"controlled",timeoutMs:60000,
    ollamaRuntime:{contextWindowTokens:16384},credentialStatus:"empty_allowed"});assert(profile.ok);
  const context=bindHelarcContextSettings(createDefaultHelarcContextSettings(),profile.profile);
  let diagnostics;
  if(process.env.TASK_DELEGATION_DIAGNOSTICS==="1") {
    const output=createWriteStream(join(directory,`${phase}-performance.jsonl`));let events=0;
    output.on("error",()=>{diagnostics.performance=()=>{};});
    diagnostics={performance:event=>{if(event.kind==="finished"&&["storage.host.request","storage.worker.dispatch","storage.worker.content.expand"].includes(event.stage)&&events++<100000)output.write(JSON.stringify(event)+"\n");}};
  }
  store=await HelarcExecutionStore.open(join(directory,"execution"),undefined,undefined,undefined,diagnostics);
  const {createHelarcMaterialAccess}=await load("context/HelarcMaterialAccess.js");
  const {createHelarcMaterialHandoff}=await load("execution-storage/HelarcMaterialHandoff.js");
  const {createHelarcReportMaterialHandoff}=await load("context/HelarcReportMaterialHandoff.js");
  let reports;
  const materialAccess=createHelarcMaterialAccess(store);
  const built=await require("./task-input-source.cjs")(provider,null,{delegation:true,
    ...(retainedReport?{materialAccess,materialHandoff:createHelarcMaterialHandoff(store),reportHandoff:{publish:async(...args)=>{
      if(phase==="report-retained")await interruptReport();
      return reports.publish(...args);
    }}}:{}),
    ...(largeResult?{delegationSchemaDescription:"Schema documentation for this isolated delegation contract. ".repeat(300)}:{}),
    prompt:"ROOT_CASE: Delegate independent CHILD_ALPHA and CHILD_BETA investigations together. Alpha delegates LEAF_CASE. Report both results."+
    (continuation?" After both complete, use SendMessage to ask Alpha to add TARGET 9507, then report all findings.":"")});
  const a=command=>store.activityHandoffs.command(command),now=()=>new Date().toISOString(),registry=new ActivityPurposeRegistry();
  if(phase==="inspect") {
    const failed=JSON.parse(await readFile(join(directory,"result-parent-response.json"),"utf8"));
    const paths=[];
    for(const ref of failed.cause?.failure?.failure?.metadata?.limitation?.evidence??[]) {
      const path=await a({kind:"read_path",pathId:ref.id});
      if(path)paths.push(path);
      if(path?.progress?.preparationPathId) {
        paths.push(await a({kind:"read_path",pathId:path.progress.preparationPathId}));
        paths.push(await a({kind:"read_stage",requestId:`${path.progress.preparationPathId}:stage:1`}));
        const check=await a({kind:"read_path",pathId:`${path.intent.id}:combination`});paths.push(check);
        if(check?.progress?.method?.gap?.stageId)paths.push(await a({kind:"read_stage",requestId:check.progress.method.gap.stageId}));
      }
    }
    await writeFile(join(directory,"failed-paths.json"),JSON.stringify(paths,null,2));
    const input=paths.at(-1)?.request?.input?.request?.template;
    if(input)console.log(JSON.stringify({failedEncodedBytes:provider.encodeInput(input,"buffered").bytes,
      sections:input.composition.sections.map(s=>({id:s.id.split(":").at(-1),bytes:Buffer.byteLength(JSON.stringify(s.content))}))}));
    await store.close();store=null;app.exit(0);return;
  }
  const authorize=async path=>{assert.equal(path.intent.permissionBasis,"isolated-tree");return {kind:"allowed"};};
  const publications=new SourceMaterialPublicationWork(store.activityHandoffs,registry,{materials:store.materialCustody,selections:store.contextSelections,authorize,now});
  async function interruptReport(){
    const tree=await store.readRunTree("root");
    await writeFile(join(directory,`${phase}.json`),JSON.stringify({members:tree.members.map(m=>({runId:m.head.state.run.id,status:m.head.state.status}))}));
    app.exit(73);return new Promise(()=>{});
  }
  reports=createHelarcReportMaterialHandoff({store,publications,rediscoveryMs:10,
    host:{assertAvailable:()=>{if(phase==="report-interrupted")throw new Error("Host closing before report publication");service.assertAvailable();},subscribe:listener=>store.onActivityChange(listener),wake:()=>service.wake()},
    binding:async result=>({child:{runId:result.correlation.child.run.id,recipient:built.delegatedAgent.id,purpose:built.request.purpose},
      parent:{runId:result.correlation.origin.parent.run.id,recipient:built.agent.id,purpose:built.request.purpose},
      permissionBasis:"isolated-tree",scopeId:"tree",localPoolId:"local",deadlineAt:"2030-01-01T00:00:00.000Z",maximumSourceBytes:1048576}),
    authorize:async(result,binding,signal)=>{signal.throwIfAborted();assert.equal(binding.parent.runId,"root");assert.equal(result.correlation.origin.root.run.id,"root");return true;}});
  const acceptance=store.sharedAcceptance;
  // The store exposes facades; intercept this facade rather than reconstructing acceptance.
  if(retainedReport&&["report-published","report-admitted"].includes(phase)) {
    const original=acceptance.accept;
    acceptance.accept=async proposal=>{
      const report=proposal.actor==="helarc.report-handoff";
      if(report&&phase==="report-published")await interruptReport();
      const result=await original.call(acceptance,proposal);
      if(report&&phase==="report-admitted"&&result.outcome==="accepted")await interruptReport();
      return result;
    };
  }
  const preparation=new ContextInputPreparationWork(store.activityHandoffs,registry,{provider,materials:store.materialCustody,authorize,now});
  const methods=new RepresentationMethodWork({provider,materials:store.materialCustody,representations:store.representations,selections:store.contextSelections,activities:store.activityHandoffs,authorize,now},registry);
  const execution=createHelarcTaskResponseExecution({provider,purposes:registry,activities:store.activityHandoffs,acceptance:store.sharedAcceptance,
    selections:store.contextSelections,authorize,now,rediscoveryMs:10,settlementWaitMs:5000,
    host:{assertAvailable:()=>service.assertAvailable(),subscribe:listener=>store.onActivityChange(listener),wake:()=>service.wake()},
    preparations:{resume:async()=>{service.assertAvailable();service.wake();}},
    arrange:source=>{
      const id=`${source.toolExposure.controllerRequestId}:response`;
      return {identity:{id,runId:source.runId,permissionBasis:"isolated-tree",resourceScope:id,scheduledWorkId:id,maximumStages:8,maximumAttempts:8,maximumConcurrent:1,deadlineAt:"2030-01-01T00:00:00.000Z"},
        schedule:{id:`${id}:schedule`,workId:id,runId:source.runId,scopeId:"tree",owner:"task-decision",reason:"task",decisionId:id,policyRevision:"isolated:1",
          delayImpact:"Original task response",timing:{kind:"unknown"},resources:[{capability:"model-request",poolId:"model",units:1}]}};
    }},built.binding);
  const methodReception=bindHelarcMethodInputSupply({store,registry,preparation,methods,authorize,now});
  const supply=createHelarcTaskPreparation({provider,activities:store.activityHandoffs,responsibilities:store.inputSupplies,publications,preparation,authorize:async basis=>{await authorize(basis.consumer);},
    binding:async()=>({context,treeScopeId:"tree",modelPoolId:"model",localPoolId:"local",deliveryMode:"buffered"}),
    decisions:store.contextPolicy,selections:store.contextSelections,materials:store.materialCustody,methods,
    methodInputs:methodReception.supply,methodConsumers:methodReception.consumer});
  if(phase==="root-response")for(const [id,capacity] of [["model",1],["local",2]])await a({kind:"bind_resource_pool",pool:{id,capacity,revision:"1",authority:"isolated-tree"}});
  const priorPhase=phase==="finish"?"parent-response":phase==="parent-response"||phase.startsWith("report-")?"child-response":phase==="child-response"?"root-response":null;
  const interrupted=priorPhase?JSON.parse(await readFile(join(directory,`${priorPhase}.json`),"utf8")):null;
  const purposes={resolve:(binding,scope)=>{
    const handler=registry.resolve(binding,scope);
    if(phase==="report-captured"&&binding.contract.ref.id===publications.purpose.contract.ref.id)return {
      authorize:handler.authorize.bind(handler),execute:handler.execute.bind(handler),reconcile:handler.reconcile.bind(handler),settle:handler.settle.bind(handler),
      interpret:async(path,stage,...args)=>{
        if(stage.request.input.intent?.version.label==="Child report")await interruptReport();
        return handler.interpret(path,stage,...args);
      }};
    if(binding.contract.ref.id!==execution.work.purpose.contract.ref.id)return handler;
    return {authorize:handler.authorize.bind(handler),execute:handler.execute.bind(handler),reconcile:handler.reconcile.bind(handler),settle:handler.settle.bind(handler),
      interpret:async(path,stage,...args)=>{
        if(stage.request.stageKind==="model"){
          const original=(await a({kind:"read_stage",requestId:`${path.intent.id}:source`})).request.input;
          const iteration=original.record.source.iteration;
          const isRoot=path.intent.runId==="root",isAlpha=original.record.source.task.input.prompt.startsWith("CHILD_ALPHA:");
          if(phase==="root-response"&&isRoot&&iteration===1||phase==="child-response"&&isAlpha&&iteration===1||phase==="parent-response"&&isRoot&&iteration===(continuation&&retainedReport?3:2)){
            const tree=await store.readRunTree("root");
            await writeFile(join(directory,`${phase}.json`),JSON.stringify({stageId:stage.request.id,resultId:stage.result.id,attemptId:stage.attempt.id,
              members:tree.members.map(m=>({runId:m.head.state.run.id,status:m.head.state.status,turns:m.head.state.counters.controllerTurns}))}));
            app.exit(73);return new Promise(()=>{});
          }
          if(interrupted&&stage.request.id===interrupted.stageId){assert.equal(stage.result.id,interrupted.resultId);assert.equal(stage.attempt.id,interrupted.attemptId);}
        }
        return handler.interpret(path,stage,...args);
      }};
  }};
  service=new HelarcActivityService({store,purposes,purposeIds:[publications.purpose.contract.ref.id,preparation.purpose.contract.ref.id,execution.work.purpose.contract.ref.id,methods.purpose.contract.ref.id,"context.input-materialization"],rediscoveryMs:10,
    reconsideration:(owner,subscription)=>owner===execution.work.purpose.contract.acceptanceOwner?execution.work.lifecycle:owner==="material-source"?(subscription.id===`${subscription.binding?.id}:source-lifecycle`?publications.lifecycle:publications.deliveries):subscription.binding?.kind==="input_need"?supply:subscription.binding?.kind==="activity_path"?methodReception.consumer:null,
    diagnostics:{record:(_stage,_context,error)=>{console.error(error);app.exit(1);}}});
  const {RunExecutionCoordinator}=await import("@agent-anything/agent-runtime/execution-coordinator");
  const {createTestContextProjection}=await import("@agent-anything/test-support");
  const {createInteractionProtocolRegistrySnapshot}=await import("@agent-anything/interaction/coordination");
  const {operations,config}=await require("./task-runner-config.cjs")(directory,built.registration,built.contextAccess);
  config.tools=built.selection;
  config.runTreeLimits={maxTotalDescendantRuns:8,maxActiveDescendantRuns:4,maxDescendantDepth:3};
  const agents={resolve:async ref=>{
    const agent=[built.agent,built.delegatedAgent].find(a=>a.id===ref.id&&a.revision===ref.revision);
    return {status:agent?"admitted":"unavailable",agent:agent??null,admissionEvidenceRef:agent?"isolated-agent":null,code:agent?null:"agent_unavailable"};}};
  let initial=phase==="root-response";
  const runner=new RunExecutionCoordinator({taskDecisions:execution.taskDecisions,preparations:execution.preparations,operations:{...operations,delegation:built.delegation},
    contextProjection:createTestContextProjection(),createRunId:()=>{if(initial){initial=false;return "root";}return randomUUID();},now,agents,
    runTreeCommits:store,interactions:createInteractionProtocolRegistrySnapshot("empty",[])});
  const handle=phase==="root-response"?runner.start(built.agent,{task:built.source.task,items:[],metadata:{}},config):
    await runner.recover("root",{resolve:async retained=>{
      const resolved=await agents.resolve(retained.head.state.activeAgent);assert(resolved.agent);
      return {agent:resolved.agent,config:{...retained.admission.config,permissions:{...retained.admission.config.permissions,
        reviewer:null,sessionAuthority:null,persistentPolicyAmendments:null}}};}});
  const result=await handle.wait();
  await writeFile(join(directory,`result-${phase}.json`),JSON.stringify(result,null,2));
  assert.equal(phase,"finish",`Expected raw-response interruption: ${result.status} ${JSON.stringify(result.cause)}`);
  assert.equal(result.status,"completed",JSON.stringify(result.cause));assert(result.finalOutput.summary.includes("7391"));assert(result.finalOutput.summary.includes("8422"));
  const tree=await store.readRunTree("root");assert.equal(tree.members.length,redistribute?6:continuation?5:4);assert(tree.members.every(m=>m.head.state.status==="completed"));
  assert(interrupted.members.every(original=>tree.members.some(m=>m.head.state.run.id===original.runId)),"Recovery cannot replace original children");
  if(continuation)assert(result.finalOutput.summary.includes("9507"));
  const {HelarcInspection}=await load("inspection/HelarcInspection.js");
  inspection=await HelarcInspection.create(join(directory,"inspection-settings.json"),join(directory,"inspection"));
  const offer=inspection.recorder.offer.bind(inspection.recorder);
  inspection.recorder.offer=value=>{const accepted=offer(value);if(!accepted){
    require("node:fs").writeFileSync(join(directory,"rejected-inspection.json"),JSON.stringify(value,null,2));
    console.error("Rejected inspection input",value.id,value.subject?.id,value.payload?.kind,value.payload?.name);
  }return accepted;};
  const runIds=tree.members.map(m=>m.head.state.run.id);
  const originalNeeds=[];
  for(const runId of runIds)for(let after=0;;) {
    const page=await a({kind:"facts",runId,after,limit:64});
    originalNeeds.push(...page.filter(f=>f.kind==="input_needed").map(f=>f.details.need.id));
    if(page.length<64)break;after=page.at(-1).sequence;
  }
  const exitDeadline=Date.now()+10000;
  while(true) {
    const pending=[];
    for(const needId of originalNeeds) {
      const exit=await store.inputSupplies.query({kind:"exit",needId});
      if(exit?.status!=="closed")pending.push({needId,exit});
      else {
        const subscription=await a({kind:"read_reconsideration",subscriptionId:exit.subscriptionId,limit:1});assert(subscription.state.closed);
        const work=await a({kind:"read_schedule",workId:exit.scheduling.workId});assert(work.closed&&work.settlementConfirmed);
      }
    }
    if(!pending.length)break;
    if(Date.now()>exitDeadline)throw new Error(`Original supply exits not settled: ${JSON.stringify(pending)}`);
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  if(retainedReport){
    const root=tree.members.find(m=>m.head.state.run.id==="root").head;
    const transfer=root.control.descendantTransfers.find(t=>t.narrative?.source.codeUnits>16000);assert(transfer);
    assert.equal(transfer.result.narrative.text,null);assert.equal(transfer.narrative.source.bytes,Buffer.byteLength(transfer.narrative.text));
    const native=result.items.filter(i=>i.payload.kind==="model_call_settlement").map(i=>i.payload.result.content)
      .find(r=>r?.output?.report?.status==="retained_material");assert(native);const reference=native.output.report.reference;
    let text="",offset=0,pages=0;
    while(true){const page=await materialAccess.read("root",{reference,offset,length:8192},new AbortController().signal,`verify-report-page:${offset}`);
      text+=page.text;pages++;if(page.nextOffset===null)break;assert(page.nextOffset>offset);offset=page.nextOffset;assert(pages<16);}
    assert.equal(text,transfer.narrative.text);assert(text.endsWith("REPORT DETAIL TARGET 9507"));
    const sibling=tree.members.find(m=>m.admission.input.task.input.prompt.includes("CHILD_BETA")).head.state.run.id;
    await assert.rejects(()=>materialAccess.validate(sibling,[reference]));
    const childRecipient={runId:transfer.childRunId,recipient:built.delegatedAgent.id,purpose:built.request.purpose};
    const publicationId=`${transfer.narrative.source.recordId}:publication:${digest(childRecipient)}`;
    const publication=await a({kind:"read_stage",requestId:`${publicationId}:capture`});assert.equal(publication.status,"accepted");
    while(true) {
      const work=await a({kind:"read_schedule",workId:publicationId});
      const subscription=await a({kind:"read_reconsideration",subscriptionId:`${publicationId}:source-lifecycle`,limit:1});
      if(work.closed&&work.settlementConfirmed&&subscription.state.closed)break;
      if(Date.now()>exitDeadline)throw new Error(`Original source lifecycle not settled: ${publicationId}`);
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    const {RunExecutionInspectionAdapter}=await import("@agent-anything/inspection/adapters");
    const {retainedRunResult}=await import("@agent-anything/agent-runtime/execution-coordinator");
    new RunExecutionInspectionAdapter(inspection.recorder).observe({kind:"descendant_result",runId:"root",occurredAt:transfer.result.createdAt,
      parentRunActionId:transfer.action.ref.id,raw:retainedRunResult(tree.members.find(m=>m.head.state.run.id===transfer.childRunId).head.state),
      projected:transfer.result,narrative:transfer.narrative});
  }
  for(const runId of runIds){await inspection.activityObserver.replay(runId,store.activityHandoffs);await inspection.contextFoundationObserver.replay(runId,store.contextFoundationFacts.bind(store));}
  const {InspectionQueryService}=await import("@agent-anything/inspection/query");queries=new InspectionQueryService(join(directory,"inspection"));
  const {selection}=await require("./inspection-settlement.cjs").settleInspection(inspection.recorder,queries);
  if(retainedReport){
    const transfer=tree.members.find(m=>m.head.state.run.id==="root").head.control.descendantTransfers.find(t=>t.narrative?.source.codeUnits>16000);
    const source=transfer.narrative.source;
    const flow=await queries.query({...selection,kind:"get_data_flow",subject:inspection.recorder.ref("agent-runtime","contribution",source.recordId,source.runId,source.digest)});
    assert(flow.graph.links.some(l=>l.from.id===transfer.result.ref.id||l.to.id===transfer.result.ref.id));
    assert(flow.graph.links.some(l=>l.from.owner==="material_custody"||l.to.owner==="material_custody"));
    const recipient={runId:"root",recipient:built.agent.id,purpose:built.request.purpose};
    const page=await store.materialCustody.command({kind:"discover",recipient,after:0,frontier:null,limit:8,filter:{materialId:source.recordId}});
    assert.equal(page.values.length,1);
    const reference=new (await import("@agent-anything/context/custody")).CustodyMaterialAccess(store.materialCustody,recipient).reference(page.values[0]);
    for(let released=0;;released++) {
      let description;
      try{description=await store.materialCustody.command({kind:"resolve_reference",reference,recipient});}
      catch(error){assert.match(error.message,/unavailable/);break;}
      assert(released<16);await store.materialCustody.command({kind:"release",holdId:description.hold.id,basis:"recipient detail retention ended"});
    }
    await assert.rejects(()=>materialAccess.validate("root",[reference]));
    await assert.rejects(()=>store.materialCustody.command({kind:"seal",instanceId:page.values[0].instanceId,cleanupId:"premature-producer-cleanup"}));
    await inspection.contextFoundationObserver.replay("root",store.contextFoundationFacts.bind(store));
    await require("./inspection-settlement.cjs").settleInspection(inspection.recorder,queries);
  }
  let presentationReceipts=0,supplyResponsibilities=0,supplyNeeds=0;const methodTotals=[];
  if(redistribute) {
    const reader=tree.members.find(m=>m.admission.input.task.input.prompt.includes("READ_MATERIAL_CASE"));assert(reader);
    const reference=reader.admission.input.task.input.material_refs[0];assert(reference);
    assert(reader.head.state.finalOutput.materialRefs.some(ref=>ref.id===reference.id));
    assert((await materialAccess.read(reader.head.state.run.id,{reference,offset:0,length:128},new AbortController().signal,"verify-reader-after-parent-release")).text.startsWith("ALPHA"));
    const resumed=tree.members.find(m=>m.admission.input.task.input.prompt.includes("CONTINUE_ALPHA"));assert(resumed);
    assert(resumed.head.state.finalOutput.materialRefs.some(ref=>ref.id===reference.id));
  }
  for(const runId of runIds){
    const facts=[];let after=0;
    while(true){const page=await a({kind:"facts",runId,after,limit:64});if(!page.length)break;facts.push(...page);after=page.at(-1).sequence;}
    for(const pathId of new Set(facts.map(f=>f.pathId).filter(Boolean))){
      const path=await a({kind:"read_path",pathId});
      if(path?.intent.purpose.contract.executionOwner==="representation-execution"&&path.progress?.method)
        methodTotals.push({pathId,readBytes:path.progress.method.readBytes,storedBytes:path.progress.method.storedBytes});
    }
    for(const fact of facts.filter(f=>f.kind==="input_needed")){
      const need=fact.details.need,head=await store.inputSupplies.query({kind:"head",needId:need.id});
      assert(head,`Accepted task input must retain its original supply responsibility: ${need.id}`);
      assert.equal(head.binding.consumerPathId,need.stage.pathId);assert.equal(head.binding.runId,runId);supplyNeeds++;
      let afterId=null;
      do {
        const page=await store.inputSupplies.query({kind:"page",needId:need.id,revision:head.revision,afterId,limit:8});
        assert.equal(page.kind,"page");
        for(const relation of page.entries){
          const path=await a({kind:"read_path",pathId:relation.target.pathId});
          assert(path,"A retained responsibility must refer to an accepted path");
          assert.equal(relation.target.owner,path.intent.owner);supplyResponsibilities++;
        }
        afterId=page.next;
      }while(afterId);
    }
    const stages=[...new Set(facts.filter(f=>f.kind==="stage_submitted"&&f.requestId?.endsWith(":model")).map(f=>f.requestId))];
    assert(stages.length>0);
    let latestEvidence=null;const baselineInputs=[],sentInputs=[];
    for(const id of stages){const stage=await a({kind:"read_stage",requestId:id});
      if(stage.status!=="accepted")await writeFile(join(directory,"unexpected-stage.json"),JSON.stringify({stage,path:await a({kind:"read_path",pathId:stage.request.pathId})},null,2));
      assert.equal(stage.status,"accepted");
      const record=await store.contextSelections.command({kind:"binding",inputId:`${id}:input`,checkCurrentControl:true});
      assert.equal(record.scope.runId,runId);
      assert.equal(record.input.exactInput.demand.runId,runId);
      sentInputs.push(record.input.exactInput.encoded.id);
      if(!Object.keys(record.input.exactInput.demand.dependencies).some(key=>/^representationProducer:\d+$/.test(key)))
        baselineInputs.push(record.input.exactInput.encoded.id);
      const presentation=stage.receipt.progress.exchange?.resultPresentationReceipt;
      if(presentation){
        presentationReceipts++;assert.equal(presentation.encodedInputId,record.input.exactInput.encoded.id);
        const flow=await queries.query({...selection,kind:"get_data_flow",subject:inspection.recorder.ref("task-result-presentation","contribution",presentation.digest,runId)});
        assert(flow.graph.links.some(link=>link.to.id===presentation.requestId));
        assert(flow.graph.links.some(link=>link.to.id===presentation.presentations[0].bindings[0].slot.callId));
      }
      latestEvidence=await store.contextPolicy.query({kind:"latest",scopeId:record.scope.id});
      assert(latestEvidence.input.methodSupplyReport,"Ordinary tasks must record their actual method offers and exclusions");
      assert.equal(latestEvidence.input.methodSupplyReport.offers.length,latestEvidence.input.options.length);
      assert.equal(latestEvidence.input.observationReport.window.scope.runId,runId);
      const flow=await queries.query({...selection,kind:"get_data_flow",subject:inspection.recorder.ref("context_selection","contribution",record.input.id,runId)});
      assert(flow.graph.links.length>0,"Actual recipient input must be inspectable");
    }
    const window=latestEvidence.input.observationReport.window;
    assert.deepEqual(window.inputs.map(i=>i.inputId).sort(),baselineInputs.sort(),"A gap must not erase prior baseline observations or impersonate an independently adopted candidate");
    assert.equal(new Set(window.inputs.map(i=>i.sequence)).size,baselineInputs.length);
    assert.equal(new Set(sentInputs).size,stages.length,"Each actual sent input retains its own durable binding");
    if(largeResult&&runId==="root")assert.equal(new Set(window.inputs.map(i=>i.representationContinuity)).size,2,"Accepted native result conversion starts a distinct comparable series");
    const policyFlow=await queries.query({...selection,kind:"get_data_flow",subject:inspection.recorder.ref("context-representation","contribution",latestEvidence.decision.id,runId)});
    await require("./process-query-verification.cjs").verifyDecisionQuery({queries,recorder:inspection.recorder,selection,original:latestEvidence,inputId:sentInputs.at(-1)});
    assert(policyFlow.graph.links.length>=window.inputs.length,"Observed inputs must remain reachable from the policy decision");
  }
  let reportProbes=[];
  if(retainedReport){
    await service.close();service=null;
    const transfer=tree.members.find(m=>m.head.state.run.id==="root").head.control.descendantTransfers.find(t=>t.narrative?.source.codeUnits>16000);
    reportProbes=await require("./report-handoff-probes.cjs")({store,createHandoff:createHelarcReportMaterialHandoff,result:transfer.result,
      binding:{child:{runId:transfer.childRunId,recipient:built.delegatedAgent.id,purpose:built.request.purpose},parent:{runId:"root",recipient:built.agent.id,purpose:built.request.purpose},
        permissionBasis:"isolated-tree",scopeId:"tree",localPoolId:"local",deadlineAt:"2030-01-01T00:00:00.000Z",maximumSourceBytes:131072}});
    for(const runId of runIds){await inspection.activityObserver.replay(runId,store.activityHandoffs);await inspection.contextFoundationObserver.replay(runId,store.contextFoundationFacts.bind(store));}
    await require("./inspection-settlement.cjs").settleInspection(inspection.recorder,queries);
  }
  const health=inspection.recorder.health();assert.equal(health.dropped,0);assert.equal(health.rejected,0);
  const processMetrics=await require("./process-metric-verification.cjs")({queries,recorder:inspection.recorder,runIds,methodTotals,replay:async()=>{
    for(const runId of runIds){await inspection.activityObserver.replay(runId,store.activityHandoffs);await inspection.contextFoundationObserver.replay(runId,store.contextFoundationFacts.bind(store));}
  }});
  if(largeResult){
    assert.equal(presentationReceipts,1,"Only actual replacement needs a new presentation receipt");
    assert(result.items.some(item=>item.payload.kind==="model_call_settlement"&&item.payload.result.content?.output?.summary?.length>10000),
      "The raw execution settlement must retain the original long result");
  }
  await writeFile(join(directory,"verification.json"),JSON.stringify({electron:process.versions.electron,generation:store.generation,
    runs:tree.members.map(m=>({runId:m.head.state.run.id,status:m.head.state.status,turns:m.head.state.counters.controllerTurns})),
    finalOutput:result.finalOutput,originalResponseResumed:true,observationWindowsRestored:true,supplyNeeds,supplyExitsClosed:originalNeeds.length,supplyResponsibilities,presentationReceipts,reportProbes,processMetrics,inspection:{captured:health.coverage.captured,dropped:health.dropped,rejected:health.rejected}},null,2));
  await queries.close();queries=null;if(service)await service.close();service=null;await inspection.close();inspection=null;await store.close();store=null;app.exit(0);
}
main().catch(async error=>{
  let interrupted=false;
  if(phase==="report-interrupted"&&error.name==="RunRecoveryError") {
    const root=await store.readLatestRun("root");
    assert.equal(root.state.status,"running");
    const transfer=root.control.descendantTransfers.find(t=>t.narrative?.source.codeUnits>16000);assert(transfer);
    assert(!root.state.items.some(i=>i.payload.kind==="observation"&&i.payload.observation.payload?.childRunId===transfer.childRunId),"Unconfirmed publication must not settle a failed delivery");
    await writeFile(join(directory,`${phase}.json`),JSON.stringify({code:error.code,cause:error.cause?.message,unsettled:true}));interrupted=true;
  } else console.error(error);
  if(service)await service.close(100);if(queries)await queries.close();if(inspection)await inspection.close();if(store)await store.close().catch(()=>{});app.exit(interrupted?73:1);
});
