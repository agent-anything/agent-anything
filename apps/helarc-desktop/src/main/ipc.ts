import { dialog, ipcMain, type BrowserWindow } from "electron";
import type { HelarcMainController } from "./HelarcMainController.js";
import type { HelarcWorkspaceProfileStore } from "./workspace/HelarcWorkspaceProfileStore.js";

export const HELARC_IPC_CHANNELS = {
  chooseWorkspace: "helarc:choose-workspace",
  getSnapshot: "helarc:get-snapshot",
  resolvePatchReview: "helarc:resolve-patch-review",
  resolvePermission: "helarc:resolve-permission",
  selectWorkspaceProfile: "helarc:select-workspace-profile",
  snapshotUpdated: "helarc:snapshot-updated",
  startSession: "helarc:start-session",
} as const;

export interface RegisterHelarcIpcInput {
  window: BrowserWindow;
  controller: HelarcMainController;
  workspaceProfileStore?: HelarcWorkspaceProfileStore | null;
}

export function registerHelarcIpc(input: RegisterHelarcIpcInput): void {
  const unsubscribe = input.controller.subscribeSnapshot((snapshot) => {
    if (!input.window.isDestroyed()) {
      input.window.webContents.send(HELARC_IPC_CHANNELS.snapshotUpdated, snapshot);
    }
  });
  input.window.once("closed", unsubscribe);

  ipcMain.handle(HELARC_IPC_CHANNELS.getSnapshot, () => input.controller.getSnapshot());

  ipcMain.handle(HELARC_IPC_CHANNELS.chooseWorkspace, async () => {
    const result = await dialog.showOpenDialog(input.window, {
      properties: ["openDirectory"],
      title: "Choose workspace",
    });

    if (result.canceled || result.filePaths.length === 0) {
      return input.controller.getSnapshot();
    }

    const workspacePath = result.filePaths[0] ?? "";
    if (!input.workspaceProfileStore) {
      return input.controller.selectWorkspacePath(workspacePath);
    }

    const remembered = await input.workspaceProfileStore.rememberWorkspacePath(workspacePath);
    if (!remembered.ok) {
      return input.controller.failWorkspaceSelection(
        remembered.error.code,
        remembered.error.message,
      );
    }

    input.controller.setWorkspaceProfiles(remembered.profiles);
    return input.controller.selectWorkspaceProfile(remembered.profile);
  });

  ipcMain.handle(HELARC_IPC_CHANNELS.selectWorkspaceProfile, async (_event, payload: unknown) => {
    if (!input.workspaceProfileStore) {
      return input.controller.failWorkspaceSelection(
        "workspace_profile_not_found",
        "Workspace profile was not found.",
      );
    }

    const resolved = await input.workspaceProfileStore.resolveWorkspaceProfile(readProfileId(payload));
    if (!resolved.ok) {
      return input.controller.failWorkspaceSelection(
        resolved.error.code,
        resolved.error.message,
      );
    }

    input.controller.setWorkspaceProfiles(resolved.profiles);
    return input.controller.selectWorkspaceProfile(resolved.profile);
  });

  ipcMain.handle(HELARC_IPC_CHANNELS.startSession, (_event, payload: unknown) => {
    const taskText = readTaskText(payload);
    return input.controller.startSession({ taskText });
  });

  ipcMain.handle(HELARC_IPC_CHANNELS.resolvePermission, (_event, payload: unknown) => {
    return input.controller.resolvePermission(readPermissionDecision(payload));
  });

  ipcMain.handle(HELARC_IPC_CHANNELS.resolvePatchReview, (_event, payload: unknown) => {
    return input.controller.resolvePatchReview(readPatchReviewDecision(payload));
  });
}

function readProfileId(payload: unknown): string {
  if (!isRecord(payload)) {
    return "";
  }

  return typeof payload.profileId === "string" ? payload.profileId : "";
}

function readTaskText(payload: unknown): string {
  if (!isRecord(payload)) {
    return "";
  }

  const value = payload.taskText;
  return typeof value === "string" ? value : "";
}

function readPermissionDecision(payload: unknown): { requestId: string; decision: "granted" | "denied" } {
  if (!isRecord(payload)) {
    return { requestId: "", decision: "denied" };
  }

  return {
    requestId: typeof payload.requestId === "string" ? payload.requestId : "",
    decision: payload.decision === "granted" ? "granted" : "denied",
  };
}

function readPatchReviewDecision(
  payload: unknown,
): { patchId: string; decision: "accepted" | "rejected"; reason?: string } {
  if (!isRecord(payload)) {
    return { patchId: "", decision: "rejected", reason: "Rejected by invalid request." };
  }

  return {
    patchId: typeof payload.patchId === "string" ? payload.patchId : "",
    decision: payload.decision === "accepted" ? "accepted" : "rejected",
    reason: typeof payload.reason === "string" ? payload.reason : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
