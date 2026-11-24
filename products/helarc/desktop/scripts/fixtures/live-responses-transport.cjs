const {app}=require("electron");
const assert=require("node:assert/strict");
const {join,resolve}=require("node:path");
const {pathToFileURL}=require("node:url");
const {readFile,writeFile}=require("node:fs/promises");
const {randomUUID}=require("node:crypto");
const [directory,settingsPath]=process.argv.slice(2);
app.setPath("userData",join(directory,"electron"));app.disableHardwareAcceleration();
const moduleAt=relative=>import(pathToFileURL(resolve(__dirname,"../../dist/main",relative)).href);
const ref=id=>({id,revision:"1"});
let execution,registry,carrier;
const evidence={kind:"batch6-live-responses-transport",syntheticInput:true,profiles:[],errors:[]};
async function main(){
  const settings=JSON.parse(await readFile(settingsPath,"utf8"));
  assert.equal(settings.live,true,"Explicit live test opt-in required");
  assert.equal(typeof settings.credentialTarget,"string");assert.equal(typeof settings.model,"string");
  const {defaultProviderDraft}=await import(pathToFileURL(resolve(__dirname,"../../dist/shared/ProviderConfiguration.js")));
  const {createElectronProviderCredentialStore}=await moduleAt("provider/createElectronProviderCredentialStore.js");
  const {ElectronSafeStorageCredentialCipher}=await moduleAt("provider/ElectronSafeStorageCredentialCipher.js");
  const {ProviderRegistryClient}=await moduleAt("provider/ProviderRegistryClient.js");
  const {ProviderConfigurationService}=await moduleAt("provider/ProviderConfigurationService.js");
  const {ProviderConnectionRetention}=await moduleAt("provider/ProviderConnectionRetention.js");
  const {HelarcResponsesTransport,helarcResponsesSessionBinding}=await moduleAt("provider/HelarcResponsesTransport.js");
  const {HelarcExecutionStore}=await moduleAt("execution-storage/HelarcExecutionStore.js");
  const native=await import("@agent-anything/provider-integrations/native"),runtime=await import("@agent-anything/agent-runtime/model-access");
  const model=await import("@agent-anything/model-interaction/protocol"),helarc=await import("@agent-anything/helarc/controller");
  const {ProtocolJournalInspectionAdapter}=await moduleAt("inspection/ProtocolJournalInspectionAdapter.js");
  registry=await ProviderRegistryClient.open(join(directory,"registry.sqlite"));
  execution=await HelarcExecutionStore.open(join(directory,"execution"));
  let credentials=createElectronProviderCredentialStore(directory),ephemeralSecret=null;
  if(settings.credentialMode==="ephemeral-import"){
    const {NativeWindowsCredentialBackend}=await moduleAt("provider/WindowsCredentialBackend.js");
    const {ProviderCredentialStore}=await moduleAt("provider/ProviderCredentialStore.js");
    const {SafeStorageCredentialBackend}=await moduleAt("provider/SafeStorageCredentialBackend.js");
    ephemeralSecret=await new NativeWindowsCredentialBackend().read(settings.credentialTarget,settings.encoding??"utf16le");
    assert(ephemeralSecret,"The selected protected credential must exist");
    // Test-only encrypted memory custody. This does not claim cross-process credential recovery.
    const records=new Map();
    credentials=new ProviderCredentialStore(new SafeStorageCredentialBackend({
      read:async id=>records.get(id)??null,
      write:async record=>{records.set(record.profileId,record);},
      delete:async id=>{records.delete(id);},
    },new ElectronSafeStorageCredentialCipher()));
    evidence.credentialCustody="test_only_encrypted_memory_import";
  }else evidence.credentialCustody="external_windows_reference";
  evidence.baseUrl=settings.baseUrl;evidence.model=settings.model;
  const service=new ProviderConfigurationService(registry,credentials,new ElectronSafeStorageCredentialCipher());
  const owner=native.OPENAI_RESPONSES_ADAPTER.id,journal=execution.protocolJournal;
  const accept=async(id,runId,parts,actor=owner)=>{
    const receipt=await execution.sharedAcceptance.accept({id,scope:runId,actor,parts});
    assert.equal(receipt.outcome,"accepted",JSON.stringify(receipt));return receipt;
  };
  const jp=(kind,proposal)=>({owner:"protocol_execution",kind,proposal});
  const profiles=[
    {id:"buffered-chain",transport:"http",stream:false,background:false,store:true,continuity:"stored-response",chain:true},
    {id:"foreground-stream",transport:"http",stream:true,background:false,store:false,continuity:"replay",chain:true},
    {id:"background-poll-cancel",transport:"http",stream:false,background:true,store:true,continuity:"stored-response",cancel:true},
    {id:"background-stream-resume",transport:"http",stream:true,background:true,store:true,continuity:"stored-response",interrupt:true},
    {id:"websocket-memory",transport:"websocket",stream:true,background:false,store:false,continuity:"connection-memory",chain:true},
    {id:"websocket-stored",transport:"websocket",stream:true,background:false,store:true,continuity:"stored-response"},
  ];
  for(const profile of profiles){
    const runId=`live-${profile.id}`,draft=defaultProviderDraft("openai.responses"),started=performance.now();
    const result={profile:profile.id,operations:[],responses:[],interruptedWhileActive:false,cancelRequestedWhileActive:false};
    evidence.profiles.push(result);
    const update=await service.save({configurationId:`provider-${randomUUID()}`,updateId:randomUUID(),expectedRevision:null,
      draft:{...draft,name:`Verification ${profile.id}`,baseUrl:settings.baseUrl,model:settings.model,generationLifetimeMs:90000,
        native:{...draft.native,transport:profile.transport,stream:profile.stream,background:profile.background,store:profile.store,
          continuity:profile.continuity,allowTemporaryRetention:profile.background,allowConnectionMemory:profile.continuity==="connection-memory"}},
      credential:ephemeralSecret?{kind:"set",storage:"safe-storage",secret:ephemeralSecret}:
        {kind:"reference",target:settings.credentialTarget,encoding:settings.encoding??"utf16le"}});
    const configuration=update.configuration;assert(configuration);
    const pin={id:`${runId}:pin`,bindingId:configuration.connectionBindingId,acceptanceId:`${runId}:connection`,owner,purpose:"live-verification",state:"provisional"};
    const retention=new ProviderConnectionRetention(service,{read:async p=>
      (await journal.command({kind:"state",activityId:`${runId}:1`}))?"accepted":"unknown"});
    await service.pin(pin);
    let previous=null,activeSession=null,history=[];
    carrier=new HelarcResponsesTransport(service,{kind:"connection",bindingId:pin.bindingId,pinId:pin.id,acceptanceId:pin.acceptanceId});
    try{
      for(let ordinal=1;ordinal<=(profile.chain?2:1);ordinal++){
        const activityId=`${runId}:${ordinal}`,scopeId=`${runId}:scope`;
        const composition=model.bindModelAgentComposition({agent:ref("live-agent"),protocol:model.OPENAI_RESPONSES,
          configuration:{configuration:{id:configuration.id,revision:configuration.revision},protocol:model.OPENAI_RESPONSES,model:configuration.model,
            connectionBinding:ref(configuration.connectionBindingId)},adapter:{implementation:native.OPENAI_RESPONSES_ADAPTER,protocol:model.OPENAI_RESPONSES},
          task:{purpose:ref("task"),input:{implementation:ref("live-input"),protocol:model.OPENAI_RESPONSES},
            interpreter:{implementation:helarc.HELARC_NATIVE_TASK_INTERPRETER,protocol:model.OPENAI_RESPONSES}},auxiliary:[]});
        const activity=runtime.bindProtocolModelActivity({composition,scope:{runId,activityId,recipientId:"task",purpose:ref("task"),compositionDigest:composition.digest},
          conditions:{input:ref(`${activityId}:input`),authority:ref("live-authority"),resources:ref("live-resources"),control:ref("live-control")}});
        const scope={id:scopeId,runId,recipientId:"task",purpose:ref("task"),compositionDigest:composition.digest,owner};
        const message={role:"user",content:ordinal>1?"Reply with the same verification word as before, and nothing else.":"This is a small transport verification. Reply with exactly BATCH6_OK and nothing else."};
        const input=profile.continuity==="replay"?[...history,message]:[message];
        const prepared=native.prepareResponses({model:settings.model,purpose:ref("task"),transport:profile.transport,stream:profile.stream,store:profile.store,
          ...(profile.transport==="http"?{background:profile.background}:{}),...(previous&&profile.continuity!=="replay"?{previous_response_id:previous}:{}),input});
        const binding=helarcResponsesSessionBinding({configuration,prepared,id:`${activityId}:session`,scopeId,
          connectionIncarnation:profile.transport==="websocket"?carrier.connectionIncarnation:null,createdAt:Date.now(),
          maximumBytes:8*1024*1024,maximumFrameBytes:4*1024*1024,maximumEvents:20000});
        const original=await runtime.retainProtocolContent(journal,`${activityId}:input`,activityId,Buffer.from(JSON.stringify(binding)));
        await accept(`${activityId}:prepare`,runId,[jp("prepare",{activity,input:original}),jp("evidence_scope",{activityId,scope})],"execution-coordinator");
        await accept(`${activityId}:claim`,runId,[jp("claim",{activityId,expectedEpoch:0})]);
        await retention.reconcile(pin);
        let state=await journal.command({kind:"state",activityId});
        const custody=()=>({id:binding.id,journal,acceptance:execution.sharedAcceptance,scope,fence:state.fence,original:[original],maximumSegmentBytes:32*1024*1024});
        let storage=new helarc.HelarcResponsesSessionStore(custody()),controller=new AbortController(),interrupted=false;
        if(profile.interrupt){
          const commit=storage.commit.bind(storage);
          storage.commit=async(expected,next,segment)=>{
            await commit(expected,next,segment);
            if(!interrupted&&next.head.responseId&&!next.head.terminal){interrupted=true;result.interruptedWhileActive=true;controller.abort();}
          };
        }
        let session=activeSession=await native.ResponsesSession.open(binding,storage);
        const authorize=async operation=>{state=await journal.command({kind:"state",activityId});result.operations.push({operation,at:Date.now()});};
        const drive=async()=>{
          while(session.snapshot().disposition==="active"){
            const delay=Math.max(0,(session.snapshot().dueAt??0)-Date.now());
            if(delay)await new Promise(resolve=>setTimeout(resolve,Math.min(delay,10000)));
            await carrier.step(session,controller.signal,authorize);
            if(controller.signal.aborted){
              storage=new helarc.HelarcResponsesSessionStore(custody());session=activeSession=await native.ResponsesSession.open(binding,storage);controller=new AbortController();
            }
          }
        };
        await carrier.step(session,controller.signal,authorize);
        if(controller.signal.aborted){storage=new helarc.HelarcResponsesSessionStore(custody());session=activeSession=await native.ResponsesSession.open(binding,storage);controller=new AbortController();}
        if(profile.cancel&&!session.snapshot().head.terminal&&session.snapshot().head.responseId){
          result.cancelRequestedWhileActive=true;
          await accept(`${activityId}:cancel`,runId,[jp("control",{activityId,expectedRevision:state.fence.controlRevision,cancelled:true})],"execution-coordinator");
          state=await journal.command({kind:"state",activityId});storage=new helarc.HelarcResponsesSessionStore(custody());
          session=activeSession=await native.ResponsesSession.open(binding,storage);await session.cancel(`${activityId}:cancel`);
        }
        await drive();
        const terminal=session.response(),head=session.snapshot();
        const continuation=session.continuationItems();
        result.responses.push({state:head,usage:terminal?.usage??null,continuationSources:continuation?.map(c=>({itemId:c.item.id,source:c.source}))??null,
          text:terminal?.output?.flatMap(item=>item.content??[]).filter(p=>p.type==="output_text").map(p=>p.text).join("")??null});
        if(continuation)history=[...input,...continuation.map(c=>c.item)];
        previous=head.head.status==="completed"?head.head.responseId:null;
        if(head.disposition!=="terminal")break;
        const reopened=await native.ResponsesSession.open(binding,new helarc.HelarcResponsesSessionStore(custody()));
        assert.deepEqual(reopened.response(),terminal);assert.deepEqual(reopened.snapshot(),head);
        assert.deepEqual(reopened.continuationItems(),continuation);
      }
      result.localRecoveryVerified=result.responses.every(r=>r.state.disposition==="terminal");
    }catch(error){result.error=error.code??error.message;if(activeSession)result.lastDurableState=activeSession.snapshot();}
    finally{await carrier.close();carrier=null;result.elapsedMs=Math.round(performance.now()-started);
      result.cleanup=activeSession?.snapshot().head.terminal?"local_carrier_closed_remote_terminal":"local_carrier_closed_original_outcome_retained";}
    await writeFile(join(directory,"live-evidence.json"),JSON.stringify(evidence,null,2));
    console.log(JSON.stringify({profile:profile.id,status:result.responses.map(r=>r.state.head.status),error:result.error??null,operations:result.operations.length,elapsedMs:result.elapsedMs}));
  }
  const offers=[],inspection=new ProtocolJournalInspectionAdapter({ref:(owner,kind,id,runId,revision="1")=>({sourceId:"live-fixture",datasetId:"live-fixture",owner,kind,id,runId,revision}),offer:r=>{offers.push(r);return true;}});
  // Records retain source/content links even when a live target refuses a profile.
  for(const profile of profiles)await inspection.replay((after,limit)=>journal.command({kind:"facts",runId:`live-${profile.id}`,after,limit}));
  evidence.inspectorRecords=offers.length;
  await writeFile(join(directory,"live-evidence.json"),JSON.stringify(evidence,null,2));
}
app.whenReady().then(main).then(async()=>{await carrier?.close();await execution?.close();await registry?.close();app.exit(0);}).catch(async error=>{
  evidence.errors.push(error.code??error.message);await writeFile(join(directory,"live-evidence.json"),JSON.stringify(evidence,null,2));
  await carrier?.close().catch(()=>{});await execution?.close().catch(()=>{});await registry?.close().catch(()=>{});console.error(error.code??error.message);app.exit(1);
});
