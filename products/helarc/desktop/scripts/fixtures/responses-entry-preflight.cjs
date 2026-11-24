// Offline only. Never open the user's registry Worker or turn this probe into a live sender.
const {app}=require("electron");
const assert=require("node:assert/strict");
const {randomUUID}=require("node:crypto");
const {mkdtempSync}=require("node:fs"),{writeFile}=require("node:fs/promises");
const {tmpdir}=require("node:os"),{join}=require("node:path"),{pathToFileURL}=require("node:url");
const root=mkdtempSync(join(tmpdir(),"helarc-responses-entry-"));
app.setPath("userData",join(root,"electron"));app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-background-networking");
let providerFetchAttempts=0;
globalThis.fetch=async()=>{providerFetchAttempts++;throw Error("Network is disabled in the Responses entry probe");};
const load=name=>import(pathToFileURL(join(__dirname,"../../dist/main",name)));

async function inspect(){
  const {HelarcInspection}=await load("inspection/HelarcInspection.js");
  const {HelarcExecutionDiagnostics}=await load("diagnostics/HelarcExecutionDiagnostics.js");
  const {HelarcExecutionStore}=await load("execution-storage/HelarcExecutionStore.js");
  const {ElectronSafeStorageCredentialCipher}=await load("provider/ElectronSafeStorageCredentialCipher.js");
  const {createHelarcActivityHost}=await load("context/HelarcActivityHost.js");
  const {createHelarcApplicationServices}=await load("HelarcApplicationServices.js");
  const {defaultProviderDraft}=await load("./provider/ProviderDraftValidation.js");
  const {InspectionQueryService}=await import("@agent-anything/inspection/query");
  const inspectionRoot=join(root,"inspection"),inspection=await HelarcInspection.create(join(root,"inspection-settings.json"),inspectionRoot);
  const diagnostics=new HelarcExecutionDiagnostics(join(root,"diagnostics.json"),inspection.performanceObserver);
  let store,host,services,query;
  try{
    const rec=inspection.recorder;assert(rec);
    store=await HelarcExecutionStore.open(join(root,"execution"),undefined,inspection.evidenceObserver,inspection.fileMaterialObserver,
      diagnostics,new ElectronSafeStorageCredentialCipher(),inspection.contextMaterialObserver,inspection.activityObserver,inspection.contextFoundationObserver,inspection.protocolObserver);
    inspection.protocolObserver.bindContentReader(store.protocolJournal,store.contextSelections);
    host=createHelarcActivityHost(store,{diagnostics});
    services=await createHelarcApplicationServices({userDataPath:root,inspection,executions:store,diagnostics,activityHost:host});
    const api=services.providerConfigurations;
    const instructions=Object.fromEntries(Object.entries(await services.instructionSettingsStore.load()).map(([k,v])=>[k,v.filter(i=>i.enabled).length]));
    assert(Object.values(instructions).every(n=>n===0));
    const vault=await api.credentialSettings(null);assert(vault.ok);
    const saved=await api.save({expectedRevision:null,configurationId:"provider-"+randomUUID(),updateId:randomUUID(),
      draft:defaultProviderDraft("openai.responses","offline-probe-not-a-live-target"),credential:{kind:"none"}});
    assert(saved.ok);const c=saved.value.configuration;
    const gate=await api.eligibility({id:c.id,revision:c.revision});
    assert.deepEqual(gate,{ok:true,value:{available:false,reason:"provider_native_activation_pending"}});
    const registry=await api.list();assert(registry.ok);assert.equal(registry.value.defaultSelection,null);
    assert.equal((await store.listProductRuns()).length,0);
    const id="preflight:"+randomUUID(),subject=rec.ref("responses-preflight","event",id,null);
    assert(await rec.offerWhenReady({id,subject,occurredAt:new Date().toISOString(),
      payload:{kind:"event",name:"responses.offline_probe",sequence:null,code:"not_a_model_request"},
      contents:[{name:"Offline probe",class:"provider",stage:"preflight",mediaType:"text/plain",value:id}]}));
    await inspection.flushRecording();query=new InspectionQueryService(inspectionRoot);
    const snap=await query.query({kind:"get_snapshot",sourceId:subject.sourceId,datasetId:subject.datasetId});
    const page=await query.query({...snap.selection,kind:"get_record",recordId:id});
    assert.equal(page.readWork.bodyReads,0);const detail=page.records[0].contents[0];assert.equal(detail.availability,"present");
    const body=await query.query({...snap.selection,kind:"get_content",contentId:detail.id});
    assert.equal(body.content.text,id);assert.equal(snap.coverage.dropped,0);assert.equal(snap.coverage.rejected,0);
    return {electron:process.versions.electron,sqliteGeneration:store.generation,defaultEligibility:gate.value,
      windowsCredentialHelperAvailable:vault.value.windowsAvailable,instructionsEnabled:instructions,
      inspector:{selection:snap.selection,record:id,metaBodyReads:page.readWork.bodyReads,bodyReads:body.readWork.bodyReads,
        rejected:snap.coverage.rejected,dropped:snap.coverage.dropped},taskAdmissions:0};
  }finally{
    try{await query?.close();await host?.service.close();}
    finally{try{await services?.close();}finally{try{await inspection.close();}finally{try{await store?.close();}finally{await diagnostics.flush();}}}}
  }
}
app.whenReady().then(async()=>{const result=await inspect();assert.equal(providerFetchAttempts,0);
  await writeFile(join(root,"result.json"),JSON.stringify({...result,providerFetchAttempts},null,2));
  console.log("Responses offline evidence: "+root);app.exit(0);
}).catch(error=>{console.error("Responses offline preflight failed:",error);app.exit(1);});
