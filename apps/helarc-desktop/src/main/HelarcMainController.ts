import type { HostPermissionBridge } from "@agent-anything/agent-core/host";
import {
  createRunCancellationController,
  toRunCancellationSummary,
  type RunCancellationController,
  type RunCancellationSummary,
} from "@agent-anything/agent-core";
import {
  createHelarcRunInput,
  createHelarcRunTerminalSummary,
  createHelarcProviderProfile,
  createHelarcConversation,
  createHelarcMessage,
  createHelarcArtifact,
  createHelarcWorkContextRun,
  createHelarcSessionHistoryRecord,
  createHelarcTask,
  createHelarcThread,
  createBuiltInHelarcTaskTemplates,
  mapRuntimeEventToHelarcRunEvent,
  runHelarcSession,
  type HelarcActivityItem,
  type HelarcPatchReviewDecision,
  type HelarcPatchReviewViewModel,
  type HelarcProviderProfile,
  type HelarcRunPermissionPrompt,
  type HelarcRunSnapshot,
  type HelarcRunTerminalStatus,
  type HelarcRunTerminalSummary,
  type HelarcSessionHistoryPatchSummary,
  type HelarcSessionHistoryRecord,
  type HelarcSessionOutput,
  type HelarcTaskInputError,
  type HelarcTaskTemplate,
  type HelarcArtifact,
  type HelarcMessage,
  type HelarcThreadRecord,
  type HelarcWorkContextError,
  type HelarcWorkContextRun,
  type HelarcWorkspaceProfile,
} from "@agent-anything/helarc";
import type { PermissionRequest } from "@agent-anything/permission";
import type { Provider } from "@agent-anything/providers";
import { basename, isAbsolute, normalize } from "node:path";
import type { ProviderCredentialStoreError } from "./provider/ProviderCredentialStore.js";
import { HelarcActiveRunController } from "./run/index.js";
import type { HelarcThreadStore, HelarcThreadSummary } from "./thread/index.js";

export interface HelarcWorkspaceSnapshot {
  id: string;
  name: string;
  path: string;
}

export interface HelarcAcceptedTaskSnapshot {
  id: string;
  prompt: string;
}

export type HelarcProviderSnapshot =
  | {
      configured: true;
      activeProfile: HelarcProviderProfile;
      profiles: HelarcProviderProfile[];
      error: null;
    }
  | {
      configured: false;
      activeProfile: null;
      profiles: HelarcProviderProfile[];
      error: HelarcMainError;
    };

export type HelarcMainSnapshotStatus =
  | "idle"
  | "workspace_selected"
  | "running"
  | "cancelling"
  | "waiting_for_permission"
  | "waiting_for_patch_review"
  | "applying_patch"
  | "completed"
  | "rejected"
  | "failed"
  | "blocked"
  | "cancelled";

export interface HelarcPermissionPromptSnapshot {
  requestId: string;
  taskId: string;
  toolName: string;
  reason: string;
  command: string | null;
  args: string[];
  cwd: string | null;
  rootName: string | null;
}

export type HelarcConversationMessageRole =
  | "user"
  | "assistant"
  | "system"
  | "tool"
  | "product-event";

export interface HelarcConversationMessageSnapshot {
  id: string;
  role: HelarcConversationMessageRole;
  content: string;
  createdAt: string;
  relatedRunIds: string[];
  relatedArtifactIds: string[];
}

export interface HelarcArtifactSnapshot {
  id: string;
  kind: HelarcArtifact["kind"];
  title: string;
  summary: string | null;
  createdAt: string;
  runId: string | null;
}

export interface HelarcActiveThreadSnapshot {
  id: string;
  title: string;
  status: "open" | "closed" | "archived";
  workspace: HelarcWorkspaceSnapshot;
  activeConversationId: string;
  messages: HelarcConversationMessageSnapshot[];
  artifacts: HelarcArtifactSnapshot[];
}

export interface HelarcThreadSummarySnapshot {
  id: string;
  title: string;
  status: "open" | "closed" | "archived";
  workspace: HelarcWorkspaceSnapshot;
  createdAt: string;
  updatedAt: string;
  latestRun: HelarcThreadRecord["thread"]["latestRun"];
}

export interface HelarcMainSnapshot {
  status: HelarcMainSnapshotStatus;
  workspace: HelarcWorkspaceSnapshot | null;
  workspaceProfiles: HelarcWorkspaceProfile[];
  sessionHistory: HelarcSessionHistoryRecord[];
  taskTemplates: HelarcTaskTemplate[];
  provider: HelarcProviderSnapshot;
  acceptedTask: HelarcAcceptedTaskSnapshot | null;
  pendingPermission: HelarcPermissionPromptSnapshot | null;
  pendingPatchReview: HelarcPatchReviewViewModel | null;
  activeThread: HelarcActiveThreadSnapshot | null;
  threadSummaries: HelarcThreadSummarySnapshot[];
  activity: HelarcActivityItem[];
  activeRun: HelarcRunSnapshot;
  output: HelarcSessionOutput | null;
  error: HelarcMainError | null;
}

export type HelarcMainErrorCode =
  | "provider_config_missing"
  | "provider_config_invalid"
  | "provider_not_available"
  | "session_execution_failed"
  | "session_persistence_failed"
  | "session_already_running"
  | "session_not_running"
  | "permission_not_pending"
  | "permission_request_mismatch"
  | "patch_review_not_pending"
  | "patch_review_mismatch"
  | "workspace_not_selected"
  | "workspace_path_required"
  | "workspace_path_not_absolute"
  | "workspace_path_not_found"
  | "workspace_path_not_directory"
  | "workspace_profile_not_found"
  | "workspace_profile_invalid"
  | HelarcWorkContextError["code"]
  | ProviderCredentialStoreError["code"]
  | "provider_profile_id_required"
  | "provider_profile_display_name_required"
  | "provider_profile_base_url_required"
  | "provider_profile_base_url_invalid"
  | "provider_profile_model_required"
  | "provider_profile_timeout_invalid"
  | "provider_profile_credential_status_invalid"
  | "provider_profile_kind_invalid"
  | "provider_profile_not_found"
  | HelarcTaskInputError["code"];

export interface HelarcMainError {
  code: HelarcMainErrorCode;
  message: string;
}

export interface StartHelarcSessionInput {
  taskText: string;
}

