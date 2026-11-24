// Headless: no BrowserWindow, IPC, discovery, activation or model dispatch.
const {app}=require("electron"),fs=require("node:fs"),path=require("node:path"),assert=require("node:assert/strict");
const {pathToFileURL}=require("node:url");
const {paths,openCase,initialize,original}=require("./responses-case-environment.cjs");
const [command,caseId,directory,...args]=process.argv.slice(2);
const load=name=>import(pathToFileURL(path.join(__dirname,"../../dist/main",name+".js")));
let fetches=0;
globalThis.fetch=async()=>{fetches++;throw Error("Responses setup has no network authority");};

async function main(){
  assert(["prepare-live","prepare-offline","reopen"].includes(command)&&!args.length,"invalid fixture setup operation");
  const creating=command!=="reopen";
  const env=creating?paths(caseId,directory,true):openCase(caseId,directory);
  app.setPath("userData",env.profile);app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-background-networking");
  await app.whenReady();assert(app.requestSingleInstanceLock(),"fixture already open");
  const {ProviderRegistryClient}=await load("provider/ProviderRegistryClient");
  const {ProviderConfigurationService}=await load("provider/ProviderConfigurationService");
  const {createElectronProviderCredentialStore}=await load("provider/createElectronProviderCredentialStore");
  const {ElectronSafeStorageCredentialCipher}=await load("provider/ElectronSafeStorageCredentialCipher");
  const {HelarcExecutionStore}=await load("execution-storage/HelarcExecutionStore");
  let registry,execution;
  try{
    execution=await HelarcExecutionStore.open(path.join(env.profile,"execution"));
    const runs=await execution.listProductRuns();
    if(creating)assert.equal(runs.length,0);
    registry=await ProviderRegistryClient.open(path.join(env.profile,"provider-registry","registry.sqlite"));
    const service=new ProviderConfigurationService(registry,createElectronProviderCredentialStore(env.profile),new ElectronSafeStorageCredentialCipher());
    if(creating)await initialize(env,service,process.env.HELARC_RESPONSES_TEST_CREDENTIAL_TARGET??"",command==="prepare-live"?"live-reference":"offline-fixture");
    const retained=openCase(caseId,env.root),c=await original(retained,service);
    assert.equal((await service.list()).defaultSelection,null);
    assert.equal(fetches,0);
    console.log(JSON.stringify({caseId,command,pid:process.pid,electron:process.versions.electron,worker:execution.generation,
      target:retained.target,credentialBackend:c.credentialBackend,admissions:runs.length,fetches}));
  }finally{try{await registry?.close();}finally{await execution?.close();}}
}
main().then(()=>app.exit(0),error=>{console.error("Responses configuration:",error.message);app.exit(1);});
