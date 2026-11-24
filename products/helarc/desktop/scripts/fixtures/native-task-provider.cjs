const {join}=require("node:path"),{readFile,writeFile}=require("node:fs/promises"),{randomUUID}=require("node:crypto");
module.exports=async function(directory,phase,endpoint,load,profile,settingsPath){
  const {ProviderRegistryClient}=await load("provider/ProviderRegistryClient.js");
  const {ProviderConfigurationService}=await load("provider/ProviderConfigurationService.js");
  const {createElectronProviderCredentialStore}=await load("provider/createElectronProviderCredentialStore.js");
  const {ElectronSafeStorageCredentialCipher}=await load("provider/ElectronSafeStorageCredentialCipher.js");
  const {defaultProviderDraft}=await load("../shared/ProviderConfiguration.js");
  const registry=await ProviderRegistryClient.open(join(directory,"providers.sqlite"));
  const service=new ProviderConfigurationService(registry,createElectronProviderCredentialStore(join(directory,"credentials")),new ElectronSafeStorageCredentialCipher());
  const manifest=join(directory,"original-provider.json");let original;
  try{original=JSON.parse(await readFile(manifest,"utf8"));}
  catch(error){if(error.code!=="ENOENT")throw error;
    const protocol=profile.startsWith("responses")?"openai.responses":profile.startsWith("deepseek")?"deepseek.chat-completions":"ollama.chat";
    const draft=defaultProviderDraft(protocol);
    let settings=null,credential={kind:"set",storage:"safe-storage",secret:"synthetic"};
    if(settingsPath){
      settings=JSON.parse(await readFile(settingsPath,"utf8"));
      if(settings.live!==true||!settings.credentialTarget||!settings.model)throw new Error("Explicit live target required");
      const {NativeWindowsCredentialBackend}=await load("provider/WindowsCredentialBackend.js");
      const secret=await new NativeWindowsCredentialBackend().read(settings.credentialTarget,settings.encoding??"utf16le");
      if(!secret)throw new Error("Protected credential unavailable");
      credential={kind:"set",storage:"safe-storage",secret};
    }
    const saved=await service.save({configurationId:`provider-${randomUUID()}`,updateId:randomUUID(),expectedRevision:null,
      // The live large-report case generates about 6k tokens; the prior 90 s episode
      // retained 5,857 events before expiry. Keep its 300 s tree limit unchanged.
      draft:{...draft,name:"Isolated native tree",model:settings?.model??"controlled",baseUrl:settings?.baseUrl??endpoint,
        generationLifetimeMs:settings&&profile.includes("-material")?240000:90000,
        native:protocol==="openai.responses"?{...draft.native,transport:"http",stream:profile.includes("-stream"),store:profile.includes("-background"),background:profile.includes("-background"),
          allowTemporaryRetention:profile.includes("-background"),continuity:"replay"}:draft.native},
      credential});
    original={id:saved.configuration.id,revision:saved.configuration.revision};await writeFile(manifest,JSON.stringify(original));
  }
  const configuration=await service.get(original.id,original.revision);
  if(phase==="child-response"){
    const current=await service.get(original.id);
    if(current.revision===original.revision){
      await service.save({configurationId:current.id,updateId:randomUUID(),expectedRevision:current.revision,
        draft:{protocol:current.protocol,baseUrl:current.baseUrl,native:current.native,observation:current.observation,generationLifetimeMs:current.generationLifetimeMs,
          name:"Changed default must not affect original tree",model:"wrong-model"},credential:{kind:"keep"}});
    }
  }
  return {service,configuration,close:()=>registry.close()};
};