export type StartHelarcSessionResult =
  | { ok: true; taskId: string; snapshot: HelarcMainSnapshot }
  | { ok: false; error: HelarcMainError; snapshot: HelarcMainSnapshot };

export interface ResolveHelarcPermissionInput {
  requestId: string;
  decision: "granted" | "denied";
}

export type ResolveHelarcPermissionResult =
  | { ok: true; snapshot: HelarcMainSnapshot }
  | { ok: false; error: HelarcMainError; snapshot: HelarcMainSnapshot };

export type CancelHelarcSessionResult =
  | { ok: true; snapshot: HelarcMainSnapshot }
  | { ok: false; error: HelarcMainError; snapshot: HelarcMainSnapshot };

export interface ResolveHelarcPatchReviewInput {
  patchId: string;
  decision: "accepted" | "rejected";
  reason?: string;
}

export type ResolveHelarcPatchReviewResult =
  | { ok: true; snapshot: HelarcMainSnapshot }
  | { ok: false; error: HelarcMainError; snapshot: HelarcMainSnapshot };

export interface HelarcMainControllerInput {
  provider?: Provider | null;
  providerConfigError?: (HelarcMainError & { missingKeys?: string[] }) | null;
  providerProfile?: HelarcProviderProfile | null;
  runtimeToolMode?: HelarcRuntimeToolMode;
  workspaceProfiles?: HelarcWorkspaceProfile[];
  sessionHistory?: HelarcSessionHistoryRecord[];
  threadSummaries?: HelarcThreadSummary[];
  taskTemplates?: HelarcTaskTemplate[];
  threadStore?: HelarcThreadStore | null;
  onSessionHistoryRecord?: (
    record: HelarcSessionHistoryRecord,
  ) => Promise<HelarcSessionHistoryRecord[]> | HelarcSessionHistoryRecord[];
}

export type HelarcRuntimeToolMode = "read-only" | "shell-enabled";

export class HelarcMainController {
  private selectedWorkspace: HelarcWorkspaceSnapshot | null = null;
  private acceptedTask: HelarcAcceptedTaskSnapshot | null = null;
  private pendingPermission: PendingPermission | null = null;
  private pendingPatchReview: PendingPatchReview | null = null;
  private activity: HelarcActivityItem[] = [];
  private output: HelarcSessionOutput | null = null;
  private lastError: HelarcMainError | null = null;
  private workspaceProfiles: HelarcWorkspaceProfile[] = [];
  private sessionHistory: HelarcSessionHistoryRecord[] = [];
  private threadSummaries: HelarcThreadSummarySnapshot[] = [];
  private readonly taskTemplates: HelarcTaskTemplate[];
  private currentSessionStartedAt: string | null = null;
  private currentThreadRecord: HelarcThreadRecord | null = null;
  private currentThreadWrite: Promise<HelarcThreadRecord | null> | null = null;
  private lastPatchReview: CompletedPatchReview | null = null;
  private readonly onSessionHistoryRecord: HelarcMainControllerInput["onSessionHistoryRecord"];
  private readonly threadStore: HelarcThreadStore | null;
  private provider: HelarcProviderSnapshot;
  private providerInstance: Provider | null;
  private readonly runtimeToolMode: HelarcRuntimeToolMode;
  private status: HelarcMainSnapshotStatus = "idle";
  private nextTaskNumber = 1;
  private runCancellation: RunCancellationController | null = null;
  private readonly activeRunController = new HelarcActiveRunController();
  private readonly snapshotSubscribers = new Set<(snapshot: HelarcMainSnapshot) => void>();

  constructor(input: HelarcMainControllerInput = {}) {
    this.providerInstance = input.provider ?? null;
    this.workspaceProfiles = input.workspaceProfiles ?? [];
    this.sessionHistory = input.sessionHistory ?? [];
    this.threadSummaries = (input.threadSummaries ?? []).map(createThreadSummarySnapshot);
    this.taskTemplates = input.taskTemplates ?? createBuiltInHelarcTaskTemplates();
    this.onSessionHistoryRecord = input.onSessionHistoryRecord;
    this.threadStore = input.threadStore ?? null;
    this.runtimeToolMode = input.runtimeToolMode ?? "read-only";
    this.provider = input.providerConfigError
      ? {
          configured: false,
          activeProfile: null,
          profiles: [],
          error: {
            code: input.providerConfigError.code,
            message: input.providerConfigError.message,
          },
        }
      : createConfiguredProviderSnapshot(input.providerProfile);
    this.activeRunController.subscribe(() => {
      this.publishSnapshot();
    });
  }

  configureProvider(input: {
    provider: Provider | null;
    profile: HelarcProviderProfile | null;
    error?: HelarcMainError | null;
  }): HelarcMainSnapshot {
    this.providerInstance = input.provider;
    this.provider = input.error
      ? {
          configured: false,
          activeProfile: null,
          profiles: [],
          error: input.error,
        }
      : createConfiguredProviderSnapshot(input.profile);
    this.lastError = null;
    return this.publishSnapshot();
  }

  getSnapshot(): HelarcMainSnapshot {
    return {
      status: this.status,
      workspace: this.selectedWorkspace,
      workspaceProfiles: this.workspaceProfiles,
      sessionHistory: this.sessionHistory,
      taskTemplates: this.taskTemplates,
      provider: this.provider,
      acceptedTask: this.acceptedTask,
      pendingPermission: this.pendingPermission?.prompt ?? null,
      pendingPatchReview: this.pendingPatchReview?.review ?? null,
      activeThread: createActiveThreadSnapshot(this.currentThreadRecord),
      threadSummaries: this.threadSummaries,
      activity: this.activity,
      activeRun: this.activeRunController.getSnapshot(),
      output: this.output,
      error: this.lastError,
    };
  }

  subscribeSnapshot(subscriber: (snapshot: HelarcMainSnapshot) => void): () => void {
    this.snapshotSubscribers.add(subscriber);
    return () => {
      this.snapshotSubscribers.delete(subscriber);
    };
  }

  selectWorkspacePath(workspacePath: string): HelarcMainSnapshot {
    const normalizedPath = normalize(workspacePath.trim());
    if (normalizedPath.length === 0) {
      return this.fail("workspace_path_required", "Workspace path is required.");
    }

    if (!isAbsolute(normalizedPath)) {
      return this.fail("workspace_path_not_absolute", "Workspace path must be absolute.");
    }

    return this.selectWorkspace({
      id: "workspace",
      name: basename(normalizedPath) || normalizedPath,
      path: normalizedPath,
    });
  }

