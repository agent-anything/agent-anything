import { dialog, ipcMain, type BrowserWindow } from "electron";
import type { HelarcMainController } from "./HelarcMainController.js";

export const HELARC_IPC_CHANNELS = {
  chooseWorkspace: "helarc:choose-workspace",
  getSnapshot: "helarc:get-snapshot",
  startSession: "helarc:start-session",
} as const;

export interface RegisterHelarcIpcInput {
  window: BrowserWindow;
  controller: HelarcMainController;
}

export function registerHelarcIpc(input: RegisterHelarcIpcInput): void {
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
}

function readTaskText(payload: unknown): string {
  if (!isRecord(payload)) {
    return "";
  }

  const value = payload.taskText;
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
