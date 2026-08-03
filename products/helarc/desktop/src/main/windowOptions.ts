import type { BrowserWindowConstructorOptions } from "electron";

export function createHelarcWindowOptions(
  preloadPath: string,
): BrowserWindowConstructorOptions {
  return {
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    title: "Helarc",
    backgroundColor: "#f4f5f3",
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
}
