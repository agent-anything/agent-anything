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
import {ProviderRegistryClient} from "./provider/ProviderRegistryClient.js";
import {ProviderConfigurationService} from "./provider/ProviderConfigurationService.js";
import {createProviderSettingsService} from "./provider/ProviderSettingsService.js";
import {ElectronSafeStorageCredentialCipher} from "./provider/ElectronSafeStorageCredentialCipher.js";
import {ProviderCustodyInspectionAdapter} from "./inspection/ProviderCustodyInspectionAdapter.js";
import {connectionReleaseReader} from "./inspection/ConnectionReleaseInspection.js";
import {ProviderConnectionRetention} from "./provider/ProviderConnectionRetention.js";
import {ProviderCustodyMaintenance} from "./provider/ProviderCustodyMaintenance.js";
import {createHelarcNativeRunArrangement} from "./context/HelarcNativeRunActivityComposition.js";
import {HelarcNativeFollowUpService} from "./provider/HelarcNativeFollowUpService.js";
import {helarcConnectionCustodyEvidence} from "./provider/HelarcConnectionCustodyEvidence.js";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {ProviderConfigurationError,type ProviderConfiguration} from "../shared/ProviderConfiguration.js";
import type {ProviderExecutionEligibility} from "../shared/ProviderSettingsApi.js";

