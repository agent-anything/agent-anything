const { contextBridge, ipcRenderer } = require("electron");

const channels = Object.freeze({
  cancelSession: "helarc:cancel-session",
  chooseWorkspace: "helarc:choose-workspace",
  getSnapshot: "helarc:get-snapshot",
  resolvePatchReview: "helarc:resolve-patch-review",
  submitApprovalDecision: "helarc:submit-approval-decision",
  saveProviderConfig: "helarc:save-provider-config",
  selectWorkspaceProfile: "helarc:select-workspace-profile",
  snapshotUpdated: "helarc:snapshot-updated",
  startSession: "helarc:start-session",
});

contextBridge.exposeInMainWorld("helarc", Object.freeze({
  bridgeVersion: 2,
  productId: "helarc",
  chooseWorkspace: () => ipcRenderer.invoke(channels.chooseWorkspace),
  getSnapshot: () => ipcRenderer.invoke(channels.getSnapshot),
  saveProviderConfig: (input) => ipcRenderer.invoke(channels.saveProviderConfig, {
    providerKind: input?.providerKind === "ollama" ? "ollama" : "openai-compatible",
    displayName: typeof input?.displayName === "string" ? input.displayName : "",
    baseUrl: typeof input?.baseUrl === "string" ? input.baseUrl : "",
    model: typeof input?.model === "string" ? input.model : "",
    timeoutMs: typeof input?.timeoutMs === "number" ? input.timeoutMs : Number(input?.timeoutMs),
    apiKeyUpdate: input?.apiKeyUpdate === "set" || input?.apiKeyUpdate === "keep" || input?.apiKeyUpdate === "clear"
      ? input.apiKeyUpdate
      : "clear",
    apiKey: typeof input?.apiKey === "string" ? input.apiKey : "",
  }),
  selectWorkspaceProfile: (input) => ipcRenderer.invoke(channels.selectWorkspaceProfile, {
    profileId: typeof input?.profileId === "string" ? input.profileId : "",
  }),
  startSession: (input) => ipcRenderer.invoke(channels.startSession, {
    taskText: typeof input?.taskText === "string" ? input.taskText : "",
  }),
  cancelSession: () => ipcRenderer.invoke(channels.cancelSession),
  submitApprovalDecision: (input) => ipcRenderer.invoke(channels.submitApprovalDecision, {
    submissionId: typeof input?.submissionId === "string" ? input.submissionId : "",
    runId: typeof input?.runId === "string" ? input.runId : "",
    requestId: typeof input?.requestId === "string" ? input.requestId : "",
    pendingVersion: typeof input?.pendingVersion === "number" ? input.pendingVersion : Number(input?.pendingVersion),
    optionId: typeof input?.optionId === "string" ? input.optionId : "",
    grantedPermissions: sanitizeGrantedPermissions(input?.grantedPermissions),
    reason: typeof input?.reason === "string" ? input.reason : null,
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

function sanitizeGrantedPermissions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fileSystem = value.fileSystem && typeof value.fileSystem === "object" && !Array.isArray(value.fileSystem)
    ? value.fileSystem
    : null;
  const network = value.network && typeof value.network === "object" && !Array.isArray(value.network)
    ? value.network
    : null;
  return {
    ...(fileSystem === null ? {} : {
      fileSystem: {
        ...(Array.isArray(fileSystem.read) ? { read: fileSystem.read.filter((item) => typeof item === "string") } : {}),
        ...(Array.isArray(fileSystem.write) ? { write: fileSystem.write.filter((item) => typeof item === "string") } : {}),
      },
    }),
    ...(network === null || typeof network.enabled !== "boolean" ? {} : {
      network: {
        enabled: network.enabled,
        ...(Array.isArray(network.domains) ? { domains: network.domains.filter((item) => typeof item === "string") } : {}),
      },
    }),
  };
}
