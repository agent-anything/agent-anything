import { helarcProduct } from "@agent-anything/helarc";
import { BrowserWindow, app } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HelarcMainController } from "./HelarcMainController.js";
import { registerHelarcIpc } from "./ipc.js";
import { createHelarcProvider } from "./provider/createHelarcProvider.js";
import { createElectronProviderCredentialStore } from "./provider/createElectronProviderCredentialStore.js";
import { FileHelarcProviderProfileStore } from "./provider/HelarcProviderProfileStore.js";
import { resolveHelarcProviderConfig } from "./provider/resolveHelarcProviderConfig.js";
import { FileHelarcSessionHistoryStore } from "./session-history/HelarcSessionHistoryStore.js";
import { FileHelarcThreadStore } from "./thread/index.js";
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
  const userDataPath = app.getPath("userData");
  const providerCredentialStore = createElectronProviderCredentialStore(userDataPath);
  const providerProfileStore = new FileHelarcProviderProfileStore(
    join(userDataPath, "provider-profile.json"),
  );
  const storedProviderConfig = await providerProfileStore.resolveActiveProfile(providerCredentialStore);
  const providerConfig = storedProviderConfig ?? resolveHelarcProviderConfig();
  const workspaceProfileStore = new FileHelarcWorkspaceProfileStore(
    join(userDataPath, "workspace-profiles.json"),
  );
  const sessionHistoryStore = new FileHelarcSessionHistoryStore(
    join(userDataPath, "session-history.json"),
  );
  const threadStore = new FileHelarcThreadStore(
    join(userDataPath, "threads.json"),
  );
  const controller = new HelarcMainController({
    provider: providerConfig.ok ? createHelarcProvider(providerConfig.config) : null,
    providerConfigError: providerConfig.ok ? null : providerConfig.error,
    providerProfile: providerConfig.ok ? providerConfig.profile : null,
    workspaceProfiles: await workspaceProfileStore.listProfiles(),
    sessionHistory: await sessionHistoryStore.listRecords(),
    threadStore,
    onSessionHistoryRecord: (record) => sessionHistoryStore.appendRecord(record),
  });
  registerHelarcIpc({
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
