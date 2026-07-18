import {
  createInMemoryHostPolicyAmendmentStore,
  createInMemoryHostSessionAuthorityStore,
  createUserApprovalReviewBridge,
  type UserApprovalReviewBridge,
} from "@agent-anything/agent-core/host";
import {
  createRunCancellationController,
  type AgentTask,
  type RunCancellationSummary,
} from "@agent-anything/agent-core";
import {
  createHelarcRunTerminalSummary,
  createHelarcProviderProfile,
  createHelarcConversation,
  createHelarcMessage,
  createHelarcArtifact,
  createHelarcPersistedRun,
  createHelarcSessionHistoryRecord,
  createHelarcThread,
  createBuiltInHelarcTaskTemplates,
  createHelarcRunProjection,
  deriveHelarcPersistedRunStatus,
  mapHelarcActivityToRunEvent,
  reduceHelarcRunProjection,
  type HelarcPatchReviewDecisionSubmission,
  type HelarcPendingPatchReviewProjection,
  type HelarcProviderProfile,
  type HelarcRunProjection,
  type HelarcRunProjectionUpdate,
  type HelarcRunTerminalStatus,
  type HelarcRunTerminalSummary,
  type HelarcSessionHistoryPatchSummary,
  type HelarcSessionHistoryRecord,
  type HelarcProductOutput,
  type HelarcRunProgressCommit,
  type HelarcRunStartCommit,
  type HelarcRunTerminalCommit,
  type HelarcTaskInputError,
  type HelarcTaskInput,
  type HelarcTaskTemplate,
  type HelarcArtifact,
  type HelarcMessage,
  type HelarcPersistedRunStatus,
  type HelarcThreadRecord,
  type HelarcWorkContextError,
  type HelarcPersistedRun,
  type HelarcWorkspaceProfile,
} from "@agent-anything/helarc";
import type {
  ApprovalDecisionSubmission,
  ApprovalSubmissionReceipt,
} from "@agent-anything/permission";
import type { Provider } from "@agent-anything/providers";
import { basename, isAbsolute, normalize } from "node:path";
import type { ProviderCredentialStoreError } from "./provider/ProviderCredentialStore.js";
import {
  createHelarcPatchReviewBridge,
  prepareHelarcHostRun,
  prepareHelarcRunStart,
  type HelarcHostActiveRun,
  type HelarcHostRunOutcome,
} from "./run/index.js";
import {
  InMemoryHelarcThreadStore,
  type HelarcThreadStore,
  type HelarcThreadSummary,
} from "./thread/index.js";

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
  | "starting"
  | "running"
  | "cancelling"
  | "waiting_for_approval"
  | "waiting_for_patch_review"
  | "applying_patch"
  | "completed"
  | "rejected"
  | "failed"
  | "blocked"
  | "cancelled";

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
  latestRun: HelarcThreadLatestRunSnapshot | null;
}

export interface HelarcThreadLatestRunSnapshot {
  runId: string;
  status: HelarcPersistedRunStatus;
  startedAt: string;
  completedAt: string | null;
}

export interface HelarcMainSnapshot {
  status: HelarcMainSnapshotStatus;
  workspace: HelarcWorkspaceSnapshot | null;
  workspaceProfiles: HelarcWorkspaceProfile[];
  sessionHistory: HelarcSessionHistoryRecord[];
  taskTemplates: HelarcTaskTemplate[];
  provider: HelarcProviderSnapshot;
  acceptedTask: HelarcAcceptedTaskSnapshot | null;
  activeThread: HelarcActiveThreadSnapshot | null;
  threadSummaries: HelarcThreadSummarySnapshot[];
  run: HelarcRunProjection | null;
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

export type CancelHelarcSessionResult =
  | { ok: true; snapshot: HelarcMainSnapshot }
  | { ok: false; error: HelarcMainError; snapshot: HelarcMainSnapshot };

export type ResolveHelarcPatchReviewInput = HelarcPatchReviewDecisionSubmission;

export type ResolveHelarcPatchReviewResult =
  | { ok: true; snapshot: HelarcMainSnapshot }
  | { ok: false; error: HelarcMainError; snapshot: HelarcMainSnapshot };

export type OpenHelarcThreadResult =
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
  threadStore?: HelarcThreadStore;
  onSessionHistoryRecord?: (
    record: HelarcSessionHistoryRecord,
  ) => Promise<HelarcSessionHistoryRecord[]> | HelarcSessionHistoryRecord[];
}