  setWorkspaceProfiles(profiles: readonly HelarcWorkspaceProfile[]): HelarcMainSnapshot {
    this.workspaceProfiles = [...profiles];
    return this.publishSnapshot();
  }

  selectWorkspaceProfile(profile: HelarcWorkspaceProfile): HelarcMainSnapshot {
    this.workspaceProfiles = [
      profile,
      ...this.workspaceProfiles.filter((item) => item.id !== profile.id),
    ];
    return this.selectWorkspace({
      id: profile.id,
      name: profile.displayName,
      path: profile.path,
    });
  }

  failWorkspaceSelection(code: HelarcMainErrorCode, message: string): HelarcMainSnapshot {
    return this.fail(code, message);
  }

  private selectWorkspace(workspace: HelarcWorkspaceSnapshot): HelarcMainSnapshot {
    this.selectedWorkspace = workspace;
    this.status = "workspace_selected";
    this.acceptedTask = null;
    this.pendingPermission = null;
    this.pendingPatchReview = null;
    this.activity = [];
    this.output = null;
    this.lastError = null;
    this.currentSessionStartedAt = null;
    this.currentThreadRecord = null;
    this.currentThreadWrite = null;
    this.lastPatchReview = null;
    this.runCancellation = null;
    this.activeRunController.reset();
    return this.publishSnapshot();
  }

  startSession(input: StartHelarcSessionInput): StartHelarcSessionResult {
    if (!this.provider.configured) {
      const error = this.setError("provider_config_missing", this.provider.error.message);
      return { ok: false, error, snapshot: this.getSnapshot() };
    }

    if (!this.providerInstance) {
      const error = this.setError("provider_not_available", "Provider is not available.");
      return { ok: false, error, snapshot: this.getSnapshot() };
    }

    if (!this.selectedWorkspace) {
      const error = this.setError("workspace_not_selected", "Choose a workspace before starting a task.");
      return { ok: false, error, snapshot: this.getSnapshot() };
    }

    if (isActiveSessionStatus(this.status)) {
      const error = this.setError("session_already_running", "A Helarc session is already running.");
      return { ok: false, error, snapshot: this.getSnapshot() };
    }

    const taskId = `helarc-task-${this.nextTaskNumber}`;
    const taskResult = createHelarcTask({
      taskId,
      prompt: input.taskText,
      createdAt: new Date().toISOString(),
      workspace: {
        id: this.selectedWorkspace.id,
        name: this.selectedWorkspace.name,
        rootRef: this.selectedWorkspace.path,
      },
    });

    if (!taskResult.ok) {
      const error = this.setError(taskResult.error.code, taskResult.error.message);
      return { ok: false, error, snapshot: this.getSnapshot() };
    }

    const startedAt = new Date().toISOString();
    const sequenceNumber = this.nextTaskNumber;
    const runResult = createHelarcRunInput({
      runId: `helarc-run-${sequenceNumber}`,
      taskText: taskResult.task.input.prompt,
      workspaceProfileId: this.selectedWorkspace.id,
      providerProfileId: this.provider.activeProfile.id,
      permissionPreset: "ask",
      createdAt: startedAt,
      metadata: {
        product: "helarc",
        taskId: taskResult.task.id,
      },
    });
    if (!runResult.ok) {
      const error = this.setError(runResult.error.code as HelarcMainErrorCode, runResult.error.message);
      return { ok: false, error, snapshot: this.getSnapshot() };
    }

    const threadRecordResult = this.createInitialThreadRecord({
      sequenceNumber,
      taskText: taskResult.task.input.prompt,
      runId: runResult.input.runId,
      startedAt,
    });
    if (!threadRecordResult.ok) {
      const error = this.setError(
        threadRecordResult.error.code as HelarcMainErrorCode,
        threadRecordResult.error.message,
      );
      return { ok: false, error, snapshot: this.getSnapshot() };
    }

    this.nextTaskNumber += 1;
    this.acceptedTask = {
      id: taskResult.task.id,
      prompt: taskResult.task.input.prompt,
    };
    this.status = "running";
    this.pendingPermission = null;
    this.pendingPatchReview = null;
    this.activity = [];
    this.output = null;
    this.lastError = null;
    this.currentSessionStartedAt = startedAt;
    this.currentThreadRecord = threadRecordResult.record;
    this.threadSummaries = upsertThreadSummarySnapshot(
      this.threadSummaries,
      createThreadSummarySnapshotFromRecord(threadRecordResult.record),
    );
    this.currentThreadWrite = this.persistInitialThreadRecord(threadRecordResult.record);
    this.lastPatchReview = null;
    this.runCancellation = createRunCancellationController({
      runId: runResult.input.runId,
    });
    this.activeRunController.startRun({
      run: runResult.input,
      workspace: {
        profileId: this.selectedWorkspace.id,
        displayName: this.selectedWorkspace.name,
        path: this.selectedWorkspace.path,
      },
      provider: {
        profileId: this.provider.activeProfile.id,
        providerKind: this.provider.activeProfile.providerKind,
        displayName: this.provider.activeProfile.displayName,
        endpointLabel: this.provider.activeProfile.endpointLabel,
        model: this.provider.activeProfile.model,
      },
      startedAt,
    });
    this.activeRunController.markRunning();

    void this.runLiveSession(taskResult.task);

    return {
      ok: true,
      taskId: taskResult.task.id,
      snapshot: this.publishSnapshot(),
    };
  }

  resolvePermission(input: ResolveHelarcPermissionInput): ResolveHelarcPermissionResult {
    if (!this.pendingPermission) {
      const error = this.setError("permission_not_pending", "No permission request is pending.");
      return { ok: false, error, snapshot: this.getSnapshot() };
    }

    if (this.pendingPermission.prompt.requestId !== input.requestId) {
      const error = this.setError("permission_request_mismatch", "Permission request is stale.");
      return { ok: false, error, snapshot: this.getSnapshot() };
    }

    const pending = this.pendingPermission;
    this.pendingPermission = null;
    this.status = "running";
    this.activeRunController.resolvePermission();
    pending.resolve({
      status: input.decision,
      reason: input.decision === "granted"
        ? "Granted from Helarc desktop."
        : "Denied from Helarc desktop.",
    });
    return { ok: true, snapshot: this.publishSnapshot() };
  }

