const {app}=require("electron");
const assert=require("node:assert/strict");
const {join}=require("node:path");
const {pathToFileURL}=require("node:url");
const {readFile,writeFile}=require("node:fs/promises");
const [directory,phase,settingsPath]=process.argv.slice(2);
app.setPath("userData",join(directory,"electron"));app.disableHardwareAcceleration();
const ref=id=>({id,revision:"1"}),part=(kind,proposal)=>({owner:"protocol_execution",kind,proposal});
let store;
async function main(){
  const settings=JSON.parse(await readFile(settingsPath,"utf8"));assert.equal(settings.live,true);
  const native=await import("@agent-anything/provider-integrations/native"),runtime=await import("@agent-anything/agent-runtime/model-access");
  const model=await import("@agent-anything/model-interaction/protocol"),h=await import("@agent-anything/helarc/controller");
  const {modelInputValueDigest:digest}=await import("@agent-anything/model-interaction/input");
  const moduleAt=file=>import(pathToFileURL(join(__dirname,"../../dist/main",file)));
  const {NativeWindowsCredentialBackend}=await moduleAt("provider/WindowsCredentialBackend.js");
  const secret=await new NativeWindowsCredentialBackend().read(settings.credentialTarget,settings.encoding??"utf16le");
  assert(secret,"Protected credential unavailable");
  const connection={baseUrl:settings.baseUrl,apiKey:secret};
  const {HelarcExecutionStore}=await moduleAt("execution-storage/HelarcExecutionStore.js");
  store=await HelarcExecutionStore.open(join(directory,"execution"));const journal=store.protocolJournal,work=[];
  const content=(id,activityId,value)=>runtime.retainProtocolContent(journal,id,activityId,Buffer.from(JSON.stringify(value)),w=>work.push(w));
  const read=async ref=>JSON.parse((await runtime.readProtocolContent(journal,ref,ref.activityId,16*1024*1024,w=>work.push(w))).toString());
  const owner=native.OPENAI_RESPONSES_ADAPTER.id,purpose=ref("context-probe"),interpreter=ref("live-probe-evaluator");
  const composition=model.bindModelAgentComposition({agent:ref("live-compaction-probe"),protocol:model.OPENAI_RESPONSES,
    configuration:{configuration:ref("frozen-live-settings"),protocol:model.OPENAI_RESPONSES,model:settings.model,connectionBinding:ref("original-protected-target")},
    adapter:{implementation:native.OPENAI_RESPONSES_ADAPTER,protocol:model.OPENAI_RESPONSES},
    task:{purpose,input:{implementation:ref("probe-input"),protocol:model.OPENAI_RESPONSES},interpreter:{implementation:interpreter,protocol:model.OPENAI_RESPONSES}},auxiliary:[]});
  const activity=id=>runtime.bindProtocolModelActivity({composition,scope:{runId:"live",activityId:id,recipientId:"probe",purpose,compositionDigest:composition.digest},
    conditions:{input:ref(`${id}:input`),authority:ref("user-authorized-synthetic-only"),resources:ref("bounded-live-probe"),control:ref("original-control")}});
  const accept=async(id,actor,parts)=>{const r=await store.sharedAcceptance.accept({id,actor,scope:"live",parts});assert.equal(r.outcome,"accepted",JSON.stringify(r));return r;};
  const scope=id=>({id:`${id}:scope`,runId:"live",recipientId:"probe",purpose,compositionDigest:composition.digest,owner});
  const prepare=async(id,value)=>{const input=await content(`${id}:original`,id,value);await accept(`${id}:prepare`,"execution-coordinator",[part("prepare",{activity:activity(id),input}),part("evidence_scope",{activityId:id,scope:scope(id)})]);return input;};
  const claim=async id=>{let s=await journal.command({kind:"state",activityId:id});assert(s);assert.equal(s.activity.composition.digest,composition.digest);
    if(s.fence.generation!==store.generation||s.fence.epoch===0){await accept(`${id}:claim:${store.generation}`,owner,[part("claim",{activityId:id,expectedEpoch:s.fence.epoch})]);s=await journal.command({kind:"state",activityId:id});}return s;};
  const evidence=async extra=>writeFile(join(directory,`${phase}.json`),JSON.stringify({phase,pid:process.pid,electron:process.versions.electron,generation:store.generation,
    endpoint:settings.baseUrl,model:settings.model,credentialCustody:"existing Windows credential read in each process; no secret copy",optionalInstructions:false,work,...extra},null,2));
  const saveUsage=async(id,raw,record,fence,input,operation)=>{
    const submission={id,protocol:model.OPENAI_RESPONSES,scope:activity(id).scope,endpoint:settings.baseUrl,account:"original-protected-target",operation,
      submittedAt:new Date().toISOString(),model:settings.model,requestedTier:null,reportedTier:null,region:null,modality:"text",reconciliationOwner:owner,beneficiaries:["live"],stage:null};
    let state=native.applyNativeAccountingCommand(native.createNativeAccountingState(),{id:`${id}:register`,kind:"register",submission});
    state=native.applyNativeAccountingCommand(state,{id:`${id}:remote`,kind:"bind_remote",submissionId:id,remote:{kind:raw.object,id:raw.id},evidence:record.source});
    state=native.applyNativeAccountingCommand(state,{id:`${id}:usage`,kind:"observe",observation:{id:`${id}:usage`,submissionId:id,source:{...record.source,position:{format:"json-pointer",value:"/usage"}},
      receivedAt:new Date().toISOString(),channel:"create",finality:"terminal",authority:"OpenAI",revisionDomain:raw.id,cumulativeRevision:null,
      profile:{kind:"openai.responses",revision:"1",cacheWrites:"not_applicable",basis:ref("native-usage")},usage:raw.usage??{}}});
    await h.retainHelarcNativeWork({journal,acceptance:store.sharedAcceptance,scope:scope(id),fence,expectedRevision:null,state,submissionId:id,cost:null,
      references:[input,record.content],dependencies:[{activityId:id,ref:record.ref}]});
  };
  const text=raw=>raw.output.filter(i=>i.type==="message").flatMap(i=>i.content??[]).filter(p=>p.type==="output_text").map(p=>p.text).join("\n");
  async function response(id,prepared,agreement=null){
    const existing=await journal.command({kind:"state",activityId:id}),retained=existing?await read(existing.input):null;
    if(retained){assert.equal(digest(retained.prepared),digest(prepared));assert.equal(digest(retained.agreement),digest(agreement));}
    const sessionBinding=retained?.sessionBinding??{id:`${id}:session`,scopeId:scope(id).id,target:digest({endpoint:settings.baseUrl,model:settings.model}),prepared,
      profile:{transport:"http",background:false,stream:prepared.body.stream,store:prepared.body.store,temporaryRetention:false,
        continuity:prepared.body.store?"persistent_chain":"native_replay",connectionIncarnation:null},
      policy:native.DEFAULT_RESPONSES_OBSERVATION_POLICY,createdAt:Date.now(),deadlineAt:Date.now()+90000,maximumBytes:16*1024*1024,maximumFrameBytes:8*1024*1024,maximumEvents:10000};
    const original=existing?existing.input:await prepare(id,{prepared,agreement,sessionBinding,endpoint:settings.baseUrl,model:settings.model}),s=await claim(id);
    const storage=new h.HelarcResponsesSessionStore({id:sessionBinding.id,journal,acceptance:store.sharedAcceptance,scope:scope(id),fence:s.fence,
      original:[original],maximumSegmentBytes:32*1024*1024,observe:w=>work.push(w)});
    const session=await native.ResponsesSession.open(sessionBinding,storage);
    if(session.snapshot().disposition!=="terminal")await session.step({now:()=>Date.now(),jitter:()=>0.5,target:sessionBinding.target,baseUrl:settings.baseUrl,
      headers:{authorization:`Bearer ${secret}`,"content-type":"application/json"},signal:AbortSignal.timeout(90000),authorize:async()=>{}});
    assert.equal(session.snapshot().disposition,"terminal",JSON.stringify({state:session.snapshot()}));
    const raw=session.response();assert(raw);const record=await storage.retainTerminal(session,ref(`${id}:terminal`));
    await saveUsage(id,raw,record,s.fence,original,"generation");return {raw,record,head:session.snapshot(),binding:sessionBinding};
  }
  if(phase==="compact"){
    const items=[{role:"user",content:"We are designing a fictional exhibit. Keep the final decisions for a later question."},
      {role:"assistant",content:Array.from({length:100},(_,i)=>`Discussion ${i+1}: We considered independent decorative options. Only the final decision governs the exhibit.`).join("\n")+
        "\nFinal decisions: the name is Lumen, the material is copper, and the side count is seven."}];
    const prepared=native.prepareResponsesCompact({model:settings.model,input:items,purpose});
    const binding={id:"live-compact",prepared,sourceDigest:digest(items),target:digest({endpoint:settings.baseUrl,model:settings.model}),disclosure:"synthetic-only",
      startedAt:Date.now(),deadlineAt:Date.now()+90000,maximumBytes:16*1024*1024};
    const input=await prepare("compact",{binding,endpoint:settings.baseUrl,model:settings.model}),s=await claim("compact");
    const custody=new h.HelarcResponsesCompactStore({id:binding.id,journal,acceptance:store.sharedAcceptance,scope:scope("compact"),fence:s.fence,original:[input],maximumBytes:32*1024*1024,observe:w=>work.push(w)});
    const session=await native.ResponsesCompactSession.open(binding,custody);
    await session.execute({now:Date.now(),authorize:async()=>true,dispatch:retainChunk=>native.dispatchResponsesCompact(prepared,connection,{signal:AbortSignal.timeout(90000),retainChunk})});
    const candidate=session.candidate();
    if(!candidate){await evidence({supported:false,state:session.snapshot(),observation:session.observed()});throw new Error("Target compact support unavailable; original refusal retained");}
    const record=await custody.retainTerminal(session,ref("compact:terminal"));await saveUsage("compact",candidate.raw,record,s.fence,input,"compact");
    await evidence({supported:true,resourceId:candidate.resourceId,items:candidate.items.map(i=>({type:i.type,role:i.role??null})),usage:candidate.raw.usage,wholeOutputDigest:candidate.digest});
    app.exit(73);return;
  }
  const original=await journal.command({kind:"state",activityId:"compact"}),packet=await read(original.input);
  assert.equal(packet.endpoint,settings.baseUrl);assert.equal(packet.model,settings.model);
  const cs=await claim("compact"),custody=new h.HelarcResponsesCompactStore({id:packet.binding.id,journal,acceptance:store.sharedAcceptance,scope:scope("compact"),fence:cs.fence,
    original:[original.input],maximumBytes:32*1024*1024,observe:w=>work.push(w)});
  const compact=await native.ResponsesCompactSession.open(packet.binding,custody),candidate=compact.candidate();assert(candidate);
  if(phase==="probe"){
    const probe=h.prepareHelarcResponsesCompactionProbe({model:settings.model,candidate,question:"State only the final exhibit name, material and side count.",
      oracle:ref("independent-exhibit-facts"),maximumOutputTokens:1200,background:[]});
    const r=await response("probe",probe.prepared),answer=text(r.raw),supported=/Lumen/i.test(answer)&&/copper/i.test(answer)&&/seven|\b7\b/i.test(answer);
    await evidence({supported,answer,usage:r.raw.usage,originalCompactReused:true,wholeWindowDigest:candidate.digest,
      qualityScope:"Only three synthetic facts, not general semantic retention"});
    assert(supported,"Independent continuation probe did not retain the tested facts");app.exit(73);return;
  }
  if(phase==="internal"||phase==="internal-8000"){
    const bounded=phase==="internal-8000",threshold=bounded?8000:1000;
    const items=[{role:"user",content:"Keep the final exhibit decisions for later."},
      {role:"assistant",content:(bounded?"Background discussion with no additional decisions. ".repeat(2000):"")+"Final exhibit decisions: name Lumen, material copper, side count seven."},
      {role:"user",content:"Return only the chosen exhibit name."}];
    const prepared=native.prepareResponses({model:settings.model,purpose,stream:true,store:true,context_management:[{type:"compaction",compact_threshold:threshold}],
      input:items,max_output_tokens:1600,reasoning:{effort:"minimal"}});
    const settingsBody=native.nativeInputSettings(prepared.body),manifest=native.bindNativeInputManifest({protocol:model.OPENAI_RESPONSES,
      scope:{id:"live-internal",runId:"live",recipientId:"probe",purpose,compositionDigest:composition.digest},
      target:{model:settings.model,configuration:"frozen-live-settings:1",connection:"original-protected-target:1",disclosure:"synthetic-only"},
      selection:{id:"live-internal-selection",revision:"1",boundary:"original-synthetic",judgments:["synthetic-only-assurance"]},
      groups:[{id:"live-synthetic",representation:ref("synthetic"),sources:["synthetic-fixture"],holds:["live-original-retention"],deliveries:[],requires:[],items,replay:"local"}],settings:settingsBody,
      settingSources:Object.keys(settingsBody).map(field=>({field,source:"live-test-settings",digest:digest(settingsBody[field])}))});
    const duties=[{id:"exhibit-facts",revision:"1",requirement:"semantic",permittedEvidence:["method_assurance"]}],dependencies={recipient:manifest.scope.id,
      source:manifest.digest,target:manifest.target.configuration,authority:manifest.target.disclosure,requirements:digest(duties),method:"openai.responses.context_management.compaction:1"};
    const agreement=h.bindHelarcResponsesCompactionAgreement({manifest,body:prepared.body,dependencies,duties,
      findings:[{id:"synthetic-scope-permission",dutyId:"exhibit-facts",dutyRevision:"1",kind:"method_assurance",conclusion:"supported",dependencies,subject:prepared.digest,
        evidence:["OpenAI documented native continuation and explicitly bounded synthetic verification"],limitations:["Limited synthetic test; no blanket quality guarantee"]}],
      threshold:{tokens:threshold,window:128000,headroom:8000,basis:"Explicit bounded synthetic historical-assistant threshold crossing experiment; not production default",
        measurement:{id:"synthetic-unmeasured",requestDigest:prepared.digest,coverage:"unknown",tokens:null,unknowns:["Actual rendered tokens not measured"],
          acceptedUncertainty:"Bounded synthetic history under 110KB, explicit test-only allowance; success does not prove count accuracy"}},
      retentionBasis:"Original durable synthetic request and all observations",recoveryBasis:"Enclosing Response original ID and retained terminal"});
    const r=await response(phase,prepared,agreement),observation=h.inspectHelarcResponsesCompaction({response:r.raw,agreement,acceptedAgreementId:agreement.id,originalRequestDigest:prepared.digest});
    await evidence({supported:r.raw.status==="completed",responseId:r.raw.id,observation,answer:text(r.raw),usage:r.raw.usage,head:r.head,incompleteDetails:r.raw.incomplete_details??null});
    assert.equal(r.raw.status,"completed","Native conversion occurrence does not make incomplete generation successful");
    assert(observation.allowed);assert(observation.occurrences.length>0,"No actual in-request compaction observed");app.exit(73);return;
  }
  if(phase==="compare"){
    const completedRaw=async id=>{
      const record=await journal.command({kind:"record",activityId:id,ref:ref(`${id}:terminal`)});
      return read(record.content);
    };
    const probe=h.prepareHelarcResponsesCompactionProbe({model:settings.model,candidate,question:"State only the final exhibit name, material and side count.",
      oracle:ref("independent-exhibit-facts"),maximumOutputTokens:1200,background:[]});
    const unchanged=native.prepareResponses({...probe.prepared.body,purpose,input:[...packet.binding.prepared.body.input,probe.prepared.body.input.at(-1)]});
    const baseline=await response("unchanged-standalone",unchanged);native.assertResponsesTaskResponse(baseline.raw);
    assert(/Lumen/i.test(text(baseline.raw))&&/copper/i.test(text(baseline.raw))&&/seven|\b7\b/i.test(text(baseline.raw)));
    const internalState=await journal.command({kind:"state",activityId:"internal-8000"}),internal=await read(internalState.input);
    const {context_management,...withoutConversion}=internal.prepared.body;
    const unchangedInternal=native.prepareResponses({...withoutConversion,purpose});
    const internalBaseline=await response("unchanged-internal",unchangedInternal);native.assertResponsesTaskResponse(internalBaseline.raw);
    assert(/Lumen/i.test(text(internalBaseline.raw)));
    const probeRaw=await completedRaw("probe"),internalRaw=await completedRaw("internal-8000");
    const unfinishedState=await journal.command({kind:"state",activityId:"internal"});
    const unfinished=unfinishedState?await completedRaw("internal"):null;
    const originalChain=await journal.command({kind:"state",activityId:"internal:chain"});
    const unfinishedChain=originalChain?await completedRaw("internal:chain"):null;
    await evidence({supported:true,unchangedJustification:"Complete original inputs fit the bounded synthetic target; no retention duty requires conversion",
      standalone:{sameSourceDigest:packet.binding.sourceDigest,question:probe.prepared.body.input.at(-1),unchangedUsage:baseline.raw.usage,
        compactUsage:candidate.raw.usage,probeUsage:probeRaw.usage,unchangedAnswer:text(baseline.raw),convertedAnswer:text(probeRaw)},
      internal:{sameInputDigest:digest(internal.prepared.body.input),unchangedUsage:internalBaseline.raw.usage,convertedUsage:internalRaw.usage,
        unchangedAnswer:text(internalBaseline.raw),convertedAnswer:text(internalRaw)},
      discardedExperiment:unfinished?{status:unfinished.status,reason:unfinished.incomplete_details,usage:unfinished.usage,followupUsage:unfinishedChain?.usage??null}:null,
      monetaryCost:"unknown; no price basis supplied",latencyConclusion:"Single samples and different wall-clock times cannot establish a performance benefit",
      cacheConclusion:"Only provider-reported counters, no inferred cache saving or independent allocation of internal compaction"});
    await store.close();store=null;app.exit(0);return;
  }
  if(phase!=="follow"&&phase!=="follow-8000"&&phase!=="inspect")throw new Error("Unknown phase");
  const internalId=phase==="follow-8000"?"internal-8000":"internal";
  const priorState=await journal.command({kind:"state",activityId:internalId}),prior=await read(priorState.input);
  const record=await journal.command({kind:"record",activityId:internalId,ref:ref(`${internalId}:terminal`)}),raw=await read(record.content);
  if(phase==="inspect"){
    console.log(JSON.stringify({status:raw.status,error:raw.error,incomplete_details:raw.incomplete_details,output:raw.output.map(i=>({type:i.type,status:i.status})),usage:raw.usage}));
    await store.close();store=null;app.exit(0);return;
  }
  assert(h.inspectHelarcResponsesCompaction({response:raw,agreement:prior.agreement,acceptedAgreementId:prior.agreement.id,originalRequestDigest:prior.prepared.digest}).allowed);
  native.assertResponsesTaskResponse(raw);
  const replay=native.responsesInternalCompactionReplay(prior.prepared.body.input,native.mapResponsesReplay(raw).items);
  const question={role:"user",content:"What are the final material and side count? Reply briefly."};
  const chain=native.prepareResponses({model:settings.model,purpose,stream:false,store:true,previous_response_id:raw.id,input:[question],reasoning:{effort:"minimal"},max_output_tokens:800});
  const chained=await response(`${internalId}:chain`,chain);
  const explicit=native.prepareResponses({model:settings.model,purpose,stream:false,store:false,input:[...replay.items,question],reasoning:{effort:"minimal"},max_output_tokens:800});
  const replayed=await response(`${internalId}:replay`,explicit);
  for(const r of [chained,replayed])assert(/copper/i.test(text(r.raw))&&/seven|\b7\b/i.test(text(r.raw)),"Continuation did not preserve tested facts");
  await evidence({chainAnswer:text(chained.raw),replayAnswer:text(replayed.raw),omittedItems:replay.omittedItems,omittedPrefixDigest:replay.omittedPrefixDigest,
    originalInternalReused:true,chainUsage:chained.raw.usage,replayUsage:replayed.raw.usage});
  await store.close();store=null;app.exit(0);
}
app.whenReady().then(main).catch(async e=>{await writeFile(join(directory,`failure-${phase}.txt`),e.stack??String(e));await store?.close().catch(()=>{});app.exit(1);});