/** One application composition. Windows attach views; they do not recreate execution owners. */
export async function createHelarcApplicationServices(input:{
  readonly userDataPath:string;
  readonly inspection:HelarcInspection;
  readonly executions:HelarcExecutionStore;
  readonly diagnostics:HelarcExecutionDiagnostics;
  readonly activityHost:ReturnType<typeof createHelarcActivityHost>;
  readonly nativeExecutionEligibility?:(configuration:ProviderConfiguration)=>ProviderExecutionEligibility;
}):Promise<Omit<RegisterHelarcIpcInput,"window">&{readonly close:()=>Promise<void>}> {
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
  let custody: ProviderCustodyInspectionAdapter | undefined;
  let maintenance: ProviderCustodyMaintenance | undefined;
  let followUp: HelarcNativeFollowUpService | undefined;
  const registry = await ProviderRegistryClient.open(join(userDataPath,"provider-registry","registry.sqlite"), event => custody?.observe(event));
  try {
  const registryId = await registry.request({kind:"identity"}) as string;
  const configurations = new ProviderConfigurationService(registry, providerCredentialStore, new ElectronSafeStorageCredentialCipher(), event => custody?.observe(event));
  if (inspection.recorder) custody = new ProviderCustodyInspectionAdapter(inspection.recorder, registryId,
    connectionReleaseReader(executions.protocolJournal,id=>configurations.readPin(id)));
  const nativeArrangements=new Set<ReturnType<typeof createHelarcNativeRunArrangement>>();
  const arrangeNative=(configuration:ProviderConfiguration,connection:import("./provider/ProviderConnectionRetention.js").RetainedConnection)=>{
    const arrangement=createHelarcNativeRunArrangement(configuration,connection,configurations);nativeArrangements.add(arrangement);return arrangement;
  };
  const connectionRetention=new ProviderConnectionRetention(configurations,helarcConnectionCustodyEvidence(executions));
  maintenance = new ProviderCustodyMaintenance(configurations, async () => {
    await custody?.replay((after,limit) => configurations.events(after,limit));
  }, event => custody?.observe(event),(after,limit)=>connectionRetention.reconcilePage(after,limit));
  const controller=new HelarcMainController({activityHost,executionDiagnostics:diagnostics,executionStore:executions,
    connectionRetention,
    async bindNativeRun(configuration,productRunId){
      const original=await configurations.get(configuration.id,configuration.revision);
      if(!original||modelInputValueDigest(original)!==modelInputValueDigest(configuration))throw new ProviderConfigurationError("provider_configuration_conflict");
      return arrangeNative(original,{kind:"connection",bindingId:original.connectionBindingId,pinId:`${productRunId}:provider-connection`,acceptanceId:productRunId});
    },
    async recoverNative(saved){
      // The accepted execution basis supplies local interpreters. Connection
      // custody and credentials are resolved by the original native operation.
      return arrangeNative(saved.model.configuration,saved.model.connection);
    },
    async bindRunProvider(provider,profile,productRunId){
      let credential:HelarcRunCredentialBinding;
      const native = profile.id === "env-provider" ? null : await configurations.get(profile.id,profile.revision);
      if(native)credential={kind:"connection",bindingId:native.connectionBindingId,pinId:`${productRunId}:provider-connection`,acceptanceId:productRunId};
      else if(profile.id==="env-provider")credential=profile.credentialStatus==="present"?{kind:"environment",name:"HELARC_PROVIDER_API_KEY"}:{kind:"none"};
      else {
        if(!profile.revision)throw new Error("The original Provider configuration revision is unavailable.");
        const ref=await providerProfileStore.credentialReference(profile.id,profile.revision);
        credential=ref?{kind:"saved",ref}:{kind:"none"};
      }
      return {credential,provider:bindHelarcRunProvider({providerProfile:profile,providerBinding:retainHelarcProviderBinding(provider),providerCredential:credential},providerCredentialStore,inspection.providerObserver,process.env,configurations)};
    },
    async recoverProvider(saved){
      if(saved.version!==3)throw new TypeError("legacy_provider_cannot_restore_native_composition");
      if(saved.providerCredential.kind==="connection")await connectionRetention.recover(saved.providerCredential);
      return bindHelarcRunProvider(saved,providerCredentialStore,inspection.providerObserver,process.env,configurations);
    },
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
  const providerConfigurations = createProviderSettingsService(configurations, {
    // Release only after the complete production arrangements and G09 are verified.
    eligibility: input.nativeExecutionEligibility??(() => ({available:false,reason:"provider_native_activation_pending"})),
  }, globalThis.fetch, async () => { maintenance?.request(); });
  maintenance.request();
  let retirementOffset=0;
  followUp=new HelarcNativeFollowUpService(executions,configurations,diagnostics,()=>maintenance?.request(),async()=>{
    const candidates=[...nativeArrangements];
    const page=candidates.slice(retirementOffset,retirementOffset+8);
    retirementOffset=retirementOffset+8>=candidates.length?0:retirementOffset+8;
    for(const arrangement of page){
      const root=await arrangement.retire();
      if(root){controller.forgetRetiredNativeComposition(root);nativeArrangements.delete(arrangement);}
    }
    return {examined:page.length,more:retirementOffset!==0};
  });
  return {storage,projectStore,inspection,instructionSettingsStore,contextSettingsStore,controller,workspaceProfileStore,
    providerProfileStore,providerCredentialStore,providerConfigurations,
    startProtocolRun:async(payload,selection)=>{
      const eligibility=await providerConfigurations.eligibility(selection);
      if(!eligibility.ok||!eligibility.value.available)throw new ProviderConfigurationError("provider_arrangement_unavailable");
      const configuration=await configurations.get(selection.id,selection.revision);
      if(!configuration)throw new ProviderConfigurationError("provider_configuration_conflict");
      return controller.startRun(payload,{native:configuration});
    },
    close:async()=>{storage.close();await followUp?.close();for(const arrangement of nativeArrangements)await arrangement.close();nativeArrangements.clear();await maintenance?.close();
      try{
        if(custody&&inspection.snapshot().settings.enabled&&inspection.recorder?.health().available){
          inspection.recorder.historyProgress("started");
          try{await custody.replay((after,limit)=>configurations.events(after,limit));inspection.recorder.historyProgress("confirmed");}
          catch{inspection.recorder.historyProgress("incomplete");}
        }
      }finally{await registry.close();}
    }};
  } catch(error) { await followUp?.close();await maintenance?.close();await registry.close(); throw error; }
}
