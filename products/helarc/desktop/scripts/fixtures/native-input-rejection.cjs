const {app}=require("electron");
const assert=require("node:assert/strict");
const {join}=require("node:path");
const {pathToFileURL}=require("node:url");
const {writeFile,readFile}=require("node:fs/promises");
const {createHash}=require("node:crypto");
const [directory,phase]=process.argv.slice(2);
app.setPath("userData",join(directory,"electron"));app.disableHardwareAcceleration();
const ref=id=>({id,revision:"1"});
let store;

async function main(){
  const runtime=await import("@agent-anything/agent-runtime/model-access");
  const context=await import("@agent-anything/agent-runtime/context-representation");
  const model=await import("@agent-anything/model-interaction/protocol");
  const {modelInputValueDigest:digest,assessInputCapacity}=await import("@agent-anything/model-interaction/input");
  const {HelarcExecutionStore}=await import(pathToFileURL(join(__dirname,"../../dist/main/execution-storage/HelarcExecutionStore.js")));
  store=await HelarcExecutionStore.open(join(directory,"execution"),pathToFileURL(join(__dirname,"native-input-accounting-worker.mjs")));
  const journal=store.protocolJournal,acceptance=store.sharedAcceptance,scope={id:"scope",runId:"root",recipient:"agent",purpose:"task",
    target:"configuration:1",owner:"context-representation",authorityBasis:"host",continuity:"root-task"};
  const participant=id=>({implementation:ref(id),protocol:model.OPENAI_RESPONSES});
  const composition=model.bindModelAgentComposition({agent:ref("agent"),protocol:model.OPENAI_RESPONSES,
    configuration:{configuration:ref("configuration"),protocol:model.OPENAI_RESPONSES,model:"controlled",connectionBinding:ref("connection")},
    adapter:participant("adapter"),task:{purpose:ref("task"),input:participant("input"),interpreter:participant("interpreter")},auxiliary:[]});
  const activity=runtime.bindProtocolModelActivity({composition,scope:{runId:"root",activityId:"native",recipientId:"agent",purpose:ref("task"),compositionDigest:composition.digest},
    conditions:{input:ref("source"),authority:ref("host"),resources:ref("resources"),control:ref("control")}});
  const exact={input:[{role:"user",content:"Retain this task."}],model:"controlled"},bodyDigest=digest(exact),exactDigest=digest(exact);
  const accept=async(id,actor,parts)=>{
    const result=await acceptance.accept({id,actor,scope:"root",parts});assert.equal(result.outcome,"accepted",JSON.stringify(result));return result;
  };
  const state=()=>journal.command({kind:"state",activityId:"native"});
  const retain=(id,value)=>runtime.retainProtocolContent(journal,id,"native",Buffer.from(JSON.stringify(value)));
  const checkpoint=ref("raw:input-rejection");
  const evidence={kind:"recipient",activityId:"native",scopeId:scope.id,boundary:"original-deliveries:1",inputId:"input",exactInputDigest:exactDigest,
    targetRevision:scope.target,bodyDigest,evidence:{...checkpoint,owner:"adapter",kind:"fact"}};
  const measurements=[{id:"input:bytes",encodedInputId:"input",targetRevision:scope.target,methodRevision:"native-body-bytes:1",dimension:"request_bytes",coverage:"complete",
    quantity:{kind:"exact",value:Buffer.byteLength(JSON.stringify(exact))},basis:"Complete native input",uncovered:[]}];
  const capacity={inputId:"input",measurements,limits:[],assessment:assessInputCapacity({encodedInputId:"input",targetRevision:scope.target,purpose:scope.purpose,
    evidence:measurements,limits:[],reservations:[],policy:{id:"native-capacity",revision:"1",purpose:scope.purpose,basis:"Unknown token capacity remains unknown",
      allowEstimatedFit:false,allowUnknown:true}})};
  const observed=context.observeContextPreparationInput({scope,settingsRevision:"fixed",sequence:0,observedAt:"2026-11-16T00:00:00.000Z",representationContinuity:"original",
    recipient:capacity,evidence:{id:"combination",revision:"1",owner:scope.owner,kind:"judgment"},previous:null});
  const policy={scope,boundary:evidence.boundary,requirementsDigest:"original-requirements",current:{kind:"recipient_prepared",scope,inputId:"input",bodyDigest,exactInputDigest:exactDigest,
    judgmentId:"combination",allowed:true,risks:["token_capacity_unknown"],capacity,evidence:{id:"combination",revision:"1",owner:scope.owner,kind:"judgment"}},
    observationReport:observed.report,currentRejectedInputId:null,rejectedInputs:[evidence],alternatives:[],pressure:observed.pressure,options:[],inFlight:[],explorationHistory:[],optionalInFlight:0,autoPrepare:false,consumerActive:true};
  const decisionPart=input=>({owner:"context_preparation_policy",kind:"decision",proposal:{input,policyRevision:"13",decisionId:context.decideContextPreparation(input).id,investment:null,expectedDecisionId:null,expectedControlRevision:0}});
  if(phase==="seed"){
    const bytes=Buffer.from("Retain this task."),range={materialId:"source",version:"1",coordinate:"bytes",start:0,end:bytes.length};
    const recipient={runId:scope.runId,recipient:scope.recipient,purpose:scope.purpose},producer={...recipient,recipient:scope.owner};
    const hold=(id,responsibility,basis,consumer=recipient)=>({id,instanceId:"custody",range,responsibility,basis,consumer,releaseCondition:"explicit"});
    const intent={id:"capture",instanceId:"custody",activityId:"source",owner:scope.owner,maximumBytes:bytes.length,
      version:{ref:{materialId:"source",version:"1"},origin:{runId:"root",owner:scope.owner,recordId:"prompt",revision:"1",occurredAt:"2026-11-16T00:00:00.000Z"},
        label:"Original task",format:"utf8",mediaType:"text/plain",bytes:bytes.length,digest:`sha256:${createHash("sha256").update(bytes).digest("hex")}`,capture:"complete",limitations:[]}};
    await store.materialCustody.command({kind:"begin",intent});
    await store.materialCustody.command({kind:"append",id:"bytes",intentId:intent.id,offset:0,bytesBase64:bytes.toString("base64")});
    await store.materialCustody.command({kind:"complete",intentId:intent.id});
    await accept("source",scope.owner,[{owner:"material_custody",kind:"publish",proposal:{intentId:intent.id,
      holds:[hold("source-hold","preparation","source",producer)],grants:[recipient,producer].map((recipient,i)=>({id:`grant-${i}`,instanceId:"custody",recipient,range,revision:0,allowed:true,basis:scope.authorityBasis}))}}]);
    const representation={ref:ref("representation"),owner:scope.owner,runId:"root",purpose:scope.purpose,target:scope.target,form:"original",body:range,
      inputs:[{role:"source",material:range,representation:null}],declaredCoverage:[range],details:[range],holds:["source-hold"],requirements:[],losses:[],restorations:[],method:null};
    await store.contextSelections.command({kind:"scope",scope});
    await store.representations.command({kind:"record",record:representation});
    const judgment={id:"combination",owner:scope.owner,runId:"root",kind:"combination",subjects:[representation.ref],inputs:[range],purpose:scope.purpose,target:scope.target,
      methodRevision:"fixture:1",dependencies:{inputDigest:exactDigest,bodyDigest,capacityDigest:digest(capacity)},coverage:[range],conclusion:"supported",limitations:[],evidenceSources:[],basis:"Exact synthetic input"};
    await store.representations.command({kind:"judge",judgment});
    const selection=context.contextPreparedInputAcceptance({id:"selected",scope,expectedSelectionId:null,expectedControlRevision:0,retainedSelectionId:null,
      selection:{id:"selection",representations:[representation.ref],judgmentIds:[judgment.id],holds:[hold("selection-hold","selection","selection")]},
      preparedValue:exact,preparedScope:{...recipient,target:scope.target},judgment,inputId:"input",activityId:"native",stageRequestId:null,
      nativeConsumer:{protocol:model.OPENAI_RESPONSES,compositionDigest:composition.digest},inputHolds:[hold("input-hold","input","input")],releaseHolds:[],deliveries:[]});
    assert.equal((await acceptance.accept(selection)).outcome,"accepted");
    const originalInput=await retain("request",exact);
    await accept("prepare","execution-coordinator",[{owner:"protocol_execution",kind:"prepare",proposal:{activity,input:originalInput,contextInput:{id:"input",digest:exactDigest}}}]);
    await accept("claim","adapter",[{owner:"protocol_execution",kind:"claim",proposal:{activityId:"native",expectedEpoch:0}}]);
    const s=await state(),dispatch={ref:ref("dispatch"),activityId:"native",operationId:"create",kind:"dispatch_intent",content:originalInput,source:null,dependencies:[]};
    await accept("dispatch","adapter",[{owner:"protocol_execution",kind:"record",proposal:{record:dispatch,fence:s.fence}}]);
    const observation={ref:ref("raw"),activityId:"native",operationId:"create",kind:"observation",content:await retain("response",{error:{code:"context_length_exceeded"},diagnostic:"x".repeat(1024*1024)}),
      source:{scope:activity.scope,protocol:model.OPENAI_RESPONSES,interpretation:ref("adapter"),operationId:"create",record:ref("raw"),position:{format:"json-pointer",value:"/error"},nativeIdentity:null},dependencies:[dispatch.ref]};
    await accept("observed","adapter",[{owner:"protocol_execution",kind:"record",proposal:{record:observation,fence:null}}]);
    const proof={kind:"protocol_input_rejection",revision:"1",scope,boundary:evidence.boundary,inputId:"input",exactInputDigest:exactDigest,bodyDigest,
      originalInput,observation:observation.ref,reason:"input_capacity_exceeded"};
    assert.deepEqual(await runtime.retainProtocolInputRejection({state:s,proof,observation,journal,acceptance}),evidence);
    await writeFile(join(directory,"original.json"),JSON.stringify({proof,observation}));
    await writeFile(join(directory,"seed.json"),JSON.stringify({phase,pid:process.pid,electron:process.versions.electron,generation:store.generation}));
    // Abrupt exit after durable refusal, before CRM has consumed it.
    app.exit(73);return;
  }
  const original=JSON.parse(await readFile(join(directory,"original.json"),"utf8"));
  const s=await state();assert.equal(s.fence.generation,1);assert.equal(store.generation,2);
  let duplicateAccepts=0;
  assert.deepEqual(await runtime.retainProtocolInputRejection({state:s,...original,journal,
    acceptance:{query:id=>acceptance.query(id),accept:async()=>{duplicateAccepts++;throw new Error("No duplicate acceptance on recovery");}}}),evidence);
  assert.equal(duplicateAccepts,0);
  const probe=join(directory,"execution/body-reads.ndjson"),before=(await readFile(probe,"utf8")).trim().split("\n").length;
  for(const [name,changed]of [
    ["body",{...evidence,bodyDigest:"other"}], ["input",{...evidence,inputId:"other"}], ["owner",{...evidence,evidence:{...evidence.evidence,owner:"other"}}],
    ["activity",{...evidence,activityId:"child"}], ["digest",{...evidence,exactInputDigest:"other"}], ["record",{...evidence,evidence:{...evidence.evidence,id:"dispatch"}}]
  ]){
    const result=await acceptance.accept({id:`reject-${name}`,scope:"root",actor:scope.owner,parts:[decisionPart({...policy,rejectedInputs:[changed]})]});
    assert.equal(result.outcome,"rejected");assert.equal(result.rejection.code,"provider_input_rejection_unconfirmed");
  }
  assert.throws(()=>context.decideContextPreparation({...policy,boundary:"other"}),/input_rejection_invalid/);
  assert.throws(()=>context.decideContextPreparation({...policy,rejectedInputs:[{...evidence,scopeId:"child"}]}),/input_rejection_invalid/);
  const changed=structuredClone(policy);changed.current.capacity.measurements[0].quantity.value++;
  changed.current.capacity.assessment=assessInputCapacity({encodedInputId:"input",targetRevision:scope.target,purpose:scope.purpose,
    evidence:changed.current.capacity.measurements,limits:[],reservations:[],policy:capacity.assessment.policy});
  changed.observationReport.window.inputs[0].measurements=changed.current.capacity.measurements;
  const unconfirmed=await acceptance.accept({id:"reject-unbound-measurement",scope:"root",actor:scope.owner,parts:[decisionPart(changed)]});
  assert.equal(unconfirmed.outcome,"rejected");assert.equal(unconfirmed.rejection.code,"decision_input_unconfirmed");
  const decision=context.decideContextPreparation(policy);
  assert.equal(decision.foreground.kind,"limited");assert.equal(decision.investment.reason,"automatic_preparation_disabled");
  await accept("decision",scope.owner,[decisionPart(policy)]);
  assert.deepEqual((await store.contextPolicy.query({kind:"latest_observation",scopeId:scope.id})).input.observationReport,observed.report);
  const reads=(await readFile(probe,"utf8")).trim().split("\n").slice(before).map(JSON.parse).filter(v=>v.kind==="body_read");
  assert(reads.length>0);assert(reads.every(v=>v.bytes<16384),"Confirmation must never hydrate the large request/response");
  const binding=await store.contextSelections.command({kind:"binding",inputId:"input",checkCurrentControl:true});assert.deepEqual(binding.input.exactInput,exact);
  const facts=await journal.command({kind:"facts",runId:"root",after:0,limit:128});
  assert.equal(facts.filter(f=>f.kind==="dispatch_intent").length,1);assert.equal(facts.filter(f=>f.kind==="purpose_accepted").length,0);
  const record={decision,input:policy,investment:null,acceptanceId:"decision"},inspection=context.contextPreparationDecisionEvidence(record,[]);
  assert(inspection.relationships.some(r=>r.to.owner==="protocol_execution"&&r.to.id===checkpoint.id));
  assert(inspection.relationships.some(r=>r.to.owner==="model-input"&&r.to.id==="input"));
  await writeFile(join(directory,"resume.json"),JSON.stringify({phase,pid:process.pid,electron:process.versions.electron,generation:store.generation,
    originalDispatches:1,duplicateAccepts,policy:decision.foreground,originalInputRetained:true,wrongBindingsRejected:9,nativeCapacityRestored:true,
    evidenceReadBytes:reads.reduce((s,r)=>s+r.bytes,0),largestEvidenceRead:Math.max(...reads.map(r=>r.bytes)),inspectorLinks:inspection.relationships.length},null,2));
  await store.close();store=null;app.exit(0);
}
app.whenReady().then(main).catch(async error=>{
  await writeFile(join(directory,`failure-${phase}.txt`),error.stack??String(error));try{await store?.close();}catch{}app.exit(1);
});
