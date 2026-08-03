const { contextBridge, ipcRenderer } = require("electron");

const COMMAND_VERSION = 1;

const channels = Object.freeze({
  cancelRun: "helarc:cancel-run",
  chooseWorkspace: "helarc:choose-workspace",
  getSnapshot: "helarc:get-snapshot",
  openThread: "helarc:open-thread",
  resolvePatchReview: "helarc:resolve-patch-review",
  submitApprovalDecision: "helarc:submit-approval-decision",
  saveProviderConfig: "helarc:save-provider-config",
  selectWorkspaceProfile: "helarc:select-workspace-profile",
  snapshotUpdated: "helarc:snapshot-updated",
  startRun: "helarc:start-run",
});

contextBridge.exposeInMainWorld("helarc", Object.freeze({
  bridgeVersion: 5,
  productId: "helarc",
  chooseWorkspace: (input) => ipcRenderer.invoke(
    channels.chooseWorkspace,
    productCommand("workspace.choose", input?.commandId, {}),
  ),
  getSnapshot: () => ipcRenderer.invoke(channels.getSnapshot),
  openThread: (input) => ipcRenderer.invoke(
    channels.openThread,
    productCommand("thread.open", input?.commandId, {
      threadId: input?.threadId,
    }),
  ),
  saveProviderConfig: (input) => ipcRenderer.invoke(
    channels.saveProviderConfig,
    productCommand("provider.save", input?.commandId, {
      providerKind: input?.providerKind,
      displayName: input?.displayName,
      baseUrl: input?.baseUrl,
      model: input?.model,
      timeoutMs: input?.timeoutMs,
      apiKeyUpdate: input?.apiKeyUpdate,
      apiKey: input?.apiKey,
    }),
  ),
  selectWorkspaceProfile: (input) => ipcRenderer.invoke(
    channels.selectWorkspaceProfile,
    productCommand("workspace.select", input?.commandId, {
      profileId: input?.profileId,
    }),
  ),
  startRun: (input) => ipcRenderer.invoke(
    channels.startRun,
    productCommand("run.start", input?.commandId, {
      taskText: input?.taskText,
    }),
  ),
  cancelRun: (input) => ipcRenderer.invoke(channels.cancelRun, {
    version: COMMAND_VERSION,
    commandId: input?.commandId,
    runId: input?.runId,
    kind: "run.cancel",
    payload: {
      reason: input?.reason,
    },
  }),
  submitApprovalDecision: (input) => ipcRenderer.invoke(
    channels.submitApprovalDecision,
    {
      version: COMMAND_VERSION,
      commandId: input?.commandId,
      runId: input?.runId,
      kind: "approval.submit",
      payload: {
        submissionId: input?.submissionId,
        requestId: input?.requestId,
        pendingVersion: input?.pendingVersion,
        optionId: input?.optionId,
        grantedPermissions: input?.grantedPermissions,
        reason: input?.reason,
      },
    },
  ),
  resolvePatchReview: (input) => ipcRenderer.invoke(
    channels.resolvePatchReview,
    productCommand("patch_review.submit", input?.commandId, {
      submissionId: input?.submissionId,
      runId: input?.runId,
      proposalId: input?.proposalId,
      reviewId: input?.reviewId,
      pendingVersion: input?.pendingVersion,
      decision: input?.decision,
      reason: input?.reason,
    }),
  ),
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

function productCommand(kind, commandId, payload) {
  return {
    version: COMMAND_VERSION,
    commandId,
    kind,
    payload,
  };
}
