const { contextBridge, ipcRenderer } = require("electron");

const COMMAND_VERSION = 1;

const channels = Object.freeze({
  cancelRun: "helarc:cancel-run",
  chooseWorkspace: "helarc:choose-workspace",
  getRunStatus: "helarc:get-run-status",
  getSnapshot: "helarc:get-snapshot",
  openThread: "helarc:open-thread",
  resumeDescendant: "helarc:resume-descendant",
  saveProviderConfig: "helarc:save-provider-config",
  selectWorkspaceProfile: "helarc:select-workspace-profile",
  snapshotUpdated: "helarc:snapshot-updated",
  startRun: "helarc:start-run",
  steerRun: "helarc:steer-run",
  submitInteraction: "helarc:submit-interaction",
});

contextBridge.exposeInMainWorld("helarc", Object.freeze({
  bridgeVersion: 11,
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
      ollamaRuntime: input?.ollamaRuntime == null
        ? input?.ollamaRuntime
        : {
            contextWindowTokens: input.ollamaRuntime.contextWindowTokens,
            maximumOutputTokens: input.ollamaRuntime.maximumOutputTokens,
          },
      qualificationPolicy: input?.qualificationPolicy,
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
      target: input?.target?.kind === "continue_thread"
        ? {
            kind: input.target.kind,
            threadId: input.target.threadId,
          }
        : {
            kind: input?.target?.kind,
          },
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
  steerRun: (input) => ipcRenderer.invoke(channels.steerRun, {
    version: COMMAND_VERSION,
    commandId: input?.commandId,
    runId: input?.runId,
    kind: "run.steer",
    payload: {
      expectedRunRevision: input?.expectedRunRevision,
      instruction: input?.instruction,
    },
  }),
  resumeDescendant: (input) => ipcRenderer.invoke(channels.resumeDescendant, {
    version: COMMAND_VERSION,
    commandId: input?.commandId,
    runId: input?.runId,
    kind: "descendant.resume",
    payload: {
      request: input?.request,
      relation: input?.relation,
      child: input?.child,
      expectedRunRevision: input?.expectedRunRevision,
      suspension: {
        run: input?.child,
        id: input?.suspension?.id,
        revision: input?.suspension?.revision,
      },
      reason: input?.reason,
    },
  }),
  submitInteraction: (input) => ipcRenderer.invoke(channels.submitInteraction, {
    version: COMMAND_VERSION,
    commandId: input?.commandId,
    runId: input?.runId,
    kind: "interaction.submit",
    payload: {
      request: input?.request,
      submissionId: input?.submissionId,
      payload: input?.payload,
    },
  }),
  getRunStatus: (input) => ipcRenderer.invoke(channels.getRunStatus, {
    version: COMMAND_VERSION,
    queryId: input?.queryId,
    runId: input?.runId,
    kind: "run.status",
    payload: {},
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

function productCommand(kind, commandId, payload) {
  return {
    version: COMMAND_VERSION,
    commandId,
    kind,
    payload,
  };
}
