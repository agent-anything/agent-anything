import { dialog, ipcMain, type BrowserWindow } from "electron";
import type { HelarcMainController } from "./HelarcMainController.js";

export const HELARC_IPC_CHANNELS = {
  chooseWorkspace: "helarc:choose-workspace",
  getSnapshot: "helarc:get-snapshot",
  resolvePermission: "helarc:resolve-permission",
  snapshotUpdated: "helarc:snapshot-updated",
  startSession: "helarc:start-session",
} as const;

export interface RegisterHelarcIpcInput {
  window: BrowserWindow;
  controller: HelarcMainController;
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

    return input.controller.selectWorkspacePath(result.filePaths[0] ?? "");
  });

  ipcMain.handle(HELARC_IPC_CHANNELS.startSession, (_event, payload: unknown) => {
    const taskText = readTaskText(payload);
    return input.controller.startSession({ taskText });
  });

  ipcMain.handle(HELARC_IPC_CHANNELS.resolvePermission, (_event, payload: unknown) => {
    return input.controller.resolvePermission(readPermissionDecision(payload));
  });
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
