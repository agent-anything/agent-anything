const { contextBridge, ipcRenderer } = require("electron");

const channels = Object.freeze({
  chooseWorkspace: "helarc:choose-workspace",
  getSnapshot: "helarc:get-snapshot",
  startSession: "helarc:start-session",
});

contextBridge.exposeInMainWorld("helarc", Object.freeze({
  bridgeVersion: 1,
  productId: "helarc",
  chooseWorkspace: () => ipcRenderer.invoke(channels.chooseWorkspace),
  getSnapshot: () => ipcRenderer.invoke(channels.getSnapshot),
  startSession: (input) => ipcRenderer.invoke(channels.startSession, {
    taskText: typeof input?.taskText === "string" ? input.taskText : "",
  }),
}));
