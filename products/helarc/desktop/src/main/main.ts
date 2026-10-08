import { helarcProduct } from "@agent-anything/helarc";
import { BrowserWindow, app, dialog } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HelarcMainController } from "./HelarcMainController.js";
import { HelarcPersistenceDiagnostics } from "./persistence/HelarcPersistenceDiagnostics.js";
import { HelarcStorageService } from "./storage/HelarcStorageService.js";
import { registerHelarcIpc } from "./ipc.js";
import { FileHelarcContextManifestStore } from "./context-manifest/index.js";
import { FileHelarcModelContinuationStore } from "./model-continuity/index.js";
import { createHelarcProvider } from "./provider/createHelarcProvider.js";
import { createElectronProviderCredentialStore } from "./provider/createElectronProviderCredentialStore.js";
import { FileHelarcProviderProfileStore } from "./provider/HelarcProviderProfileStore.js";
import { resolveHelarcProviderConfig } from "./provider/resolveHelarcProviderConfig.js";
import { FileHelarcThreadStore } from "./thread/index.js";
import { FileHelarcWorkspaceProfileStore } from "./workspace/HelarcWorkspaceProfileStore.js";
import { FileHelarcProjectStore } from "./project/FileHelarcProjectStore.js";
import { createHelarcWindowOptions } from "./windowOptions.js";
import { FileHelarcRunTranscriptStore } from "./run-transcript/index.js";
import { FileHelarcInstructionSettingsStore } from "./instructions/FileHelarcInstructionSettingsStore.js";
import { HelarcInspection } from "./inspection/HelarcInspection.js";
import { CommandOutputRegistry } from "./workbench/CommandOutputRegistry.js";
import { HelarcQualificationStore } from "./qualification/HelarcQualificationStore.js";
import { HelarcQualificationService } from "./qualification/HelarcQualificationService.js";
import { DEFAULT_HELARC_RUN_LIMITS } from "./run/HelarcHostRunComposition.js";
import { HELARC_LOCAL_FILE_ACTION_ADAPTER_IDS } from "@agent-anything/helarc-local-environment/filesystem";
import { HELARC_LOCAL_SHELL_ACTION_ADAPTER_ID, HELARC_LOCAL_TASK_STOP_ACTION_ADAPTER_ID,
  selectNativeShell, projectNativeShellRuntimeProfile } from "@agent-anything/helarc-local-environment/command";

const currentDir = dirname(fileURLToPath(import.meta.url));
let inspection: Promise<HelarcInspection> | null = null;
let inspectionClosed = false;
const qualifications = new Set<HelarcQualificationService>();

app.on("before-quit", (event) => {
  if (!inspection || inspectionClosed) return;
  event.preventDefault();
  inspectionClosed = true;
  void (async () => {
    for (const qualification of qualifications) await qualification.close();
    await inspection!.then((source) => source.close());
  })().catch(() => {}).finally(() => app.quit());
});

