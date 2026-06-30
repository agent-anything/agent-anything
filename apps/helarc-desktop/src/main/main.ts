import { helarcProduct } from "@agent-anything/helarc";
import { BrowserWindow, app } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HelarcMainController } from "./HelarcMainController.js";
import { registerHelarcIpc } from "./ipc.js";
import { OpenAICompatibleProvider } from "./provider/OpenAICompatibleProvider.js";
import { resolveHelarcProviderConfig } from "./provider/resolveHelarcProviderConfig.js";
import { FileHelarcWorkspaceProfileStore } from "./workspace/HelarcWorkspaceProfileStore.js";
import { createHelarcWindowOptions } from "./windowOptions.js";

const currentDir = dirname(fileURLToPath(import.meta.url));

app.whenReady().then(() => {
  void createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
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
  const providerConfig = resolveHelarcProviderConfig();
  const workspaceProfileStore = new FileHelarcWorkspaceProfileStore(
    join(app.getPath("userData"), "workspace-profiles.json"),
  );
  const controller = new HelarcMainController({
    provider: providerConfig.ok ? new OpenAICompatibleProvider(providerConfig.config) : null,
    providerConfigError: providerConfig.ok ? null : providerConfig.error,
    providerProfile: providerConfig.ok ? providerConfig.profile : null,
    workspaceProfiles: await workspaceProfileStore.listProfiles(),
  });
  registerHelarcIpc({ window, controller, workspaceProfileStore });
  window.setTitle(helarcProduct.displayName);
  window.once("ready-to-show", () => window.show());
  void window.loadFile(join(currentDir, "../renderer/index.html"));
}
