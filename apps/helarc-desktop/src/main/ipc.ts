import { dialog, ipcMain, type BrowserWindow } from "electron";
import type { HelarcMainController } from "./HelarcMainController.js";
import { createHelarcProvider } from "./provider/createHelarcProvider.js";
import type { ProviderCredentialStore } from "./provider/ProviderCredentialStore.js";
import type {
  FileHelarcProviderProfileStore,
  SaveHelarcProviderProfileInput,
} from "./provider/HelarcProviderProfileStore.js";
import type { HelarcWorkspaceProfileStore } from "./workspace/HelarcWorkspaceProfileStore.js";
import type { ApprovalDecisionSubmission } from "@agent-anything/permission";
import type { HelarcPatchReviewDecisionSubmission } from "@agent-anything/helarc";

export const HELARC_IPC_CHANNELS = {
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
} as const;

export interface RegisterHelarcIpcInput {
  window: BrowserWindow;
  controller: HelarcMainController;
  providerCredentialStore?: ProviderCredentialStore | null;
  providerProfileStore?: FileHelarcProviderProfileStore | null;
  workspaceProfileStore?: HelarcWorkspaceProfileStore | null;
}

export function registerHelarcIpc(input: RegisterHelarcIpcInput): void {
  const unsubscribe = input.controller.subscribeSnapshot((snapshot) => {
    if (!input.window.isDestroyed()) {
      input.window.webContents.send(HELARC_IPC_CHANNELS.snapshotUpdated, snapshot);
    }
  });
  input.window.once("closed", unsubscribe);

  ipcMain.handle(HELARC_IPC_CHANNELS.getSnapshot, () => input.controller.getSnapshot());

  ipcMain.handle(HELARC_IPC_CHANNELS.openThread, (_event, payload: unknown) => {
    return input.controller.openThread(readThreadId(payload));
  });

  ipcMain.handle(HELARC_IPC_CHANNELS.chooseWorkspace, async () => {
    const result = await dialog.showOpenDialog(input.window, {
      properties: ["openDirectory"],
      title: "Choose workspace",
    });

    if (result.canceled || result.filePaths.length === 0) {
      return input.controller.getSnapshot();
    }

    const workspacePath = result.filePaths[0] ?? "";
    if (!input.workspaceProfileStore) {
      return input.controller.selectWorkspacePath(workspacePath);
    }

    const remembered = await input.workspaceProfileStore.rememberWorkspacePath(workspacePath);
    if (!remembered.ok) {
      return input.controller.failWorkspaceSelection(
        remembered.error.code,
        remembered.error.message,
      );
    }

    input.controller.setWorkspaceProfiles(remembered.profiles);
    return input.controller.selectWorkspaceProfile(remembered.profile);
  });

  ipcMain.handle(HELARC_IPC_CHANNELS.selectWorkspaceProfile, async (_event, payload: unknown) => {
    if (!input.workspaceProfileStore) {
      return input.controller.failWorkspaceSelection(
        "workspace_profile_not_found",
        "Workspace profile was not found.",
      );
    }

    const resolved = await input.workspaceProfileStore.resolveWorkspaceProfile(readProfileId(payload));
    if (!resolved.ok) {
      return input.controller.failWorkspaceSelection(
        resolved.error.code,
        resolved.error.message,
      );
    }

    input.controller.setWorkspaceProfiles(resolved.profiles);
    return input.controller.selectWorkspaceProfile(resolved.profile);
  });

  ipcMain.handle(HELARC_IPC_CHANNELS.saveProviderConfig, async (_event, payload: unknown) => {
    if (!input.providerProfileStore || !input.providerCredentialStore) {
      return input.controller.configureProvider({
        provider: null,
        profile: null,
        error: {
          code: "provider_config_missing",
          message: "Provider profile storage is unavailable.",
        },
      });
    }

    const saved = await input.providerProfileStore.saveActiveProfile(
      readProviderConfig(payload),
      input.providerCredentialStore,
    );
    if (!saved.ok) {
      return input.controller.configureProvider({
        provider: null,
        profile: null,
        error: {
          code: saved.error.code,
          message: saved.error.message,
        },
      });
    }

    return input.controller.configureProvider({
      provider: createHelarcProvider(saved.config),
      profile: saved.profile,
    });
  });

  ipcMain.handle(HELARC_IPC_CHANNELS.startRun, (_event, payload: unknown) => {
    const taskText = readTaskText(payload);
    return input.controller.startRun({ taskText });
  });

  ipcMain.handle(HELARC_IPC_CHANNELS.cancelRun, () => {
    return input.controller.cancelRun();
  });

  ipcMain.handle(HELARC_IPC_CHANNELS.submitApprovalDecision, (_event, payload: unknown) => {
    return input.controller.submitApprovalDecision(readApprovalDecisionSubmission(payload));
  });

  ipcMain.handle(HELARC_IPC_CHANNELS.resolvePatchReview, (_event, payload: unknown) => {
    return input.controller.resolvePatchReview(readPatchReviewDecision(payload));
  });
}