  cancelSession(): CancelHelarcSessionResult {
    if (!isActiveSessionStatus(this.status)) {
      const error = this.setError("session_not_running", "No Helarc session is running.");
      return { ok: false, error, snapshot: this.getSnapshot() };
    }

    const receipt = this.runCancellation?.requestCancellation({
      origin: "user",
      reasonCode: "user_requested",
      reason: "Cancelled from Helarc desktop.",
    });
    if (!receipt) {
      const error = this.setError("session_not_running", "No Helarc session is running.");
      return { ok: false, error, snapshot: this.getSnapshot() };
    }
    this.activeRunController.requestCancel(toRunCancellationSummary(receipt.request));

    if (this.pendingPermission) {
      const pending = this.pendingPermission;
      this.pendingPermission = null;
      pending.resolve({
        status: "unavailable",
        reason: "Cancelled from Helarc desktop.",
      });
    }

    this.status = "cancelling";
    this.pendingPatchReview = null;
    this.lastError = null;
    return { ok: true, snapshot: this.publishSnapshot() };
  }

  resolvePatchReview(input: ResolveHelarcPatchReviewInput): ResolveHelarcPatchReviewResult {
    if (!this.pendingPatchReview) {
      const error = this.setError("patch_review_not_pending", "No patch review is pending.");
      return { ok: false, error, snapshot: this.getSnapshot() };
    }

    if (this.pendingPatchReview.review.patchId !== input.patchId) {
      const error = this.setError("patch_review_mismatch", "Patch review is stale.");
      return { ok: false, error, snapshot: this.getSnapshot() };
    }

    const rejectReason = input.reason?.trim() ?? "";
    if (input.decision === "rejected" && rejectReason.length === 0) {
      const error = this.setError("patch_review_not_pending", "Rejected patch reason is required.");
      return { ok: false, error, snapshot: this.getSnapshot() };
    }

    const pending = this.pendingPatchReview;
    this.pendingPatchReview = null;
    this.lastPatchReview = {
      review: pending.review,
      decision: input.decision,
      reason: input.reason?.trim() || null,
    };
    this.status = input.decision === "accepted" ? "applying_patch" : "running";
    pending.resolve(input.decision === "accepted"
      ? { decision: "accepted", reason: input.reason }
      : { decision: "rejected", reason: rejectReason });
    return { ok: true, snapshot: this.publishSnapshot() };
  }

  private fail(code: HelarcMainErrorCode, message: string): HelarcMainSnapshot {
    this.setError(code, message);
    return this.getSnapshot();
  }

  private setError(code: HelarcMainErrorCode, message: string): HelarcMainError {
    const error = { code, message };
    this.lastError = error;
    return error;
  }

  private async runLiveSession(
    task: Parameters<typeof runHelarcSession>[0]["task"],
  ): Promise<void> {
    let terminal: HelarcRunTerminalSummary | null;
    try {
      const sessionResult = await runHelarcSession({
        task,
        runId: this.activeRunController.getSnapshot().runId,
        cancellation: this.runCancellation ?? undefined,
        provider: this.providerInstance as Provider,
        enableShell: this.runtimeToolMode === "shell-enabled",
        permissionBridge: this.createPermissionBridge(),
        patchReviewBridge: this.createPatchReviewBridge(),
        onActivity: (item, event) => {
          this.activity = [...this.activity, item];
          this.activeRunController.appendEvent(mapRuntimeEventToHelarcRunEvent(event));
          this.publishSnapshot();
        },
      });

      this.status = sessionResult.status;
      this.activity = sessionResult.activity;
      this.output = sessionResult.output;
      this.pendingPermission = null;
      this.pendingPatchReview = null;

      if (sessionResult.status === "failed") {
        const firstError = sessionResult.output.safeErrors[0] ?? {
          code: "provider_not_available",
          message: "Helarc session failed.",
        };
        this.lastError = {
          code: firstError.code as HelarcMainErrorCode,
          message: firstError.message,
        };
      }
      terminal = this.createActiveRunTerminalSummary({
        status: mapSessionStatusToRunTerminalStatus(this.status, sessionResult.output),
        runtimeStatus: sessionResult.runResult.status,
        runtimeCode: sessionResult.runResult.code,
        cancellation: sessionResult.runResult.cancellation,
        safeOutput: sessionResult.output,
        errorSummary: sessionResult.output.safeErrors,
      });
    } catch (error) {
      this.status = "failed";
      this.pendingPermission = null;
      this.pendingPatchReview = null;
      this.output = {
        taskId: task.id,
        workspaceId: task.workspaceScope?.roots[task.workspaceScope.defaultRootName ?? ""]?.id ?? null,
        agentSummary: null,
        runtimeStatus: "failed",
        patchStatus: null,
        appliedPath: null,
        safeErrors: [{
          code: "session_execution_failed",
          message: error instanceof Error ? error.message : "Helarc session failed.",
        }],
      };
      this.lastError = {
        code: "session_execution_failed",
        message: error instanceof Error ? error.message : "Helarc session failed.",
      };
      terminal = this.createActiveRunTerminalSummary({
        status: "failed",
        runtimeStatus: "failed",
        runtimeCode: "session_execution_failed",
        cancellation: this.activeRunController.getSnapshot().cancellation,
        safeOutput: this.output,
        errorSummary: this.output.safeErrors,
      });
    }

    this.completeActiveRun(terminal);
    try {
      await this.persistSessionHistory(task, terminal);
      await this.persistWorkContextRun(terminal);
    } catch (error) {
      this.lastError ??= {
        code: "session_persistence_failed",
        message: error instanceof Error
          ? error.message
          : "Helarc session persistence failed.",
      };
    }
    this.runCancellation = null;
    this.publishSnapshot();
  }

  private createPermissionBridge(): HostPermissionBridge {
    return async ({ request }) => new Promise((resolve) => {
      if (this.pendingPermission) {
        resolve({
          status: "unavailable",
          reason: "Another permission request is already pending.",
        });
        return;
      }

      this.pendingPermission = {
        prompt: createPermissionPromptSnapshot(request),
        resolve,
      };
      this.status = "waiting_for_permission";
      this.activeRunController.requestPermission(
        createRunPermissionPromptSnapshot(request, this.selectedWorkspace),
      );
      this.publishSnapshot();
    });
  }

