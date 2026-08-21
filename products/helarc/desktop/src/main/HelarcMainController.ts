import {
  createHostCommandDispatcher,
  createHostRunStatusQueryHandler,
  type HostCommandDispatcher,
  type HostCommandKind,
  type HostCommandReceipt,
  type HostRunStatusQueryHandler,
  type HostRunStatusQueryReceipt,
} from "@agent-anything/host/transport";
import {
  createInMemoryHostPolicyAmendmentStore,
  createInMemoryHostSessionAuthorityStore,
} from "@agent-anything/host/authority";
import type {
  HostTerminalRunProjection,
} from "@agent-anything/host/projection";
import {
  createHelarcProviderProfile,
  type HelarcProviderProfile,
  type HelarcWorkspaceProfile,
} from "@agent-anything/helarc/configuration";
import {
  createHelarcMessage,
  createHelarcArtifact,
  createHelarcPersistedRun,
  createHelarcThread,
  deriveHelarcPersistedRunStatus,
  projectHelarcWorkspaceSelectionIdentity,
  type HelarcRunProgressCommit,
  type HelarcRunStartCommit,
  type HelarcRunTerminalCommit,
  type HelarcArtifact,
  type HelarcArtifactCompleteness,
  type HelarcArtifactProducer,
  type HelarcArtifactRecordRef,
  type HelarcSafeValue,
  type HelarcMessage,
  type HelarcPersistedRunStatus,
  type HelarcThreadRecord,
  type HelarcThreadWorkspaceIdentity,
  type HelarcWorkContextError,
  type HelarcPersistedRun,
} from "@agent-anything/helarc/work-context";
import {
  createHelarcRunProjection,
  reduceHelarcRunProjection,
  type HelarcRunPermissionPreset,
  type HelarcRunProjection,
  type HelarcRunProjectionUpdate,
  type HelarcRunProviderRef,
} from "@agent-anything/helarc/run";
import type { HelarcProductResult } from "@agent-anything/helarc/composition";
import {
  createBuiltInHelarcTaskTemplates,
  type HelarcTaskTemplate,
  type HelarcTaskInputError,
} from "@agent-anything/helarc/task";
import type { RunInputItem } from "@agent-anything/agent-core/input";
import type { ContextManifestPersistencePort } from "@agent-anything/context/persistence";
import type { WorkspaceSelection } from "@agent-anything/workspace/selection";
import type { Provider } from "@agent-anything/model-interaction";
import type { ModelContinuationStore } from "@agent-anything/model-interaction/continuation";
import { basename, isAbsolute, normalize } from "node:path";
import type { HelarcProductRunStartTarget } from "../shared/HelarcDesktopCommand.js";
import type { HelarcProviderProfileStoreError } from "./provider/HelarcProviderProfileStore.js";
import type { ProviderCredentialStoreError } from "./provider/ProviderCredentialStore.js";
import {
  createHelarcDesktopIdentityResolver,
  createHelarcDesktopWorkspaceResolver,
  prepareHelarcHostRun,
  prepareHelarcRunStart,
  type HelarcHostActiveRun,
  type HelarcHostRunResult,
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
  | "completed"
  | "rejected"
  | "failed"
  | "blocked"
  | "cancelled";

export type HelarcThreadMessageRole =
  | "user"
  | "assistant"
  | "system"
  | "product";

export interface HelarcThreadMessageSnapshot {
  id: string;
  sequence: number;
  role: HelarcThreadMessageRole;
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
  revision: number;
  messages: HelarcThreadMessageSnapshot[];
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
  | "run_execution_failed"
  | "run_persistence_failed"
  | "run_already_active"
  | "run_not_active"
  | "workspace_not_selected"
  | "workspace_path_required"
  | "workspace_path_not_absolute"
  | "workspace_path_not_found"
  | "workspace_path_not_directory"
  | "workspace_profile_not_found"
  | "workspace_profile_invalid"
  | "thread_not_selected"
  | "thread_selection_mismatch"
  | "thread_not_open"
  | "thread_workspace_mismatch"
  | HelarcWorkContextError["code"]
  | ProviderCredentialStoreError["code"]
  | HelarcProviderProfileStoreError["code"]
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

export interface StartHelarcRunInput {
  taskText: string;
  target: HelarcProductRunStartTarget;
}

export type StartHelarcRunResult =
  | {
      ok: true;
      taskId: string;
      productRunId: string;
      threadId: string;
      snapshot: HelarcMainSnapshot;
    }
  | { ok: false; error: HelarcMainError; snapshot: HelarcMainSnapshot };

type HelarcRunStartCommitTarget =
  | {
      readonly kind: "create_thread";
      readonly threadId: string;
      readonly expectedThreadRevision: 0;
      readonly messageSequence: 1;
    }
  | {
      readonly kind: "existing_thread";
      readonly threadId: string;
      readonly expectedThreadRevision: number;
      readonly messageSequence: number;
    };

interface ResolvedHelarcRunStartTarget {
  readonly threadId: string;
  readonly startedAt: string;
  readonly workspaceProfileId: string;
  readonly additionalWorkspaceProfileIds: readonly string[];
  readonly workspaceProfiles: readonly HelarcWorkspaceProfile[];
  readonly inputItems: readonly RunInputItem[];
  readonly commitTarget: HelarcRunStartCommitTarget;
}

type ResolveHelarcRunStartTargetResult =
  | { readonly ok: true; readonly target: ResolvedHelarcRunStartTarget }
  | { readonly ok: false; readonly error: HelarcMainError };

export type OpenHelarcThreadResult =
  | { ok: true; snapshot: HelarcMainSnapshot }
  | { ok: false; error: HelarcMainError; snapshot: HelarcMainSnapshot };

export interface HelarcMainControllerInput {
  provider?: Provider | null;
  providerConfigError?: (HelarcMainError & { missingKeys?: string[] }) | null;
  providerProfile?: HelarcProviderProfile | null;
  runtimeToolMode?: HelarcRuntimeToolMode;
  workspaceProfiles?: HelarcWorkspaceProfile[];
  threadSummaries?: HelarcThreadSummary[];
  taskTemplates?: HelarcTaskTemplate[];
  threadStore?: HelarcThreadStore;
  modelContinuationStore?: ModelContinuationStore;
  contextManifestPersistence?: ContextManifestPersistencePort;
}

export type HelarcRuntimeToolMode = "read-only" | "shell-enabled";

type DesktopActiveRunSlot =
  | { readonly kind: "empty" }
  | {
      readonly kind: "reserved";
      readonly token: symbol;
      readonly threadId: string;
      readonly productRunId: string;
    }
  | {
      readonly kind: "active";
      readonly token: symbol;
      readonly threadId: string;
      readonly productRunId: string;
      readonly handle: HelarcHostActiveRun;
      progressSequence: number;
      threadRevision: number;
      progressTail: Promise<void>;
      persistenceFailure: Error | null;
    };

export class HelarcMainController {
  private selectedWorkspace: HelarcWorkspaceSnapshot | null = null;
  private acceptedTask: HelarcAcceptedTaskSnapshot | null = null;
  private runProjection: HelarcRunProjection | null = null;
  private lastError: HelarcMainError | null = null;
  private workspaceProfiles: HelarcWorkspaceProfile[] = [];
  private threadSummaries: HelarcThreadSummarySnapshot[] = [];
  private readonly taskTemplates: HelarcTaskTemplate[];
  private currentThreadRecord: HelarcThreadRecord | null = null;
  private readonly threadStore: HelarcThreadStore;
  private readonly modelContinuationStore: ModelContinuationStore | undefined;
  private readonly contextManifestPersistence:
    | ContextManifestPersistencePort
    | undefined;
  private provider: HelarcProviderSnapshot;
  private providerInstance: Provider | null;
  private readonly runtimeToolMode: HelarcRuntimeToolMode;
  private inactiveStatus: "idle" | "workspace_selected" = "idle";
  private nextTaskNumber = 1;
  private activeRunSlot: DesktopActiveRunSlot = { kind: "empty" };
  private readonly hostCommandDispatcher: HostCommandDispatcher =
    createHostCommandDispatcher({
      resolveActiveRun: (runId) => {
        const slot = this.activeRunSlot;
        return slot.kind === "active" && slot.handle.runId === runId
          ? slot.handle
          : null;
      },
      cancellationAttribution: {
        origin: "user",
        reasonCode: "user_requested",
      },
      steeringAttribution: {
        origin: "user",
        actorId: null,
      },
    });
  private readonly hostRunStatusQueryHandler: HostRunStatusQueryHandler =
    createHostRunStatusQueryHandler({
      resolveRun: (runId) => {
        const slot = this.activeRunSlot;
        return slot.kind === "active" && slot.handle.runId === runId
          ? slot.handle
          : null;
      },
    });
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
    this.threadSummaries = (input.threadSummaries ?? []).map(createThreadSummarySnapshot);
    this.nextTaskNumber = resolveNextTaskNumber(input.threadSummaries ?? []);
    this.taskTemplates = input.taskTemplates ?? createBuiltInHelarcTaskTemplates();
    this.threadStore = input.threadStore ?? new InMemoryHelarcThreadStore();
    this.modelContinuationStore = input.modelContinuationStore;
    this.contextManifestPersistence = input.contextManifestPersistence;
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

  dispatchHostCommand(
    candidate: unknown,
    expectedKind: HostCommandKind,
  ): HostCommandReceipt {
    return this.hostCommandDispatcher.dispatch(candidate, expectedKind);
  }

  queryRunStatus(candidate: unknown): HostRunStatusQueryReceipt {
    return this.hostRunStatusQueryHandler.query(candidate);
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
      return this.fail("run_already_active", "A Helarc Run is already active.");
    }
    this.selectedWorkspace = workspace;
    this.inactiveStatus = "workspace_selected";
    this.acceptedTask = null;
    this.runProjection = null;
    this.lastError = null;
    this.currentThreadRecord = null;
    this.detachRunProjectionSubscriptions();
    return this.publishSnapshot();
  }

  async startRun(input: StartHelarcRunInput): Promise<StartHelarcRunResult> {
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
      const error = this.setError("run_already_active", "A Helarc Run is already active.");
      return { ok: false, error, snapshot: this.getSnapshot() };
    }

    const sequenceNumber = this.nextTaskNumber;
    const taskId = `helarc-task-${sequenceNumber}`;
    const runId = `helarc-run-${sequenceNumber}`;
    const resolvedTarget = this.resolveRunStartTarget(
      input.target,
      sequenceNumber,
      new Date().toISOString(),
    );
    if (!resolvedTarget.ok) {
      const error = this.setError(
        resolvedTarget.error.code,
        resolvedTarget.error.message,
      );
      return { ok: false, error, snapshot: this.getSnapshot() };
    }
    const {
      additionalWorkspaceProfileIds,
      commitTarget,
      inputItems,
      startedAt,
      threadId,
      workspaceProfileId,
      workspaceProfiles,
    } = resolvedTarget.target;
    const preparedStart = prepareHelarcRunStart({
      runId,
      taskId,
      taskText: input.taskText,
      workspaceProfileId,
      additionalWorkspaceProfileIds,
      providerProfileId: this.provider.activeProfile.id,
      workspaceProfiles,
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

    const token = Symbol(runId);
    this.activeRunSlot = {
      kind: "reserved",
      token,
      threadId,
      productRunId: runId,
    };
    this.acceptedTask = null;
    this.runProjection = null;
    this.lastError = null;
    this.publishSnapshot();

    let startCommitted = false;
    try {
      const threadWorkspace = preparedStart.prepared.workspace;
      const preparedHostRun = await prepareHelarcHostRun({
        task: preparedStart.prepared.task,
        workspaceResolver: createHelarcDesktopWorkspaceResolver(threadWorkspace),
        workspaceSelection: {
          kind: "references",
          primaryRef: threadWorkspace.primary.profileId,
          additionalRefs: threadWorkspace.additional.map(
            (workspace) => workspace.profileId,
          ),
        },
        identityResolver: createHelarcDesktopIdentityResolver(),
        identitySelection: { kind: "anonymous" },
        productRunId: runId,
        sessionId: threadId,
        provider: providerInstance,
        modelContinuationStore: this.modelContinuationStore,
        contextManifestPersistence: this.contextManifestPersistence,
        inputItems,
        toolMode: this.runtimeToolMode,
        permissionPreset: preparedStart.prepared.run.permissionPreset,
        sessionAuthorityPort: this.sessionAuthorityStore,
        persistentPolicyAmendments: this.policyAmendmentStore,
      });
      const startCommitResult = this.createRunStartCommit({
        sequenceNumber,
        taskId,
        taskText: preparedStart.prepared.task.input.prompt,
        runId,
        target: commitTarget,
        startedAt,
        threadWorkspace,
        runWorkspace: preparedHostRun.workspace,
        provider: preparedStart.prepared.provider,
        permissionPreset: preparedStart.prepared.run.permissionPreset,
      });
      if (!startCommitResult.ok) {
        throw new TypeError(startCommitResult.error.message);
      }
      let committed: Awaited<ReturnType<HelarcThreadStore["commitRunStart"]>>;
      try {
        committed = await this.threadStore.commitRunStart(startCommitResult.commit);
      } catch {
        throw new HelarcDesktopPersistenceError(
          "thread_store_write_failed",
          "Helarc could not persist the Run start.",
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
        runId,
        composition.activeRun,
      );
      void this.observeActiveRun(token, composition.result);
      return {
        ok: true,
        taskId: preparedStart.prepared.task.id,
        productRunId: runId,
        threadId,
        snapshot: this.getSnapshot(),
      };
    } catch (cause) {
      if (startCommitted && this.nextTaskNumber === sequenceNumber) {
        this.nextTaskNumber += 1;
      }
      this.releaseActiveRunSlot(token);
      const persistenceFailure = cause instanceof HelarcDesktopPersistenceError;
      const error = this.setError(
        persistenceFailure ? "run_persistence_failed" : "run_execution_failed",
        persistenceFailure
          ? "Helarc could not persist the Run start."
          : "Helarc could not start the Run.",
      );
      this.publishSnapshot();
      return { ok: false, error, snapshot: this.getSnapshot() };
    }
  }

  async openThread(threadId: string): Promise<OpenHelarcThreadResult> {
    const normalizedThreadId = threadId.trim();
    const slot = this.activeRunSlot;
    if (slot.kind !== "empty" && slot.threadId !== normalizedThreadId) {
      const error = this.setError(
        "run_already_active",
        "A different Helarc Thread is active.",
      );
      return { ok: false, error, snapshot: this.getSnapshot() };
    }
    const record = await this.threadStore.loadThread(normalizedThreadId);
    if (record === null) {
      const error = this.setError("thread_record_invalid", "Thread was not found.");
      return { ok: false, error, snapshot: this.getSnapshot() };
    }
    if (slot.kind === "empty") {
      this.acceptedTask = null;
      this.runProjection = null;
      this.detachRunProjectionSubscriptions();
    }
    this.currentThreadRecord = record;
    const primaryWorkspace = record.thread.workspace.primary;
    this.selectedWorkspace = {
      id: primaryWorkspace.profileId,
      name: primaryWorkspace.displayName,
      path: primaryWorkspace.path,
    };
    this.inactiveStatus = "workspace_selected";
    this.lastError = null;
    return { ok: true, snapshot: this.publishSnapshot() };
  }

  private resolveRunStartTarget(
    target: HelarcProductRunStartTarget,
    sequenceNumber: number,
    requestedStartedAt: string,
  ): ResolveHelarcRunStartTargetResult {
    const selectedWorkspace = this.selectedWorkspace;
    if (selectedWorkspace === null) {
      return rejectRunStartTarget(
        "workspace_not_selected",
        "Choose a workspace before starting a task.",
      );
    }

    if (target.kind === "new_thread") {
      const threadId = `helarc-thread-${sequenceNumber}`;
      const workspaceProfile = this.workspaceProfiles.find(
        (profile) =>
          profile.id === selectedWorkspace.id &&
          profile.displayName === selectedWorkspace.name &&
          profile.path === selectedWorkspace.path,
      ) ?? {
        id: selectedWorkspace.id,
        displayName: selectedWorkspace.name,
        path: selectedWorkspace.path,
        lastOpenedAt: requestedStartedAt,
        trustState: "trusted" as const,
      };
      return {
        ok: true,
        target: {
          threadId,
          startedAt: requestedStartedAt,
          workspaceProfileId: workspaceProfile.id,
          additionalWorkspaceProfileIds: [],
          workspaceProfiles: [workspaceProfile],
          inputItems: [],
          commitTarget: {
            kind: "create_thread",
            threadId,
            expectedThreadRevision: 0,
            messageSequence: 1,
          },
        },
      };
    }

    const record = this.currentThreadRecord;
    if (record === null) {
      return rejectRunStartTarget(
        "thread_not_selected",
        "Open the Thread before continuing it.",
      );
    }
    if (target.threadId !== record.thread.id) {
      return rejectRunStartTarget(
        "thread_selection_mismatch",
        "The continued Thread does not match the selected Thread.",
      );
    }
    if (record.thread.status !== "open") {
      return rejectRunStartTarget(
        "thread_not_open",
        "Only an open Thread can be continued.",
      );
    }

    const primary = record.thread.workspace.primary;
    if (
      selectedWorkspace.id !== primary.profileId ||
      selectedWorkspace.name !== primary.displayName ||
      selectedWorkspace.path !== primary.path
    ) {
      return rejectRunStartTarget(
        "thread_workspace_mismatch",
        "The selected Workspace does not match the continued Thread.",
      );
    }

    const startedAt = maxIsoDateTime(requestedStartedAt, record.thread.updatedAt);
    const workspaceProfiles: HelarcWorkspaceProfile[] = [];
    for (const workspace of [
      record.thread.workspace.primary,
      ...record.thread.workspace.additional,
    ]) {
      const currentProfile = this.workspaceProfiles.find(
        (profile) => profile.id === workspace.profileId,
      );
      if (
        currentProfile !== undefined &&
        (
          currentProfile.displayName !== workspace.displayName ||
          currentProfile.path !== workspace.path
        )
      ) {
        return rejectRunStartTarget(
          "thread_workspace_mismatch",
          "A continued Thread Workspace reference no longer matches its profile.",
        );
      }
      workspaceProfiles.push(currentProfile ?? {
        id: workspace.profileId,
        displayName: workspace.displayName,
        path: workspace.path,
        lastOpenedAt: startedAt,
        trustState: "trusted",
      });
    }

    const inputItems: RunInputItem[] = [];
    for (const message of record.messages) {
      if (
        message.role === "system" ||
        message.role === "user" ||
        message.role === "assistant"
      ) {
        inputItems.push({
          id: message.id,
          kind: "message",
          role: message.role,
          content: message.content,
          createdAt: message.createdAt,
          metadata: {},
        });
      }
    }

    return {
      ok: true,
      target: {
        threadId: record.thread.id,
        startedAt,
        workspaceProfileId: primary.profileId,
        additionalWorkspaceProfileIds: record.thread.workspace.additional.map(
          (workspace) => workspace.profileId,
        ),
        workspaceProfiles,
        inputItems,
        commitTarget: {
          kind: "existing_thread",
          threadId: record.thread.id,
          expectedThreadRevision: record.thread.revision,
          messageSequence: record.messages.length + 1,
        },
      },
    };
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
    result: Promise<HelarcHostRunResult>,
  ): Promise<void> {
    let outcome: HelarcHostRunResult;
    try {
      outcome = await result;
    } catch {
      const failedSlot = this.activeRunSlot;
      if (failedSlot.kind !== "active" || failedSlot.token !== token) return;
      await failedSlot.progressTail;
      this.lastError = {
        code: "run_execution_failed",
        message: "Helarc could not settle the active Run.",
      };
      this.releaseActiveRunSlot(token);
      this.publishSnapshot();
      return;
    }
    const slot = this.activeRunSlot;
    if (slot.kind !== "active" || slot.token !== token) return;
    await slot.progressTail;

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
      await this.persistWorkContextTerminal(outcome);
    } catch {
      this.lastError = {
        code: "run_persistence_failed",
        message: "Helarc could not persist the terminal Run state.",
      };
    }
    this.releaseActiveRunSlot(token);
    this.publishSnapshot();
  }

  private attachActiveHostRun(
    token: symbol,
    threadId: string,
    productRunId: string,
    activeRun: HelarcHostActiveRun,
  ): void {
    const reservation = this.activeRunSlot;
    if (reservation.kind !== "reserved" || reservation.token !== token ||
      reservation.productRunId !== productRunId ||
      reservation.threadId !== threadId) {
      throw new Error("Helarc active Run reservation does not match the prepared launch.");
    }
    this.detachRunProjectionSubscriptions();
    this.activeRunSlot = {
      kind: "active",
      token,
      threadId,
      productRunId,
      handle: activeRun,
      progressSequence: 0,
      threadRevision: this.currentThreadRecord?.thread.revision ?? 0,
      progressTail: Promise.resolve(),
      persistenceFailure: null,
    };
    this.runProjection = createHelarcRunProjection({
      host: activeRun.getProjection(),
      product: activeRun.getProductProjection(),
    });
    this.runProjectionUnsubscribers = [
      activeRun.subscribe((projection) => {
        this.applyRunProjectionUpdate({ kind: "host", projection });
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
    if (slot.kind === "active" && reduction.projection.host.terminal === null &&
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
    const expectedThreadRevision = slot.threadRevision;
    slot.threadRevision += 1;
    const currentRun = this.currentThreadRecord?.runs.find(
      (run) => run.id === slot.productRunId,
    );
    const recordedAt = maxIsoDateTime(
      currentRun?.updatedAt ?? new Date().toISOString(),
      new Date().toISOString(),
    );
    const commit: HelarcRunProgressCommit = {
      kind: "run_progress",
      commitId: `helarc-progress-${slot.productRunId}-${progressSequence}`,
      threadId: slot.threadId,
      runId: slot.productRunId,
      committedAt: recordedAt,
      expectedThreadRevision,
      progressSequence,
      progress: {
        recordedAt,
        host: projection.host,
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
        code: "run_persistence_failed",
        message: "Helarc could not persist Run progress.",
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

  private getCurrentStatus(): HelarcMainSnapshotStatus {
    if (this.runProjection !== null) return this.runProjection.display.status;
    if (this.activeRunSlot.kind === "reserved") return "starting";
    return this.lastError?.code === "run_execution_failed"
      ? "failed"
      : this.inactiveStatus;
  }

  private createRunStartCommit(input: {
    sequenceNumber: number;
    taskId: string;
    taskText: string;
    runId: string;
    target: HelarcRunStartCommitTarget;
    startedAt: string;
    threadWorkspace: HelarcThreadWorkspaceIdentity;
    runWorkspace: WorkspaceSelection;
    provider: HelarcRunProviderRef;
    permissionPreset: HelarcRunPermissionPreset;
  }): { ok: true; commit: HelarcRunStartCommit } | { ok: false; error: HelarcWorkContextError } {
    const threadId = input.target.threadId;
    const messageId = `helarc-message-${input.sequenceNumber}`;

    const messageResult = createHelarcMessage({
      id: messageId,
      threadId,
      sequence: input.target.messageSequence,
      role: "user",
      content: input.taskText,
      source: { kind: "user_input", owner: "helarc-desktop", refId: messageId },
      correlation: {
        runId: input.runId,
        interactionRequestId: null,
        reviewId: null,
      },
      createdAt: input.startedAt,
      relatedRunIds: [input.runId],
      relatedArtifactIds: [],
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
      triggeringThreadRevision: input.target.expectedThreadRevision,
      workspace: projectHelarcWorkspaceSelectionIdentity({
        workspace: input.runWorkspace,
        threadWorkspace: input.threadWorkspace,
      }),
      provider: input.provider,
      permissionPreset: input.permissionPreset,
      startedAt: input.startedAt,
      metadata: {
        product: "helarc",
      },
    });
    if (!runResult.ok) {
      return runResult;
    }

    let target: HelarcRunStartCommit["target"];
    if (input.target.kind === "create_thread") {
      const threadResult = createHelarcThread({
        id: threadId,
        revision: 0,
        workspace: input.threadWorkspace,
        title: createThreadTitle(input.taskText),
        status: "open",
        createdAt: input.startedAt,
        updatedAt: input.startedAt,
        latestRunId: null,
        metadata: {
          product: "helarc",
        },
      });
      if (!threadResult.ok) {
        return threadResult;
      }

      target = {
        kind: "create_thread",
        thread: threadResult.thread,
      };
    } else {
      target = { kind: "existing_thread" };
    }

    return {
      ok: true,
      commit: {
        kind: "run_start",
        commitId: `helarc-start-${input.runId}`,
        threadId,
        runId: input.runId,
        committedAt: input.startedAt,
        expectedThreadRevision: input.target.expectedThreadRevision,
        target,
        triggeringMessage: messageResult.message,
        run: runResult.run,
      },
    };
  }

  private async persistWorkContextTerminal(
    outcome: HelarcHostRunResult,
  ): Promise<void> {
    const record = this.currentThreadRecord;
    if (record === null) {
      throw new HelarcDesktopPersistenceError(
        "thread_not_found",
        "The active Thread record is unavailable.",
      );
    }
    const run = record.runs.find(
      (candidate) => candidate.id === outcome.productRunId,
    );
    if (run === undefined) {
      throw new HelarcDesktopPersistenceError("run_not_found", "The active Run was not found.");
    }
    const artifacts = createTerminalArtifacts(
      record,
      run,
      outcome.terminal,
      outcome.product,
    );
    const assistantMessage = createAssistantTerminalMessage(
      record,
      run,
      outcome.terminal,
      outcome.product,
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
        maxIsoDateTime(run.updatedAt, outcome.terminal.completedAt),
        new Date().toISOString(),
      ),
      expectedThreadRevision: record.thread.revision,
      terminal: {
        host: outcome.terminal,
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

class HelarcDesktopPersistenceError extends Error {
  constructor(readonly persistenceCode: string, message: string) {
    super(message);
    this.name = "HelarcDesktopPersistenceError";
  }
}

function createAssistantTerminalMessage(
  record: HelarcThreadRecord,
  run: HelarcPersistedRun,
  terminal: HostTerminalRunProjection,
  product: HelarcProductResult,
  relatedArtifactIds: readonly string[],
): HelarcMessage | null {
  const content = createAssistantTerminalMessageContent(terminal, product);
  if (!content) {
    return null;
  }

  const result = createHelarcMessage({
    id: `${run.triggeringMessageId}-assistant`,
    threadId: record.thread.id,
    sequence: record.messages.length + 1,
    role: "assistant",
    content,
    source: { kind: "agent_run", owner: "helarc", refId: run.id },
    correlation: {
      runId: run.id,
      interactionRequestId: null,
      reviewId: null,
    },
    createdAt: terminal.completedAt,
    relatedRunIds: [run.id],
    relatedArtifactIds,
  });

  return result.ok ? result.message : null;
}

function createTerminalArtifacts(
  record: HelarcThreadRecord,
  run: HelarcPersistedRun,
  terminal: HostTerminalRunProjection,
  product: HelarcProductResult,
): HelarcArtifact[] {
  const artifacts: HelarcArtifact[] = [];
  const safeOutput = product.output;
  const summary = safeOutput.agentSummary;

  if (summary) {
    const artifact = createArtifact({
      id: `${run.id}-artifact-final-output`,
      threadId: record.thread.id,
      runId: run.id,
      kind: "final-output",
      title: "Final output",
      summary,
      createdAt: terminal.completedAt,
      producer: { kind: "agent", owner: "helarc", refId: run.id },
      sourceRefs: [runResultArtifactRef(product)],
      effectRefs: operationEffectArtifactRefs(product),
      completeness: product.incompleteWork.length === 0 ? "complete" : "partial",
      limitations: [...product.uncertainty, ...product.residualRisk],
      payload: safeOutput
        ? {
            agentSummary: safeOutput.agentSummary,
            runtimeStatus: safeOutput.runtimeStatus,
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

  if (safeOutput.safeErrors.length > 0) {
    const artifact = createArtifact({
      id: `${run.id}-artifact-error-report`,
      threadId: record.thread.id,
      runId: run.id,
      kind: "error-report",
      title: "Error report",
      summary: safeOutput.safeErrors[0]?.message ?? "Run reported errors.",
      createdAt: terminal.completedAt,
      producer: { kind: "product", owner: "helarc", refId: run.id },
      sourceRefs: [runResultArtifactRef(product)],
      effectRefs: operationEffectArtifactRefs(product),
      completeness: product.incompleteWork.length === 0 ? "complete" : "partial",
      limitations: [...product.uncertainty, ...product.residualRisk],
      payload: {
        hostStatus: terminal.status,
        productStatus: product.status,
        runtimeStatus: safeOutput.runtimeStatus,
        runtimeCode: terminal.code,
        errors: safeOutput.safeErrors.map((error) => ({
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

interface CreateTerminalArtifactInput {
  readonly id: string;
  readonly threadId: string;
  readonly runId: string;
  readonly kind: HelarcArtifact["kind"];
  readonly title: string;
  readonly summary: string | null;
  readonly producer: HelarcArtifactProducer;
  readonly sourceRefs: readonly [HelarcArtifactRecordRef, ...HelarcArtifactRecordRef[]];
  readonly effectRefs: readonly HelarcArtifactRecordRef[];
  readonly completeness: HelarcArtifactCompleteness;
  readonly limitations: readonly string[];
  readonly createdAt: string;
  readonly payload: HelarcSafeValue;
}

function createArtifact(input: CreateTerminalArtifactInput): HelarcArtifact | null {
  const result = createHelarcArtifact({
    id: input.id,
    threadId: input.threadId,
    runId: input.runId,
    kind: input.kind,
    title: input.title,
    summary: input.summary,
    producer: input.producer,
    sourceRefs: input.sourceRefs,
    effectRefs: input.effectRefs,
    content: { kind: "inline", mediaType: "application/json", value: input.payload },
    completeness: input.completeness,
    sensitivity: "private",
    freshness: {
      status: "current",
      observedAt: input.createdAt,
      sourceRevision: input.sourceRefs[0].revision,
    },
    integrity: { status: "unverified" },
    lifecycle: "final",
    persistence: "thread_record",
    limitations: input.limitations,
    createdAt: input.createdAt,
  });
  return result.ok ? result.artifact : null;
}

function runResultArtifactRef(product: HelarcProductResult): HelarcArtifactRecordRef {
  return {
    owner: "agent-core",
    kind: "run_result",
    id: product.runResult.runId,
    revision: product.runResult.completedAt,
  };
}

function operationEffectArtifactRefs(product: HelarcProductResult): readonly HelarcArtifactRecordRef[] {
  return product.effects.map((effect) => ({
    owner: effect.semanticOwner,
    kind: "operation_result",
    id: effect.operationResultId,
    revision: null,
  }));
}

function createAssistantTerminalMessageContent(
  terminal: HostTerminalRunProjection,
  product: HelarcProductResult,
): string {
  const summary = product.output.agentSummary;
  if (summary) {
    return summary;
  }

  if (terminal.status === "cancelled") {
    return "Run cancelled.";
  }

  if (terminal.status === "blocked") {
    return "Run blocked.";
  }

  if (product.output.safeErrors.length > 0) {
    return product.output.safeErrors
      .map((error) => `${error.code}: ${error.message}`)
      .join("; ");
  }

  if (terminal.status === "failed") {
    return "Run failed.";
  }

  if (product.status === "rejected") {
    return "Run rejected.";
  }

  return product.status === "completed" ? "Run completed." : `Run ${product.status}.`;
}

function createActiveThreadSnapshot(record: HelarcThreadRecord | null): HelarcActiveThreadSnapshot | null {
  if (!record) {
    return null;
  }

  const messages = record.messages.map((message) => ({
    id: message.id,
    sequence: message.sequence,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    relatedRunIds: [...message.relatedRunIds],
    relatedArtifactIds: [...message.relatedArtifactIds],
  }));

  const primaryWorkspace = record.thread.workspace.primary;
  return {
    id: record.thread.id,
    title: record.thread.title,
    status: record.thread.status,
    workspace: {
      id: primaryWorkspace.profileId,
      name: primaryWorkspace.displayName,
      path: primaryWorkspace.path,
    },
    revision: record.thread.revision,
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
  const primaryWorkspace = summary.workspace.primary;
  return {
    id: summary.id,
    title: summary.title,
    status: summary.status,
    workspace: {
      id: primaryWorkspace.profileId,
      name: primaryWorkspace.displayName,
      path: primaryWorkspace.path,
    },
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    latestRun: summary.latestRun,
  };
}

function createThreadSummarySnapshotFromRecord(record: HelarcThreadRecord): HelarcThreadSummarySnapshot {
  const primaryWorkspace = record.thread.workspace.primary;
  return {
    id: record.thread.id,
    title: record.thread.title,
    status: record.thread.status,
    workspace: {
      id: primaryWorkspace.profileId,
      name: primaryWorkspace.displayName,
      path: primaryWorkspace.path,
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
    completedAt: latestRun.terminal?.host.completedAt ?? null,
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

function rejectRunStartTarget(
  code: HelarcMainErrorCode,
  message: string,
): ResolveHelarcRunStartTargetResult {
  return { ok: false, error: { code, message } };
}

function maxIsoDateTime(left: string, right: string): string {
  return right.localeCompare(left) > 0 ? right : left;
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
