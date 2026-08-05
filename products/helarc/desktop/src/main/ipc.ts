import { dialog, ipcMain, type BrowserWindow } from "electron";
import type { HelarcMainController } from "./HelarcMainController.js";
import {
  projectHelarcDesktopSnapshot,
  projectHelarcHostCommandReceipt,
} from "./HelarcDesktopProjection.js";
import { createHelarcProductCommandDispatcher } from "./HelarcProductCommandDispatcher.js";
import { createHelarcProvider } from "./provider/createHelarcProvider.js";
import type { ProviderCredentialStore } from "./provider/ProviderCredentialStore.js";
import type {
  FileHelarcProviderProfileStore,
} from "./provider/HelarcProviderProfileStore.js";
import type { HelarcWorkspaceProfileStore } from "./workspace/HelarcWorkspaceProfileStore.js";

export const HELARC_IPC_CHANNELS = {
  cancelRun: "helarc:cancel-run",
  chooseWorkspace: "helarc:choose-workspace",
  getSnapshot: "helarc:get-snapshot",
  openThread: "helarc:open-thread",
  resolvePatchReview: "helarc:resolve-patch-review",
  submitApprovalDecision: "helarc:submit-approval-decision",
  saveProviderConfig: "helarc:save-provider-config",
  selectWorkspaceProfile: "helarc:select-workspace-profile",
  snapshotUpdated: "helarc:snapshot-updated",
  startRun: "helarc:start-run",
} as const;

export interface RegisterHelarcIpcInput {
  window: BrowserWindow;
  controller: HelarcMainController;
  providerCredentialStore?: ProviderCredentialStore | null;
  providerProfileStore?: FileHelarcProviderProfileStore | null;
  workspaceProfileStore?: HelarcWorkspaceProfileStore | null;
}

export function registerHelarcIpc(input: RegisterHelarcIpcInput): void {
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
        );
        if (!saved.ok) {
          return projectHelarcDesktopSnapshot(
            input.controller.configureProvider({
              provider: null,
              profile: null,
              error: {
                code: saved.error.code,
                message: saved.error.message,
              },
            }),
          );
        }

        return projectHelarcDesktopSnapshot(
          input.controller.configureProvider({
            provider: createHelarcProvider(saved.config),
            profile: saved.profile,
          }),
        );
      },
      "run.start": async (payload) => {
        const result = await input.controller.startRun(payload);
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
      "patch_review.submit": (payload) => {
        const result = input.controller.resolvePatchReview(payload);
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

  ipcMain.handle(HELARC_IPC_CHANNELS.getSnapshot, () => {
    return projectHelarcDesktopSnapshot(input.controller.getSnapshot());
  });

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

  ipcMain.handle(
    HELARC_IPC_CHANNELS.resolvePatchReview,
    (_event, command: unknown) => {
      return productCommands.dispatch(command, "patch_review.submit");
    },
  );

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
    HELARC_IPC_CHANNELS.submitApprovalDecision,
    (_event, command: unknown) => {
      const receipt = input.controller.dispatchHostCommand(
        command,
        "approval.submit",
      );
      return {
        receipt: projectHelarcHostCommandReceipt(receipt),
        snapshot: projectHelarcDesktopSnapshot(input.controller.getSnapshot()),
      };
    },
  );
}