app.whenReady().then(() => {
  void createWindow().catch(reportWindowCreationFailure);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow().catch(reportWindowCreationFailure);
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

async function createWindow(): Promise<void> {
  const window = new BrowserWindow(createHelarcWindowOptions(
    join(currentDir, "../preload/preload.cjs"),
  ));
  const userDataPath = app.getPath("userData");
  inspection ??= HelarcInspection.create(join(userDataPath, "inspection-settings.json"));
  const inspectionSource = await inspection;
  const storage = new HelarcStorageService(userDataPath, () => inspectionSource.snapshot().health);
  window.once("closed", () => storage.close());
  const instructionSettingsStore = new FileHelarcInstructionSettingsStore(join(userDataPath, "instruction-settings.json"));
  const providerCredentialStore = createElectronProviderCredentialStore(userDataPath);
  const providerProfileStore = new FileHelarcProviderProfileStore(
    join(userDataPath, "provider-profile.json"),
  );
  const storedProviderConfig = await providerProfileStore.resolveActiveProfile(providerCredentialStore);
  const providerConfig = storedProviderConfig ?? resolveHelarcProviderConfig();
  const providerReady = providerConfig.ok && providerConfig.config.model.trim().length > 0;
  const providerConfigError = !providerConfig.ok ? providerConfig.error : providerReady ? null : {
    code: "provider_config_missing" as const, message: "Select a model before starting work or verification.",
  };
  const provider = providerReady ? createHelarcProvider(providerConfig.config, inspectionSource.providerObserver) : null;
  const workspaceProfileStore = new FileHelarcWorkspaceProfileStore(
    join(userDataPath, "workspace-profiles.json"),
  );
  const threadStore = new FileHelarcThreadStore(
    join(userDataPath, "threads.json"),
  );
  const projectStore = new FileHelarcProjectStore(join(userDataPath, "projects.json"));
  const modelContinuationStore = new FileHelarcModelContinuationStore(
    join(userDataPath, "model-continuations.json"),
  );
  const contextManifestStore = new FileHelarcContextManifestStore(
    join(userDataPath, "context-manifests.json"),
  );
  const runTranscriptStore = new FileHelarcRunTranscriptStore(
    join(userDataPath, "run-transcripts"),
  );
  await Promise.all([
    modelContinuationStore.listContinuations(),
    contextManifestStore.listManifests(),
  ]);
  const controller = new HelarcMainController({
    commandOutputDirectory: join(userDataPath, "command-output"),
    projects: await projectStore.listProjects(),
    responseDelivery: "streaming",
    commandOutputRegistry: new CommandOutputRegistry(join(userDataPath, "command-output", "locators.json")),
    inspection: inspectionSource,
    instructionSettings: await instructionSettingsStore.load(),
    provider,
    providerConfigError,
    providerProfile: providerConfig.ok ? providerConfig.profile : null,
    workspaceProfiles: await workspaceProfileStore.listProfiles(),
    threadSummaries: await threadStore.listThreadSummaries(),
    threadStore,
    persistenceDiagnostics: new HelarcPersistenceDiagnostics(join(userDataPath, "persistence-diagnostics.json")),
    modelContinuationStore,
    contextManifestPersistence: contextManifestStore,
    runTranscriptPort: runTranscriptStore,
  });
  if (storedProviderConfig) {
    const profiles = await providerProfileStore.listProfiles(providerCredentialStore);
    controller.configureProvider({ provider, profile: profiles.find(p => p.isActive) ?? null, profiles, error: providerConfigError });
  }
  const shellRuntime = projectNativeShellRuntimeProfile(await selectNativeShell({
    platform: process.platform === "win32" ? "win32" : "posix", cwd: userDataPath,
    environment: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
  }));
  const qualification = new HelarcQualificationService({
    store: new HelarcQualificationStore(join(userDataPath, "model-qualification.json")),
    configuration() {
      const current = controller.getQualificationConfiguration();
      return current ? { ...current, shellRuntime, planLimits: DEFAULT_HELARC_RUN_LIMITS.plan,
        fileActionAdapterIds: HELARC_LOCAL_FILE_ACTION_ADAPTER_IDS,
        shellActionAdapterId: HELARC_LOCAL_SHELL_ACTION_ADAPTER_ID,
        taskStopActionAdapterId: HELARC_LOCAL_TASK_STOP_ACTION_ADAPTER_ID } : null;
    },
    publishCatalog: catalog => controller.configureQualificationCatalog(catalog),
  });
  await qualification.initialize();
  qualifications.add(qualification);
  window.once("closed", () => { void qualification.close().finally(() => qualifications.delete(qualification)); });
  registerHelarcIpc({
    storage,
    qualification,
    projectStore,
    inspection: inspectionSource,
    instructionSettingsStore,
    window,
    controller,
    workspaceProfileStore,
    providerProfileStore,
    providerCredentialStore,
  });
  window.setTitle(helarcProduct.displayName);
  window.once("ready-to-show", () => window.show());
  const rendererDevServerUrl = readRendererDevServerUrl(process.env);
  if (rendererDevServerUrl) {
    void window.loadURL(rendererDevServerUrl);
    return;
  }

  void window.loadFile(join(currentDir, "../renderer/index.html"));
}

function reportWindowCreationFailure(cause: unknown): void {
  const message = cause instanceof Error ? cause.message : "Helarc window creation failed.";
  console.error("Helarc window creation failed.", cause);
  dialog.showErrorBox("Helarc failed to start", message);
}

function readRendererDevServerUrl(env: NodeJS.ProcessEnv): string | null {
  const value = env.HELARC_RENDERER_DEV_SERVER_URL?.trim();
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}