export type HelarcRuntimeToolMode = "read-only" | "shell-enabled";

type DesktopActiveRunSlot =
  | { readonly kind: "empty" }
  | {
      readonly kind: "reserved";
      readonly token: symbol;
      readonly threadId: string;
      readonly runId: string;
    }
  | {
      readonly kind: "active";
      readonly token: symbol;
      readonly threadId: string;
      readonly task: AgentTask<HelarcTaskInput>;
      readonly handle: HelarcHostActiveRun;
      progressSequence: number;
      progressTail: Promise<void>;
      persistenceFailure: Error | null;
    };

export class HelarcMainController {
  private selectedWorkspace: HelarcWorkspaceSnapshot | null = null;
  private acceptedTask: HelarcAcceptedTaskSnapshot | null = null;
  private runProjection: HelarcRunProjection | null = null;
  private lastError: HelarcMainError | null = null;
  private workspaceProfiles: HelarcWorkspaceProfile[] = [];
  private sessionHistory: HelarcSessionHistoryRecord[] = [];
  private threadSummaries: HelarcThreadSummarySnapshot[] = [];
  private readonly taskTemplates: HelarcTaskTemplate[];
  private currentSessionStartedAt: string | null = null;
  private currentThreadRecord: HelarcThreadRecord | null = null;
  private lastPatchReview: CompletedPatchReview | null = null;
  private readonly onSessionHistoryRecord: HelarcMainControllerInput["onSessionHistoryRecord"];
  private readonly threadStore: HelarcThreadStore;
  private provider: HelarcProviderSnapshot;
  private providerInstance: Provider | null;
  private readonly runtimeToolMode: HelarcRuntimeToolMode;
  private inactiveStatus: "idle" | "workspace_selected" = "idle";
  private nextTaskNumber = 1;
  private activeRunSlot: DesktopActiveRunSlot = { kind: "empty" };
  private runProjectionUnsubscribers: Array<() => void> = [];
  private readonly sessionAuthorityStore = createInMemoryHostSessionAuthorityStore({
    maxRecords: 64,
  });
  private readonly policyAmendmentStore = createInMemoryHostPolicyAmendmentStore({
    maxRecords: 64,
  });
  private readonly snapshotSubscribers = new Set<(snapshot: HelarcMainSnapshot) => void>();

  constructor(input: HelarcMainControllerInput = {}) {
    this.providerInstance = input.provider ?? null;
    this.workspaceProfiles = input.workspaceProfiles ?? [];
    this.sessionHistory = input.sessionHistory ?? [];
    this.threadSummaries = (input.threadSummaries ?? []).map(createThreadSummarySnapshot);
    this.nextTaskNumber = resolveNextTaskNumber(input.threadSummaries ?? []);
    this.taskTemplates = input.taskTemplates ?? createBuiltInHelarcTaskTemplates();
    this.onSessionHistoryRecord = input.onSessionHistoryRecord;
    this.threadStore = input.threadStore ?? new InMemoryHelarcThreadStore();
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
      status: this.getCurrentStatus(),
      workspace: this.selectedWorkspace,
      workspaceProfiles: this.workspaceProfiles,
      sessionHistory: this.sessionHistory,
      taskTemplates: this.taskTemplates,
      provider: this.provider,
      acceptedTask: this.acceptedTask,
      activeThread: createActiveThreadSnapshot(this.currentThreadRecord),
      threadSummaries: this.threadSummaries,
      run: this.runProjection,
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
    if (this.activeRunSlot.kind !== "empty") {
      return this.fail("session_already_running", "A Helarc session is already running.");
    }
    this.selectedWorkspace = workspace;
    this.inactiveStatus = "workspace_selected";
    this.acceptedTask = null;
    this.runProjection = null;
    this.lastError = null;
    this.currentSessionStartedAt = null;
    this.currentThreadRecord = null;
    this.lastPatchReview = null;
    this.detachRunProjectionSubscriptions();
    return this.publishSnapshot();
  }

