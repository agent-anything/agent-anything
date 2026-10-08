import { dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import type { HelarcMainController } from "./HelarcMainController.js";
import {
  projectHelarcDesktopSnapshot,
  projectHelarcHostCommandReceipt,
  projectHelarcRunStatusQueryReceipt,
} from "./HelarcDesktopProjection.js";
import { createHelarcProductCommandDispatcher } from "./HelarcProductCommandDispatcher.js";
import { createHelarcProvider } from "./provider/createHelarcProvider.js";
import { HelarcProviderSelection } from "./provider/HelarcProviderSelection.js";
import type { ProviderCredentialStore } from "./provider/ProviderCredentialStore.js";
import type {
  FileHelarcProviderProfileStore,
} from "./provider/HelarcProviderProfileStore.js";
import type { HelarcWorkspaceProfileStore } from "./workspace/HelarcWorkspaceProfileStore.js";
import type { FileHelarcProjectStore } from "./project/FileHelarcProjectStore.js";
import type { FileHelarcInstructionSettingsStore } from "./instructions/FileHelarcInstructionSettingsStore.js";
import { HelarcResponseProgress } from "./workbench/HelarcResponseProgress.js";
import { readToken, workScopeValid } from "./workbench/WorkbenchReadLimits.js";

export const HELARC_IPC_CHANNELS = {
  getQualification: "helarc:get-qualification",
  readQualificationEvidence: "helarc:read-qualification-evidence",
  startQualification: "helarc:start-qualification",
  cancelQualification: "helarc:cancel-qualification",
  publishQualification: "helarc:publish-qualification",
  saveProject: "helarc:save-project",
  selectProject: "helarc:select-project",
  chooseProjectFolder: "helarc:choose-project-folder",
  readConversation: "helarc:read-conversation",
  readConversationTurn: "helarc:read-conversation-turn",
  readCurrentWork: "helarc:read-current-work",
  readTaskDetails: "helarc:read-task-details",
  readWorkHistory: "helarc:read-work-history",
  readArtifactContent: "helarc:read-artifact-content",
  readResponsePreview: "helarc:read-response-preview",
  subscribeResponseProgress: "helarc:subscribe-response-progress",
  unsubscribeResponseProgress: "helarc:unsubscribe-response-progress",
  responseProgress: "helarc:response-progress",
  listThreadRuns: "helarc:list-thread-runs",
  readCommandDetails: "helarc:read-command-details",
  readWorkbenchItem: "helarc:read-workbench-item",
  readCommandOutput: "helarc:read-command-output",
  openExternalLink: "helarc:open-external-link",
  getInspectionSettings: "helarc:get-inspection-settings",
  getStorage: "helarc:get-storage",
  cleanupStorage: "helarc:cleanup-storage",
  saveInspectionSettings: "helarc:save-inspection-settings",
  getInstructionSettings: "helarc:get-instruction-settings",
  saveInstructionSettings: "helarc:save-instruction-settings",
  cancelRun: "helarc:cancel-run",
  chooseWorkspace: "helarc:choose-workspace",
  getRunStatus: "helarc:get-run-status",
  getSnapshot: "helarc:get-snapshot",
  openThread: "helarc:open-thread",
  resumeDescendant: "helarc:resume-descendant",
  saveProviderConfig: "helarc:save-provider-config",
  discoverModels: "helarc:discover-models",
  getProviderCredentialSettings: "helarc:get-provider-credential-settings",
  selectProvider: "helarc:select-provider",
  deleteProvider: "helarc:delete-provider",
  selectWorkspaceProfile: "helarc:select-workspace-profile",
  snapshotUpdated: "helarc:snapshot-updated",
  startRun: "helarc:start-run",
  steerRun: "helarc:steer-run",
  submitInteraction: "helarc:submit-interaction",
} as const;

export interface RegisterHelarcIpcInput {
  qualification?: import("./qualification/HelarcQualificationService.js").HelarcQualificationService;
  projectStore?: FileHelarcProjectStore;
  inspection?: import("./inspection/HelarcInspection.js").HelarcInspection;
  storage?: import("./storage/HelarcStorageService.js").HelarcStorageService;
  instructionSettingsStore?: FileHelarcInstructionSettingsStore | null;
  window: BrowserWindow;
  controller: HelarcMainController;
  providerCredentialStore?: ProviderCredentialStore | null;
  providerProfileStore?: FileHelarcProviderProfileStore | null;
  workspaceProfileStore?: HelarcWorkspaceProfileStore | null;
}

export function registerHelarcIpc(input: RegisterHelarcIpcInput): void {
  const selection = input.providerProfileStore && input.providerCredentialStore
    ? new HelarcProviderSelection(input.providerProfileStore, input.providerCredentialStore) : null;
  let providerRefreshSequence = 0;
  const refreshProvider = async () => {
    if (!selection || !input.providerProfileStore || !input.providerCredentialStore) return input.controller.getSnapshot();
    const refreshSequence = ++providerRefreshSequence;
    let resolved;
    try { resolved = await selection.resolve(); }
    catch (error) {
      const stored = await input.providerProfileStore.resolveActiveProfile(input.providerCredentialStore);
      const profiles = await input.providerProfileStore.listProfiles(input.providerCredentialStore);
      if (refreshSequence !== providerRefreshSequence) return input.controller.getSnapshot();
      return input.controller.configureProvider({ provider: null, profile: stored?.ok ? stored.profile : profiles.find(p => p.isActive) ?? null, profiles,
        error: { code: "provider_config_invalid", message: error instanceof Error ? error.message : "Provider selection is unavailable." } });
    }
    const profiles = await input.providerProfileStore.listProfiles(input.providerCredentialStore);
    if (refreshSequence !== providerRefreshSequence) return input.controller.getSnapshot();
    const previous = input.controller.getQualificationConfiguration();
    const provider = resolved ? createHelarcProvider(resolved.config, input.inspection?.providerObserver) : null;
    if (previous && resolved && JSON.stringify([previous.provider.descriptor, previous.providerProfile, input.controller.getSnapshot().provider.profiles]) ===
        JSON.stringify([provider!.descriptor, resolved.profile, profiles])) return input.controller.getSnapshot();
    return input.controller.configureProvider(resolved
      ? { provider, profile: resolved.profile, profiles }
      : { provider: null, profile: null, profiles, error: { code: "provider_config_missing", message: "Add a Provider configuration." } });
  };
  const trustedSender = (event: IpcMainInvokeEvent) => event.sender === input.window.webContents &&
    event.senderFrame === input.window.webContents.mainFrame && event.senderFrame?.url === input.window.webContents.getURL();
  ipcMain.handle(HELARC_IPC_CHANNELS.getProviderCredentialSettings, async (event, query) => {
    if (!trustedSender(event) || !input.providerCredentialStore || !input.providerProfileStore ||
        !query || typeof query !== "object" || Object.keys(query).sort().join() !== "profileId,profileRevision" ||
        !((query.profileId === null && query.profileRevision === null) || (readToken(query.profileId) && readToken(query.profileRevision)))) {
      throw new Error("Invalid credential settings query.");
    }
    const selection = query.profileId === null ? { source: "safe-storage" as const }
      : await input.providerProfileStore.credentialSelection(query.profileId, query.profileRevision);
    return { windowsAvailable: await input.providerCredentialStore.windowsAvailable(), selection };
  });
  ipcMain.handle(HELARC_IPC_CHANNELS.getQualification, async (event) => {
    if (!trustedSender(event) || !input.qualification) throw new Error("Qualification is unavailable.");
    if (selection) {
      const saved = await input.providerProfileStore!.resolveActiveProfile(input.providerCredentialStore!);
      if (saved) await refreshProvider();
    }
    return input.qualification.snapshot();
  });
  ipcMain.handle(HELARC_IPC_CHANNELS.discoverModels, async (event, query) => {
    if (!trustedSender(event) || !selection || !query || Object.keys(query).sort().join() !== "model,profileId,profileRevision,refresh" ||
      !readToken(query.profileId) || !readToken(query.profileRevision) || typeof query.model !== "string" || query.model.length > 512 || typeof query.refresh !== "boolean") {
      return { ok: false, error: "Invalid model discovery request." };
    }
    return selection.discover(query);
  });
  ipcMain.handle(HELARC_IPC_CHANNELS.readQualificationEvidence, (event, query) => {
    if (!trustedSender(event) || !input.qualification || !query || Object.keys(query).length !== 2 ||
      !readToken(query.campaignId) || (query.trialId !== null && !readToken(query.trialId))) return { ok: false, error: "Invalid evidence request." };
    return input.qualification.evidence(query.campaignId, query.trialId);
  });
  for (const method of ["listThreadRuns", "readCommandDetails", "readWorkbenchItem", "readCommandOutput",
    "readConversation", "readConversationTurn", "readCurrentWork", "readTaskDetails", "readWorkHistory", "readArtifactContent", "readResponsePreview"] as const) {
    ipcMain.handle(HELARC_IPC_CHANNELS[method], (event, query) => {
      if (!trustedSender(event)) return { status: "rejected", code: "invalid_query" };
      return input.controller.workbench[method](query);
    });
  }
  const subscriptions = new Map<string,() => void>();
  const clearResponseSubscriptions = () => { for (const dispose of subscriptions.values()) dispose(); subscriptions.clear(); };
  input.window.once("closed", clearResponseSubscriptions);
  input.window.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) clearResponseSubscriptions();
  });
  input.window.webContents.on("render-process-gone", clearResponseSubscriptions);
  ipcMain.handle(HELARC_IPC_CHANNELS.subscribeResponseProgress, (event, query) => {
    const subscriptionId: unknown = query?.subscriptionId;
    if (!trustedSender(event) || !workScopeValid(query) || !readToken(subscriptionId) ||
      subscriptions.size >= 8 || subscriptions.has(subscriptionId)) return {status:"rejected",code:"invalid_query"};
    const scope = {threadId:query.threadId,productRunId:query.productRunId};
    const publisher = new HelarcResponseProgress(subscriptionId,scope,frame => {
      if (!input.window.isDestroyed()) input.window.webContents.send(HELARC_IPC_CHANNELS.responseProgress,frame);
    });
    const detach = input.controller.subscribeResponsePreviews(scope,(state,attempt) => publisher.observe(state,attempt));
    if (!detach) {publisher.dispose(); return {status:"rejected",code:"not_found"};}
    subscriptions.set(subscriptionId,() => {detach();publisher.dispose();});
    return {status:"subscribed"};
  });
  ipcMain.handle(HELARC_IPC_CHANNELS.unsubscribeResponseProgress, (event, query) => {
    if (!trustedSender(event) || !readToken(query?.subscriptionId)) return {status:"rejected",code:"invalid_query"};
    subscriptions.get(query.subscriptionId)?.();subscriptions.delete(query.subscriptionId);
    return {status:"unsubscribed"};
  });
  ipcMain.handle(HELARC_IPC_CHANNELS.openExternalLink, async (event, inputLink: unknown) => {
    if (!trustedSender(event) || !inputLink || typeof inputLink !== "object" || !("url" in inputLink) || typeof inputLink.url !== "string" || inputLink.url.length > 8192) return { ok: false };
    try { const url = new URL(inputLink.url); if (!["http:", "https:"].includes(url.protocol)) return { ok: false }; await shell.openExternal(url.href); return { ok: true }; }
    catch { return { ok: false }; }
  });
  const unsubscribe = input.controller.subscribeSnapshot((snapshot) => {
    if (!input.window.isDestroyed()) {
      input.window.webContents.send(
        HELARC_IPC_CHANNELS.snapshotUpdated,
        projectHelarcDesktopSnapshot(snapshot),
      );
    }
  });
  input.window.once("closed", unsubscribe);

  const productCommands = createHelarcProductCommandDispatcher({
    handlers: {
      "qualification.start": async ({ targetId }) => {
        if (selection && await input.providerProfileStore!.resolveActiveProfile(input.providerCredentialStore!)) await refreshProvider();
        return input.qualification?.start(targetId) ?? { ok: false, error: "Qualification is unavailable." };
      },
      "qualification.cancel": ({ campaignId }) => input.qualification?.cancel(campaignId) ?? { ok: false, error: "Qualification is unavailable." },
      "qualification.publish": async ({ campaignId, targetId, reviewed }) => {
        if (selection && await input.providerProfileStore!.resolveActiveProfile(input.providerCredentialStore!)) await refreshProvider();
        return input.qualification?.publish(campaignId, targetId, reviewed) ?? { ok: false, error: "Qualification is unavailable." };
      },
      "project.select": ({ projectId }) => projectHelarcDesktopSnapshot(input.controller.selectProject(projectId)),
      "project.chooseFolder": async () => {
        if (!input.workspaceProfileStore) throw new Error("Folder storage is unavailable.");
        const result = await dialog.showOpenDialog(input.window, { properties: ["openDirectory"], title: "Add Project folder" });
        if (result.canceled || !result.filePaths[0]) return { profile: null, error: null, snapshot: projectHelarcDesktopSnapshot(input.controller.getSnapshot()) };
        const remembered = await input.workspaceProfileStore.rememberWorkspacePath(result.filePaths[0]);
        if (!remembered.ok) return { profile: null, error: remembered.error.message, snapshot: projectHelarcDesktopSnapshot(input.controller.getSnapshot()) };
        return { profile: remembered.profile, error: null, snapshot: projectHelarcDesktopSnapshot(input.controller.setWorkspaceProfiles(remembered.profiles)) };
      },
      "project.save": async (payload) => {
        if (!input.projectStore || !input.workspaceProfileStore) throw new Error("Project storage is unavailable.");
        for (const id of [payload.primaryProfileId, ...payload.additionalProfileIds]) {
          const resolved = await input.workspaceProfileStore.resolveWorkspaceProfile(id);
          if (!resolved.ok) return { ok: false, error: resolved.error.message, snapshot: projectHelarcDesktopSnapshot(input.controller.getSnapshot()) };
          input.controller.setWorkspaceProfiles(resolved.profiles);
        }
        try {
          const projects = await input.projectStore.save(payload);
          return { ok: true, error: null, snapshot: projectHelarcDesktopSnapshot(input.controller.setProjects(projects)) };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : "Project could not be saved.", snapshot: projectHelarcDesktopSnapshot(input.controller.getSnapshot()) };
        }
      },
      "inspection.save": async ({ settings }) => {
        if (!input.inspection) throw new Error("Inspection source is unavailable.");
        return input.inspection.save(settings);
      },
      "storage.cleanup": ({ recordingIds }) => {
        if (!input.storage) throw new Error("Storage maintenance is unavailable.");
        return input.storage.cleanup(recordingIds);
      },
      "instructions.save": async ({ settings }) => {
        if (!input.instructionSettingsStore) throw new Error("Instruction settings storage is unavailable.");
        const saved = await input.instructionSettingsStore.save(settings);
        return input.controller.configureInstructions(saved);
      },
      "workspace.choose": async () => {
        const result = await dialog.showOpenDialog(input.window, {
          properties: ["openDirectory"],
          title: "Choose workspace",
        });

        if (result.canceled || result.filePaths.length === 0) {
          return projectHelarcDesktopSnapshot(input.controller.getSnapshot());
        }

        const workspacePath = result.filePaths[0] ?? "";
        if (!input.workspaceProfileStore) {
          return projectHelarcDesktopSnapshot(
            input.controller.selectWorkspacePath(workspacePath),
          );
        }

        const remembered = await input.workspaceProfileStore.rememberWorkspacePath(
          workspacePath,
        );
        if (!remembered.ok) {
          return projectHelarcDesktopSnapshot(
            input.controller.failWorkspaceSelection(
              remembered.error.code,
              remembered.error.message,
            ),
          );
        }

        input.controller.setWorkspaceProfiles(remembered.profiles);
        return projectHelarcDesktopSnapshot(
          input.controller.selectWorkspaceProfile(remembered.profile),
        );
      },
      "workspace.select": async (payload) => {
        if (!input.workspaceProfileStore) {
          return projectHelarcDesktopSnapshot(
            input.controller.failWorkspaceSelection(
              "workspace_profile_not_found",
              "Workspace profile was not found.",
            ),
          );
        }

        const resolved = await input.workspaceProfileStore.resolveWorkspaceProfile(
          payload.profileId,
        );
        if (!resolved.ok) {
          return projectHelarcDesktopSnapshot(
            input.controller.failWorkspaceSelection(
              resolved.error.code,
              resolved.error.message,
            ),
          );
        }

        input.controller.setWorkspaceProfiles(resolved.profiles);
        return projectHelarcDesktopSnapshot(
          input.controller.selectWorkspaceProfile(resolved.profile),
        );
      },
      "provider.save": async (payload) => {
        if (!input.providerProfileStore || !input.providerCredentialStore) {
          return projectHelarcDesktopSnapshot(
            input.controller.configureProvider({
              provider: null,
              profile: null,
              error: {
                code: "provider_config_missing",
                message: "Provider profile storage is unavailable.",
              },
            }),
          );
        }

        const saved = await input.providerProfileStore.saveActiveProfile(
          payload,
          input.providerCredentialStore,
          config => selection!.validateSavedSelection(config),
        );
        if (!saved.ok) {
          return projectHelarcDesktopSnapshot(input.controller.reportProviderError(saved.error.message));
        }
        const snapshot = await refreshProvider();
        return projectHelarcDesktopSnapshot(saved.cleanupWarning ? input.controller.reportProviderError(saved.cleanupWarning) : snapshot);
      },
      "provider.select": async ({ profileId }) => {
        if (!input.providerProfileStore || !input.providerCredentialStore) throw new Error("Provider storage unavailable.");
        const selected = await input.providerProfileStore.selectActiveProfile(profileId, input.providerCredentialStore);
        if (!selected.ok && selected.error.code === "provider_profile_not_found") return projectHelarcDesktopSnapshot(input.controller.reportProviderError(selected.error.message));
        try { return projectHelarcDesktopSnapshot(await refreshProvider()); }
        catch (error) { return projectHelarcDesktopSnapshot(input.controller.reportProviderError(error instanceof Error ? error.message : "Provider selection failed.")); }
      },
      "provider.delete": async ({ profileId, expectedRevision }) => {
        if (!input.providerProfileStore || !input.providerCredentialStore) throw new Error("Provider storage unavailable.");
        const warning = await input.providerProfileStore.deleteProfile(profileId, expectedRevision, input.providerCredentialStore);
        const snapshot = await refreshProvider();
        return projectHelarcDesktopSnapshot(warning ? input.controller.reportProviderError(warning) : snapshot);
      },
      "run.start": async (payload) => {
        let resolved;
        try { resolved = await selection?.resolve(payload.modelSelection); }
        catch (error) {
          const snapshot = input.controller.reportProviderError(error instanceof Error ? error.message : "Provider selection failed.");
          return { ok: false as const, error: { code: "provider_config_invalid", message: snapshot.error!.message }, snapshot: projectHelarcDesktopSnapshot(snapshot) };
        }
        const result = await input.controller.startRun(payload, resolved ? { provider: createHelarcProvider(resolved.config, input.inspection?.providerObserver), profile: resolved.profile } : undefined);
        return result.ok
          ? {
              ok: true,
              taskId: result.taskId,
              productRunId: result.productRunId,
              threadId: result.threadId,
              snapshot: projectHelarcDesktopSnapshot(result.snapshot),
            }
          : {
              ok: false,
              error: { code: result.error.code, message: result.error.message },
              snapshot: projectHelarcDesktopSnapshot(result.snapshot),
            };
      },
      "thread.open": async (payload) => {
        const result = await input.controller.openThread(payload.threadId);
        return result.ok
          ? {
              ok: true,
              snapshot: projectHelarcDesktopSnapshot(result.snapshot),
            }
          : {
              ok: false,
              error: { code: result.error.code, message: result.error.message },
              snapshot: projectHelarcDesktopSnapshot(result.snapshot),
            };
      },
    },
  });
  for (const [channel, kind] of [
    [HELARC_IPC_CHANNELS.startQualification, "qualification.start"],
    [HELARC_IPC_CHANNELS.cancelQualification, "qualification.cancel"],
    [HELARC_IPC_CHANNELS.publishQualification, "qualification.publish"],
    [HELARC_IPC_CHANNELS.saveProject, "project.save"],
    [HELARC_IPC_CHANNELS.selectProject, "project.select"],
    [HELARC_IPC_CHANNELS.chooseProjectFolder, "project.chooseFolder"],
    [HELARC_IPC_CHANNELS.selectProvider, "provider.select"],
    [HELARC_IPC_CHANNELS.deleteProvider, "provider.delete"],
  ] as const) {
    ipcMain.handle(channel, (event, command: unknown) => {
      if (!trustedSender(event)) throw new Error("Untrusted Project request.");
      return productCommands.dispatch(command, kind);
    });
  }

  ipcMain.handle(HELARC_IPC_CHANNELS.getSnapshot, () => {
    return projectHelarcDesktopSnapshot(input.controller.getSnapshot());
  });

  ipcMain.handle(HELARC_IPC_CHANNELS.getInstructionSettings, () => input.controller.getInstructionSettings());
  ipcMain.handle(HELARC_IPC_CHANNELS.getInspectionSettings, () => {
    if (!input.inspection) throw new Error("Inspection source is unavailable.");
    return input.inspection.snapshot();
  });
  ipcMain.handle(HELARC_IPC_CHANNELS.saveInspectionSettings, (_event, command: unknown) => productCommands.dispatch(command, "inspection.save"));
  ipcMain.handle(HELARC_IPC_CHANNELS.getStorage, (event) => {
    if (!trustedSender(event) || !input.storage) throw new Error("Storage is unavailable.");
    return input.storage.snapshot();
  });
  ipcMain.handle(HELARC_IPC_CHANNELS.cleanupStorage, (event, command: unknown) => {
    if (!trustedSender(event)) throw new Error("Storage is unavailable.");
    return productCommands.dispatch(command, "storage.cleanup");
  });
  ipcMain.handle(HELARC_IPC_CHANNELS.saveInstructionSettings, (_event, command: unknown) =>
    productCommands.dispatch(command, "instructions.save"));

  ipcMain.handle(HELARC_IPC_CHANNELS.chooseWorkspace, (_event, command: unknown) => {
    return productCommands.dispatch(command, "workspace.choose");
  });

  ipcMain.handle(
    HELARC_IPC_CHANNELS.selectWorkspaceProfile,
    (_event, command: unknown) => {
      return productCommands.dispatch(command, "workspace.select");
    },
  );

  ipcMain.handle(
    HELARC_IPC_CHANNELS.saveProviderConfig,
    (_event, command: unknown) => {
      return productCommands.dispatch(command, "provider.save");
    },
  );

  ipcMain.handle(HELARC_IPC_CHANNELS.startRun, (_event, command: unknown) => {
    return productCommands.dispatch(command, "run.start");
  });

  ipcMain.handle(HELARC_IPC_CHANNELS.openThread, (_event, command: unknown) => {
    return productCommands.dispatch(command, "thread.open");
  });

  ipcMain.handle(HELARC_IPC_CHANNELS.cancelRun, (_event, command: unknown) => {
    const receipt = input.controller.dispatchHostCommand(command, "run.cancel");
    return {
      receipt: projectHelarcHostCommandReceipt(receipt),
      snapshot: projectHelarcDesktopSnapshot(input.controller.getSnapshot()),
    };
  });

  ipcMain.handle(
    HELARC_IPC_CHANNELS.steerRun,
    (_event, command: unknown) => {
      const receipt = input.controller.dispatchHostCommand(
        command,
        "run.steer",
      );
      return {
        receipt: projectHelarcHostCommandReceipt(receipt),
        snapshot: projectHelarcDesktopSnapshot(input.controller.getSnapshot()),
      };
    },
  );

  ipcMain.handle(
    HELARC_IPC_CHANNELS.resumeDescendant,
    (_event, command: unknown) => {
      const receipt = input.controller.dispatchHostCommand(
        command,
        "descendant.resume",
      );
      return {
        receipt: projectHelarcHostCommandReceipt(receipt),
        snapshot: projectHelarcDesktopSnapshot(input.controller.getSnapshot()),
      };
    },
  );

  ipcMain.handle(
    HELARC_IPC_CHANNELS.submitInteraction,
    (_event, command: unknown) => {
      const receipt = input.controller.dispatchHostCommand(
        command,
        "interaction.submit",
      );
      return {
        receipt: projectHelarcHostCommandReceipt(receipt),
        snapshot: projectHelarcDesktopSnapshot(input.controller.getSnapshot()),
      };
    },
  );

  ipcMain.handle(HELARC_IPC_CHANNELS.getRunStatus, (_event, query: unknown) => {
    return {
      receipt: projectHelarcRunStatusQueryReceipt(
        input.controller.queryRunStatus(query),
      ),
      snapshot: projectHelarcDesktopSnapshot(input.controller.getSnapshot()),
    };
  });
}
