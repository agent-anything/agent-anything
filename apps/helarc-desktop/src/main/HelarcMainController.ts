import type { HostPermissionBridge } from "@agent-anything/agent-core/host";
import {
  createHelarcRunInput,
  createHelarcRunTerminalSummary,
  createHelarcProviderProfile,
  createHelarcSessionHistoryRecord,
  createHelarcTask,
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
  type HelarcSessionHistoryPatchSummary,
  type HelarcSessionHistoryRecord,
  type HelarcSessionOutput,
  type HelarcTaskInputError,
  type HelarcTaskTemplate,
  type HelarcWorkspaceProfile,
} from "@agent-anything/helarc";
import type { PermissionRequest } from "@agent-anything/permission";
import type { Provider } from "@agent-anything/providers";
import { basename, isAbsolute, normalize } from "node:path";
import type { ProviderCredentialStoreError } from "./provider/ProviderCredentialStore.js";
import { HelarcActiveRunController } from "./run/index.js";

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
  activity: HelarcActivityItem[];
  activeRun: HelarcRunSnapshot;
  output: HelarcSessionOutput | null;
  error: HelarcMainError | null;
}

export type HelarcMainErrorCode =
  | "provider_config_missing"
  | "provider_config_invalid"
  | "provider_not_available"
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
  taskTemplates?: HelarcTaskTemplate[];
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
  private readonly taskTemplates: HelarcTaskTemplate[];
  private currentSessionStartedAt: string | null = null;
  private lastPatchReview: CompletedPatchReview | null = null;
  private readonly onSessionHistoryRecord: HelarcMainControllerInput["onSessionHistoryRecord"];
  private provider: HelarcProviderSnapshot;
  private providerInstance: Provider | null;
  private readonly runtimeToolMode: HelarcRuntimeToolMode;
  private status: HelarcMainSnapshotStatus = "idle";
  private nextTaskNumber = 1;
  private cancellationRequested = false;
  private readonly activeRunController = new HelarcActiveRunController();
  private readonly snapshotSubscribers = new Set<(snapshot: HelarcMainSnapshot) => void>();

  constructor(input: HelarcMainControllerInput = {}) {
    this.providerInstance = input.provider ?? null;
    this.workspaceProfiles = input.workspaceProfiles ?? [];
    this.sessionHistory = input.sessionHistory ?? [];
    this.taskTemplates = input.taskTemplates ?? createBuiltInHelarcTaskTemplates();
    this.onSessionHistoryRecord = input.onSessionHistoryRecord;
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
    this.lastPatchReview = null;
    this.cancellationRequested = false;
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

    if (
      this.status === "running" ||
      this.status === "waiting_for_permission" ||
      this.status === "waiting_for_patch_review" ||
      this.status === "applying_patch"
    ) {
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
    const runResult = createHelarcRunInput({
      runId: `helarc-run-${this.nextTaskNumber}`,
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
    this.lastPatchReview = null;
    this.cancellationRequested = false;
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

    this.cancellationRequested = true;
    this.activeRunController.requestCancel();

    if (this.pendingPermission) {
      const pending = this.pendingPermission;
      this.pendingPermission = null;
      pending.resolve({
        status: "unavailable",
        reason: "Cancelled from Helarc desktop.",
      });
    }

    this.status = "cancelled";
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
    try {
      const sessionResult = await runHelarcSession({
        task,
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

      this.status = this.cancellationRequested ? "cancelled" : sessionResult.status;
      this.activity = sessionResult.activity;
      this.output = sessionResult.output;
      this.pendingPermission = null;
      this.pendingPatchReview = null;

      if (!this.cancellationRequested && sessionResult.status === "failed") {
        const firstError = sessionResult.output.safeErrors[0] ?? {
          code: "provider_not_available",
          message: "Helarc session failed.",
        };
        this.lastError = {
          code: firstError.code as HelarcMainErrorCode,
          message: firstError.message,
        };
      }
      await this.persistSessionHistory(task);
      this.completeActiveRun({
        status: mapSessionStatusToRunTerminalStatus(this.status, sessionResult.output),
        runtimeStatus: sessionResult.runtimeResult.status,
        runtimeCode: sessionResult.runtimeResult.errors[0]?.code ?? null,
        safeOutput: sessionResult.output,
        errorSummary: sessionResult.output.safeErrors,
      });
    } catch (error) {
      this.status = this.cancellationRequested ? "cancelled" : "failed";
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
          code: "provider_not_available",
          message: error instanceof Error ? error.message : "Helarc session failed.",
        }],
      };
      this.lastError = this.cancellationRequested
        ? null
        : {
            code: "provider_not_available",
            message: error instanceof Error ? error.message : "Helarc session failed.",
          };
      await this.persistSessionHistory(task);
      this.completeActiveRun({
        status: this.cancellationRequested ? "cancelled" : "failed",
        runtimeStatus: "failed",
        runtimeCode: "provider_not_available",
        safeOutput: this.output,
        errorSummary: this.output.safeErrors,
      });
    } finally {
      this.publishSnapshot();
    }
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
  ): Promise<void> {
    if (!this.output || !this.selectedWorkspace || !this.provider.configured) {
      return;
    }
    if (!isTerminalSessionStatus(this.status)) {
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
      endedAt: new Date().toISOString(),
      status: this.status,
      activity: this.activity,
      output: this.output,
      patch: createHistoryPatchSummary(this.lastPatchReview, this.output),
    });

    if (!recordResult.ok) {
      return;
    }

    this.sessionHistory = this.onSessionHistoryRecord
      ? await this.onSessionHistoryRecord(recordResult.record)
      : [recordResult.record, ...this.sessionHistory.filter((record) => record.id !== recordResult.record.id)];
  }

  private completeActiveRun(input: {
    status: HelarcRunTerminalStatus;
    runtimeStatus: "succeeded" | "failed" | "blocked" | "cancelled";
    runtimeCode: string | null;
    safeOutput: unknown;
    errorSummary: Array<{ code: string; message: string }>;
  }): void {
    const activeRun = this.activeRunController.getSnapshot();
    const terminalResult = createHelarcRunTerminalSummary({
      status: input.status,
      runtimeStatus: input.runtimeStatus,
      runtimeCode: input.runtimeCode,
      safeOutput: input.safeOutput,
      errorSummary: input.errorSummary,
      startedAt: activeRun.startedAt ?? this.currentSessionStartedAt ?? new Date().toISOString(),
      completedAt: new Date().toISOString(),
      eventCount: activeRun.events.length,
    });

    if (terminalResult.ok) {
      this.activeRunController.completeRun(terminalResult.terminal);
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
): status is Exclude<HelarcMainSnapshotStatus, "idle" | "workspace_selected" | "running" | "waiting_for_permission" | "waiting_for_patch_review" | "applying_patch"> {
  return status === "completed" ||
    status === "rejected" ||
    status === "failed" ||
    status === "blocked" ||
    status === "cancelled";
}

function isActiveSessionStatus(status: HelarcMainSnapshotStatus): boolean {
  return status === "running" ||
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
