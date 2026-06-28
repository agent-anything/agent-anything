const { contextBridge, ipcRenderer } = require("electron");

const channels = Object.freeze({
  chooseWorkspace: "helarc:choose-workspace",
  getSnapshot: "helarc:get-snapshot",
  resolvePatchReview: "helarc:resolve-patch-review",
  resolvePermission: "helarc:resolve-permission",
  snapshotUpdated: "helarc:snapshot-updated",
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
  resolvePermission: (input) => ipcRenderer.invoke(channels.resolvePermission, {
    requestId: typeof input?.requestId === "string" ? input.requestId : "",
    decision: input?.decision === "granted" ? "granted" : "denied",
  }),
  resolvePatchReview: (input) => ipcRenderer.invoke(channels.resolvePatchReview, {
    patchId: typeof input?.patchId === "string" ? input.patchId : "",
    decision: input?.decision === "accepted" ? "accepted" : "rejected",
    reason: typeof input?.reason === "string" ? input.reason : undefined,
  }),
  subscribeSnapshot: (listener) => {
    const safeListener = (_event, snapshot) => {
      if (typeof listener === "function") {
        listener(snapshot);
      }
    };
    ipcRenderer.on(channels.snapshotUpdated, safeListener);
    return () => {
      ipcRenderer.removeListener(channels.snapshotUpdated, safeListener);
    };
  },
}));
