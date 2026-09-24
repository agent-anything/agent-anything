const { contextBridge, ipcRenderer } = require("electron");

const COMMAND_VERSION = 1;
let responseSubscriptionNumber = 0;
const workScope = (input) => ({ threadId: input?.threadId, productRunId: input?.productRunId });
const taskScope = (input) => ({ ...workScope(input), runId: input?.runId });

const channels = Object.freeze({
  saveProject: "helarc:save-project",
  selectProject: "helarc:select-project",
  chooseProjectFolder: "helarc:choose-project-folder",
  getInspectionSettings: "helarc:get-inspection-settings",
  saveInspectionSettings: "helarc:save-inspection-settings",
  getInstructionSettings: "helarc:get-instruction-settings",
  saveInstructionSettings: "helarc:save-instruction-settings",
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
  saveProject: (input) => ipcRenderer.invoke(channels.saveProject, productCommand("project.save", input?.commandId, {
    id: input?.id, expectedRevision: input?.expectedRevision, name: input?.name,
    primaryProfileId: input?.primaryProfileId, additionalProfileIds: input?.additionalProfileIds,
  })),
  selectProject: (input) => ipcRenderer.invoke(channels.selectProject, productCommand("project.select", input?.commandId, { projectId: input?.projectId })),
  chooseProjectFolder: (input) => ipcRenderer.invoke(channels.chooseProjectFolder, productCommand("project.chooseFolder", input?.commandId, {})),
  readConversation: (input) => ipcRenderer.invoke("helarc:read-conversation", {threadId:input?.threadId,position:input?.position?.kind === "before" ? {kind:"before",cursor:input.position.cursor} : {kind:input?.position?.kind}}),
  readCurrentWork: (input) => ipcRenderer.invoke("helarc:read-current-work", {...workScope(input),collection:input?.collection,cursor:input?.cursor}),
  readTaskDetails: (input) => ipcRenderer.invoke("helarc:read-task-details", taskScope(input)),
  readWorkHistory: (input) => ipcRenderer.invoke("helarc:read-work-history", {...taskScope(input),collection:input?.collection,cursor:input?.cursor}),
  readArtifactContent: (input) => ipcRenderer.invoke("helarc:read-artifact-content", {threadId:input?.threadId,artifactId:input?.artifactId,cursor:input?.cursor}),
  readResponsePreview: (input) => ipcRenderer.invoke("helarc:read-response-preview", {...taskScope(input),invocationId:input?.invocationId,cursor:input?.cursor}),
  subscribeResponseProgress: async (input, listener) => {
    const scope = workScope(input);
    const subscriptionId = `response-${++responseSubscriptionNumber}`;
    let disposed = false;
    const safeListener = (_event, frame) => {
      if (!disposed && frame?.subscriptionId === subscriptionId && frame?.scope?.threadId === scope.threadId &&
        frame?.scope?.productRunId === scope.productRunId && typeof listener === "function") listener(frame);
    };
    ipcRenderer.on("helarc:response-progress", safeListener);
    const remove = () => {disposed = true;ipcRenderer.removeListener("helarc:response-progress",safeListener);};
    try {
      const receipt = await ipcRenderer.invoke("helarc:subscribe-response-progress", {...scope,subscriptionId});
      if (receipt.status !== "subscribed") {remove();return receipt;}
      return {status:"subscribed",dispose:() => {
        if (disposed) return;
        remove();
        void ipcRenderer.invoke("helarc:unsubscribe-response-progress",{subscriptionId}).catch(() => {});
      }};
    } catch { remove();return {status:"rejected",code:"read_failed"}; }
  },
  listThreadRuns: (input) => ipcRenderer.invoke("helarc:list-thread-runs", { threadId: input?.threadId }),
  readCommandDetails: (input) => ipcRenderer.invoke("helarc:read-command-details", { threadId: input?.threadId, productRunId: input?.productRunId, runId: input?.runId, executionId: input?.executionId }),
  readWorkbenchItem: (input) => ipcRenderer.invoke("helarc:read-workbench-item", { threadId: input?.threadId, productRunId: input?.productRunId, runId: input?.runId, itemId: input?.itemId, offset: input?.offset, section: input?.section }),
  readCommandOutput: (input) => ipcRenderer.invoke("helarc:read-command-output", { threadId: input?.threadId, productRunId: input?.productRunId, runId: input?.runId, executionId: input?.executionId, cursor: input?.cursor }),
  openExternalLink: (input) => ipcRenderer.invoke("helarc:open-external-link", { url: input?.url }),
  getInspectionSettings: () => ipcRenderer.invoke(channels.getInspectionSettings),
  saveInspectionSettings: (input) => ipcRenderer.invoke(channels.saveInspectionSettings, productCommand("inspection.save", input?.commandId, { settings: input?.settings })),
  getInstructionSettings: () => ipcRenderer.invoke(channels.getInstructionSettings),
  saveInstructionSettings: (input) => ipcRenderer.invoke(
    channels.saveInstructionSettings,
    productCommand("instructions.save", input?.commandId, { settings: input?.settings }),
  ),
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