  async startSession(input: StartHelarcSessionInput): Promise<StartHelarcSessionResult> {
    if (!this.provider.configured) {
      const error = this.setError("provider_config_missing", this.provider.error.message);
      return { ok: false, error, snapshot: this.getSnapshot() };
    }

    if (!this.providerInstance) {
      const error = this.setError("provider_not_available", "Provider is not available.");
      return { ok: false, error, snapshot: this.getSnapshot() };
    }
    const providerInstance = this.providerInstance;

    if (!this.selectedWorkspace) {
      const error = this.setError("workspace_not_selected", "Choose a workspace before starting a task.");
      return { ok: false, error, snapshot: this.getSnapshot() };
    }

    if (this.activeRunSlot.kind !== "empty") {
      const error = this.setError("session_already_running", "A Helarc session is already running.");
      return { ok: false, error, snapshot: this.getSnapshot() };
    }

    const startedAt = new Date().toISOString();
    const sequenceNumber = this.nextTaskNumber;
    const taskId = `helarc-task-${sequenceNumber}`;
    const runId = `helarc-run-${sequenceNumber}`;
    const threadId = `helarc-thread-${sequenceNumber}`;
    const workspaceProfile = this.workspaceProfiles.find(
      (profile) => profile.id === this.selectedWorkspace?.id,
    ) ?? {
      id: this.selectedWorkspace.id,
      displayName: this.selectedWorkspace.name,
      path: this.selectedWorkspace.path,
      lastOpenedAt: startedAt,
      trustState: "trusted" as const,
    };
    const preparedStart = prepareHelarcRunStart({
      runId,
      taskId,
      taskText: input.taskText,
      workspaceProfileId: workspaceProfile.id,
      providerProfileId: this.provider.activeProfile.id,
      workspaceProfiles: [workspaceProfile],
      providerProfiles: this.provider.profiles,
      taskTemplates: this.taskTemplates,
      permissionPreset: "ask_for_approval",
      createdAt: startedAt,
      metadata: {
        product: "helarc",
        taskId,
      },
    });
    if (!preparedStart.ok) {
      const error = this.setError(
        preparedStart.error.code as HelarcMainErrorCode,
        preparedStart.error.message,
      );
      return { ok: false, error, snapshot: this.getSnapshot() };
    }

    const startCommitResult = this.createInitialRunStartCommit({
      sequenceNumber,
      taskId,
      taskText: preparedStart.prepared.task.input.prompt,
      runId: `helarc-run-${sequenceNumber}`,
      startedAt,
    });
    if (!startCommitResult.ok) {
      const error = this.setError(
        startCommitResult.error.code as HelarcMainErrorCode,
        startCommitResult.error.message,
      );
      return { ok: false, error, snapshot: this.getSnapshot() };
    }

    const token = Symbol(runId);
    this.activeRunSlot = { kind: "reserved", token, threadId, runId };
    this.acceptedTask = null;
    this.runProjection = null;
    this.lastError = null;
    this.currentSessionStartedAt = startedAt;
    this.lastPatchReview = null;
    this.publishSnapshot();

    const cancellation = createRunCancellationController({ runId });
    const userApprovalBridge = this.createApprovalReviewBridge(runId);
    const patchReviewBridge = this.createPatchReviewBridge(runId);
    let startCommitted = false;
    try {
      const preparedHostRun = await prepareHelarcHostRun({
        task: preparedStart.prepared.task,
        runId,
        sessionId: threadId,
        cancellation,
        provider: providerInstance,
        toolMode: this.runtimeToolMode,
        permissionPreset: preparedStart.prepared.run.permissionPreset,
        userApprovalBridge,
        sessionAuthorityPort: this.sessionAuthorityStore,
        persistentPolicyAmendments: this.policyAmendmentStore,
        patchReviewBridge,
      });
      let committed: Awaited<ReturnType<HelarcThreadStore["commitRunStart"]>>;
      try {
        committed = await this.threadStore.commitRunStart(startCommitResult.commit);
      } catch (cause) {
        throw new HelarcDesktopPersistenceError(
          "thread_store_write_failed",
          cause instanceof Error ? cause.message : "Run start persistence failed.",
        );
      }
      if (committed.status === "rejected") {
        throw new HelarcDesktopPersistenceError(committed.code, committed.message);
      }
      startCommitted = true;
      this.nextTaskNumber += 1;
      this.currentThreadRecord = committed.aggregate.record;
      this.threadSummaries = upsertThreadSummarySnapshot(
        this.threadSummaries,
        createThreadSummarySnapshotFromRecord(committed.aggregate.record),
      );
      this.acceptedTask = {
        id: preparedStart.prepared.task.id,
        prompt: preparedStart.prepared.task.input.prompt,
      };

      const composition = preparedHostRun.start();
      this.attachActiveHostRun(
        token,
        threadId,
        preparedStart.prepared.task,
        composition.activeRun,
      );
      void this.observeActiveRun(token, composition.result);
      return {
        ok: true,
        taskId: preparedStart.prepared.task.id,
        snapshot: this.getSnapshot(),
      };
    } catch (cause) {
      if (startCommitted && this.nextTaskNumber === sequenceNumber) {
        this.nextTaskNumber += 1;
      }
      this.releaseActiveRunSlot(token);
      const persistenceFailure = cause instanceof HelarcDesktopPersistenceError;
      const error = this.setError(
        persistenceFailure ? "session_persistence_failed" : "session_execution_failed",
        cause instanceof Error ? cause.message : "Helarc session failed to start.",
      );
      this.publishSnapshot();
      return { ok: false, error, snapshot: this.getSnapshot() };
    }
  }

