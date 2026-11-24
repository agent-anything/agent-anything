const {app}=require("electron");
const assert=require("node:assert/strict");
const {join}=require("node:path");
const {pathToFileURL}=require("node:url");
const {createHash}=require("node:crypto");
const {readFile,writeFile,appendFile}=require("node:fs/promises");
const [directory,phase,historyArgument,endpoint]=process.argv.slice(2);
const historyRepetitions=Number(historyArgument);
assert(Number.isSafeInteger(historyRepetitions)&&historyRepetitions>0&&historyRepetitions<=100000);
app.setPath("userData",join(directory,"electron"));app.disableHardwareAcceleration();
const ref=id=>({id,revision:"1"}),at="2026-11-15T00:00:00.000Z",part=(kind,proposal)=>({owner:"protocol_execution",kind,proposal});
let store;
async function main(){
  const runtime=await import("@agent-anything/agent-runtime/model-access"),model=await import("@agent-anything/model-interaction/protocol");
  const native=await import("@agent-anything/provider-integrations/native"),h=await import("@agent-anything/helarc/controller");
  const {modelInputValueDigest:digest}=await import("@agent-anything/model-interaction/input");
  const {HelarcExecutionStore}=await import(pathToFileURL(join(__dirname,"../../dist/main/execution-storage/HelarcExecutionStore.js")));
  const work=[],calls={},facts=[];
  store=await HelarcExecutionStore.open(join(directory,"execution"),pathToFileURL(join(__dirname,"native-input-accounting-worker.mjs")),
    undefined,undefined,undefined,undefined,undefined,undefined,undefined,{observe:f=>facts.push(f)});
  const journal={command:async c=>{calls[c.kind]=(calls[c.kind]??0)+1;return store.protocolJournal.command(c);}};
  const content=(id,activityId,value)=>runtime.retainProtocolContent(journal,id,activityId,Buffer.from(JSON.stringify(value)),w=>work.push(w));
  const read=async c=>JSON.parse((await runtime.readProtocolContent(journal,c,c.activityId,32*1024*1024,w=>work.push(w))).toString());
  const accept=async(id,actor,parts,scope="root")=>{const r=await store.sharedAcceptance.accept({id,scope,actor,parts});assert.equal(r.outcome,"accepted",JSON.stringify(r));return r;};
  const owner=native.OPENAI_RESPONSES_ADAPTER.id,crm="context-representation",recipient={runId:"root",recipient:crm,purpose:"task"};
  const composition=model.bindModelAgentComposition({agent:ref("fixture-agent"),protocol:model.OPENAI_RESPONSES,
    configuration:{configuration:ref("fixture-config"),protocol:model.OPENAI_RESPONSES,model:"fixture-model",connectionBinding:ref("original-connection")},
    adapter:{implementation:native.OPENAI_RESPONSES_ADAPTER,protocol:model.OPENAI_RESPONSES},
    task:{purpose:ref("task"),input:{implementation:ref(crm),protocol:model.OPENAI_RESPONSES},interpreter:{implementation:h.HELARC_NATIVE_TASK_INTERPRETER,protocol:model.OPENAI_RESPONSES}},
    auxiliary:[{purpose:ref("compact"),input:{implementation:ref(crm),protocol:model.OPENAI_RESPONSES},interpreter:{implementation:ref(crm),protocol:model.OPENAI_RESPONSES}}]});
  const activity=(id,purpose=ref("compact"))=>runtime.bindProtocolModelActivity({composition,
    scope:{runId:"root",activityId:id,recipientId:purpose.id==="task"?"task":crm,purpose,compositionDigest:composition.digest},
    conditions:{input:ref(`${id}:input`),authority:ref("authority"),resources:ref("resources"),control:ref("control")}});
  const a=activity("compact"),scope={id:"compact-scope",runId:"root",recipientId:a.scope.recipientId,purpose:a.scope.purpose,compositionDigest:composition.digest,owner};
  const state=id=>journal.command({kind:"state",activityId:id});
  const claim=async id=>{let s=await state(id);if(s.fence.generation!==store.generation||s.fence.epoch===0){await accept(`${id}:claim:${store.generation}`,owner,[part("claim",{activityId:id,expectedEpoch:s.fence.epoch})]);s=await state(id);}return s.fence;};
  const evidence=extra=>writeFile(join(directory,`${phase}.json`),JSON.stringify({phase,pid:process.pid,electron:process.versions.electron,generation:store.generation,calls,work,performanceFacts:facts.length,...extra},null,2));
  const crash=async extra=>{await evidence(extra);app.exit(73);await new Promise(()=>{});};
  const mark=async stage=>appendFile(join(directory,"stages.ndjson"),JSON.stringify({phase,stage,at:Date.now()})+"\n");
  const retain=async(key,value,fence,refs,dependencies=[])=>h.retainHelarcNativeEvidence({journal,acceptance:store.sharedAcceptance,scope,fence,
    kind:"transformation",key,value,expectedRevision:null,references:refs,dependencies,memberships:[],metadata:{stage:key},observe:w=>work.push(w)});
  const load=async key=>(await h.readHelarcNativeEvidence({journal,activityId:"compact",scopeId:scope.id,kind:"transformation",key,
    restore:v=>v,maximumBytes:32*1024*1024,observe:w=>work.push(w)})).value;
  const publish=async(id,items,originRun="root")=>{
    const bytes=Buffer.from(JSON.stringify(items)),range={materialId:id,version:"1",coordinate:"bytes",start:0,end:bytes.length};
    const intent={id:`${id}:capture`,instanceId:id,activityId:`${id}:producer`,owner:crm,maximumBytes:bytes.length,
      version:{ref:{materialId:id,version:"1"},origin:{runId:originRun,owner:crm,recordId:`${id}:source`,revision:"1",occurredAt:at},
        label:id,format:"json",mediaType:"application/json",bytes:bytes.length,digest:`sha256:${createHash("sha256").update(bytes).digest("hex")}`,capture:"complete",limitations:[]}};
    await store.materialCustody.command({kind:"begin",intent});
    for(let offset=0;offset<bytes.length;offset+=65536)await store.materialCustody.command({kind:"append",id:`${id}:chunk:${offset}`,intentId:intent.id,offset,bytesBase64:bytes.subarray(offset,offset+65536).toString("base64")});
    await store.materialCustody.command({kind:"complete",intentId:intent.id});
    const hold={id:`${id}:checkpoint`,instanceId:id,consumer:recipient,responsibility:"checkpoint",range,basis:`${id}:source`,releaseCondition:"Explicit complete scope settlement"};
    const grant={id:`${id}:grant`,instanceId:id,recipient,range,revision:0,allowed:true,basis:"original-disclosure"};
    const record={ref:ref(`${id}:representation`),runId:"root",owner:crm,purpose:"task",target:"fixture-config:1",form:"original",body:range,
      inputs:[{role:"source",material:range,representation:null}],declaredCoverage:[range],details:[range],holds:[hold.id],requirements:[],losses:[],restorations:[],method:null};
    await accept(`${id}:publish`,crm,[{owner:"material_custody",kind:"publish",proposal:{intentId:intent.id,holds:[hold],grants:[grant]}}],originRun);
    await accept(`${id}:representation`,crm,[{owner:"representation",kind:"record",proposal:record}]);
    return {record,holds:[hold],grant,instanceId:id,items};
  };
  await mark("opened");
  if(phase==="compact"){
    const items=[{role:"user",content:"Remember that the selected option is blue. "+"Historical discussion. ".repeat(historyRepetitions)},
      {id:"old_reply",type:"message",role:"assistant",status:"completed",content:[{type:"output_text",text:"Selected blue; original operation already completed.",annotations:[]}]}];
    const original=await publish("original",items);
    const request={model:"fixture-model",purpose:ref("task"),stream:false,store:true};
    const settings=native.nativeInputSettings(native.prepareResponses({...request,input:items}).body);
    const manifest=native.bindNativeInputManifest({protocol:model.OPENAI_RESPONSES,
      scope:{id:"root-task",runId:"root",recipientId:"task",purpose:ref("task"),compositionDigest:composition.digest},
      target:{model:"fixture-model",configuration:"fixture-config:1",connection:"original-connection",disclosure:"original-disclosure"},
      selection:{id:"old-selection",revision:"1",boundary:"old-delivery",judgments:["old-judgment"]},
      groups:[{id:"original",representation:original.record.ref,sources:["original:source"],holds:[original.holds[0].id],deliveries:[],requires:[],items,replay:"local"}],settings,
      settingSources:Object.keys(settings).map(field=>({field,source:"original-config",digest:digest(settings[field])}))});
    const working=new h.HelarcNativeWorkingInput();
    working.append(items,{id:"original-history",originRunId:"root",sources:[{source:{owner:"host",kind:"task",...ref("original")},position:""}],
      duties:["objective","continuity"],preservation:{obligations:[{id:"option",requirement:"account",basis:"Retain the selected blue option and completed original operation"}],relationships:[]},
      exchangeId:null,protection:[],acceptedBy:{runId:"root",activityId:"original-model-input",acceptance:ref("original-reply")},representations:[]});
    const prepared=native.prepareResponses({...request,input:items}),retained={kind:"helarc_native_input",manifest,
      wire:{body:prepared.encoded,digest:prepared.digest},workingSources:working.snapshot(),prefixGroups:0,predecessor:null,continuity:{kind:"explicit"}};
    const sources=await require("./native-compact-sources.cjs")({store,h,retained,at});
    const offered=h.helarcResponsesCompactScopes(retained,sources.publications,ref("compact"),8);assert.equal(offered.enumeration.eligible,1);
    const source=offered.scopes[0],dependencies=source.dependencies;
    assert.deepEqual(h.bindHelarcResponsesCompactPrefix(retained,sources.publications,1,ref("compact")),source);
    const binding={id:"compact-method",prepared:source.methodRequest,sourceDigest:source.sourceDigest,target:dependencies.target,disclosure:dependencies.authority,
      startedAt:Date.now(),deadlineAt:Date.now()+60000,maximumBytes:8*1024*1024};
    const input=await content("compact-original","compact",{source,original:sources.originals[0],request,binding,retained});
    await accept("compact:prepare","execution-coordinator",[part("prepare",{activity:a,input}),part("evidence_scope",{activityId:"compact",scope})]);
    const fence=await claim("compact");
    const losing={query:id=>store.sharedAcceptance.query(id),accept:async proposal=>{
      const r=await store.sharedAcceptance.accept(proposal);
      if(r.outcome==="accepted"&&proposal.parts.some(p=>p.kind==="evidence"&&p.proposal.evidence.metadata.status==="observed"))await crash({lostAcknowledgement:"original compact result",receipt:r.id});
      return r;
    }};
    const custody=new h.HelarcResponsesCompactStore({id:binding.id,journal,acceptance:losing,scope,fence,original:[input],maximumBytes:16*1024*1024,observe:w=>work.push(w)});
    const session=await native.ResponsesCompactSession.open(binding,custody);
    await mark("dispatch");
    await require("./native-compact-work.cjs")({store,h,native,source,original:sources.originals[0],retained,publications:sources.publications,session,custody,activity:a,endpoint,at,digest,ref});
    throw new Error("Expected crash after original result commit");
  }
  const saved=await state("compact"),original=await read(saved.input),fence=await claim("compact");
  const custody=new h.HelarcResponsesCompactStore({id:original.binding.id,journal,acceptance:store.sharedAcceptance,scope,fence,original:[saved.input],maximumBytes:16*1024*1024,observe:w=>work.push(w)});
  const session=await native.ResponsesCompactSession.open(original.binding,custody),candidate=session.candidate();
  assert(candidate);assert.equal(session.snapshot().status,"observed");
  await assert.rejects(()=>session.execute({now:Date.now(),authorize:async()=>true,dispatch:async()=>{throw new Error("Must not dispatch original method again");}}),/not_dispatchable/);
  const terminal=await custody.retainTerminal(session,ref("compact-terminal"));
  const submission={id:"compact-method-work",protocol:model.OPENAI_RESPONSES,scope:a.scope,endpoint,account:"controlled",operation:"compact",submittedAt:at,
    model:"fixture-model",requestedTier:null,reportedTier:null,region:null,modality:"text",reconciliationOwner:owner,beneficiaries:["root"],stage:null};
  const accounting=native.responsesCompactAccounting({session,submission,source:terminal.source,observedAt:at});
  await h.retainHelarcNativeWork({journal,acceptance:store.sharedAcceptance,scope,fence,expectedRevision:null,state:accounting,submissionId:submission.id,cost:null,
    references:[saved.input,terminal.content],dependencies:[{activityId:"compact",ref:terminal.ref}]});
  await mark("original-restored");
  if(phase==="check"){
    const sources=await require("./native-compact-sources.cjs")({store,h,retained:original.retained,at});
    await require("./native-compact-work.cjs")({store,h,native,source:original.source,original:original.original,retained:original.retained,
      publications:sources.publications,session,custody,activity:a,endpoint,at,digest,ref});
    const result=await content("compact-purpose-result","compact",{candidateDigest:candidate.digest,sourceDigest:original.source.sourceDigest});
    await accept("compact-purpose",crm,[part("purpose",{fence,acceptance:{evidence:{scope:a.scope,interpreter:ref(crm),acceptance:ref("compact-accepted"),sources:[terminal.source]},
      result,effects:[],deliveries:[]}})]);
    const missing=h.assessHelarcResponsesCompact({source:original.source,candidate,findings:[]});assert.equal(missing.quality.allowed,false);
    assert.deepEqual(h.bindHelarcResponsesCompactPrefix(original.retained,sources.publications,1,ref("compact")),original.source);
    const findings=original.source.duties.map(d=>({id:`synthetic-calibration:${d.id}`,dutyId:d.id,dutyRevision:d.revision,kind:"method_assurance",conclusion:"supported",subject:candidate.digest,
      dependencies:original.source.dependencies,evidence:["controlled fixture preserves blue"],limitations:["Controlled evidence, not a real model semantic quality claim"]}));
    const assessment=h.assessHelarcResponsesCompact({source:original.source,candidate,findings});assert.equal(assessment.quality.allowed,true);
    const publication=await h.retainHelarcResponsesCompactMaterial({materials:store.materialCustody,representations:store.representations,acceptance:store.sharedAcceptance,
      source:original.source,candidate,owner:crm,purpose:"task",activityId:"compact",observationId:terminal.ref.id,occurredAt:at,sources:[original.original],
      sourceAdmissions:require("./native-compact-material-admissions.cjs")({source:original.source,sources:[original.original],owner:crm,purpose:"task",digest}),
      confirmation:{rawRevision:"1",acceptanceId:"compact-accepted",acceptanceRevision:"1"}});
    const judgment=await h.retainHelarcResponsesCompactAssessment({catalog:store.representations,assessment,record:publication.record,observationId:terminal.ref.id});
    const checked=await retain("check",{assessment,publication,judgment},fence,[saved.input,terminal.content],[{activityId:"compact",ref:terminal.ref}]);
    await crash({lostAcknowledgement:"check retained",assessment:assessment.id,checkContent:checked.content.id,unknownNotAdopted:true,forgedProvenanceRejected:true,publicationRolledBack:true});
  }
  const checked=await load("check");
  assert.deepEqual(await h.retainHelarcResponsesCompactAssessment({catalog:store.representations,assessment:checked.assessment,record:checked.publication.record,observationId:terminal.ref.id}),checked.judgment);
  const contextScope={id:"root-task",runId:"root",recipient:"task",purpose:"task",owner:crm,continuity:"task",target:"fixture-config:1",authorityBasis:"original-disclosure"};
  if(phase==="receive"||phase==="adopt"){
    const tail=await publish("late-child",[{role:"user",content:"Child delivered its result. User correction: keep blue, choose the smaller shape."}],"child");
    const suffix={id:"late-child",representation:tail.record.ref,sources:["late-child:source"],holds:[tail.holds[0].id],deliveries:[],requires:[],items:tail.items,replay:"local"};
    const current=native.bindNativeInputManifest({...original.source.manifest,groups:[...original.source.manifest.groups,suffix]});
    const props={source:original.source,candidate,assessment:checked.assessment,current,dependencies:original.source.dependencies,
      group:{id:"compacted",representation:checked.publication.record.ref,holds:[checked.publication.hold.id],observation:terminal.ref.id}};
    for(const field of ["authority","requirements","target","recipient","source"])assert.throws(()=>h.helarcResponsesCompactedGroups({...props,dependencies:{...props.dependencies,[field]:"changed"}}),/not_applicable/);
    const groups=h.helarcResponsesCompactedGroups(props);assert.deepEqual(groups[0].items,candidate.items);assert.deepEqual(groups[1],suffix);
    const prior=await require("./native-compact-sources.cjs")({store,h,retained:original.retained,at});
    const method=await require("./native-compact-work.cjs")({store,h,native,source:original.source,original:original.original,retained:original.retained,
      publications:prior.publications,session,custody,activity:a,endpoint,at,digest,ref});
    const working=new h.HelarcNativeWorkingInput();
    for(const g of original.retained.workingSources.groups){const {occurrence,...basis}=g;
      working.append(original.retained.manifest.groups.flatMap(g=>g.items).slice(occurrence.start,occurrence.start+occurrence.count),basis);}
    working.append(tail.items,{id:"late-child",originRunId:"child",sources:[{source:{owner:"child",kind:"result",...ref("late-child")},position:""}],
      duties:["new_information","evidence"],preservation:{obligations:[{id:"late-child",requirement:"exact",basis:"Unseen Child result and user correction"}],relationships:[]},
      exchangeId:null,protection:["first_delivery"],acceptedBy:null,representations:[]});
    const history=await publish("current-history",working.items);
    const manifest=native.bindNativeInputManifest({...original.retained.manifest,groups:[{...original.retained.manifest.groups[0],
      representation:history.record.ref,holds:[history.holds[0].id],items:working.items}],selection:{...original.retained.manifest.selection,boundary:"late-child:1"}});
    const previous={scope:manifest.scope,target:manifest.target,revision:1,policy:"persistent_chain",generation:1,pending:null,
      response:{id:"old-response",coverage:original.source.groups.map(({id,digest})=>({id,digest})),observation:"original-reply",replayDigest:"old"}};
    const conditions={basis:"checked transformation adoption",authorized:true,disclosureRevision:"original-disclosure",remoteStorage:true,targetSupport:"established",
      predecessor:"available",reestablish:true,policyChange:false};
    const prepared=native.prepareResponses({...original.request,input:working.items});
    const retained={...original.retained,manifest,wire:{body:prepared.encoded,digest:prepared.digest},workingSources:working.snapshot(),
      continuity:{kind:"responses",policy:"persistent_chain",previous,conditions}};
    const sources=await require("./native-compact-sources.cjs")({store,h,retained,at});
    const ports={methods:method.methods,journal,materials:store.materialCustody,representations:store.representations};
    const input={original:retained,publications:sources.publications,methodPathId:method.pathId,scope:contextScope,activityId:"successor",
      inputId:"adopted-input",selectionId:"compacted-selection",maximumReadBytes:8*1024*1024,
      capacity:{limits:[{id:"request-bytes",targetRevision:contextScope.target,dimension:"request_bytes",maximum:8*1024*1024,source:"controlled"}],
        reservations:[],policy:{id:"fixture",revision:"1",purpose:"task",basis:"Controlled whole input",allowUnknown:false,allowEstimatedFit:false},maximumCombinations:1,maximumMeasurements:0}};
    const signal=new AbortController().signal;
    const rejected=await h.prepareHelarcResponsesCompactReception({...input,capacity:{...input.capacity,limits:[{...input.capacity.limits[0],maximum:1}]}},ports,signal);
    assert.equal(rejected.kind,"unavailable");assert.equal(rejected.reason,"recipient_input_capacity_unavailable");
    await assert.rejects(()=>store.contextSelections.command({kind:"binding",inputId:input.inputId,checkCurrentControl:false}),/input_binding_missing/);
    await assert.rejects(()=>h.prepareHelarcResponsesCompactReception({...input,scope:{...contextScope,recipient:"other"}},ports,signal),/scope_changed/);
    await assert.rejects(()=>h.prepareHelarcResponsesCompactReception({...input,maximumReadBytes:1},ports,signal),/output_unavailable/);
    const received=await require("./native-compact-reception-work.cjs")({store,h,input,history:{record:history.record,hold:history.holds[0]},
      method,activity:activity("successor",ref("task")),at,phase,checkpoint:crash});
    const reception=received.reception;
    assert.equal(reception.kind,"ready");assert.equal(reception.readiness.allowed,true);
    assert.deepEqual(reception.selected.manifest.groups[0].items,candidate.items);assert.deepEqual(reception.selected.manifest.groups[1].items,tail.items);
    assert.equal(reception.selected.workingSources.groups.at(-1).acceptedBy,null);
    const {adoption,receipt}=received;
    assert.equal(await store.activityHandoffs.command({kind:"read_stage",requestId:"input-stage"}),null);
    await retain("adoption",{proposal:adoption,receipt,receivingWork:received.verification},fence,[saved.input,terminal.content]);
    await crash({lostAcknowledgement:"selection and successor input",newGeneration:2,lateChildPreserved:true,staleControlRejected:true});
  }
  const adoption=await load("adoption");assert.deepEqual(await store.sharedAcceptance.accept(adoption.proposal),adoption.receipt);
  const accepted=await store.contextSelections.command({kind:"binding",inputId:"adopted-input",checkCurrentControl:true}),next=accepted.input.exactInput;
  assert.equal(next.predecessor,null);assert.deepEqual(next.manifest.groups[0].items,candidate.items);assert.match(next.manifest.groups[1].items[0].content,/Child delivered/);
  const realized=native.realizeResponsesInput({manifest:next.manifest,request:original.request,...next.continuity});
  assert.equal(realized.next.generation,2);assert.equal(realized.prepared.digest,next.wire.digest);
  if(phase==="use"){
    const activityId="successor",task=activity(activityId,ref("task")),input=await content("successor-input",activityId,next);
    await accept("successor:prepare","execution-coordinator",[part("prepare",{activity:task,input})]);const tf=await claim(activityId);
    const dispatch={ref:ref("successor-dispatch"),activityId,operationId:"successor",kind:"dispatch_intent",content:input,source:null,dependencies:[]};
    await accept("successor:dispatch",owner,[part("record",{record:dispatch,fence:tf})]);
    const http=await native.dispatchResponses(realized.prepared,{baseUrl:endpoint,apiKey:"synthetic"},{signal:AbortSignal.timeout(15000),retainChunk:async()=>{}});
    const raw=native.readResponsesObservation(http),output=await content("successor-result",activityId,raw);
    const record={ref:ref("successor-response"),activityId,operationId:"successor",kind:"observation",content:output,
      source:{scope:task.scope,protocol:model.OPENAI_RESPONSES,interpretation:native.OPENAI_RESPONSES_ADAPTER,operationId:"successor",record:ref("successor-response"),
        position:{format:"json-pointer",value:""},nativeIdentity:{kind:"response",id:raw.id}},dependencies:[dispatch.ref]};
    await accept("successor:observed",owner,[part("record",{record,fence:null})]);
    await crash({successorResponse:raw.id,wholeWindowUsed:true});
  }
  if(phase==="internal"||phase==="internal-effect"){
    const ia=activity("internal",ref("task")),iscope={...scope,id:"internal-scope",recipientId:"task",purpose:ref("task")};
    if(phase==="internal"){
      const definition={name:"Write_a1",description:"Write a synthetic file",inputSchema:{type:"object",properties:{path:{type:"string"}},required:["path"],additionalProperties:false}};
      const request={model:"fixture-model",purpose:ref("task"),stream:true,store:true,tools:[definition],context_management:[{type:"compaction",compact_threshold:1000}]};
      const prepared=native.prepareResponses({...request,input:next.manifest.groups.flatMap(g=>g.items)}),settings=native.nativeInputSettings(prepared.body);
      const oldSelection=adoption.proposal.parts.find(p=>p.owner==="context_selection"&&p.kind==="selection_input").proposal;
      const inputHolds=oldSelection.input.holds.map((hold,i)=>({...hold,id:`internal-input:${i}`,basis:"internal-input"}));
      const mappedHolds=new Map(oldSelection.input.holds.map((hold,i)=>[hold.id,inputHolds[i].id]));
      const holds=oldSelection.selection.holds.map((hold,i)=>({...hold,id:`internal-selection:${i}`,basis:"internal-selection"}));
      const manifest=native.bindNativeInputManifest({...next.manifest,groups:next.manifest.groups.map(g=>({...g,holds:g.holds.map(id=>mappedHolds.get(id))})),settings,
        settingSources:Object.keys(settings).map(field=>({field,source:"accepted-internal-settings",digest:digest(settings[field])})),
        selection:{id:"internal-selection",revision:"1",boundary:"same-content-new-request",judgments:["internal-combination"]}});
      const duties=[{id:"option",revision:"1",requirement:"semantic",permittedEvidence:["method_assurance"]}],dependencies={recipient:manifest.scope.id,source:manifest.digest,
        target:manifest.target.configuration,authority:manifest.target.disclosure,requirements:digest(duties),method:"openai.responses.context_management.compaction:1"};
      const agreement=h.bindHelarcResponsesCompactionAgreement({manifest,body:prepared.body,dependencies,duties,
        findings:[{id:"internal-assurance",dutyId:"option",dutyRevision:"1",kind:"method_assurance",conclusion:"supported",subject:prepared.digest,dependencies,
          evidence:["controlled synthetic response"],limitations:["Not real model quality evidence"]}],
        threshold:{tokens:1000,basis:"controlled measurement",window:32000,headroom:4000,
          measurement:{id:"controlled-count",requestDigest:prepared.digest,coverage:"complete",tokens:1200,unknowns:[],acceptedUncertainty:null}},
        retentionBasis:"whole input and original result",recoveryBasis:"original enclosing response"});
      const nativeValue={...next,manifest,wire:{body:prepared.encoded,digest:prepared.digest},compactionAgreement:agreement,
        continuity:{...next.continuity,previous:null}};
      const priorJudgment=await store.representations.command({kind:"read_judgment",id:next.manifest.selection.judgments[0]});
      const judgment={...priorJudgment,id:"internal-combination",dependencies:{inputDigest:digest(nativeValue)}};
      await store.representations.command({kind:"judge",judgment});
      const {ActivityPurposeRegistry}=await import("@agent-anything/agent-runtime/activity"),registry=new ActivityPurposeRegistry(),unused=async()=>{throw new Error("No fixture activity execution");};
      const purpose=registry.register({ref:ref("internal-task-input"),inputOwner:crm,executionOwner:owner,interpretationOwner:crm,acceptanceOwner:crm,recoveryOwner:crm,
        stageKinds:["model"],capabilities:["model-access"],continuationKinds:[]},{authorize:unused,execute:unused,reconcile:unused,interpret:unused});
      await store.activityHandoffs.command({kind:"open_path",intent:{id:"internal-path",runId:"root",owner:crm,purpose,permissionBasis:"original-disclosure",resourceScope:"internal-path",
        maximumStages:1,maximumAttempts:1,maximumConcurrent:1,deadlineAt:"2030-01-01T00:00:00Z"}});
      const args={id:"internal-selection-acceptance",scope:contextScope,expectedSelectionId:"compacted-selection",expectedControlRevision:0,retainedSelectionId:null,
        selection:{id:"internal-selection",representations:manifest.groups.map(g=>g.representation),judgmentIds:[judgment.id],holds},native:nativeValue,judgment,
        inputId:"internal-input",activityId:"internal-path",stageRequestId:"internal-stage",stageKind:"model",capabilities:["model-access"],inputHolds,releaseHolds:[]};
      const {compactionAgreement,...unauthorized}=nativeValue;
      assert.throws(()=>h.helarcNativeInputAcceptance({...args,native:unauthorized}),/agreement_missing/);
      const receipt=await store.sharedAcceptance.accept(h.helarcNativeInputAcceptance(args));assert.equal(receipt.outcome,"accepted",JSON.stringify(receipt));
      const base={scope:ia.scope,protocol:model.OPENAI_RESPONSES,adapter:native.OPENAI_RESPONSES_ADAPTER,interpreter:h.HELARC_NATIVE_TASK_INTERPRETER,
        acceptance:ref("internal-purpose"),requestId:"internal-request",controllerRequestId:"internal-decision",operationId:"internal-session:operation:1",record:ref("internal-terminal"),
        catalog:[{definition,binding:{kind:"tool",callableName:"Write_a1",toolName:"Write",tool:{tool:{namespace:"fixture",name:"Write"},revision:"1"},
          binding:{kind:"operation",operation:{operation:{namespace:"fixture",name:"write"},revision:"1"},revision:"1"}}}],schemaMode:"responses-strict",hasPlan:false,
        planLimits:{maxSteps:20,maxStepLength:1000,maxExplanationLength:2000}};
      const binding={...base,catalogRevision:h.nativeTaskCatalog(base).revision};
      const session={id:"internal-session",scopeId:iscope.id,target:"fixture-config:1",prepared,profile:{transport:"http",background:false,stream:true,store:true,
        temporaryRetention:false,continuity:"persistent_chain",connectionIncarnation:null},policy:native.DEFAULT_RESPONSES_OBSERVATION_POLICY,
        createdAt:Date.now(),deadlineAt:Date.now()+60000,maximumBytes:8*1024*1024,maximumFrameBytes:4*1024*1024,maximumEvents:1000};
      const input=await content("internal-original","internal",{format:"helarc.native-prepared-task.v1",binding,wire:nativeValue.wire,previous:null,selectedInputId:"internal-input",session});
      await accept("internal-prepare","execution-coordinator",[part("prepare",{activity:ia,input}),part("evidence_scope",{activityId:"internal",scope:iscope})]);
    }
    const s=await state("internal"),prepared=await read(s.input),f=await claim("internal");
    const storage=new h.HelarcResponsesSessionStore({id:prepared.session.id,journal,acceptance:store.sharedAcceptance,scope:iscope,fence:f,
      original:[s.input],maximumSegmentBytes:16*1024*1024,observe:w=>work.push(w)});
    const transport=await native.ResponsesSession.open(prepared.session,storage);
    if(phase==="internal"){
      await transport.step({now:()=>Date.now(),jitter:()=>0.5,target:"fixture-config:1",baseUrl:endpoint,headers:{"content-type":"application/json"},
        signal:AbortSignal.timeout(10000),authorize:async()=>{}});
      assert.equal(transport.snapshot().disposition,"terminal");await storage.retainTerminal(transport,prepared.binding.record);
      assert.equal(await journal.command({kind:"acceptance",activityId:"internal"}),null);
      await crash({originalInternalResponseRetained:true,acceptedBeforeDispatch:true,effectsBeforePurposeAcceptance:0});
    }
    const recovered=await h.recoverHelarcNativeTask({journal,activity:ia,observation:prepared.binding.record,interpret:h.interpretHelarcResponses,
      validateOriginalInput:h.validateHelarcResponsesTaskInput,contextSelections:store.contextSelections});
    assert.equal(recovered.kind,"advance");assert.equal(recovered.calls.length,1);
    const result=await content("internal-purpose-result","internal",recovered),call=recovered.calls[0].call,callId=call.modelCallRef.id;
    await accept("internal-purpose-accepted",h.HELARC_NATIVE_TASK_INTERPRETER.id,[part("purpose",{fence:f,acceptance:{evidence:recovered.evidence,result,effects:[{call,owner:"fixture-effect"}],deliveries:[]}})]);
    await accept("internal-effect-dispatched","fixture-effect",[part("effect_dispatch",{fence:f,callId})]);
    await appendFile(join(directory,"effect-attempts"),"1\n");await writeFile(join(directory,"one.txt"),"One accepted effect after internal compaction",{flag:"wx"});
    const output=await content("internal-effect-result","internal",{written:true});
    await accept("internal-effect-confirmed","fixture-effect",[part("effect_confirmation",{activityId:"internal",callId,dispatchBasis:"intent_recorded",confirmation:ref("effect-confirmed"),result:output,deliveries:[]})]);
    await crash({internalResponseReused:true,localEffectCount:1,callId});
  }
  if(phase!=="verify")throw new Error(`Unknown phase ${phase}`);
  const internal=await journal.command({kind:"acceptance",activityId:"internal"});assert(internal);
  const effect=await journal.command({kind:"effect",activityId:"internal",callId:internal.effects[0].call.modelCallRef.id});
  assert.deepEqual(effect.confirmation,ref("effect-confirmed"));assert.equal(await readFile(join(directory,"effect-attempts"),"utf8"),"1\n");
  const successor=await journal.command({kind:"record",activityId:"successor",ref:ref("successor-response")});assert(successor);
  assert.equal((await read(successor.content)).id,"response-after-compact");
  const secondManifest=native.bindNativeInputManifest({...next.manifest,groups:[next.manifest.groups[0]]});
  const secondCoverage=[{id:secondManifest.groups[0].id,digest:native.nativeInputGroupDigest(secondManifest.groups[0]),deliveredBasis:successor.ref.id}];
  const secondSource=h.bindHelarcResponsesCompactSource({manifest:secondManifest,throughGroups:1,receipts:[{groupId:secondManifest.groups[0].id,basis:successor.ref.id}],
    dependencies:{...original.source.dependencies,source:digest(secondCoverage)},duties:original.source.duties,purpose:ref("compact"),ancestry:[checked.publication.record.ref.id]});
  const secondActivity=activity("second-compact"),secondScope={...scope,id:"second-compact-scope"};
  const secondBinding={...original.binding,id:"second-compact",prepared:secondSource.methodRequest,sourceDigest:secondSource.sourceDigest,startedAt:Date.now(),deadlineAt:Date.now()+60000};
  const secondInput=await content("second-compact-input","second-compact",{source:secondSource,binding:secondBinding});
  await accept("second-compact:prepare","execution-coordinator",[part("prepare",{activity:secondActivity,input:secondInput}),part("evidence_scope",{activityId:"second-compact",scope:secondScope})]);
  const secondFence=await claim("second-compact"),secondStore=new h.HelarcResponsesCompactStore({id:secondBinding.id,journal,acceptance:store.sharedAcceptance,scope:secondScope,
    fence:secondFence,original:[secondInput],maximumBytes:16*1024*1024,observe:w=>work.push(w)});
  const second=await native.ResponsesCompactSession.open(secondBinding,secondStore);
  await second.execute({now:Date.now(),authorize:async()=>true,dispatch:async()=>({status:200,headers:{},frames:[],body:JSON.stringify({...candidate.raw,id:"second-compact-resource"})})});
  const secondTerminal=await secondStore.retainTerminal(second,ref("second-compact-terminal"));
  await accept("second-compact-purpose",crm,[part("purpose",{fence:secondFence,acceptance:{evidence:{scope:secondActivity.scope,interpreter:ref(crm),acceptance:ref("second-compact-accepted"),sources:[secondTerminal.source]},
    result:secondTerminal.content,effects:[],deliveries:[]}})]);
  const twice=await h.retainHelarcResponsesCompactMaterial({materials:store.materialCustody,representations:store.representations,acceptance:store.sharedAcceptance,
    source:secondSource,candidate:second.candidate(),owner:crm,purpose:"task",activityId:"second-compact",observationId:secondTerminal.ref.id,occurredAt:at,
    sourceAdmissions:require("./native-compact-material-admissions.cjs")({source:secondSource,sources:[{record:checked.publication.record,holds:[checked.publication.hold,original.original.holds[0]]}],owner:crm,purpose:"task",digest}),
    sources:[{record:checked.publication.record,holds:[checked.publication.hold,original.original.holds[0]]}],confirmation:{rawRevision:"1",acceptanceId:"second-compact-accepted",acceptanceRevision:"1"}});
  for(const loss of checked.publication.record.losses)assert(twice.record.losses.some(l=>digest(l)===digest(loss)));
  assert(twice.record.details.some(r=>digest(r)===digest(original.original.record.body)));
  const originalBytes=h.helarcNativeSourceBytes(original.retained.workingSources.groups[0],original.retained.manifest.groups[0].items);
  const detailOffset=originalBytes.indexOf(Buffer.from("selected option is blue"));assert(detailOffset>=0);
  const detailPage=await store.materialCustody.command({kind:"read",access:{id:"precise-original-detail",holdId:original.original.holds[0].id,recipient:original.original.holds[0].consumer,
    range:original.original.record.body},offset:detailOffset,length:64});assert.match(detailPage.text,/selected option is blue/);
  const faultEvidence=[];
  for(const mode of ["save-failure","cancel-race","unknown"]){
    const id=`fault:${mode}`,fa=activity(id),fscope={...scope,id:`${id}:scope`};
    const binding={...original.binding,id,startedAt:Date.now(),deadlineAt:Date.now()+60000};
    const input=await content(`${id}:input`,id,binding);
    await accept(`${id}:prepare`,"execution-coordinator",[part("prepare",{activity:fa,input}),part("evidence_scope",{activityId:id,scope:fscope})]);
    const ff=await claim(id);let injected=false,dispatches=0;
    const faultAcceptance={query:id=>store.sharedAcceptance.query(id),accept:async proposal=>{
      if(!injected&&proposal.parts.some(p=>p.kind==="evidence"&&p.proposal.evidence.metadata.status==="observed")){
        injected=true;
        if(mode==="save-failure")throw new Error("injected-original-save-failure");
        if(mode==="cancel-race")await accept(`${id}:cancel`,"execution-coordinator",[part("control",{activityId:id,expectedRevision:0,cancelled:true})]);
      }
      return store.sharedAcceptance.accept(proposal);
    }};
    const options={id,journal,acceptance:faultAcceptance,scope:fscope,fence:ff,original:[input],maximumBytes:16*1024*1024,observe:w=>work.push(w)};
    let fs=new h.HelarcResponsesCompactStore(options),f=await native.ResponsesCompactSession.open(binding,fs);
    const observation={status:200,headers:{},body:JSON.stringify(candidate.raw),frames:[]};
    await assert.rejects(()=>f.execute({now:Date.now(),authorize:async()=>true,dispatch:async()=>{
      dispatches++;if(mode==="unknown")throw new Error("original remote outcome unknown");return observation;
    }}),mode==="save-failure"?/injected-original-save-failure/:mode==="cancel-race"?/fenced|retained/:/outcome unknown/);
    if(mode!=="unknown")assert.throws(()=>f.candidate(),/reload_required/);
    const latest=await state(id);fs=new h.HelarcResponsesCompactStore({...options,acceptance:store.sharedAcceptance,fence:latest.fence});
    f=await native.ResponsesCompactSession.open(binding,fs);
    if(mode==="save-failure"){
      await f.retainObservation(observation);assert.equal(f.snapshot().status,"observed");assert.deepEqual(f.candidate().items,candidate.items);
    }else if(mode==="cancel-race"){
      const recorded=[];let after=0;
      while(true){const page=await journal.command({kind:"facts",runId:"root",after,limit:128});if(!page.length)break;recorded.push(...page);after=page.at(-1).sequence;}
      assert(recorded.some(v=>v.activityId===id&&v.kind==="observation"&&v.value.ref.id.includes(":late:")));
      assert.equal(f.snapshot().status,"dispatched");await f.cancel("accepted-cancellation");await f.retainObservation(observation);
      const cancelledResult=await fs.retainTerminal(f,ref(`${id}:terminal`));
      const cancelledSubmission={...submission,id:`${id}:work`,scope:fa.scope};
      const cancelledUsage=native.responsesCompactAccounting({session:f,submission:cancelledSubmission,source:cancelledResult.source,observedAt:at});
      await h.retainHelarcNativeWork({journal,acceptance:store.sharedAcceptance,scope:fscope,fence:latest.fence,expectedRevision:null,state:cancelledUsage,
        submissionId:cancelledSubmission.id,cost:null,references:[input,cancelledResult.content],dependencies:[{activityId:id,ref:cancelledResult.ref}]});
      const page=await h.readHelarcNativeWorkPage({journal,activityId:id,scopeId:fscope.id,afterKey:null,limit:1});
      assert.equal(page.entries[0].inputTokens,12000);assert.equal(page.entries[0].operation,"compact");
      assert.equal(await journal.command({kind:"acceptance",activityId:id}),null,"Cancelled observed work is not a locally accepted task");
    }else assert.equal(f.snapshot().status,"unknown");
    await assert.rejects(()=>f.execute({now:Date.now(),authorize:async()=>true,dispatch:async()=>{dispatches++;return observation;}}),/not_dispatchable/);
    assert.equal(dispatches,1);faultEvidence.push({mode,dispatches,status:f.snapshot().status,cancelled:f.snapshot().cancelled});
  }
  const before=await readFile(join(directory,"execution/body-reads.ndjson"),"utf8"),reads=calls.content_read??0;
  for(let i=0;i<32;i++){assert.equal((await custody.observe()).metadata.status,"observed");await state("compact");}
  const {ProtocolJournalInspectionAdapter}=await import(pathToFileURL(join(__dirname,"../../dist/main/inspection/ProtocolJournalInspectionAdapter.js")));
  const offers=[];await new ProtocolJournalInspectionAdapter({ref:(owner,kind,id,runId,revision=null)=>({owner,kind,id,runId,revision}),offer:v=>offers.push(v)})
    .replay((after,limit)=>journal.command({kind:"facts",runId:"root",after,limit}));
  assert.equal(calls.content_read??0,reads);assert.equal(await readFile(join(directory,"execution/body-reads.ndjson"),"utf8"),before);
  assert(offers.some(o=>JSON.stringify(o).includes("transformation")));assert(!JSON.stringify(offers).includes("Historical discussion."));
  const sources=await require("./native-compact-sources.cjs")({store,h,retained:original.retained,at});
  await require("./native-compact-work.cjs")({store,h,native,source:original.source,original:original.original,retained:original.retained,
    publications:sources.publications,session,custody,activity:a,endpoint,at,digest,ref,closeProduction:true});
  const sourceReader=original.original.holds[0].consumer;
  const detail=await store.materialCustody.command({kind:"describe",holdId:original.original.holds[0].id,recipient:sourceReader});assert(detail);
  await accept("cancel-original","execution-coordinator",[part("control",{activityId:"compact",expectedRevision:0,cancelled:true})]);
  const guarded=await store.sharedAcceptance.accept({id:"cancelled-readiness",scope:"root",actor:crm,
    parts:[adoption.proposal.parts.find(p=>p.owner==="protocol_execution"&&p.kind==="require_accepted_result")]});
  assert.equal(guarded.outcome,"rejected");
  assert.deepEqual(await store.sharedAcceptance.accept(adoption.proposal),adoption.receipt,"Past acceptance is not undone or executed again");
  const access={id:"original-detail-access",holdId:original.original.holds[0].id,recipient:sourceReader,range:original.original.record.body};
  await assert.rejects(()=>store.materialCustody.command({kind:"read",access:{...access,recipient:{...sourceReader,runId:"sibling"}},offset:0,length:64}),/material_hold_missing/);
  await store.materialCustody.command({kind:"grant",grant:{...original.original.grant,revision:1,allowed:false},expectedRevision:0});
  await assert.rejects(()=>store.materialCustody.command({kind:"read",access,offset:0,length:64}),/unavailable/);
  await evidence({metadataRefreshes:32,metadataBodyReads:0,inspectorOffers:offers.length,originalDetailsRetained:true,cancelledAdoptionRejected:true,
    wrongRecipientRejected:true,revokedDetailAccessRejected:true,receivingWork:adoption.receivingWork,
    originalResultReused:true,assessmentReused:true,selectionReused:true,wholeWindow:true,lateChild:true,faultEvidence,
    repeatedConversion:{ancestry:secondSource.ancestry,inheritedLosses:checked.publication.record.losses.length,originalDetailRead:true}});
  await store.close();store=null;app.exit(0);
}
app.whenReady().then(main).catch(async error=>{
  const {captureExecutionError}=await import(pathToFileURL(join(__dirname,"../../dist/main/diagnostics/ExecutionErrorDetails.js")));
  await writeFile(join(directory,`failure-${phase}.txt`),JSON.stringify(captureExecutionError(error),null,2));
  await store?.close().catch(()=>{});app.exit(1);});
