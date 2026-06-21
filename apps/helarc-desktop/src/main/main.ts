import { helarcProduct } from "@agent-anything/helarc";
import { BrowserWindow, app } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHelarcWindowOptions } from "./windowOptions.js";

const currentDir = dirname(fileURLToPath(import.meta.url));

app.whenReady().then(() => {
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

function createWindow(): void {
  const window = new BrowserWindow(createHelarcWindowOptions(
    join(currentDir, "../preload/preload.cjs"),
  ));
  window.setTitle(helarcProduct.displayName);
  window.once("ready-to-show", () => window.show());
  void window.loadFile(join(currentDir, "../renderer/index.html"));
}
