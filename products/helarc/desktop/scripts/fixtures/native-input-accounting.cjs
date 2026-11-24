const {app}=require("electron");
const assert=require("node:assert/strict");
const {join,resolve}=require("node:path");
const {pathToFileURL}=require("node:url");
const {createHash}=require("node:crypto");
const {readFile,writeFile,appendFile,mkdir}=require("node:fs/promises");
const [directory,phase,endpoint]=process.argv.slice(2);
app.setPath("userData",join(directory,"electron"));app.disableHardwareAcceleration();
const ref=id=>({id,revision:"1"}),at="2026-11-13T01:00:00.000Z",now="2026-11-13T01:00:01.000Z";
const jp=(kind,proposal)=>({owner:"protocol_execution",kind,proposal});
let store;

async function main(){
  const runtime=await import("@agent-anything/agent-runtime/model-access"),model=await import("@agent-anything/model-interaction/protocol");
  const {modelInputValueDigest:digest}=await import("@agent-anything/model-interaction/input");
  const native=await import("@agent-anything/provider-integrations/native"),helarc=await import("@agent-anything/helarc/controller");
  const repo=resolve(__dirname,"../../../../.."),provider=join(repo,"harness/integrations/providers/dist/native");
  const measurement={...await import(pathToFileURL(join(provider,"measurement/ResponsesInputTokenCount.js"))),
    ...await import(pathToFileURL(join(provider,"measurement/ResponsesCountEvidence.js"))),
    ...await import(pathToFileURL(join(provider,"measurement/ResponsesMeasurementBinding.js"))),
    ...await import(pathToFileURL(join(provider,"measurement/ResponsesCapacityBridge.js")))};
  const accounting=await import(pathToFileURL(join(provider,"accounting/index.js")));
  const {HelarcExecutionStore}=await import(pathToFileURL(join(__dirname,"../../dist/main/execution-storage/HelarcExecutionStore.js")));
  for(const name of ["retainHelarcNativeEvidence","readHelarcNativeEvidence","retainHelarcNativeWork","readHelarcNativeWorkPage","helarcNativeInputAcceptance"])
    assert.equal(typeof helarc[name],"function",`Build current core before running: ${name}`);
  const calls={},work=[],observer=[];
  store=await HelarcExecutionStore.open(join(directory,"execution"),pathToFileURL(join(__dirname,"native-input-accounting-worker.mjs")),
    undefined,undefined,undefined,undefined,undefined,undefined,undefined,{observe:fact=>observer.push(fact)});
  const journal={command:async command=>{calls[command.kind]=(calls[command.kind]??0)+1;return store.protocolJournal.command(command);}};
  const content=(id,activityId,value)=>runtime.retainProtocolContent(journal,id,activityId,Buffer.from(JSON.stringify(value)),entry=>work.push(entry));
  const read=async reference=>JSON.parse((await runtime.readProtocolContent(journal,reference,reference.activityId,32*1024*1024,entry=>work.push(entry))).toString());
  const accept=async(id,actor,parts,scope="root")=>{
    const receipt=await store.sharedAcceptance.accept({id,actor,scope,parts});assert.equal(receipt.outcome,"accepted",JSON.stringify(receipt));return receipt;
  };
  const reject=async(id,actor,parts,pattern,scope="root")=>{
    const receipt=await store.sharedAcceptance.accept({id,actor,scope,parts});assert.equal(receipt.outcome,"rejected",JSON.stringify(receipt));assert.match(receipt.rejection.code,pattern);return receipt;
  };
  const composition=model.bindModelAgentComposition({agent:ref("fixture-agent"),protocol:model.OPENAI_RESPONSES,
    configuration:{configuration:ref("original-config"),protocol:model.OPENAI_RESPONSES,model:"fixture-model",connectionBinding:ref("original-connection")},
    adapter:{implementation:native.OPENAI_RESPONSES_ADAPTER,protocol:model.OPENAI_RESPONSES},
    task:{purpose:ref("task"),input:{implementation:ref("task-input"),protocol:model.OPENAI_RESPONSES},
      interpreter:{implementation:helarc.HELARC_NATIVE_TASK_INTERPRETER,protocol:model.OPENAI_RESPONSES}},
    auxiliary:[{purpose:ref("measurement"),input:{implementation:ref("measurement-input"),protocol:model.OPENAI_RESPONSES},
      interpreter:{implementation:ref("measurement-interpreter"),protocol:model.OPENAI_RESPONSES}}]});
  const activity=(id="a",runId="root",recipientId="task",purpose=ref("task"))=>runtime.bindProtocolModelActivity({composition,
    scope:{runId,activityId:id,recipientId,purpose,compositionDigest:composition.digest},
    conditions:{input:ref(`${id}:input`),authority:ref("authority"),resources:ref("resources"),control:ref("control")}});
  const originalActivity=activity(),owner=native.OPENAI_RESPONSES_ADAPTER.id;
  const scope={id:"root-task",runId:"root",recipientId:"task",purpose:ref("task"),compositionDigest:composition.digest,owner};
  const countActivity=activity("measurement","root","input-counter",ref("measurement"));
  const countScope={id:"count-scope",runId:"root",recipientId:"input-counter",purpose:ref("measurement"),compositionDigest:composition.digest,owner};
  const countSource={scope:countActivity.scope,protocol:model.OPENAI_RESPONSES,interpretation:native.OPENAI_RESPONSES_ADAPTER,
    operationId:"count",record:ref("count-observation"),position:{format:"json-pointer",value:""},nativeIdentity:null};
  let taskHeadBeforeCount=null;
  const state=id=>journal.command({kind:"state",activityId:id});
  const claim=async id=>{
    let saved=await state(id);
    if(saved.fence.generation!==store.generation||saved.fence.epoch===0){
      await accept(`${id}:claim:${store.generation}`,owner,[jp("claim",{activityId:id,expectedEpoch:saved.fence.epoch})],saved.activity.scope.runId);saved=await state(id);
    }
    return saved.fence;
  };
  const loadEvidence=(kind,key,restore=value=>value,activityId="a",revision,evidenceScope=scope)=>helarc.readHelarcNativeEvidence({journal,activityId,scopeId:evidenceScope.id,kind,key,restore,
    ...(revision===undefined?{}:{revision}),maximumBytes:32*1024*1024,observe:entry=>work.push(entry)});
  const evidenceArgs=(fence,value,kind,key,expectedRevision,references,dependencies=[],metadata={},evidenceScope=scope)=>({journal,acceptance:store.sharedAcceptance,scope:evidenceScope,fence,value,kind,key,
    expectedRevision,references,dependencies,metadata,memberships:[],observe:entry=>work.push(entry)});
  const commitWithOriginal=(parts,label,dropAck=false)=>({query:id=>store.sharedAcceptance.query(id),accept:async proposal=>{
    const combined={...proposal,id:`${label}:commit`,parts:[...parts,...proposal.parts]};
    const receipt=await store.sharedAcceptance.accept(combined);assert.equal(receipt.outcome,"accepted",JSON.stringify(receipt));
    if(dropAck){
      if(label==="count")assert.deepEqual(await journal.command({kind:"evidence",activityId:"a",scopeId:scope.id,evidenceKind:"continuation",key:"head"}),taskHeadBeforeCount);
      // The real Worker has committed. The fixture's calling bridge never receives its acknowledgement.
      await writeFile(join(directory,`${label}-receipt.json`),JSON.stringify(receipt));
      await phaseEvidence({lostAcknowledgement:label,receiptId:receipt.id,...label==="count"?{independentPurpose:"measurement",taskHeadUnchanged:true}:{}});app.exit(73);return new Promise(()=>{});
    }
    return receipt;
  }});
  const phaseEvidence=extra=>writeFile(join(directory,`${phase}.json`),JSON.stringify({phase,pid:process.pid,electron:process.versions.electron,
    generation:store.generation,calls,work,observerFacts:observer.length,...extra},null,2));
  const assertReceipt=async label=>{
    const expected=JSON.parse(await readFile(join(directory,`${label}-receipt.json`),"utf8"));
    assert.deepEqual(await store.sharedAcceptance.query(expected.id),expected);return expected;
  };
  const checkMetadata=async(original,workId)=>{
    const before=await readFile(join(directory,"execution/body-reads.ndjson"),"utf8"),reads=calls.content_read??0;
    assert(before.includes('"kind":"body_read"'),"Physical read probe must observe actual recovery before zero-read assertions");
    const aggregations=[];
    for(const fanout of [1,2,4,32]){
      const entries=[];
      for(let i=0;i<fanout;i++){
        const page=await helarc.readHelarcNativeWorkPage({journal,activityId:"a",scopeId:scope.id,afterKey:null,limit:1,membership:"root"});
        assert.equal(page.next,null);assert.equal(page.entries.length,1);entries.push(...page.entries);
        const count=await journal.command({kind:"evidence",activityId:"measurement",scopeId:countScope.id,evidenceKind:"measurement",key:original.countRequest.bindingDigest});
        assert(count);assert.equal(count.activityId,"measurement");
        await journal.command({kind:"evidence",activityId:"a",scopeId:scope.id,evidenceKind:"continuation",key:"head"});
        await state("a");
      }
      const aggregate=accounting.aggregateNativeWork(entries,{id:"tree",kind:"selected_work",runIds:["root"],expectedWorkIds:[workId],evidenceBoundary:"retained-current",scanComplete:true});
      assert.equal(aggregate.workIds.length,1);assert.equal(aggregate.counts.observed,1);
      assert.equal(Object.values(aggregate.protocolTotals)[0].inputTokens,"42");assert.equal(Object.values(aggregate.protocolTotals)[0].outputTokens,"9");
      assert.deepEqual(aggregate.pricedSubtotals,{USD:"0.0001488"});assert.equal(aggregate.monetaryCoverage,"complete");
      aggregations.push({fanout,uniqueWork:1,inputTokens:42,outputTokens:9,pricedSubtotals:aggregate.pricedSubtotals,monetaryCoverage:aggregate.monetaryCoverage});
    }
    assert.equal(calls.content_read??0,reads);
    assert.equal(await readFile(join(directory,"execution/body-reads.ndjson"),"utf8"),before,"Metadata queries must consume zero SQLite content rows");
    return {refreshes:39,rpcBodyReads:0,sqliteBodyQueries:0,sqliteBodyBytes:0,aggregations};
  };
  const measurementInput=original=>({manifest:original.manifest,realization:original.realization,
    targetValidity:{basis:"fixture-target",validUntil:"2030-01-01T00:00:00Z"},
    dependencies:{revision:"original-rendering:1",resolution:{kind:"immutable",basis:"retained-original-manifest"}}});
  const current=(original,authorized=true)=>measurement.responsesMeasurementApplicabilityFromRealization(measurementInput(original),{
    now,manifestDigest:original.manifest.digest,
    authority:{authorized,basis:"fixture-current-authority",checkedAt:at,validUntil:"2026-11-13T01:05:00.000Z"},
    dependencies:{available:true,basis:"fixture-retained-dependencies",checkedAt:at,validUntil:"2026-11-13T01:05:00.000Z"}});
  const source=(record,position="/usage")=>({scope:originalActivity.scope,protocol:model.OPENAI_RESPONSES,interpretation:native.OPENAI_RESPONSES_ADAPTER,
    operationId:"create",record:ref(record),position:{format:"json-pointer",value:position},nativeIdentity:{kind:"response",id:"response-original"}});
  const observationRecord=(id,body)=>({ref:ref(id),activityId:"a",operationId:"create",kind:"observation",content:body,source:source(id),dependencies:[ref("create-dispatch")]});
  const observeUsage=(saved,id,raw,channel)=>accounting.applyNativeAccountingCommand(saved,{id:`observe:${id}`,kind:"observe",observation:{id,submissionId:"generation-original",
    source:source(id),receivedAt:at,channel,finality:"terminal",authority:"controlled-provider",revisionDomain:"original-response",cumulativeRevision:null,
    profile:{kind:"openai.responses",revision:"1",cacheWrites:"not_applicable",basis:ref("fixture-usage-mapping")},usage:raw.usage}});

  async function inspectFacts(expectedFacts){
    const {ProtocolJournalInspectionAdapter}=await import(pathToFileURL(join(__dirname,"../../dist/main/inspection/ProtocolJournalInspectionAdapter.js")));
    const before=await readFile(join(directory,"execution/body-reads.ndjson"),"utf8"),reads=calls.content_read??0;
    const offered=[],replayed=[],pages=[];
    const recorder={ref:(owner,kind,id,runId,revision=null)=>({owner,kind,id,runId,revision}),offer:record=>offered.push(record)};
    await new ProtocolJournalInspectionAdapter(recorder).replay(async(after,limit)=>{
      assert.equal(limit,128);
      const facts=await journal.command({kind:"facts",runId:"root",after,limit});
      pages.push({after,limit,rows:facts.length});replayed.push(...facts);return facts;
    });
    assert.deepEqual(replayed,expectedFacts);assert.equal(pages.at(-1).rows,0);
    const linked=[];
    for(const fact of replayed.filter(fact=>fact.kind==="evidence")){
      const value=fact.value,offering=offered.find(item=>item.id===`protocol-execution:${fact.runId}:${fact.sequence}`);
      assert(offering);
      const target=recorder.ref("protocol-evidence","event",`${value.scopeId}:${value.kind}:${value.key}`,fact.runId,String(value.revision));
      const hasBinding=from=>offering.links.some(link=>link.kind==="binding"&&digest(link.from)===digest(from)&&digest(link.to)===digest(target));
      assert(hasBinding(recorder.ref("protocol-evidence","event",value.scopeId,fact.runId)));
      for(const content of [value.content,...value.references])
        assert(hasBinding(recorder.ref("protocol-content","contribution",content.id,fact.runId,content.digest)),`Missing original content link: ${content.id}`);
      for(const dependency of value.dependencies)
        assert(hasBinding(recorder.ref("protocol-execution","event",dependency.ref.id,fact.runId,dependency.ref.revision)));
      linked.push({sequence:fact.sequence,activityId:fact.activityId,kind:value.kind,scopeId:value.scopeId,key:value.key,revision:value.revision,
        content:value.content,references:value.references,dependencies:value.dependencies});
    }
    assert.deepEqual(linked.map(item=>item.kind).sort(),["continuation","continuation","continuation","measurement","usage","usage","usage"]);
    for(const fact of replayed.filter(fact=>fact.kind==="evidence_scope")){
      const offering=offered.find(item=>item.id===`protocol-execution:${fact.runId}:${fact.sequence}`);
      assert(offering.links.some(link=>link.kind==="binding"&&link.to.owner==="protocol-evidence"&&link.to.id===fact.value.scope.id));
    }
    assert.equal(calls.content_read??0,reads);
    assert.equal(await readFile(join(directory,"execution/body-reads.ndjson"),"utf8"),before,"Inspector replay must not hydrate SQLite content");
    assert(!JSON.stringify(offered).includes("bytesBase64"));assert(!JSON.stringify(offered).includes("Original fixture response."));
    return {facts:replayed.length,offers:offered.length,pages,linked,rpcBodyReads:0,sqliteBodyQueries:0,sqliteBodyBytes:0};
  }

  async function contextAcceptance(original){
    const {ActivityPurposeRegistry}=await import("@agent-anything/agent-runtime/activity");
    const recipient={runId:"root",recipient:"task",purpose:"task"},bytes=Buffer.from(original.manifest.groups[0].items[0].content);
    const range={materialId:"original-prompt",version:"1",coordinate:"bytes",start:0,end:bytes.length};
    const hold=(id,responsibility,basis)=>({id,instanceId:"prompt-custody",consumer:recipient,responsibility,range,basis,releaseCondition:"explicit owner settlement"});
    const c=command=>store.materialCustody.command(command);
    const intent={id:"prompt-capture",instanceId:"prompt-custody",activityId:"prompt-source",owner:"task-input",maximumBytes:bytes.length,
      version:{ref:{materialId:range.materialId,version:range.version},origin:{runId:"root",owner:"task-input",recordId:"original-prompt",revision:"1",occurredAt:at},
        label:"Original fixture task",format:"utf8",mediaType:"text/plain",bytes:bytes.length,digest:`sha256:${createHash("sha256").update(bytes).digest("hex")}`,capture:"complete",limitations:[]}};
    await c({kind:"begin",intent});await c({kind:"append",id:"prompt-chunk",intentId:intent.id,offset:0,bytesBase64:bytes.toString("base64")});await c({kind:"complete",intentId:intent.id});
    const preparation={...hold("preparation-hold","preparation","original-selection"),consumer:{...recipient,recipient:"task-input"}};
    const countRecipient={runId:"root",recipient:"input-counter",purpose:"measurement"};
    const countHold={...hold("count-input-hold","preparation","count:original-input"),consumer:countRecipient};
    await accept("publish-prompt","task-input",[{owner:"material_custody",kind:"publish",proposal:{intentId:intent.id,holds:[preparation,countHold],grants:[{
      id:"prompt-grant",instanceId:intent.instanceId,recipient,range,revision:0,allowed:true,basis:"fixture-authority"},
      {id:"preparation-grant",instanceId:intent.instanceId,recipient:preparation.consumer,range,revision:0,allowed:true,basis:"fixture-authority"},
      {id:"count-disclosure-grant",instanceId:intent.instanceId,recipient:countRecipient,range,revision:0,allowed:true,basis:"explicit-count-disclosure"}]}}]);
    const {CustodyMaterialAccess}=await import("@agent-anything/context/custody");
    const counterAccess=new CustodyMaterialAccess(store.materialCustody,countRecipient);
    const counterReference=counterAccess.reference(await c({kind:"describe",holdId:countHold.id,recipient:countRecipient}));
    assert.equal((await counterAccess.read("root",{reference:counterReference},new AbortController().signal,"count-input-access")).text,bytes.toString());
    const contextScope={...recipient,id:scope.id,continuity:"task",owner:"task-input",target:original.manifest.target.configuration,authorityBasis:"fixture-authority"};
    await store.contextSelections.command({kind:"scope",scope:contextScope});
    const representation={ref:original.manifest.groups[0].representation,owner:"task-input",runId:"root",purpose:"task",target:contextScope.target,form:"original",body:range,
      inputs:[{role:"source",material:range,representation:null}],declaredCoverage:[range],details:[range],holds:[preparation.id],requirements:[],losses:[],restorations:[],method:null};
    await store.representations.command({kind:"record",record:representation});
    const nativeInput={kind:"helarc_native_input",manifest:original.manifest,wire:original.wire,prefixGroups:0,predecessor:null,
      continuity:{kind:"responses",policy:"persistent_chain",previous:null,conditions:original.conditions}};
    const judgment={id:"combination",owner:"task-input",runId:"root",evidenceSources:[],kind:"combination",subjects:[representation.ref],inputs:[range],purpose:"task",target:contextScope.target,
      methodRevision:"fixture:1",dependencies:{inputDigest:digest(nativeInput)},coverage:[range],conclusion:"supported",limitations:["Exact synthetic original; not semantic model evaluation"],basis:"independent fixture source bytes"};
    await store.representations.command({kind:"judge",judgment});
    const registry=new ActivityPurposeRegistry(),unexpected=async()=>{throw new Error("Context fixture stage must not dispatch remote work");};
    const purpose=registry.register({ref:ref("native-task-stage"),inputOwner:"task-input",executionOwner:owner,interpretationOwner:"task-input",acceptanceOwner:"task-input",recoveryOwner:"task-input",
      stageKinds:["model"],capabilities:["model-access"],continuationKinds:[]},{authorize:unexpected,execute:unexpected,reconcile:unexpected,interpret:unexpected});
    await store.activityHandoffs.command({kind:"open_path",intent:{id:"native-input-path",runId:"root",owner:"task-input",purpose,permissionBasis:"fixture-authority",resourceScope:"native-input-path",
      maximumStages:1,maximumAttempts:1,maximumConcurrent:1,deadlineAt:"2030-01-01T00:00:00Z"}});
    const args={id:"native-input-selection",scope:contextScope,expectedSelectionId:null,expectedControlRevision:0,retainedSelectionId:null,
      selection:{id:original.manifest.selection.id,representations:[representation.ref],judgmentIds:[judgment.id],holds:[hold("selection-hold","selection",original.manifest.selection.id)]},
      native:nativeInput,judgment,inputId:"native-selected-input",activityId:"native-input-path",stageRequestId:"native-input-stage",stageKind:"model",capabilities:["model-access"],
      inputHolds:[hold("input-hold","input","native-selected-input")],releaseHolds:[]};
    assert.throws(()=>helarc.helarcNativeInputAcceptance({...args,inputHolds:[]}),/hold_missing/);
    const forgedBody={...JSON.parse(nativeInput.wire.body),input:[],previous_response_id:"unproven-response"};
    assert.throws(()=>helarc.helarcNativeInputAcceptance({...args,native:{...nativeInput,prefixGroups:1,predecessor:"unproven-response",
      wire:{body:JSON.stringify(forgedBody),digest:digest(forgedBody)}}}),/prefix_unproven/);
    assert.throws(()=>helarc.helarcNativeInputAcceptance({...args,native:{...nativeInput,continuity:{...nativeInput.continuity,
      conditions:{...nativeInput.continuity.conditions,authorized:false}}}}),/authority_changed/);
    const invalid=await store.sharedAcceptance.accept(helarc.helarcNativeInputAcceptance({...args,id:"native-input-invalid",expectedControlRevision:1}));
    assert.equal(invalid.outcome,"rejected");assert.equal(await store.activityHandoffs.command({kind:"read_stage",requestId:args.stageRequestId}),null);
    const proposal=helarc.helarcNativeInputAcceptance(args),receipt=await store.sharedAcceptance.accept(proposal);assert.equal(receipt.outcome,"accepted",JSON.stringify(receipt));
    assert.deepEqual(await store.sharedAcceptance.accept(proposal),receipt);
    assert.deepEqual((await store.contextSelections.command({kind:"binding",inputId:args.inputId,checkCurrentControl:true})).input.exactInput,nativeInput);
    return {receiptId:receipt.id,originalMaterialDigest:intent.version.digest,nativeInputDigest:digest(nativeInput),staleControlRejected:true,missingHoldRejected:true,
      unprovenPrefixRejected:true,currentNativeAuthorityRejected:true,
      countAccess:{recipient:countRecipient,holdId:countHold.id,grantId:"count-disclosure-grant",basis:"explicit-count-disclosure",sourceDigest:intent.version.digest}};
  }

  if(phase==="count"){
    const definition={name:"Write_a1",description:"Write one test file",inputSchema:{type:"object",properties:{path:{type:"string"}},required:["path"],additionalProperties:false}};
    const request={model:"fixture-model",purpose:ref("task"),stream:false,tools:[definition]};
    const inputScope={id:scope.id,runId:scope.runId,recipientId:scope.recipientId,purpose:scope.purpose,compositionDigest:scope.compositionDigest};
    const settings=native.nativeInputSettings(native.prepareResponses({...request,input:[],store:true}).body);
    const manifest=native.bindNativeInputManifest({protocol:model.OPENAI_RESPONSES,scope:inputScope,
      target:{model:"fixture-model",configuration:"original-config:1",connection:"original-connection:1",disclosure:"disclosure:1"},
      selection:{id:"selection-original",revision:"1",boundary:"delivery:0",judgments:["combination"]},
      groups:[{id:"user-original",representation:ref("prompt-representation"),sources:["original-prompt"],holds:["input-hold"],deliveries:[],requires:[],
        items:[{role:"user",content:"Write exactly one fixture file, then report."}],replay:"local"}],
      settings,settingSources:Object.keys(settings).map(field=>({field,source:`original:${field}`,digest:digest(settings[field])}))});
    const conditions={basis:"fixture-authority",authorized:true,disclosureRevision:"disclosure:1",remoteStorage:true,targetSupport:"established",predecessor:"available",reestablish:true,policyChange:false};
    const realization=native.realizeResponsesInput({manifest,request,policy:"persistent_chain",previous:null,conditions});
    const pending=native.reserveResponsesInput(realization,"create");
    const countRequest=measurement.prepareResponsesInputTokenCount({prepared:realization.prepared,
      binding:measurement.buildResponsesMeasurementBinding(measurementInput({manifest,realization}))});
    const bindingBase={scope:originalActivity.scope,protocol:model.OPENAI_RESPONSES,adapter:native.OPENAI_RESPONSES_ADAPTER,interpreter:helarc.HELARC_NATIVE_TASK_INTERPRETER,
      acceptance:ref("purpose-original"),requestId:"request-original",controllerRequestId:"decision-original",operationId:"create",record:ref("response"),
      catalog:[{definition,binding:{kind:"tool",callableName:"Write_a1",toolName:"Write",tool:{tool:{namespace:"fixture",name:"Write"},revision:"1"},
        binding:{kind:"operation",operation:{operation:{namespace:"fixture",name:"write"},revision:"1"},revision:"1"}}}],
      schemaMode:"responses-strict",hasPlan:false,planLimits:{maxSteps:20,maxStepLength:1000,maxExplanationLength:2000}};
    const binding={...bindingBase,catalogRevision:helarc.nativeTaskCatalog(bindingBase).revision};
    const pricing={calculation:ref("synthetic-original-calculation"),decisionAt:at,
      context:{protocol:model.OPENAI_RESPONSES,endpoint,account:"synthetic-account",operation:"generation",occurredAt:at,
        model:"fixture-model",reportedTier:null,region:null,modality:"text",basis:ref("synthetic-original-price-context")},
      rates:[{ref:ref("synthetic-original-price"),source:"Controlled fixture only; not a provider price or invoice",kind:"synthetic",protocol:model.OPENAI_RESPONSES,
        effectiveFrom:"2026-01-01T00:00:00.000Z",effectiveUntil:null,endpoint:{match:"exact",value:endpoint},account:{match:"exact",value:"synthetic-account"},
        model:{match:"exact",value:"fixture-model"},reportedTier:{match:"any"},region:{match:"any"},modality:{match:"exact",value:"text"},
        operation:"generation",inputBand:null,currency:"USD",rates:[
          {component:"input_tokens.ordinary",unit:"tokens",amount:"2",perUnits:"1000000"},
          {component:"input_tokens_details.cached_tokens",unit:"tokens",amount:"0.2",perUnits:"1000000"},
          {component:"output_tokens",unit:"tokens",amount:"8",perUnits:"1000000"}]}],
      additional:[],chargeCoverage:{state:"complete",basis:ref("synthetic-fixture-charge-inventory")}};
    const original={format:"helarc.native-prepared-task.v1",binding,wire:{body:realization.prepared.encoded,digest:realization.prepared.digest},previous:null,
      manifest,request,realization,pending,countRequest,conditions,pricing};
    const selected=await contextAcceptance(original);await writeFile(join(directory,"context-evidence.json"),JSON.stringify(selected));
    const input=await content("original-input","a",original);
    await accept("prepare","execution-coordinator",[jp("prepare",{activity:originalActivity,input}),jp("evidence_scope",{activityId:"a",scope})]);
    const fence=await claim("a");
    taskHeadBeforeCount=await helarc.retainHelarcNativeEvidence(evidenceArgs(fence,pending,"continuation","head",null,[input]));
    const countInput=await content("measurement-input","measurement",{format:"fixture-measurement-handoff/1",originalTaskInput:input,
      manifest,request:countRequest,disclosure:selected.countAccess});
    await accept("measurement:prepare","execution-coordinator",[jp("prepare",{activity:countActivity,input:countInput}),
      jp("evidence_scope",{activityId:"measurement",scope:countScope})]);
    const countFence=await claim("measurement");
    const dispatch={ref:ref("count-dispatch"),activityId:"measurement",operationId:"count",kind:"dispatch_intent",content:countInput,source:null,dependencies:[]};
    await accept("count-dispatch",owner,[jp("record",{record:dispatch,fence:countFence})]);
    const retained=[];
    const http=await measurement.dispatchResponsesInputTokenCount(countRequest,{baseUrl:endpoint,apiKey:"synthetic",targetDigest:countRequest.binding.targetDigest},
      {signal:AbortSignal.timeout(10000),applicability:current(original),retainChunk:async bytes=>retained.push(Buffer.from(bytes))});
    assert.equal(Buffer.concat(retained).toString(),http.body);
    const result=measurement.interpretResponsesInputTokenCount(countRequest,http,{operationId:"count",measuredAt:at});
    assert.equal(result.status,"measured");assert.equal(result.inputTokens,42);assert.equal(result.coverage,"complete");
    const raw=await content("count-http","measurement",http),record={ref:ref("count-observation"),activityId:"measurement",operationId:"count",kind:"observation",content:raw,source:countSource,dependencies:[dispatch.ref]};
    const args=evidenceArgs(countFence,{request:countRequest,result},"measurement",countRequest.bindingDigest,null,[countInput,raw],
      [{activityId:"measurement",ref:record.ref}],{inputTokens:42,coverage:"complete"},countScope);
    await helarc.retainHelarcNativeEvidence({...args,acceptance:commitWithOriginal([jp("record",{record,fence:null})],"count",true)});
    throw new Error("Lost acknowledgement must not return to the count caller");
  }

  const saved=await state("a");assert(saved);assert.deepEqual(saved.activity,originalActivity);
  const original=await read(saved.input);native.assertNativeInputManifest(original.manifest);
  assert.deepEqual(JSON.parse(original.wire.body),original.realization.prepared.body);
  const selected=await store.contextSelections.command({kind:"binding",inputId:"native-selected-input",checkCurrentControl:true});
  assert.deepEqual(selected.input.exactInput.manifest,original.manifest);assert.deepEqual(selected.input.exactInput.wire,original.wire);
  await assertReceipt("count");
  const measurementState=await state("measurement");assert.deepEqual(measurementState.activity,countActivity);
  assert.equal(measurementState.activity.scope.purpose.id,"measurement");
  const measurementHandoff=await read(measurementState.input);
  assert.deepEqual(measurementHandoff.originalTaskInput,saved.input);assert.deepEqual(measurementHandoff.manifest,original.manifest);
  assert.deepEqual(measurementHandoff.request,original.countRequest);assert.equal(measurementHandoff.request.binding.scope.purpose,"task");
  assert.equal(measurementHandoff.disclosure.recipient.purpose,"measurement");
  const measured=await loadEvidence("measurement",original.countRequest.bindingDigest,packet=>{
    const request=measurement.restoreResponsesInputTokenCount(packet.request);return {request,result:measurement.restoreResponsesCountEvidence(request,packet.result)};
  },"measurement",undefined,countScope);
  assert(measured);assert.equal(measured.value.result.inputTokens,42);
  assert.deepEqual(measured.value.request,original.countRequest);
  assert.deepEqual(measurement.buildResponsesMeasurementBinding(measurementInput(original)),measured.value.request.binding);
  for(let i=0;i<20;i++)assert.equal(measurement.reuseResponsesInputTokenCount(measured.value.request,measured.value.result,current(original)).reusable,true);
  assert.equal(measurement.reuseResponsesInputTokenCount(measured.value.request,measured.value.result,current(original,false)).reusable,false);
  assert.equal(measurement.reuseResponsesInputTokenCount(measured.value.request,measured.value.result,{...current(original),binding:{...measured.value.request.binding,sourceDigest:"changed-source"}}).reusable,false);
  const countFence=await claim("measurement"),fence=await claim("a");let replayAccepts=0;
  const recovered=await helarc.retainHelarcNativeEvidence({...evidenceArgs(countFence,measured.value,"measurement",original.countRequest.bindingDigest,null,
    measured.evidence.references,measured.evidence.dependencies,measured.evidence.metadata,countScope),acceptance:{query:id=>store.sharedAcceptance.query(id),accept:async()=>{replayAccepts++;throw new Error("Recovery must use immutable revision, not repeat CAS");}}});
  assert.deepEqual(recovered,measured.evidence);assert.equal(replayAccepts,0);
  let head=await loadEvidence("continuation","head");assert(head);
  await assert.rejects(()=>loadEvidence("measurement",original.countRequest.bindingDigest,value=>value,"a",undefined,countScope),/activity_scope_invalid/);
  await assert.rejects(()=>loadEvidence("continuation","head",value=>value,"measurement"),/activity_scope_invalid/);
  assert.equal(await journal.command({kind:"evidence",activityId:"measurement",scopeId:countScope.id,evidenceKind:"continuation",key:"head"}),null);
  const countDelivery={id:"measurement-to-task",recipient:{runId:"root",id:"task-input",purpose:"task"},content:measured.evidence.content};
  if(!await journal.command({kind:"acceptance",activityId:"measurement"})){
    assert.equal(phase,"execute");
    await accept("measurement-purpose","measurement-interpreter",[jp("purpose",{fence:countFence,acceptance:{
      evidence:{scope:countActivity.scope,interpreter:ref("measurement-interpreter"),acceptance:ref("measurement-accepted"),sources:[countSource]},
      result:measured.evidence.content,effects:[],deliveries:[countDelivery]}})]);
    await accept("measurement-received","task-input",[jp("received",{activityId:"measurement",deliveryId:countDelivery.id,receipt:ref("measurement-used-by-task"),recipient:countDelivery.recipient})]);
    assert.deepEqual(await journal.command({kind:"evidence",activityId:"a",scopeId:scope.id,evidenceKind:"continuation",key:"head"}),head.evidence);
  }
  const delivered=await journal.command({kind:"delivery",activityId:"measurement",id:countDelivery.id});
  assert.deepEqual(delivered.delivery,countDelivery);assert.deepEqual(delivered.receipt,ref("measurement-used-by-task"));
  assert.deepEqual((await read(delivered.delivery.content)).request.binding,original.countRequest.binding);
  const capacityPolicy={id:"fixture-task-capacity",revision:"1",purpose:"task",basis:"controlled input-only capacity policy",allowEstimatedFit:false,allowUnknown:false};
  const capacity=measurement.assessResponsesInputCapacity({request:measured.value.request,result:measured.value.result,current:current(original),
    policy:capacityPolicy,reservations:[],limits:[{id:"fixture-input-limit",dimension:"input_tokens",targetRevision:original.manifest.target.configuration,maximum:64,source:"configured fixture"}]});
  assert.equal(capacity.allowed,true);assert.equal(capacity.decisions.length,1);assert.equal(capacity.decisions[0].conclusion,"within");
  const capacityEvidence=measurement.responsesInputCapacityEvidence(measured.value.request,measured.value.result,current(original));
  assert.deepEqual(capacityEvidence.quantity,{kind:"exact",value:42});assert.equal(capacityEvidence.coverage,"complete");
  for(const body of [JSON.parse(original.wire.body),original.realization.prepared.body,measured.value.request.body,measured.value.request.generation.body])
    assert.equal(Object.hasOwn(body,"max_output_tokens"),false);
  assert.deepEqual(JSON.parse(original.wire.body),original.realization.prepared.body);

  if(phase==="execute"){
    assert.equal(head.evidence.revision,0);assert.deepEqual(head.value,original.pending);
    const submission={id:"generation-original",protocol:model.OPENAI_RESPONSES,scope:originalActivity.scope,endpoint,account:"synthetic-account",operation:"generation",submittedAt:at,
      model:"fixture-model",requestedTier:null,reportedTier:null,region:null,modality:"text",reconciliationOwner:owner,beneficiaries:["root","child-beneficiary"],stage:null};
    let accountingState=accounting.applyNativeAccountingCommand(accounting.createNativeAccountingState(),{id:"register",kind:"register",submission});
    accountingState=accounting.applyNativeAccountingCommand(accountingState,{id:"reserve",kind:"reserve",reservation:{id:"reservation-original",submissionId:submission.id,resource:"fixture-budget",amount:"1",unit:"USD",guarantee:"estimate",admissionBasis:ref("fixture-budget")}});
    const initial=await helarc.retainHelarcNativeWork({journal,acceptance:store.sharedAcceptance,scope,fence,expectedRevision:null,state:accountingState,submissionId:submission.id,cost:null,
      references:[saved.input],dependencies:[]});assert.equal(initial.metadata.heldReservations,1);
    const dispatch={ref:ref("create-dispatch"),activityId:"a",operationId:"create",kind:"dispatch_intent",content:saved.input,source:null,dependencies:[]};
    assert.equal(await journal.command({kind:"record",activityId:"a",ref:dispatch.ref}),null);
    await accept("create-dispatch",owner,[jp("record",{record:dispatch,fence})]);
    const response=await native.dispatchResponses(original.realization.prepared,{baseUrl:endpoint,apiKey:"synthetic"},{signal:AbortSignal.timeout(10000),retainChunk:async()=>{}});
    const raw=native.readResponsesObservation(response);assert.equal(raw.id,"response-original");assert.equal(raw.usage.input_tokens,42);
    const rawContent=await content("response-body","a",raw),record={...observationRecord("response",rawContent),source:source("response","")};
    await accept("response",owner,[jp("record",{record,fence:null})]);
    const outputGroup=native.responsesOutputGroup({manifest:original.manifest,response:raw,observation:"response",id:"response-group",representation:ref("response-representation"),holds:["response-hold"]});
    const continuation=native.acceptResponsesContinuation({pending:head.value,manifest:original.manifest,operationId:"create",response:raw,observation:"response",outputGroup});
    await helarc.retainHelarcNativeEvidence(evidenceArgs(fence,{checkpoint:continuation,outputGroup},"continuation","head",0,[saved.input,rawContent],[{activityId:"a",ref:record.ref}]));
    const interpreted=await helarc.recoverHelarcNativeTask({journal,activity:originalActivity,observation:record.ref,interpret:helarc.interpretHelarcResponses,validateOriginalInput:helarc.validateHelarcResponsesTaskInput,observe:entry=>work.push(entry)});
    assert.equal(interpreted.kind,"advance");assert.equal(interpreted.calls.length,1);assert.deepEqual(interpreted.calls[0].call.input,{path:"one.txt"});
    const interpretedContent=await content("purpose-result","a",interpreted),callId=interpreted.calls[0].call.modelCallRef.id;
    await accept("purpose",helarc.HELARC_NATIVE_TASK_INTERPRETER.id,[jp("purpose",{fence,acceptance:{evidence:interpreted.evidence,result:interpretedContent,effects:[{call:interpreted.calls[0].call,owner:"fixture-effect"}],deliveries:[]}})]);
    await accept("effect-dispatch","fixture-effect",[jp("effect_dispatch",{fence,callId})]);
    await appendFile(join(directory,"effect-attempts"),"1\n");await writeFile(join(directory,"one.txt"),"one original accepted effect",{flag:"wx"});await appendFile(join(directory,"effect-count"),"1\n");
    const result=await content("effect-output","a",{written:true,path:"one.txt"});
    await accept("effect-confirm","fixture-effect",[jp("effect_confirmation",{activityId:"a",callId,dispatchBasis:"intent_recorded",confirmation:ref("effect-confirmation"),result,deliveries:[]})]);
    accountingState=accounting.applyNativeAccountingCommand(accountingState,{id:"bind-remote",kind:"bind_remote",submissionId:submission.id,remote:{kind:"response",id:raw.id},evidence:source("response")});
    accountingState=observeUsage(accountingState,"usage-terminal",raw,"create");
    const settle={id:"settle-original",kind:"settle",submissionId:submission.id,owner,contributionRevision:accounting.nativeWorkForSubmission(accountingState,submission.id).contribution.revision,
      reservationIds:["reservation-original"],basis:ref("settlement-original")};
    accountingState=accounting.applyNativeAccountingCommand(accountingState,settle);
    const cost=accounting.calculateNativeCost({...original.pricing,work:accounting.nativeWorkForSubmission(accountingState,submission.id)});
    assert.deepEqual(cost.subtotals,{USD:"0.0001488"});assert.equal(cost.coverage,"complete");
    const usageRecord=observationRecord("usage-terminal",rawContent);
    await helarc.retainHelarcNativeWork({journal,acceptance:commitWithOriginal([jp("record",{record:usageRecord,fence:null})],"settlement",true),scope,fence,expectedRevision:0,
      state:accountingState,submissionId:submission.id,cost,references:[saved.input,rawContent],dependencies:[{activityId:"a",ref:usageRecord.ref}]});
    throw new Error("Lost settlement acknowledgement must not return");
  }

  await assertReceipt("settlement");
  const usagePage=await helarc.readHelarcNativeWorkPage({journal,activityId:"a",scopeId:scope.id,afterKey:null,limit:1,membership:"root"});
  assert.equal(usagePage.entries.length,1);const workId=usagePage.entries[0].workId;
  const usage=await loadEvidence("usage",workId,packet=>({state:accounting.restoreNativeAccountingState(packet.state),cost:packet.cost}));assert(usage);
  const originalWork=accounting.nativeWorkForSubmission(usage.value.state,"generation-original");
  const cost=usage.value.cost;assert(cost);
  assert.deepEqual(cost.rateBases,original.pricing.rates);assert.deepEqual(cost.context,original.pricing.context);
  assert.deepEqual(cost.subtotals,{USD:"0.0001488"});assert.equal(cost.coverage,"complete");
  assert.deepEqual(cost,accounting.calculateNativeCost({...original.pricing,work:originalWork}));
  assert.deepEqual(originalWork.costCalculations,[cost]);
  assert.equal(Object.values(usage.value.state.commands).filter(value=>value.command.kind==="record_cost").length,1);
  assert.deepEqual(usagePage.entries[0].pricedSubtotals,cost.subtotals);assert.equal(usagePage.entries[0].costRevision,cost.revision);
  assert.deepEqual(cost.components.filter(component=>component.state==="priced").map(({id,quantity,amount})=>({id,quantity,amount})),[
    {id:"input_tokens.ordinary",quantity:"38",amount:"0.000076"},
    {id:"input_tokens_details.cached_tokens",quantity:"4",amount:"0.0000008"},
    {id:"output_tokens",quantity:"9",amount:"0.000072"}]);
  assert.equal(originalWork.settlement.id,"settle-original");assert.equal(originalWork.exposure,"reconciled");
  assert.equal(Object.values(usage.value.state.reservations)[0].status,"reconciled");
  const settleCommand=Object.values(usage.value.state.commands).find(value=>value.command.id==="settle-original").command;
  assert.equal(accounting.applyNativeAccountingCommand(usage.value.state,settleCommand),usage.value.state);
  assert.throws(()=>accounting.applyNativeAccountingCommand(usage.value.state,{...settleCommand,id:"duplicate-settlement"}),/already_committed/);
  const usageReplay=await helarc.retainHelarcNativeWork({journal,acceptance:{query:id=>store.sharedAcceptance.query(id),accept:async()=>{throw new Error("Usage replay must not CAS again");}},
    scope,fence,expectedRevision:usage.evidence.revision-1,state:usage.value.state,submissionId:"generation-original",cost,references:usage.evidence.references,dependencies:usage.evidence.dependencies});
  assert.deepEqual(usageReplay,usage.evidence);
  const accepted=await journal.command({kind:"acceptance",activityId:"a"}),callId=accepted.effects[0].call.modelCallRef.id;
  const effect=await journal.command({kind:"effect",activityId:"a",callId});assert.deepEqual(effect.confirmation,ref("effect-confirmation"));
  assert.equal(await readFile(join(directory,"effect-count"),"utf8"),"1\n");
  const metadata=await checkMetadata(original,workId);

  if(phase==="reconcile"){
    assert.equal(usage.evidence.revision,1);assert.equal(head.evidence.revision,1);
    const nextManifest=native.bindNativeInputManifest({...original.manifest,selection:{...original.manifest.selection,id:"selection-next",revision:"2",boundary:"effect:1"},
      groups:[{...original.manifest.groups[0],holds:["renewed-input-hold"]},head.value.outputGroup,
        {id:"actual-result",representation:ref("actual-result"),sources:["effect-confirmation"],holds:["result-hold"],deliveries:["actual-result-delivery"],requires:[],replay:"local",
          items:[{type:"function_call_output",call_id:"call-original",output:JSON.stringify(await read(effect.result))}]}]});
    const next=native.realizeResponsesInput({manifest:nextManifest,request:original.request,policy:"persistent_chain",previous:head.value.checkpoint,conditions:original.conditions});
    assert.equal(next.path,"extend");assert.equal(next.prefixGroups,2);assert.equal(next.prepared.body.previous_response_id,"response-original");
    assert.deepEqual(next.prepared.body.input,nextManifest.groups[2].items);
    assert.throws(()=>native.realizeResponsesInput({manifest:nextManifest,request:original.request,policy:"persistent_chain",previous:head.value.checkpoint,conditions:{...original.conditions,authorized:false}}),/authority_changed/);
    const b=activity("b"),bInput=await content("b:input","b",{manifest:nextManifest,wire:{body:next.prepared.encoded,digest:next.prepared.digest}});
    await accept("b:prepare","execution-coordinator",[jp("prepare",{activity:b,input:bInput})]);
    await assert.rejects(()=>journal.command({kind:"evidence",activityId:"b",scopeId:scope.id,evidenceKind:"continuation",key:"head"}),/activity_binding/);
    await accept("b:bind","execution-coordinator",[jp("evidence_scope",{activityId:"b",scope})]);const bFence=await claim("b");
    assert.deepEqual((await loadEvidence("continuation","head",value=>value,"b")).value,head.value);
    const bHead=await helarc.retainHelarcNativeEvidence(evidenceArgs(bFence,head.value,"continuation","head",1,[saved.input,bInput],head.evidence.dependencies));
    assert.equal(bHead.revision,2);
    const responseOriginal=await journal.command({kind:"record",activityId:"a",ref:ref("response")});
    const rollbackObservation=observationRecord("rollback-observation",responseOriginal.content);
    await reject("stale-cas",owner,[jp("record",{record:rollbackObservation,fence:null}),jp("evidence",{fence:bFence,expectedRevision:1,evidence:bHead})],/revision_conflict/);
    assert.equal(await journal.command({kind:"record",activityId:"a",ref:rollbackObservation.ref}),null,"CAS rejection must roll back its original observation too");
    await reject("wrong-owner","other-owner",[jp("evidence",{fence:bFence,expectedRevision:2,evidence:{...bHead,revision:3}})],/owner_invalid/);
    const changedComposition=model.bindModelAgentComposition({...composition.composition,configuration:{...composition.composition.configuration,configuration:ref("changed-config")}});
    const changedBase=activity("changed-composition"),changedActivity=runtime.bindProtocolModelActivity({...changedBase,composition:changedComposition,
      scope:{...changedBase.scope,compositionDigest:changedComposition.digest}});
    const changedInput=await content("changed:input","changed-composition",{task:"different accepted composition"});
    await accept("changed:prepare","execution-coordinator",[jp("prepare",{activity:changedActivity,input:changedInput})]);
    await reject("changed:scope","execution-coordinator",[jp("evidence_scope",{activityId:"changed-composition",scope})],/activity_scope_invalid/);
    const child=activity("child-activity","child","child-task"),childInput=await content("child:input","child-activity",{task:"independent Child"});
    await accept("child:prepare","execution-coordinator",[jp("prepare",{activity:child,input:childInput})],"child");
    await reject("child:scope","execution-coordinator",[jp("evidence_scope",{activityId:"child-activity",scope})],/scope_owner_invalid|activity_scope_invalid/,"child");
    await assert.rejects(()=>loadEvidence("continuation","head",value=>value,"child-activity"),/activity_scope_invalid/);
    await assert.rejects(()=>runtime.readProtocolContent(journal,saved.input,"child-activity",32*1024*1024),/scope_invalid/);
    const foreignManifest=native.bindNativeInputManifest({...nextManifest,scope:{...nextManifest.scope,id:"child",runId:"child",recipientId:"child-task"}});
    assert.throws(()=>native.realizeResponsesInput({manifest:foreignManifest,request:original.request,policy:"persistent_chain",previous:head.value.checkpoint,conditions:original.conditions}),/scope_changed/);
    await accept("cancel","execution-coordinator",[jp("control",{activityId:"a",expectedRevision:0,cancelled:true})]);
    const cancelled=(await state("a")).fence;
    await reject("cancelled-effect","fixture-effect",[jp("effect_dispatch",{fence:cancelled,callId})],/fenced/);
    const responseRecord=await journal.command({kind:"record",activityId:"a",ref:ref("response")}),raw=await read(responseRecord.content);
    const lateState=observeUsage(usage.value.state,"usage-late",raw,"recovery");
    assert.equal(accounting.nativeWorkForSubmission(lateState,"generation-original").contribution.revision,originalWork.contribution.revision);
    assert.deepEqual(accounting.nativeWorkForSubmission(lateState,"generation-original").costCalculations,[cost]);
    assert.deepEqual(accounting.nativeWorkIndexEntry(lateState,"generation-original").pricedSubtotals,cost.subtotals);
    const lateRecord=observationRecord("usage-late",responseRecord.content);
    await writeFile(join(directory,"reconciliation-evidence.json"),JSON.stringify({metadata,headRevision:2,extendedPrefixGroups:2,suffixItems:1,
      casConflictRejected:true,atomicOriginalRollback:true,compositionMismatchRejected:true,wrongOwnerRejected:true,childScopeRejected:true,
      unboundActivityRejected:true,currentAuthorityRejected:true,cancelledEffectRejected:true,settlementPreserved:true,
      originalCostRevision:cost.revision,pricedSubtotals:cost.subtotals,lateUsagePreservesOriginalCost:true}));
    await helarc.retainHelarcNativeWork({journal,acceptance:commitWithOriginal([jp("record",{record:lateRecord,fence:null})],"late",true),scope,fence:cancelled,expectedRevision:1,
      state:lateState,submissionId:"generation-original",cost,references:usage.evidence.references,dependencies:[...usage.evidence.dependencies,{activityId:"a",ref:lateRecord.ref}]});
    throw new Error("Lost late-usage acknowledgement must not return");
  }

  assert.equal(phase,"verify");await assertReceipt("late");assert.equal(usage.evidence.revision,2);assert.equal(head.evidence.revision,2);
  assert.equal((await state("a")).cancelled,true);assert.equal((await loadEvidence("continuation","head",value=>value,"b")).evidence.activityId,"b");
  assert.deepEqual((await loadEvidence("continuation","head",value=>value,"a",0)).value,original.pending);
  assert.deepEqual((await loadEvidence("measurement",original.countRequest.bindingDigest,value=>value,"measurement",0,countScope)).value,measured.value);
  assert.deepEqual(originalWork.contribution.observationIds,["usage-late","usage-terminal"]);
  const settledUsage=await loadEvidence("usage",workId,value=>value,"a",1);
  assert.deepEqual(settledUsage.value.cost,cost);
  assert.deepEqual(settledUsage.value.state.reservations,usage.value.state.reservations);
  const facts=await journal.command({kind:"facts",runId:"root",after:0,limit:128});
  assert.equal(facts.filter(f=>f.kind==="purpose_accepted"&&f.activityId==="a").length,1);
  assert.equal(facts.filter(f=>f.kind==="purpose_accepted"&&f.activityId==="measurement").length,1);
  assert.equal(facts.filter(f=>f.kind==="delivery_received"&&f.activityId==="measurement").length,1);
  assert.equal(facts.filter(f=>f.kind==="effect_confirmed").length,1);
  const inspection=await inspectFacts(facts);
  const Database=require("better-sqlite3"),db=new Database(join(directory,"execution/execution.sqlite"),{readonly:true});
  let sqlEvidence;
  try{
    const history=db.prepare("SELECT kind,COUNT(*) AS revisions FROM protocol_evidence_history GROUP BY kind ORDER BY kind").all();
    assert.deepEqual(history,[{kind:"continuation",revisions:3},{kind:"measurement",revisions:1},{kind:"usage",revisions:3}]);
    const slots=db.prepare("SELECT kind,revision FROM protocol_evidence_slots ORDER BY kind").all();
    assert.deepEqual(slots,[{kind:"continuation",revision:2},{kind:"measurement",revision:0},{kind:"usage",revision:2}]);
    sqlEvidence={format:db.prepare("SELECT version FROM store").get().version,history,slots,
      usageMemberships:db.prepare("SELECT COUNT(*) AS n FROM protocol_evidence_memberships").get().n,
      countRecordOwners:db.prepare("SELECT activity_id,COUNT(*) AS records FROM protocol_records WHERE json_extract(value,'$.operationId')='count' GROUP BY activity_id").all(),
      scopePurposes:db.prepare("SELECT id,json_extract(value,'$.purpose.id') AS purpose FROM protocol_evidence_scopes ORDER BY id").all(),
      receipts:db.prepare("SELECT id,outcome FROM shared_acceptances WHERE id IN ('count:commit','settlement:commit','late:commit') ORDER BY id").all()};
    assert.equal(sqlEvidence.usageMemberships,2);assert.equal(sqlEvidence.receipts.length,3);
    assert.deepEqual(sqlEvidence.countRecordOwners,[{activity_id:"measurement",records:2}]);
    assert.deepEqual(sqlEvidence.scopePurposes,[{id:"count-scope",purpose:"measurement"},{id:"root-task",purpose:"task"}]);
  }finally{db.close();}
  const reconciliation=JSON.parse(await readFile(join(directory,"reconciliation-evidence.json"),"utf8"));
  const summary={electron:process.versions.electron,generation:store.generation,originalManifestDigest:original.manifest.digest,measurementBinding:original.countRequest.bindingDigest,
    reusableCount:42,recoveryPosts:0,replayedBridgeAccepts:replayAccepts,duplicateSettlementRejected:true,lateUsagePreservesSettlement:true,
    capacity:{bindingBuilder:"buildResponsesMeasurementBinding",applicability:"responsesMeasurementApplicabilityFromRealization",policy:capacityPolicy,
      assessment:capacity,evidence:capacityEvidence,noOutputCap:true,explicitMeasurementDelivery:countDelivery.id},
    accounting:{cost,retainedCostCalculations:originalWork.costCalculations.length,retainedCostCommands:1,originalPriceAndAmountPreserved:true,
      duplicateSettlementDidNotMultiply:true,lateUsageDidNotMultiply:true,reservations:Object.values(usage.value.state.reservations)},inspection,
    independentMeasurement:{activityId:"measurement",purpose:"measurement",scopeId:countScope.id,measuredInputPurpose:original.countRequest.binding.scope.purpose,
      taskScopeId:scope.id,countDidNotAdvanceTaskHead:true,crossPurposeAccessRejected:true,measurementHasNoContinuation:true,
      handoffAcceptance:"measurement-purpose",deliveryId:countDelivery.id,receipt:delivered.receipt},
    contextSelection:JSON.parse(await readFile(join(directory,"context-evidence.json"),"utf8")),metadata,reconciliation,sqlEvidence};
  await writeFile(join(directory,"verification.json"),JSON.stringify(summary,null,2));await phaseEvidence({verified:true,metadata});
}
app.whenReady().then(main).then(async()=>{await store?.close();app.exit(0);}).catch(async error=>{
  await mkdir(directory,{recursive:true});await writeFile(join(directory,`failure-${phase}.txt`),error.stack??String(error));
  try{await store?.close();}finally{app.exit(1);}
});