  private createPatchReviewBridge() {
    return async (review: HelarcPatchReviewViewModel) => new Promise<HelarcPatchReviewDecision>((resolve) => {
      if (this.pendingPatchReview) {
        resolve({
          decision: "rejected",
          reason: "Another patch review is already pending.",
        });
        return;
      }

      this.pendingPatchReview = { review, resolve };
      this.lastPatchReview = {
        review,
        decision: null,
        reason: null,
      };
      this.status = "waiting_for_patch_review";
      this.publishSnapshot();
    });
  }

  private async persistSessionHistory(
    task: Parameters<typeof runHelarcSession>[0]["task"],
    terminal: HelarcRunTerminalSummary | null,
  ): Promise<void> {
    if (!terminal || !this.output || !this.selectedWorkspace || !this.provider.configured) {
      return;
    }
    if (!isTerminalSessionStatus(this.status)) {
      return;
    }

    const activeRun = this.activeRunController.getSnapshot();
    if (activeRun.runId.length === 0) {
      return;
    }

    const recordResult = createHelarcSessionHistoryRecord({
      id: `history-${task.id}`,
      taskId: task.id,
      taskText: task.input.prompt,
      workspace: {
        profileId: this.selectedWorkspace.id.startsWith("workspace:")
          ? this.selectedWorkspace.id
          : null,
        displayName: this.selectedWorkspace.name,
        path: this.selectedWorkspace.path,
      },
      provider: {
        profileId: this.provider.activeProfile.id,
        displayName: this.provider.activeProfile.displayName,
        endpointLabel: this.provider.activeProfile.endpointLabel,
        model: this.provider.activeProfile.model,
      },
      startedAt: this.currentSessionStartedAt ?? new Date().toISOString(),
      endedAt: terminal.completedAt,
      status: this.status,
      activity: this.activity,
      output: this.output,
      patch: createHistoryPatchSummary(this.lastPatchReview, this.output),
      run: {
        runId: activeRun.runId,
        status: terminal.status,
        events: activeRun.events,
        terminal,
      },
    });

    if (!recordResult.ok) {
      return;
    }

    this.sessionHistory = this.onSessionHistoryRecord
      ? await this.onSessionHistoryRecord(recordResult.record)
      : [recordResult.record, ...this.sessionHistory.filter((record) => record.id !== recordResult.record.id)];
  }

  private createInitialThreadRecord(input: {
    sequenceNumber: number;
    taskText: string;
    runId: string;
    startedAt: string;
  }): { ok: true; record: HelarcThreadRecord } | { ok: false; error: HelarcWorkContextError } {
    if (!this.selectedWorkspace || !this.provider.configured) {
      return {
        ok: false,
        error: {
          code: "thread_workspace_invalid",
          message: "Thread workspace context is unavailable.",
        },
      };
    }

    const threadId = `helarc-thread-${input.sequenceNumber}`;
    const conversationId = `helarc-conversation-${input.sequenceNumber}`;
    const messageId = `helarc-message-${input.sequenceNumber}`;

    const threadResult = createHelarcThread({
      id: threadId,
      workspace: {
        profileId: this.selectedWorkspace.id.startsWith("workspace:")
          ? this.selectedWorkspace.id
          : null,
        displayName: this.selectedWorkspace.name,
        path: this.selectedWorkspace.path,
      },
      title: createThreadTitle(input.taskText),
      status: "open",
      createdAt: input.startedAt,
      updatedAt: input.startedAt,
      activeConversationId: conversationId,
      latestRun: {
        runId: input.runId,
        status: "running",
        startedAt: input.startedAt,
        completedAt: null,
      },
      metadata: {
        product: "helarc",
      },
    });
    if (!threadResult.ok) {
      return threadResult;
    }

    const conversationResult = createHelarcConversation({
      id: conversationId,
      threadId,
      createdAt: input.startedAt,
      updatedAt: input.startedAt,
      messageIds: [messageId],
    });
    if (!conversationResult.ok) {
      return conversationResult;
    }

    const messageResult = createHelarcMessage({
      id: messageId,
      threadId,
      conversationId,
      role: "user",
      content: input.taskText,
      createdAt: input.startedAt,
      relatedRunIds: [input.runId],
    });
    if (!messageResult.ok) {
      return messageResult;
    }

    const runResult = createHelarcWorkContextRun({
      id: input.runId,
      threadId,
      triggeringMessageId: messageId,
      triggerMessageRole: "user",
      status: "running",
      provider: {
        profileId: this.provider.activeProfile.id,
        providerKind: this.provider.activeProfile.providerKind,
        displayName: this.provider.activeProfile.displayName,
        endpointLabel: this.provider.activeProfile.endpointLabel,
        model: this.provider.activeProfile.model,
      },
      permissionPreset: "ask",
      startedAt: input.startedAt,
      metadata: {
        product: "helarc",
      },
    });
    if (!runResult.ok) {
      return runResult;
    }

    return {
      ok: true,
      record: {
        thread: threadResult.thread,
        conversations: [conversationResult.conversation],
        messages: [messageResult.message],
        runs: [runResult.run],
        artifacts: [],
      },
    };
  }

  private async persistInitialThreadRecord(record: HelarcThreadRecord): Promise<HelarcThreadRecord | null> {
    if (!this.threadStore) {
      return record;
    }

    const persisted = await this.threadStore.createThread(record);
    this.currentThreadRecord = persisted ?? record;
    this.threadSummaries = upsertThreadSummarySnapshot(
      this.threadSummaries,
      createThreadSummarySnapshotFromRecord(this.currentThreadRecord),
    );
    return persisted;
  }

