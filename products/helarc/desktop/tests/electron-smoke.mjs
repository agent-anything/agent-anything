import { app, BrowserWindow } from "electron";
import { fileURLToPath } from "node:url";
import { HelarcMainController } from "../dist/main/HelarcMainController.js";
import { registerHelarcIpc } from "../dist/main/ipc.js";
import { createHelarcWindowOptions } from "../dist/main/windowOptions.js";
app.setPath("userData", process.env.HELARC_SMOKE_USER_DATA);
void app.whenReady().then(async () => {
  const window = new BrowserWindow(
    createHelarcWindowOptions(
      fileURLToPath(new URL("../dist/preload/preload.cjs", import.meta.url)),
    ),
  );
  registerHelarcIpc({ window, controller: new HelarcMainController() });
  await window.loadFile(
    fileURLToPath(new URL("../dist/renderer/index.html", import.meta.url)),
  );
});
