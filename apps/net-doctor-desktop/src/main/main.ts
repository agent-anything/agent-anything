import { BrowserWindow, app, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { DesktopDiagnosisRequest } from "../shared/DesktopDiagnosis.js";
import { runDesktopDiagnosis } from "../shared/runDesktopDiagnosis.js";

const currentDir = dirname(fileURLToPath(import.meta.url));

app.whenReady().then(() => {
  registerIpcHandlers();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

function registerIpcHandlers(): void {
  ipcMain.handle("netDoctor:diagnose", async (_event, request: DesktopDiagnosisRequest) => {
    return runDesktopDiagnosis({ request });
  });
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 760,
    minHeight: 560,
    title: "NetDoctor",
    webPreferences: {
      preload: join(currentDir, "../preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  void window.loadFile(join(currentDir, "../renderer/index.html"));
}
