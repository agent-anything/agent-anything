const {app}=require("electron");
const assert=require("node:assert/strict");
const {join,resolve,dirname}=require("node:path");
const {pathToFileURL}=require("node:url");
const {writeFile,readFile,appendFile}=require("node:fs/promises");
const {randomUUID}=require("node:crypto");
const {execFile}=require("node:child_process");
const {admitComponentRun,commitComponentRun}=require("./admit-component-run.cjs");
const [directory,scenario,phase]=process.argv.slice(2);
app.setPath("userData",join(directory,"electron"));app.disableHardwareAcceleration();
const started=performance.now(),observed=[],counts={reads:0,creates:0,deletes:0};
const stage=name=>appendFile(join(directory,`${phase}-stages.jsonl`),JSON.stringify({name,elapsedMs:Math.round(performance.now()-started)})+"\n");
let registry,execution,inspection,backend,maintenance;
const moduleAt=relative=>import(pathToFileURL(resolve(__dirname,"../../dist/main",relative)).href);
const fixtureKey="synthetic-custody-verification-key";
const externalFixture=(operation,target)=>new Promise((accept,reject)=>execFile(resolve(__dirname,"../../native/credential-helper/target/x86_64-pc-windows-msvc/release/examples/external-credential-fixture.exe"),[operation,target],{windowsHide:true,timeout:10000},error=>error?reject(new Error("external_credential_fixture_failed")):accept()));
function checkpoint(original,connections){
  const revision=original.state.revision+1;
  return {...original,id:`root:commit:${revision}`,expectedRevision:original.state.revision,admission:null,
    state:{...original.state,revision},control:{...original.control,
      controllerCheckpoints:[...original.control.controllerCheckpoints,["connections",connections],
        ["accepted-response",{text:"original accepted response",operation:"effect already completed"}]]}};
}
app.whenReady().then(async()=>{
  await stage("app_ready");
  const {NativeWindowsCredentialBackend}=await moduleAt("provider/WindowsCredentialBackend.js");backend=new NativeWindowsCredentialBackend();
  assert.equal(await backend.available(),true,"Actual Windows credential helper required");
  const manifestPath=join(directory,"owned.json");
  let owned=JSON.parse(await readFile(manifestPath,"utf8").catch(()=>"[]"));
  if(phase==="cleanup"){
    for(const item of owned){assert.match(item.id,/^provider-[a-f0-9-]{36}$/);assert.match(item.update,/^[a-f0-9-]{36}$/);await backend.delete(`Helarc/Provider/${item.id}-${item.update}`);}
    for(const target of JSON.parse(await readFile(join(directory,"external-owned.json"),"utf8").catch(()=>"[]"))){assert.match(target,/^Helarc-Custody-Test\/[a-f0-9-]{36}$/);await externalFixture("delete",target);}
    app.exit(0);return;
  }
  const {ProviderCredentialStore}=await moduleAt("provider/ProviderCredentialStore.js");
  const {SafeStorageCredentialBackend,FileProviderCredentialPersistence}=await moduleAt("provider/SafeStorageCredentialBackend.js");
  const {ElectronSafeStorageCredentialCipher}=await moduleAt("provider/ElectronSafeStorageCredentialCipher.js");
  const {ProviderRegistryClient}=await moduleAt("provider/ProviderRegistryClient.js");
  const {ProviderConfigurationService}=await moduleAt("provider/ProviderConfigurationService.js");
  const {ProviderConnectionRetention}=await moduleAt("provider/ProviderConnectionRetention.js");
  const {ProviderCustodyMaintenance}=await moduleAt("provider/ProviderCustodyMaintenance.js");
  const {defaultProviderDraft}=await import(pathToFileURL(resolve(__dirname,"../../dist/main/provider/ProviderDraftValidation.js")).href);
  const {HelarcExecutionStore}=await moduleAt("execution-storage/HelarcExecutionStore.js");
  const {HelarcInspection}=await moduleAt("inspection/HelarcInspection.js");
  const {ProviderCustodyInspectionAdapter}=await moduleAt("inspection/ProviderCustodyInspectionAdapter.js");
  await stage("modules_loaded");
  inspection=await HelarcInspection.create(join(directory,"inspection-settings.json"),join(directory,"inspection"));
  assert(inspection.recorder,"Actual inspection recorder required");
  registry=await ProviderRegistryClient.open(join(directory,"registry.sqlite"),event=>observed.push(event));
  await stage("registry_open");
  const inspectionAdapter=new ProviderCustodyInspectionAdapter(inspection.recorder,await registry.request({kind:"identity"}));
  const cipher=new ElectronSafeStorageCredentialCipher();assert.equal(cipher.isEncryptionAvailable(),true);
  const credentials=new ProviderCredentialStore(new SafeStorageCredentialBackend(new FileProviderCredentialPersistence(join(directory,"safe-storage")),cipher),{
    available:()=>backend.available(),async read(...args){counts.reads++;await stage("vault_read_start");try{return await backend.read(...args);}finally{await stage("vault_read_end");}},async create(...args){counts.creates++;await stage("vault_create_start");try{return await backend.create(...args);}finally{await stage("vault_create_end");}},async delete(...args){counts.deletes++;return backend.delete(...args);},
  });
  const service=new ProviderConfigurationService(registry,credentials,cipher,event=>observed.push(event));
  maintenance=new ProviderCustodyMaintenance(service,async()=>{},event=>observed.push(event));
  async function make(model="original-model",storage="windows-managed"){
    const id=`provider-${randomUUID()}`,update=randomUUID();owned.push({id,update});await writeFile(manifestPath,JSON.stringify(owned));
    return {configurationId:id,updateId:update,expectedRevision:null,draft:defaultProviderDraft("openai.responses",model),credential:{kind:"set",storage,secret:fixtureKey}};
  }
  if(scenario==="staging"){
    if(phase==="seed"){
      const request=await make();await writeFile(join(directory,"expected.json"),JSON.stringify({id:request.configurationId,updateId:request.updateId,policy:request.draft.inRequestCompaction}));
      const original=registry.request.bind(registry);
      registry.request=async command=>{if(command.kind==="publish_update"){await stage("before_crash_exit");app.exit(73);await new Promise(()=>{});}return original(command);};
      await service.save(request);assert.fail("expected crash");
    }
    const expected=JSON.parse(await readFile(join(directory,"expected.json"),"utf8"));
    maintenance.request();await maintenance.idle();
    const receipt=await service.receipt(expected.updateId);assert.equal(receipt.disposition,"committed");assert.equal(receipt.configuration.id,expected.id);assert.equal(counts.creates,0);
    assert.deepEqual(receipt.configuration.inRequestCompaction,expected.policy,"Recovery preserves the policy stored before the save interruption");
    assert.equal(receipt.configuration.native.allowInRequestCompaction,false);
    assert.equal(await service.withConnection(receipt.configuration.connectionBindingId,async(_config,key)=>key===fixtureKey),true);
    const reads=counts.reads;for(let i=0;i<20;i++)await service.list();assert.equal(counts.reads,reads);
    const local=await service.save(await make("local-store","safe-storage"));assert.equal(await service.withConnection(local.configuration.connectionBindingId,async(_c,key)=>key===fixtureKey),true);
    const externalTarget=`Helarc-Custody-Test/${randomUUID()}`;
    await writeFile(join(directory,"external-owned.json"),JSON.stringify([externalTarget]));await externalFixture("create",externalTarget);
    const aliasRequest=await make("external-reference");aliasRequest.credential={kind:"reference",target:externalTarget.toUpperCase(),encoding:"utf16le"};
    const alias=(await service.save(aliasRequest)).configuration;
    assert.equal(await service.withConnection(alias.connectionBindingId,async(_c,key)=>key===fixtureKey),true);
    await externalFixture("delete",externalTarget);await externalFixture("changed",externalTarget);
    await assert.rejects(()=>service.withConnection(alias.connectionBindingId,async()=>assert.fail("changed key must not dispatch")),/provider_credential_changed/);
    await service.archive(alias.id,alias.revision);await service.collect();
    assert.equal(await backend.read(externalTarget,"utf16le"),"synthetic-external-change");
    const bound=await service.binding(receipt.configuration.connectionBindingId);
    await service.archive(receipt.configuration.id,receipt.configuration.revision);
    const pin={id:"actual-pin-race",bindingId:bound.id,acceptanceId:"actual-acceptance",owner:"fixture",purpose:"task",state:"provisional"};
    const admissionFirst=await Promise.allSettled([service.pin(pin),registry.request({kind:"claim_collection",id:bound.credential.id})]);
    assert.equal(admissionFirst[0].status,"fulfilled");assert.equal(admissionFirst[1].status,"rejected");
    assert.match(String(admissionFirst[1].reason),/provider_credential_retained/);
    await service.settlePin(pin.id,pin.acceptanceId,"released");
    const collectionFirst=await Promise.allSettled([registry.request({kind:"claim_collection",id:bound.credential.id}),service.pin({...pin,id:"actual-late-pin"})]);
    assert.equal(collectionFirst[0].status,"fulfilled");assert.equal(collectionFirst[1].status,"rejected");
    assert.match(String(collectionFirst[1].reason),/provider_credential_not_usable|provider_credential_collection_in_progress/);
    maintenance.request();await maintenance.idle();assert.equal(await backend.read(bound.credential.ref.id,"utf16le"),null);
  }else{
    execution=await HelarcExecutionStore.open(join(directory,"execution"));
    const evidence={async read(pin){const head=await execution.readLatestRun("root");const connections=head?.control.controllerCheckpoints.find(([name])=>name==="connections")?.[1]??[];
      return connections.some(c=>c.pinId===pin.id&&c.bindingId===pin.bindingId&&c.acceptanceId===pin.acceptanceId)?"accepted":"unknown";}};
    const retention=new ProviderConnectionRetention(service,evidence);
    if(phase==="seed"){
      const admitted=await admitComponentRun(execution,directory);
      const request=await make(),saved=(await service.save(request)).configuration;
      const pins=["root","child","auxiliary"].map(owner=>({id:`pin-${owner}`,bindingId:saved.connectionBindingId,acceptanceId:`accept-${owner}`,owner,purpose:owner==="auxiliary"?"compaction":"task",state:"provisional"}));
      for(const pin of pins)await service.pin(pin);
      const connections=pins.map(pin=>({kind:"connection",bindingId:pin.bindingId,pinId:pin.id,acceptanceId:pin.acceptanceId}));
      await writeFile(join(directory,"expected.json"),JSON.stringify({saved,connections}));
      await retention.accept(pins[0],async()=>{
        await appendFile(join(directory,"effect-count"),"one\n");
        await commitComponentRun(execution,checkpoint(admitted,connections));
        // Execution acceptance is durable; Host pin confirmation acknowledgement is intentionally absent.
        app.exit(73);await new Promise(()=>{});
      });assert.fail("expected crash");
    }
    const expected=JSON.parse(await readFile(join(directory,"expected.json"),"utf8"));
    const reads=counts.reads;
    for(const connection of expected.connections){
      const recovered=await retention.recover(connection);
      assert.equal(recovered.revision,expected.saved.revision);
      assert.deepEqual(recovered.inRequestCompaction,expected.saved.inRequestCompaction);
      assert.equal(recovered.native.allowInRequestCompaction,false);
    }
    assert.equal(counts.reads,reads);assert.equal(await readFile(join(directory,"effect-count"),"utf8"),"one\n");
    const original=await service.binding(expected.saved.connectionBindingId);
    const next=await make("new-default-model");next.configurationId=expected.saved.id;next.expectedRevision=expected.saved.revision;
    next.draft.native.allowInRequestCompaction=true;
    owned.push({id:next.configurationId,update:next.updateId});await writeFile(manifestPath,JSON.stringify(owned));
    const updated=(await service.save(next)).configuration;
    await service.activate(updated.id,updated.revision,()=>{});
    assert.equal((await retention.recover(expected.connections[1])).model,"original-model");
    for(const connection of expected.connections){
      const recovered=await retention.recover(connection);
      assert.deepEqual(recovered.inRequestCompaction,expected.saved.inRequestCompaction,"Root/Child/auxiliary retain the original policy, not the new default");
      assert.equal(recovered.native.allowInRequestCompaction,false);
    }
    await service.collect();assert.equal(await backend.read(original.credential.ref.id,"utf16le"),fixtureKey);
    await service.revoke(original.id,original.revision);
    for(const connection of expected.connections)assert.equal((await retention.recover(connection)).model,"original-model");
    await assert.rejects(()=>service.withConnection(original.id,async()=>assert.fail("must not dispatch")),/provider_binding_revoked/);
    await service.repair(original.id,original.revision+1,updated.connectionBindingId,true);
    assert.equal(await service.withConnection(original.id,async(config,key)=>config.model==="original-model"&&key===fixtureKey),true);
    for(const connection of expected.connections)await service.settlePin(connection.pinId,connection.acceptanceId,"released");
    await service.archive(updated.id,updated.revision);maintenance.request();await maintenance.idle();
    assert.equal(await backend.read(original.credential.ref.id,"utf16le"),null);
    assert.equal((await execution.readLatestRun("root")).control.controllerCheckpoints.find(([name])=>name==="accepted-response")[1].text,"original accepted response");
    assert.equal(await readFile(join(directory,"effect-count"),"utf8"),"one\n");
  }
  await inspectionAdapter.replay((after,limit)=>service.events(after,limit));
  for(const event of observed)inspectionAdapter.observe(event);
  const publicEvidence=JSON.stringify({listing:await service.list(),events:await service.events(),timings:observed});
  assert(!publicEvidence.includes(fixtureKey));assert(!publicEvidence.includes("Helarc/Provider/"));
  await maintenance.close();await execution?.close();execution=null;await registry.close();registry=null;await inspection.close();
  assert.equal(inspection.snapshot().health.dropped,0);
  await writeFile(join(directory,"verification.json"),JSON.stringify({scenario,actualElectron:process.versions.electron,actualSQLiteWorker:true,counts,
    originalInteractionsPreserved:scenario==="recovery",completedOperationCount:scenario==="recovery"?1:0,
    pinCollectionRace:scenario==="staging"?"both orders verified":null,
    configuredUsePolicyPreserved:true,
    custodyEvents:"recorded",listOperations:observed.filter(event=>event.operation==="list").map(event=>({durationMs:event.durationMs,workerMs:event.workerMs,work:event.work})),
    elapsedMs:Math.round(performance.now()-started)},null,2));
  app.exit(0);
}).catch(async error=>{
  await writeFile(join(directory,`${phase}-failure.txt`),String(error.stack??error));
  try{await maintenance?.close();}catch{}try{await execution?.close();}catch{}try{await registry?.close();}catch{}try{await inspection?.close();}catch{}
  app.exit(1);
});
