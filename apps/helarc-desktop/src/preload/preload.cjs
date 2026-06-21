const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("helarc", Object.freeze({
  bridgeVersion: 1,
  productId: "helarc",
}));