  private async persistWorkContextRun(terminal: HelarcRunTerminalSummary | null): Promise<void> {
    if (!terminal || !this.currentThreadRecord) {
      return;
    }

    const existingRun = this.currentThreadRecord.runs[0];
    if (!existingRun) {
      return;
    }

    const finalRun = createFinalWorkContextRun(existingRun, terminal);
    const nextRecord: HelarcThreadRecord = {
      ...this.currentThreadRecord,
      thread: {
        ...this.currentThreadRecord.thread,
        updatedAt: terminal.completedAt,
        latestRun: {
          runId: finalRun.id,
          status: finalRun.status,
          startedAt: finalRun.startedAt,
          completedAt: finalRun.completedAt,
        },
      },
      runs: [finalRun],
    };

    this.currentThreadRecord = nextRecord;
    await this.currentThreadWrite;
    this.currentThreadWrite = this.threadStore
      ? this.threadStore.updateRun(nextRecord.thread.id, finalRun)
      : Promise.resolve(nextRecord);
    const persistedRunRecord = await this.currentThreadWrite;
    const runRecord = persistedRunRecord ?? nextRecord;
    this.currentThreadRecord = runRecord;

    const artifacts = createTerminalArtifacts(runRecord, finalRun, terminal, this.lastPatchReview);
    let artifactRecord = runRecord;
    for (const artifact of artifacts) {
      artifactRecord = appendArtifactToThreadRecord(artifactRecord, artifact);
      this.currentThreadRecord = artifactRecord;
      this.currentThreadWrite = this.threadStore
        ? this.threadStore.appendArtifact(artifactRecord.thread.id, artifact)
        : Promise.resolve(artifactRecord);
      const persistedArtifactRecord = await this.currentThreadWrite;
      artifactRecord = persistedArtifactRecord ?? artifactRecord;
      this.currentThreadRecord = artifactRecord;
    }

    const assistantMessage = createAssistantTerminalMessage(
      artifactRecord,
      finalRun,
      terminal,
      artifacts.map((artifact) => artifact.id),
    );
    if (!assistantMessage) {
      return;
    }

    const messageRecord = appendMessageToThreadRecord(artifactRecord, assistantMessage);
    this.currentThreadRecord = messageRecord;
    this.currentThreadWrite = this.threadStore
      ? this.threadStore.appendMessage(messageRecord.thread.id, assistantMessage)
      : Promise.resolve(messageRecord);
    const persistedMessageRecord = await this.currentThreadWrite;
    this.currentThreadRecord = persistedMessageRecord ?? messageRecord;
    this.threadSummaries = upsertThreadSummarySnapshot(
      this.threadSummaries,
      createThreadSummarySnapshotFromRecord(this.currentThreadRecord),
    );
  }

  private createActiveRunTerminalSummary(input: {
    status: HelarcRunTerminalStatus;
    runtimeStatus: "succeeded" | "failed" | "blocked" | "cancelled";
    runtimeCode: string | null;
    cancellation: RunCancellationSummary | null;
    safeOutput: unknown;
    errorSummary: Array<{ code: string; message: string }>;
  }): HelarcRunTerminalSummary | null {
    const activeRun = this.activeRunController.getSnapshot();
    const terminalResult = createHelarcRunTerminalSummary({
      status: input.status,
      runtimeStatus: input.runtimeStatus,
      runtimeCode: input.runtimeCode,
      cancellation: input.cancellation,
      safeOutput: input.safeOutput,
      errorSummary: input.errorSummary,
      startedAt: activeRun.startedAt ?? this.currentSessionStartedAt ?? new Date().toISOString(),
      completedAt: new Date().toISOString(),
      eventCount: activeRun.events.length,
    });

    return terminalResult.ok ? terminalResult.terminal : null;
  }

  private completeActiveRun(terminal: HelarcRunTerminalSummary | null): void {
    if (terminal) {
      this.activeRunController.completeRun(terminal);
    }
  }

  private publishSnapshot(): HelarcMainSnapshot {
    const snapshot = this.getSnapshot();
    for (const subscriber of this.snapshotSubscribers) {
      subscriber(snapshot);
    }
    return snapshot;
  }
}

interface PendingPermission {
  prompt: HelarcPermissionPromptSnapshot;
  resolve: (result: { status: "granted" | "denied" | "unavailable"; reason: string }) => void;
}

interface PendingPatchReview {
  review: HelarcPatchReviewViewModel;
  resolve: (decision: HelarcPatchReviewDecision) => void;
}

interface CompletedPatchReview {
  review: HelarcPatchReviewViewModel;
  decision: "accepted" | "rejected" | null;
  reason: string | null;
}

function isTerminalSessionStatus(
  status: HelarcMainSnapshotStatus,
): status is Exclude<HelarcMainSnapshotStatus, "idle" | "workspace_selected" | "running" | "cancelling" | "waiting_for_permission" | "waiting_for_patch_review" | "applying_patch"> {
  return status === "completed" ||
    status === "rejected" ||
    status === "failed" ||
    status === "blocked" ||
    status === "cancelled";
}

function isActiveSessionStatus(status: HelarcMainSnapshotStatus): boolean {
  return status === "running" ||
    status === "cancelling" ||
    status === "waiting_for_permission" ||
    status === "waiting_for_patch_review" ||
    status === "applying_patch";
}

function mapSessionStatusToRunTerminalStatus(
  status: HelarcMainSnapshotStatus,
  output: HelarcSessionOutput,
): HelarcRunTerminalStatus {
  if (status === "completed") {
    return "completed";
  }

  if (status === "cancelled") {
    return "cancelled";
  }

  if (
    status === "rejected" ||
    output.safeErrors.some((error) => error.code === "permission_denied")
  ) {
    return "denied";
  }

  return "failed";
}

function createHistoryPatchSummary(
  patchReview: CompletedPatchReview | null,
  output: HelarcSessionOutput,
): HelarcSessionHistoryPatchSummary {
  if (!patchReview) {
    return {
      patchId: null,
      operation: null,
      path: output.appliedPath,
      summary: output.agentSummary,
      decision: "not_required" as const,
      reason: null,
      status: output.patchStatus,
    };
  }

  return {
    patchId: patchReview.review.patchId,
    operation: patchReview.review.operation,
    path: patchReview.review.path,
    summary: patchReview.review.summary,
    decision: patchReview.decision ?? "unknown" as const,
    reason: patchReview.reason,
    status: output.patchStatus,
  };
}

function createFinalWorkContextRun(
  run: HelarcWorkContextRun,
  terminal: HelarcRunTerminalSummary,
): HelarcWorkContextRun {
  return {
    ...run,
    status: terminal.status,
    completedAt: terminal.completedAt,
    runtime: {
      status: terminal.runtimeStatus,
      code: terminal.runtimeCode,
      summary: createRuntimeSummary(terminal.safeOutput),
    },
    errors: terminal.errorSummary,
  };
}

