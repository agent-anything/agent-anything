import {join} from "node:path";
import {HelarcMainController} from "./HelarcMainController.js";
import type {RegisterHelarcIpcInput} from "./ipc.js";
import type {HelarcExecutionStore} from "./execution-storage/HelarcExecutionStore.js";
import type {HelarcInspection} from "./inspection/HelarcInspection.js";
import type {HelarcExecutionDiagnostics} from "./diagnostics/HelarcExecutionDiagnostics.js";
import type {createHelarcActivityHost} from "./context/HelarcActivityHost.js";
import {HelarcStorageService} from "./storage/HelarcStorageService.js";
import {HelarcPersistenceDiagnostics} from "./persistence/HelarcPersistenceDiagnostics.js";
import {FileHelarcInstructionSettingsStore} from "./instructions/FileHelarcInstructionSettingsStore.js";
import {FileHelarcContextSettingsStore} from "./context/FileHelarcContextSettingsStore.js";
import {createElectronProviderCredentialStore} from "./provider/createElectronProviderCredentialStore.js";
import {FileHelarcProviderProfileStore} from "./provider/HelarcProviderProfileStore.js";
import {resolveHelarcProviderConfig} from "./provider/resolveHelarcProviderConfig.js";
import {createHelarcProvider} from "./provider/createHelarcProvider.js";
import {bindHelarcRunProvider,type HelarcRunCredentialBinding} from "./provider/HelarcRunProviderBinding.js";
import {retainHelarcProviderBinding} from "./execution-storage/HelarcExecutionAdmission.js";
import {FileHelarcWorkspaceProfileStore} from "./workspace/HelarcWorkspaceProfileStore.js";
import {FileHelarcThreadStore} from "./thread/index.js";
import {FileHelarcProjectStore} from "./project/FileHelarcProjectStore.js";
import {FileHelarcContextManifestStore} from "./context-manifest/index.js";
import {FileHelarcRunTranscriptStore} from "./run-transcript/index.js";
import {CommandOutputRegistry} from "./workbench/CommandOutputRegistry.js";

/** One application composition. Windows attach views; they do not recreate execution owners. */
export async function createHelarcApplicationServices(input:{
  readonly userDataPath:string;
  readonly inspection:HelarcInspection;
  readonly executions:HelarcExecutionStore;
  readonly diagnostics:HelarcExecutionDiagnostics;
  readonly activityHost:ReturnType<typeof createHelarcActivityHost>;
}):Promise<Omit<RegisterHelarcIpcInput,"window">&{readonly close:()=>void}> {
  const {userDataPath,inspection,executions,diagnostics,activityHost}=input;
  const instructionSettingsStore=new FileHelarcInstructionSettingsStore(join(userDataPath,"instruction-settings.json"));
  const contextSettingsStore=new FileHelarcContextSettingsStore(join(userDataPath,"context-settings.json"));
  const providerCredentialStore=createElectronProviderCredentialStore(userDataPath);
  const providerProfileStore=new FileHelarcProviderProfileStore(join(userDataPath,"provider-profile.json"));
  const stored=await providerProfileStore.resolveActiveProfile(providerCredentialStore);
  const config=stored??resolveHelarcProviderConfig();
  const ready=config.ok&&config.config.model.trim().length>0;
  const error=!config.ok?config.error:ready?null:{code:"provider_config_missing" as const,message:"Select a model before starting work."};
  const provider=ready?createHelarcProvider(config.config,inspection.providerObserver):null;
  const workspaceProfileStore=new FileHelarcWorkspaceProfileStore(join(userDataPath,"workspace-profiles.json"));
  const threadStore=new FileHelarcThreadStore(join(userDataPath,"threads.json"));
  const projectStore=new FileHelarcProjectStore(join(userDataPath,"projects.json"));
  const contextManifestStore=new FileHelarcContextManifestStore(join(userDataPath,"context-manifests.json"));
  const runTranscriptStore=new FileHelarcRunTranscriptStore(join(userDataPath,"run-transcripts"));
  await contextManifestStore.listManifests();
  const controller=new HelarcMainController({activityHost,executionDiagnostics:diagnostics,executionStore:executions,
    async bindRunProvider(provider,profile){
      let credential:HelarcRunCredentialBinding;
      if(profile.id==="env-provider")credential=profile.credentialStatus==="present"?{kind:"environment",name:"HELARC_PROVIDER_API_KEY"}:{kind:"none"};
      else {
        if(!profile.revision)throw new Error("The original Provider configuration revision is unavailable.");
        const ref=await providerProfileStore.credentialReference(profile.id,profile.revision);
        credential=ref?{kind:"saved",ref}:{kind:"none"};
      }
      return {credential,provider:bindHelarcRunProvider({providerProfile:profile,providerBinding:retainHelarcProviderBinding(provider),providerCredential:credential},providerCredentialStore,inspection.providerObserver)};
    },
    async recoverProvider(saved){return bindHelarcRunProvider(saved,providerCredentialStore,inspection.providerObserver);},
    commandOutputDirectory:join(userDataPath,"command-output"),projects:await projectStore.listProjects(),responseDelivery:"streaming",
    commandOutputRegistry:new CommandOutputRegistry(join(userDataPath,"command-output","locators.json")),inspection,
    instructionSettings:await instructionSettingsStore.load(),contextSettings:(await contextSettingsStore.load()).settings,
    provider,providerConfigError:error,providerProfile:config.ok?config.profile:null,
    workspaceProfiles:await workspaceProfileStore.listProfiles(),threadSummaries:await threadStore.listThreadSummaries(),threadStore,
    persistenceDiagnostics:new HelarcPersistenceDiagnostics(join(userDataPath,"persistence-diagnostics.json")),
    contextManifestPersistence:contextManifestStore,runTranscriptPort:runTranscriptStore});
  if(stored){const profiles=await providerProfileStore.listProfiles(providerCredentialStore);
    controller.configureProvider({provider,profile:profiles.find(p=>p.isActive)??null,profiles,error});}
  const storage=new HelarcStorageService(userDataPath,()=>inspection.snapshot().health);
  return {storage,projectStore,inspection,instructionSettingsStore,contextSettingsStore,controller,workspaceProfileStore,
    providerProfileStore,providerCredentialStore,close:()=>storage.close()};
}