  submitApprovalDecision(
    input: ApprovalDecisionSubmission,
  ): ApprovalSubmissionReceipt {
    const slot = this.activeRunSlot;
    if (slot.kind !== "active") {
      return {
        status: "rejected",
        submissionId: typeof input?.submissionId === "string" ? input.submissionId : "",
        code: "approval_not_pending",
      };
    }
    return slot.handle.submitApprovalDecision(input);
  }

  cancelSession(): CancelHelarcSessionResult {
    const slot = this.activeRunSlot;
    if (slot.kind !== "active") {
      const error = this.setError("session_not_running", "No Helarc session is running.");
      return { ok: false, error, snapshot: this.getSnapshot() };
    }

    const cancellationInput = {
      origin: "user",
      reasonCode: "user_requested",
      reason: "Cancelled from Helarc desktop.",
    } as const;
    const receipt = slot.handle.cancel(cancellationInput);
    if (receipt.status === "run_settled" || receipt.status === "start_failed") {
      const error = this.setError("session_not_running", "No Helarc session is running.");
      return { ok: false, error, snapshot: this.getSnapshot() };
    }
    this.lastError = null;
    return { ok: true, snapshot: this.publishSnapshot() };
  }

  resolvePatchReview(input: ResolveHelarcPatchReviewInput): ResolveHelarcPatchReviewResult {
    const slot = this.activeRunSlot;
    if (slot.kind !== "active") {
      const error = this.setError("patch_review_not_pending", "No patch review is pending.");
      return { ok: false, error, snapshot: this.getSnapshot() };
    }
    const pending = this.getPendingPatchReview();
    const receipt = slot.handle.submitPatchReviewDecision(input);
    if (receipt.status === "rejected") {
      const code = receipt.code === "patch_review_not_pending" ||
          receipt.code === "patch_review_already_resolved"
        ? "patch_review_not_pending"
        : "patch_review_mismatch";
      const error = this.setError(
        code,
        code === "patch_review_not_pending"
          ? "No patch review is pending."
          : "Patch review submission is stale or invalid.",
      );
      return { ok: false, error, snapshot: this.getSnapshot() };
    }
    if (pending === null) {
      const error = this.setError("patch_review_not_pending", "No patch review is pending.");
      return { ok: false, error, snapshot: this.getSnapshot() };
    }
    this.lastPatchReview = {
      review: pending,
      decision: input.decision,
      reason: input.reason,
    };
    return { ok: true, snapshot: this.getSnapshot() };
  }