function createAssistantTerminalMessage(
  record: HelarcThreadRecord,
  run: HelarcWorkContextRun,
  terminal: HelarcRunTerminalSummary,
  relatedArtifactIds: readonly string[],
): HelarcMessage | null {
  const content = createAssistantTerminalMessageContent(terminal);
  if (!content) {
    return null;
  }

  const conversation = record.conversations.find((item) => item.id === record.thread.activeConversationId);
  if (!conversation) {
    return null;
  }

  const result = createHelarcMessage({
    id: `${run.triggeringMessageId}-assistant`,
    threadId: record.thread.id,
    conversationId: conversation.id,
    role: "assistant",
    content,
    createdAt: terminal.completedAt,
    relatedRunIds: [run.id],
    relatedArtifactIds,
  });

  return result.ok ? result.message : null;
}

function createTerminalArtifacts(
  record: HelarcThreadRecord,
  run: HelarcWorkContextRun,
  terminal: HelarcRunTerminalSummary,
  patchReview: CompletedPatchReview | null,
): HelarcArtifact[] {
  const artifacts: HelarcArtifact[] = [];
  const summary = createRuntimeSummary(terminal.safeOutput);
  const safeOutput = isHelarcSessionOutput(terminal.safeOutput) ? terminal.safeOutput : null;

  if (summary) {
    const artifact = createArtifact({
      id: `${run.id}-artifact-final-output`,
      threadId: record.thread.id,
      runId: run.id,
      kind: "final-output",
      title: "Final output",
      summary,
      createdAt: terminal.completedAt,
      payload: safeOutput
        ? {
            agentSummary: safeOutput.agentSummary,
            runtimeStatus: safeOutput.runtimeStatus,
            patchStatus: safeOutput.patchStatus,
            appliedPath: safeOutput.appliedPath,
          }
        : { summary },
    });
    if (artifact) {
      artifacts.push(artifact);
    }
  }

  if (patchReview) {
    const patchSummary = createPatchArtifactSummary(patchReview);
    const proposal = createArtifact({
      id: `${run.id}-artifact-patch-proposal`,
      threadId: record.thread.id,
      runId: run.id,
      kind: "patch-proposal",
      title: `Patch proposal: ${patchReview.review.operation} ${patchReview.review.path}`,
      summary: patchSummary,
      createdAt: terminal.completedAt,
      payload: {
        operation: patchReview.review.operation,
        path: patchReview.review.path,
        summary: patchReview.review.summary,
        rationale: patchReview.review.rationale,
        decision: patchReview.decision,
        reason: patchReview.reason,
        originalContentBytes: patchReview.review.originalContentBytes,
        proposedContentBytes: patchReview.review.proposedContentBytes,
        status: safeOutput?.patchStatus ?? null,
      },
    });
    if (proposal) {
      artifacts.push(proposal);
    }

    if (patchReview.decision === "accepted" && safeOutput?.patchStatus === "applied") {
      const applied = createArtifact({
        id: `${run.id}-artifact-applied-patch`,
        threadId: record.thread.id,
        runId: run.id,
        kind: "applied-patch",
        title: `Applied patch: ${patchReview.review.path}`,
        summary: safeOutput.appliedPath
          ? `Applied ${patchReview.review.operation} to ${safeOutput.appliedPath}.`
          : `Applied ${patchReview.review.operation} patch.`,
        createdAt: terminal.completedAt,
        payload: {
          operation: patchReview.review.operation,
          path: safeOutput.appliedPath ?? patchReview.review.path,
          reason: patchReview.reason,
          status: safeOutput.patchStatus,
        },
      });
      if (applied) {
        artifacts.push(applied);
      }
    }
  }

  if (terminal.errorSummary.length > 0) {
    const artifact = createArtifact({
      id: `${run.id}-artifact-error-report`,
      threadId: record.thread.id,
      runId: run.id,
      kind: "error-report",
      title: "Error report",
      summary: terminal.errorSummary[0]?.message ?? "Run reported errors.",
      createdAt: terminal.completedAt,
      payload: {
        status: terminal.status,
        runtimeStatus: terminal.runtimeStatus,
        runtimeCode: terminal.runtimeCode,
        errors: terminal.errorSummary,
      },
    });
    if (artifact) {
      artifacts.push(artifact);
    }
  }

  return artifacts;
}

function createArtifact(input: Parameters<typeof createHelarcArtifact>[0]): HelarcArtifact | null {
  const result = createHelarcArtifact(input);
  return result.ok ? result.artifact : null;
}

function createPatchArtifactSummary(patchReview: CompletedPatchReview): string {
  if (patchReview.decision === "accepted") {
    return `Accepted ${patchReview.review.operation} patch for ${patchReview.review.path}.`;
  }

  if (patchReview.decision === "rejected") {
    return `Rejected ${patchReview.review.operation} patch for ${patchReview.review.path}.`;
  }

  return `Proposed ${patchReview.review.operation} patch for ${patchReview.review.path}.`;
}

function createAssistantTerminalMessageContent(terminal: HelarcRunTerminalSummary): string | null {
  const summary = createRuntimeSummary(terminal.safeOutput);
  if (summary) {
    return summary;
  }

  if (terminal.errorSummary.length > 0) {
    return terminal.errorSummary
      .map((error) => `${error.code}: ${error.message}`)
      .join("; ");
  }

  if (terminal.status === "completed") {
    return "Run completed.";
  }

  if (terminal.status === "denied") {
    return "Run denied.";
  }

  if (terminal.status === "cancelled") {
    return "Run cancelled.";
  }

  return "Run failed.";
}

function createRuntimeSummary(safeOutput: unknown): string | null {
  if (
    typeof safeOutput === "object" &&
    safeOutput !== null &&
    "agentSummary" in safeOutput &&
    typeof safeOutput.agentSummary === "string"
  ) {
    return safeOutput.agentSummary;
  }

  return null;
}

function appendMessageToThreadRecord(
  record: HelarcThreadRecord,
  message: HelarcMessage,
): HelarcThreadRecord {
  const conversation = record.conversations.find((item) => item.id === record.thread.activeConversationId);
  if (!conversation) {
    return record;
  }

  const messageIds = appendUniqueString(conversation.messageIds, message.id);
  const nextConversation = {
    ...conversation,
    updatedAt: maxIsoDateTime(conversation.updatedAt, message.createdAt),
    messageIds,
  };
  const messages = replaceById(record.messages, message);
  const messageById = new Map(messages.map((item) => [item.id, item]));

  return {
    ...record,
    thread: {
      ...record.thread,
      updatedAt: maxIsoDateTime(record.thread.updatedAt, message.createdAt),
    },
    conversations: replaceById(record.conversations, nextConversation),
    messages: messageIds.flatMap((id) => {
      const item = messageById.get(id);
      return item ? [item] : [];
    }),
  };
}

