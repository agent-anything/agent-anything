const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("netDoctor", {
  diagnose(request) {
    return ipcRenderer.invoke("netDoctor:diagnose", request);
  },
});