  async openThread(threadId: string): Promise<OpenHelarcThreadResult> {
    const normalizedThreadId = threadId.trim();
    const slot = this.activeRunSlot;
    if (slot.kind !== "empty" && slot.threadId !== normalizedThreadId) {
      const error = this.setError(
        "session_already_running",
        "A different Helarc Thread is active.",
      );
      return { ok: false, error, snapshot: this.getSnapshot() };
    }
    const record = await this.threadStore.loadThread(normalizedThreadId);
    if (record === null) {
      const error = this.setError("thread_record_invalid", "Thread was not found.");
      return { ok: false, error, snapshot: this.getSnapshot() };
    }
    this.currentThreadRecord = record;
    this.selectedWorkspace = {
      id: record.thread.workspace.profileId ?? "workspace",
      name: record.thread.workspace.displayName,
      path: record.thread.workspace.path,
    };
    this.inactiveStatus = "workspace_selected";
    this.lastError = null;
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

  private async observeActiveRun(
    token: symbol,
    result: Promise<HelarcHostRunOutcome>,
  ): Promise<void> {
    let outcome: HelarcHostRunOutcome;
    try {
      outcome = await result;
    } catch (cause) {
      const failedSlot = this.activeRunSlot;
      if (failedSlot.kind !== "active" || failedSlot.token !== token) return;
      await failedSlot.progressTail;
      this.lastError = {
        code: "session_execution_failed",
        message: cause instanceof Error ? cause.message : "Helarc Host result projection failed.",
      };
      this.releaseActiveRunSlot(token);
      this.publishSnapshot();
      return;
    }
    const slot = this.activeRunSlot;
    if (slot.kind !== "active" || slot.token !== token) return;
    await slot.progressTail;

    if (outcome.kind === "start_failure") {
      this.lastError = {
        code: "session_execution_failed",
        message: outcome.failure.code,
      };
      this.runProjection = null;
      this.releaseActiveRunSlot(token);
      this.publishSnapshot();
      return;
    }

    const terminal = this.createActiveRunTerminalSummary({
      status: mapSessionStatusToRunTerminalStatus(this.getCurrentStatus(), outcome.product.output),
      runtimeStatus: outcome.runResult.status,
      runtimeCode: outcome.runResult.code,
      cancellation: outcome.runResult.cancellation,
      safeOutput: outcome.product.output,
      errorSummary: [...outcome.product.output.safeErrors],
      completedAt: outcome.terminal.completedAt,
    });
    if (outcome.product.status === "failed") {
      const firstError = outcome.product.output.safeErrors[0];
      if (firstError) {
        this.lastError = {
          code: firstError.code as HelarcMainErrorCode,
          message: firstError.message,
        };
      }
    }

    try {
      if (terminal === null) {
        throw new HelarcDesktopPersistenceError(
          "terminal_projection_invalid",
          "Helarc terminal summary is invalid.",
        );
      }
      await this.persistWorkContextTerminal(outcome, terminal);
      await this.persistSessionHistory(slot.task, terminal);
    } catch (cause) {
      this.lastError = {
        code: "session_persistence_failed",
        message: cause instanceof Error ? cause.message : "Helarc session persistence failed.",
      };
    }
    this.releaseActiveRunSlot(token);
    this.publishSnapshot();
  }

  private attachActiveHostRun(
    token: symbol,
    threadId: string,
    task: AgentTask<HelarcTaskInput>,
    activeRun: HelarcHostActiveRun,
  ): void {
    const reservation = this.activeRunSlot;
    if (reservation.kind !== "reserved" || reservation.token !== token ||
      reservation.runId !== activeRun.runId || reservation.threadId !== threadId) {
      throw new Error("Helarc active Run reservation does not match the prepared launch.");
    }
    this.detachRunProjectionSubscriptions();
    this.activeRunSlot = {
      kind: "active",
      token,
      threadId,
      task,
      handle: activeRun,
      progressSequence: 0,
      progressTail: Promise.resolve(),
      persistenceFailure: null,
    };
    this.runProjection = createHelarcRunProjection({
      platform: activeRun.getProjection(),
      product: activeRun.getProductProjection(),
    });
    this.runProjectionUnsubscribers = [
      activeRun.subscribe((projection) => {
        this.applyRunProjectionUpdate({ kind: "platform", projection });
      }),
      activeRun.subscribeProductProjection((projection) => {
        this.applyRunProjectionUpdate({ kind: "product", projection });
      }),
    ];
    this.publishSnapshot();
  }

  private applyRunProjectionUpdate(update: HelarcRunProjectionUpdate): void {
    const current = this.runProjection;
    if (current === null) return;
    const reduction = reduceHelarcRunProjection(current, update);
    if (reduction.status !== "applied") return;
    this.runProjection = reduction.projection;
    const slot = this.activeRunSlot;
    if (slot.kind === "active" && reduction.projection.platform.terminal === null &&
      reduction.projection.product.result === null) {
      this.enqueueRunProgress(slot, reduction.projection);
    }
    this.publishSnapshot();
  }

  private enqueueRunProgress(
    slot: Extract<DesktopActiveRunSlot, { kind: "active" }>,
    projection: HelarcRunProjection,
  ): void {
    slot.progressSequence += 1;
    const progressSequence = slot.progressSequence;
    const currentRun = this.currentThreadRecord?.runs.find(
      (run) => run.id === slot.handle.runId,
    );
    const recordedAt = maxIsoDateTime(
      currentRun?.updatedAt ?? new Date().toISOString(),
      new Date().toISOString(),
    );
    const commit: HelarcRunProgressCommit = {
      kind: "run_progress",
      commitId: `helarc-progress-${slot.handle.runId}-${progressSequence}`,
      threadId: slot.threadId,
      runId: slot.handle.runId,
      committedAt: recordedAt,
      progressSequence,
      progress: {
        recordedAt,
        platform: projection.platform,
        product: projection.product,
      },
    };
    slot.progressTail = slot.progressTail.then(async () => {
      const result = await this.threadStore.commitRunProgress(commit);
      if (result.status === "rejected") {
        throw new HelarcDesktopPersistenceError(result.code, result.message);
      }
      this.currentThreadRecord = result.aggregate.record;
    }).catch((cause) => {
      const failure = cause instanceof Error ? cause : new Error("Run progress persistence failed.");
      slot.persistenceFailure ??= failure;
      this.lastError = {
        code: "session_persistence_failed",
        message: failure.message,
      };
      this.publishSnapshot();
    });
  }

  private releaseActiveRunSlot(token: symbol): void {
    if (this.activeRunSlot.kind === "empty" || this.activeRunSlot.token !== token) return;
    this.detachRunProjectionSubscriptions();
    this.activeRunSlot = { kind: "empty" };
  }

  private detachRunProjectionSubscriptions(): void {
    for (const unsubscribe of this.runProjectionUnsubscribers) {
      unsubscribe();
    }
    this.runProjectionUnsubscribers = [];
  }

  private getPendingPatchReview(): HelarcPendingPatchReviewProjection | null {
    const phase = this.runProjection?.product.phase;
    return phase?.kind === "waiting_for_patch_review" ? phase.review : null;
  }

  private getCurrentStatus(): HelarcMainSnapshotStatus {
    if (this.runProjection !== null) return this.runProjection.display.status;
    if (this.activeRunSlot.kind === "reserved") return "starting";
    return this.lastError?.code === "session_execution_failed"
      ? "failed"
      : this.inactiveStatus;
  }

  private createApprovalReviewBridge(
    runId: string,
  ): UserApprovalReviewBridge {
    return createUserApprovalReviewBridge({
      runId,
      descriptor: {
        id: "helarc-desktop-user-reviewer",
        kind: "user",
        displayName: "Helarc user",
        source: "helarc-desktop",
        metadata: { product: "helarc" },
      },
    });
  }

  private createPatchReviewBridge(runId: string) {
    return createHelarcPatchReviewBridge({ runId });
  }

  private async persistSessionHistory(
    task: AgentTask<HelarcTaskInput>,
    terminal: HelarcRunTerminalSummary | null,
  ): Promise<void> {
    const run = this.runProjection;
    const output = run?.product.result?.output ?? readTerminalProductOutput(terminal);
    const status = this.getCurrentStatus();
    if (!terminal || !run || !output || !this.selectedWorkspace || !this.provider.configured) {
      return;
    }
    if (!isTerminalSessionStatus(status)) {
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
      status,
      activity: [...run.product.activity],
      output,
      patch: createHistoryPatchSummary(this.lastPatchReview, output),
      run: {
        runId: run.runId,
        status: terminal.status,
        events: run.product.activity.map(mapHelarcActivityToRunEvent),
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

  private createInitialRunStartCommit(input: {
    sequenceNumber: number;
    taskId: string;
    taskText: string;
    runId: string;
    startedAt: string;
  }): { ok: true; commit: HelarcRunStartCommit } | { ok: false; error: HelarcWorkContextError } {
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
      latestRunId: null,
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
      messageIds: [],
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

    const runResult = createHelarcPersistedRun({
      id: input.runId,
      taskId: input.taskId,
      sessionId: threadId,
      threadId,
      triggeringMessageId: messageId,
      triggerMessageRole: "user",
      provider: {
        profileId: this.provider.activeProfile.id,
        providerKind: this.provider.activeProfile.providerKind,
        displayName: this.provider.activeProfile.displayName,
        endpointLabel: this.provider.activeProfile.endpointLabel,
        model: this.provider.activeProfile.model,
      },
      permissionPreset: "ask_for_approval",
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
      commit: {
        kind: "run_start",
        commitId: `helarc-start-${input.runId}`,
        threadId,
        runId: input.runId,
        committedAt: input.startedAt,
        target: {
          kind: "create_thread",
          thread: threadResult.thread,
          conversation: conversationResult.conversation,
        },
        triggeringMessage: messageResult.message,
        run: runResult.run,
      },
    };
  }

  private async persistWorkContextTerminal(
    outcome: Extract<HelarcHostRunOutcome, { kind: "run_result" }>,
    terminal: HelarcRunTerminalSummary,
  ): Promise<void> {
    const record = this.currentThreadRecord;
    if (record === null) {
      throw new HelarcDesktopPersistenceError(
        "thread_not_found",
        "The active Thread record is unavailable.",
      );
    }
    const run = record.runs.find((candidate) => candidate.id === outcome.terminal.runId);
    if (run === undefined) {
      throw new HelarcDesktopPersistenceError("run_not_found", "The active Run was not found.");
    }
    const artifacts = createTerminalArtifacts(record, run, terminal, this.lastPatchReview);
    const assistantMessage = createAssistantTerminalMessage(
      record,
      run,
      terminal,
      artifacts.map((artifact) => artifact.id),
    );
    if (assistantMessage === null) {
      throw new HelarcDesktopPersistenceError(
        "terminal_message_invalid",
        "The terminal assistant Message is invalid.",
      );
    }
    const commit: HelarcRunTerminalCommit = {
      kind: "run_terminal",
      commitId: `helarc-terminal-${run.id}`,
      threadId: record.thread.id,
      runId: run.id,
      committedAt: maxIsoDateTime(
        maxIsoDateTime(run.updatedAt, terminal.completedAt),
        new Date().toISOString(),
      ),
      terminal: {
        platform: outcome.terminal,
        product: outcome.product,
      },
      assistantMessage,
      artifacts,
    };
    const committed = await this.threadStore.commitRunTerminal(commit);
    if (committed.status === "rejected") {
      throw new HelarcDesktopPersistenceError(committed.code, committed.message);
    }
    this.currentThreadRecord = committed.aggregate.record;
    this.threadSummaries = upsertThreadSummarySnapshot(
      this.threadSummaries,
      createThreadSummarySnapshotFromRecord(committed.aggregate.record),
    );
  }

  private createActiveRunTerminalSummary(input: {
    status: HelarcRunTerminalStatus;
    runtimeStatus: "succeeded" | "failed" | "blocked" | "cancelled";
    runtimeCode: string | null;
    cancellation: RunCancellationSummary | null;
    safeOutput: unknown;
    errorSummary: Array<{ code: string; message: string }>;
    completedAt: string;
  }): HelarcRunTerminalSummary | null {
    const run = this.runProjection;
    const terminalResult = createHelarcRunTerminalSummary({
      status: input.status,
      runtimeStatus: input.runtimeStatus,
      runtimeCode: input.runtimeCode,
      cancellation: input.cancellation,
      safeOutput: input.safeOutput,
      errorSummary: input.errorSummary,
      startedAt: run?.platform.startedAt ?? this.currentSessionStartedAt ?? new Date().toISOString(),
      completedAt: input.completedAt,
      eventCount: run?.product.activity.length ?? 0,
    });

    return terminalResult.ok ? terminalResult.terminal : null;
  }

  private publishSnapshot(): HelarcMainSnapshot {
    const snapshot = this.getSnapshot();
    for (const subscriber of [...this.snapshotSubscribers]) {
      try {
        subscriber(snapshot);
      } catch {
        // Snapshot delivery is non-authoritative and isolated from Run execution.
      }
    }
    return snapshot;
  }
}

interface CompletedPatchReview {
  review: HelarcPendingPatchReviewProjection;
  decision: "accepted" | "rejected" | null;
  reason: string | null;
}

class HelarcDesktopPersistenceError extends Error {
  constructor(readonly persistenceCode: string, message: string) {
    super(message);
    this.name = "HelarcDesktopPersistenceError";
  }
}

function isTerminalSessionStatus(
  status: HelarcMainSnapshotStatus,
): status is Exclude<HelarcMainSnapshotStatus, "idle" | "workspace_selected" | "starting" | "running" | "cancelling" | "waiting_for_approval" | "waiting_for_patch_review" | "applying_patch"> {
  return status === "completed" ||
    status === "rejected" ||
    status === "failed" ||
    status === "blocked" ||
    status === "cancelled";
}

function mapSessionStatusToRunTerminalStatus(
  status: HelarcMainSnapshotStatus,
  output: HelarcProductOutput,
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
  output: HelarcProductOutput,
): HelarcSessionHistoryPatchSummary {
  if (!patchReview) {
    return {
      proposalId: null,
      operation: null,
      path: output.appliedPath,
      summary: output.agentSummary,
      decision: "not_required" as const,
      reason: null,
      status: output.patchStatus,
    };
  }

  return {
    proposalId: patchReview.review.proposalId,
    operation: patchReview.review.operation,
    path: patchReview.review.path,
    summary: patchReview.review.summary,
    decision: patchReview.decision ?? "unknown" as const,
    reason: patchReview.reason,
    status: output.patchStatus,
  };
}

function createAssistantTerminalMessage(
  record: HelarcThreadRecord,
  run: HelarcPersistedRun,
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
  run: HelarcPersistedRun,
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
            enforcement: {
              selected: safeOutput.enforcement.selected,
              status: safeOutput.enforcement.status,
              code: safeOutput.enforcement.code,
            },
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
        errors: terminal.errorSummary.map((error) => ({
          code: error.code,
          message: error.message,
        })),
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
    latestRun: createLatestRunSnapshot(record),
  };
}

function createLatestRunSnapshot(
  record: HelarcThreadRecord,
): HelarcThreadLatestRunSnapshot | null {
  const latestRun = record.thread.latestRunId === null
    ? null
    : record.runs.find((run) => run.id === record.thread.latestRunId) ?? null;
  if (latestRun === null) return null;
  return {
    runId: latestRun.id,
    status: deriveHelarcPersistedRunStatus(latestRun),
    startedAt: latestRun.startedAt,
    completedAt: latestRun.terminal?.platform.completedAt ?? null,
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

function maxIsoDateTime(left: string, right: string): string {
  return right.localeCompare(left) > 0 ? right : left;
}

function isHelarcSessionOutput(value: unknown): value is HelarcProductOutput {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const output = value as Partial<HelarcProductOutput>;
  return typeof output.taskId === "string" &&
    typeof output.runtimeStatus === "string" &&
    Array.isArray(output.safeErrors);
}

function readTerminalProductOutput(
  terminal: HelarcRunTerminalSummary | null,
): HelarcProductOutput | null {
  return terminal !== null && isHelarcSessionOutput(terminal.safeOutput)
    ? terminal.safeOutput
    : null;
}

function createThreadTitle(taskText: string): string {
  const normalized = taskText.trim().replace(/\s+/g, " ");
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
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

function resolveNextTaskNumber(summaries: readonly HelarcThreadSummary[]): number {
  let maximum = 0;
  for (const summary of summaries) {
    const match = /^helarc-thread-(\d+)$/.exec(summary.id);
    const value = match?.[1] === undefined ? 0 : Number(match[1]);
    if (Number.isSafeInteger(value) && value > maximum) {
      maximum = value;
    }
  }
  return maximum + 1;
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