function appendArtifactToThreadRecord(
  record: HelarcThreadRecord,
  artifact: HelarcArtifact,
): HelarcThreadRecord {
  return {
    ...record,
    thread: {
      ...record.thread,
      updatedAt: maxIsoDateTime(record.thread.updatedAt, artifact.createdAt),
    },
    runs: artifact.runId
      ? record.runs.map((run) =>
          run.id === artifact.runId
            ? { ...run, artifactIds: appendUniqueString(run.artifactIds, artifact.id) }
            : run
        )
      : record.runs,
    artifacts: replaceById(record.artifacts, artifact),
  };
}

function createActiveThreadSnapshot(record: HelarcThreadRecord | null): HelarcActiveThreadSnapshot | null {
  if (!record) {
    return null;
  }

  const activeConversation = record.conversations.find((item) => item.id === record.thread.activeConversationId);
  const messageById = new Map(record.messages.map((message) => [message.id, message]));
  const messages = (activeConversation?.messageIds ?? []).flatMap((messageId) => {
    const message = messageById.get(messageId);
    return message
      ? [{
          id: message.id,
          role: message.role,
          content: message.content,
          createdAt: message.createdAt,
          relatedRunIds: [...message.relatedRunIds],
          relatedArtifactIds: [...message.relatedArtifactIds],
        }]
      : [];
  });

  return {
    id: record.thread.id,
    title: record.thread.title,
    status: record.thread.status,
    workspace: {
      id: record.thread.workspace.profileId ?? "workspace",
      name: record.thread.workspace.displayName,
      path: record.thread.workspace.path,
    },
    activeConversationId: record.thread.activeConversationId,
    messages,
    artifacts: record.artifacts.map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      title: artifact.title,
      summary: artifact.summary,
      createdAt: artifact.createdAt,
      runId: artifact.runId,
    })),
  };
}

function createThreadSummarySnapshot(summary: HelarcThreadSummary): HelarcThreadSummarySnapshot {
  return {
    id: summary.id,
    title: summary.title,
    status: summary.status,
    workspace: {
      id: summary.workspace.profileId ?? "workspace",
      name: summary.workspace.displayName,
      path: summary.workspace.path,
    },
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    latestRun: summary.latestRun,
  };
}

function createThreadSummarySnapshotFromRecord(record: HelarcThreadRecord): HelarcThreadSummarySnapshot {
  return {
    id: record.thread.id,
    title: record.thread.title,
    status: record.thread.status,
    workspace: {
      id: record.thread.workspace.profileId ?? "workspace",
      name: record.thread.workspace.displayName,
      path: record.thread.workspace.path,
    },
    createdAt: record.thread.createdAt,
    updatedAt: record.thread.updatedAt,
    latestRun: record.thread.latestRun,
  };
}

function upsertThreadSummarySnapshot(
  summaries: readonly HelarcThreadSummarySnapshot[],
  summary: HelarcThreadSummarySnapshot,
): HelarcThreadSummarySnapshot[] {
  return [
    summary,
    ...summaries.filter((item) => item.id !== summary.id),
  ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function replaceById<T extends { id: string }>(items: readonly T[], item: T): T[] {
  return [
    ...items.filter((candidate) => candidate.id !== item.id),
    item,
  ];
}

function appendUniqueString(items: readonly string[], item: string): string[] {
  return items.includes(item) ? [...items] : [...items, item];
}

function maxIsoDateTime(left: string, right: string): string {
  return right.localeCompare(left) > 0 ? right : left;
}

function isHelarcSessionOutput(value: unknown): value is HelarcSessionOutput {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const output = value as Partial<HelarcSessionOutput>;
  return typeof output.taskId === "string" &&
    typeof output.runtimeStatus === "string" &&
    Array.isArray(output.safeErrors);
}

function createThreadTitle(taskText: string): string {
  const normalized = taskText.trim().replace(/\s+/g, " ");
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

function createPermissionPromptSnapshot(request: PermissionRequest): HelarcPermissionPromptSnapshot {
  return {
    requestId: request.id,
    taskId: request.taskId,
    toolName: request.toolName ?? request.target?.name ?? "unknown",
    reason: request.reason,
    command: readString(request.metadata.command),
    args: readStringArray(request.metadata.args),
    cwd: readString(request.metadata.cwd),
    rootName: readString(request.metadata.rootName),
  };
}

function createRunPermissionPromptSnapshot(
  request: PermissionRequest,
  workspace: HelarcWorkspaceSnapshot | null,
): HelarcRunPermissionPrompt {
  return {
    requestId: request.id,
    actionLabel: request.action,
    toolName: request.toolName ?? request.target?.name ?? "unknown",
    riskLevel: request.risk === "risky" ? "high" : "low",
    workspaceDisplayName: workspace?.name ?? null,
    explanation: request.reason,
    inputSummary: createPermissionInputSummary(request),
    createdAt: new Date().toISOString(),
  };
}

function createPermissionInputSummary(request: PermissionRequest): string | null {
  const command = readString(request.metadata.command);
  const args = readStringArray(request.metadata.args);
  if (command) {
    return [command, ...args].join(" ");
  }

  const resource = readString(request.target?.resource);
  return resource ?? request.toolCallId ?? null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : [];
}

function createConfiguredProviderSnapshot(
  profile: HelarcProviderProfile | null | undefined,
): HelarcProviderSnapshot {
  const activeProfile = profile ?? createInjectedProviderProfile();
  return {
    configured: true,
    activeProfile,
    profiles: [activeProfile],
    error: null,
  };
}

function createInjectedProviderProfile(): HelarcProviderProfile {
  const result = createHelarcProviderProfile({
    id: "test-provider",
    displayName: "Injected Test Provider",
    baseUrl: "https://provider.local/v1",
    model: "test-model",
    timeoutMs: 30_000,
    credentialStatus: "empty_allowed",
    isActive: true,
  });

  if (!result.ok) {
    throw new Error("Injected provider profile is invalid.");
  }

  return result.profile;
}