function readProfileId(payload: unknown): string {
  if (!isRecord(payload)) {
    return "";
  }

  return typeof payload.profileId === "string" ? payload.profileId : "";
}

function readThreadId(payload: unknown): string {
  if (!isRecord(payload)) {
    return "";
  }
  return typeof payload.threadId === "string" ? payload.threadId : "";
}

function readTaskText(payload: unknown): string {
  if (!isRecord(payload)) {
    return "";
  }

  const value = payload.taskText;
  return typeof value === "string" ? value : "";
}

function readProviderConfig(payload: unknown): SaveHelarcProviderProfileInput {
  if (!isRecord(payload)) {
    return {
      providerKind: "openai-compatible",
      displayName: "",
      baseUrl: "",
      model: "",
      timeoutMs: 30_000,
      apiKeyUpdate: "clear",
      apiKey: "",
    };
  }

  return {
    providerKind: readProviderKind(payload.providerKind),
    displayName: typeof payload.displayName === "string" ? payload.displayName : "",
    baseUrl: typeof payload.baseUrl === "string" ? payload.baseUrl : "",
    model: typeof payload.model === "string" ? payload.model : "",
    timeoutMs: readPositiveNumber(payload.timeoutMs, 30_000),
    apiKeyUpdate: readApiKeyUpdate(payload.apiKeyUpdate),
    apiKey: typeof payload.apiKey === "string" ? payload.apiKey : "",
  };
}

function readProviderKind(value: unknown): SaveHelarcProviderProfileInput["providerKind"] {
  return value === "ollama" ? "ollama" : "openai-compatible";
}

function readApiKeyUpdate(value: unknown): SaveHelarcProviderProfileInput["apiKeyUpdate"] {
  return value === "set" || value === "keep" || value === "clear" ? value : "clear";
}

function readPositiveNumber(value: unknown, fallback: number): number {
  const numberValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : fallback;
}

function readApprovalDecisionSubmission(payload: unknown): ApprovalDecisionSubmission {
  if (!isRecord(payload)) {
    return {
      submissionId: "",
      runId: "",
      requestId: "",
      pendingVersion: 0,
      optionId: "",
      grantedPermissions: null,
      reason: null,
    };
  }

  return {
    submissionId: typeof payload.submissionId === "string" ? payload.submissionId : "",
    runId: typeof payload.runId === "string" ? payload.runId : "",
    requestId: typeof payload.requestId === "string" ? payload.requestId : "",
    pendingVersion: typeof payload.pendingVersion === "number"
      ? payload.pendingVersion
      : Number(payload.pendingVersion),
    optionId: typeof payload.optionId === "string" ? payload.optionId : "",
    grantedPermissions: readGrantedPermissions(payload.grantedPermissions),
    reason: typeof payload.reason === "string" ? payload.reason : null,
  };
}

function readGrantedPermissions(
  value: unknown,
): ApprovalDecisionSubmission["grantedPermissions"] {
  if (!isRecord(value)) return null;
  const fileSystem = isRecord(value.fileSystem) ? value.fileSystem : null;
  const network = isRecord(value.network) ? value.network : null;
  return {
    ...(fileSystem === null
      ? {}
      : {
          fileSystem: {
            ...(Array.isArray(fileSystem.read)
              ? { read: fileSystem.read.filter((item): item is string => typeof item === "string") }
              : {}),
            ...(Array.isArray(fileSystem.write)
              ? { write: fileSystem.write.filter((item): item is string => typeof item === "string") }
              : {}),
          },
        }),
    ...(network === null || typeof network.enabled !== "boolean"
      ? {}
      : {
          network: {
            enabled: network.enabled,
            ...(Array.isArray(network.domains)
              ? { domains: network.domains.filter((item): item is string => typeof item === "string") }
              : {}),
          },
        }),
  };
}

function readPatchReviewDecision(
  payload: unknown,
): HelarcPatchReviewDecisionSubmission {
  if (!isRecord(payload)) {
    return {
      submissionId: "",
      runId: "",
      proposalId: "",
      reviewId: "",
      pendingVersion: 0,
      decision: "rejected",
      reason: "Rejected by invalid request.",
    };
  }

  return {
    submissionId: typeof payload.submissionId === "string" ? payload.submissionId : "",
    runId: typeof payload.runId === "string" ? payload.runId : "",
    proposalId: typeof payload.proposalId === "string" ? payload.proposalId : "",
    reviewId: typeof payload.reviewId === "string" ? payload.reviewId : "",
    pendingVersion: typeof payload.pendingVersion === "number" ? payload.pendingVersion : 0,
    decision: payload.decision === "accepted" ? "accepted" : "rejected",
    reason: typeof payload.reason === "string" ? payload.reason : null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
