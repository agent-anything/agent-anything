import type {
  HostRunProjection,
  HostTerminalRunProjection,
} from "@agent-anything/host";
import type { ISODateTimeString, Metadata } from "@agent-anything/shared";
import type {
  HelarcProductResult,
} from "../composition/HelarcProductResult.js";
import type { HelarcProviderKind } from "../provider-profile/index.js";
import type { HelarcRunPermissionPreset } from "../run/index.js";
import type { HelarcProductRunProjection } from "../run/HelarcRunProjection.js";

export type HelarcThreadStatus = "open" | "closed" | "archived";

export type HelarcMessageRole =
  | "user"
  | "assistant"
  | "system"
  | "tool"
  | "product-event";

export type HelarcRunTriggerMessageRole = Extract<
  HelarcMessageRole,
  "user" | "product-event" | "system"
>;

export type HelarcPersistedRunStatus =
  | "inactive"
  | "completed"
  | "rejected"
  | "blocked"
  | "failed"
  | "cancelled";

export type HelarcArtifactKind =
  | "final-output"
  | "patch-proposal"
  | "applied-patch"
  | "trace-projection"
  | "tool-output-summary"
  | "error-report";

export interface HelarcThreadWorkspaceRef {
  profileId: string | null;
  displayName: string;
  path: string;
}

export interface CreateHelarcThreadInput {
  id: string;
  workspace: HelarcThreadWorkspaceRef;
  title: string;
  status?: HelarcThreadStatus;
  createdAt: ISODateTimeString;
  updatedAt: ISODateTimeString;
  activeConversationId: string;
  latestRunId?: string | null;
  metadata?: Metadata;
}

export interface HelarcThread {
  id: string;
  workspace: HelarcThreadWorkspaceRef;
  title: string;
  status: HelarcThreadStatus;
  createdAt: ISODateTimeString;
  updatedAt: ISODateTimeString;
  activeConversationId: string;
  latestRunId: string | null;
  metadata: Metadata;
}

export interface CreateHelarcConversationInput {
  id: string;
  threadId: string;
  createdAt: ISODateTimeString;
  updatedAt: ISODateTimeString;
  messageIds?: readonly string[];
  metadata?: Metadata;
}

export interface HelarcConversation {
  id: string;
  threadId: string;
  createdAt: ISODateTimeString;
  updatedAt: ISODateTimeString;
  messageIds: string[];
  metadata: Metadata;
}

export interface CreateHelarcMessageInput {
  id: string;
  threadId: string;
  conversationId: string;
  role: HelarcMessageRole;
  content: string;
  createdAt: ISODateTimeString;
  relatedRunIds?: readonly string[];
  relatedArtifactIds?: readonly string[];
  metadata?: Metadata;
}

export interface HelarcMessage {
  id: string;
  threadId: string;
  conversationId: string;
  role: HelarcMessageRole;
  content: string;
  createdAt: ISODateTimeString;
  relatedRunIds: string[];
  relatedArtifactIds: string[];
  metadata: Metadata;
}

export interface HelarcRunProviderContext {
  profileId: string | null;
  providerKind: HelarcProviderKind | null;
  displayName: string;
  endpointLabel: string;
  model: string;
}

export interface CreateHelarcPersistedRunInput {
  id: string;
  taskId: string;
  sessionId: string;
  threadId: string;
  triggeringMessageId: string;
  triggerMessageRole: HelarcRunTriggerMessageRole;
  provider?: HelarcRunProviderContext | null;
  permissionPreset?: HelarcRunPermissionPreset;
  startedAt: ISODateTimeString;
  metadata?: Metadata;
}

export interface HelarcRunProgressRecord {
  readonly recordedAt: ISODateTimeString;
  readonly platform: HostRunProjection;
  readonly product: HelarcProductRunProjection;
}

export interface HelarcRunTerminalRecord {
  readonly platform: HostTerminalRunProjection;
  readonly product: HelarcProductResult | null;
}

export interface HelarcPersistedRun {
  id: string;
  taskId: string;
  sessionId: string;
  threadId: string;
  triggeringMessageId: string;
  triggerMessageRole: HelarcRunTriggerMessageRole;
  provider: HelarcRunProviderContext | null;
  permissionPreset: HelarcRunPermissionPreset;
  startedAt: ISODateTimeString;
  updatedAt: ISODateTimeString;
  progressSequence: number;
  lastProgress: HelarcRunProgressRecord | null;
  terminal: HelarcRunTerminalRecord | null;
  artifactIds: string[];
  metadata: Metadata;
}

export type HelarcSafeValue =
  | null
  | boolean
  | number
  | string
  | readonly HelarcSafeValue[]
  | { readonly [key: string]: HelarcSafeValue };

export interface CreateHelarcArtifactInput {
  id: string;
  threadId: string;
  runId?: string | null;
  kind: HelarcArtifactKind;
  title: string;
  summary?: string | null;
  createdAt: ISODateTimeString;
  payload?: HelarcSafeValue;
  metadata?: Metadata;
}

export interface HelarcArtifact {
  id: string;
  threadId: string;
  runId: string | null;
  kind: HelarcArtifactKind;
  title: string;
  summary: string | null;
  createdAt: ISODateTimeString;
  payload: HelarcSafeValue;
  metadata: Metadata;
}

export interface HelarcThreadRecord {
  thread: HelarcThread;
  conversations: HelarcConversation[];
  messages: HelarcMessage[];
  runs: HelarcPersistedRun[];
  artifacts: HelarcArtifact[];
}

export type HelarcWorkContextErrorCode =
  | "thread_id_required"
  | "thread_workspace_invalid"
  | "thread_title_required"
  | "thread_status_invalid"
  | "thread_timestamp_invalid"
  | "thread_active_conversation_id_required"
  | "thread_latest_run_id_invalid"
  | "conversation_id_required"
  | "conversation_thread_id_required"
  | "conversation_timestamp_invalid"
  | "conversation_message_ids_invalid"
  | "message_id_required"
  | "message_thread_id_required"
  | "message_conversation_id_required"
  | "message_role_invalid"
  | "message_content_required"
  | "message_timestamp_invalid"
  | "message_related_ids_invalid"
  | "run_id_required"
  | "run_task_id_required"
  | "run_session_id_required"
  | "run_thread_id_required"
  | "run_triggering_message_id_required"
  | "run_trigger_message_role_invalid"
  | "run_provider_invalid"
  | "run_permission_preset_invalid"
  | "run_timestamp_invalid"
  | "run_progress_invalid"
  | "run_terminal_invalid"
  | "run_metadata_invalid"
  | "run_artifact_ids_invalid"
  | "artifact_id_required"
  | "artifact_thread_id_required"
  | "artifact_kind_invalid"
  | "artifact_title_required"
  | "artifact_timestamp_invalid"
  | "thread_record_invalid";

export interface HelarcWorkContextError {
  code: HelarcWorkContextErrorCode;
  message: string;
}

export type CreateHelarcThreadResult =
  | { ok: true; thread: HelarcThread }
  | { ok: false; error: HelarcWorkContextError };

export type CreateHelarcConversationResult =
  | { ok: true; conversation: HelarcConversation }
  | { ok: false; error: HelarcWorkContextError };

export type CreateHelarcMessageResult =
  | { ok: true; message: HelarcMessage }
  | { ok: false; error: HelarcWorkContextError };

export type CreateHelarcPersistedRunResult =
  | { ok: true; run: HelarcPersistedRun }
  | { ok: false; error: HelarcWorkContextError };

export type CreateHelarcArtifactResult =
  | { ok: true; artifact: HelarcArtifact }
  | { ok: false; error: HelarcWorkContextError };

export type NormalizeHelarcThreadRecordResult =
  | { ok: true; record: HelarcThreadRecord }
  | { ok: false; error: HelarcWorkContextError };

export function createHelarcThread(input: CreateHelarcThreadInput): CreateHelarcThreadResult {
  const id = normalizeRequiredString(input.id);
  if (!id) {
    return reject("thread_id_required", "Thread id is required.");
  }

  const workspace = normalizeWorkspace(input.workspace);
  if (!workspace.ok) {
    return workspace;
  }

  const title = normalizeRequiredString(input.title);
  if (!title) {
    return reject("thread_title_required", "Thread title is required.");
  }

  const status = input.status ?? "open";
  if (!isThreadStatus(status)) {
    return reject("thread_status_invalid", "Thread status is invalid.");
  }

  if (!isIsoDateTime(input.createdAt) || !isIsoDateTime(input.updatedAt)) {
    return reject("thread_timestamp_invalid", "Thread timestamps are invalid.");
  }

  const activeConversationId = normalizeRequiredString(input.activeConversationId);
  if (!activeConversationId) {
    return reject(
      "thread_active_conversation_id_required",
      "Thread active conversation id is required.",
    );
  }

  const latestRunId = normalizeNullableString(input.latestRunId ?? null);
  if (input.latestRunId !== undefined && input.latestRunId !== null && latestRunId === null) {
    return reject("thread_latest_run_id_invalid", "Thread latest Run id is invalid.");
  }

  return {
    ok: true,
    thread: {
      id,
      workspace: workspace.workspace,
      title,
      status,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      activeConversationId,
      latestRunId,
      metadata: input.metadata ?? {},
    },
  };
}

export function createHelarcConversation(
  input: CreateHelarcConversationInput,
): CreateHelarcConversationResult {
  const id = normalizeRequiredString(input.id);
  if (!id) {
    return reject("conversation_id_required", "Conversation id is required.");
  }

  const threadId = normalizeRequiredString(input.threadId);
  if (!threadId) {
    return reject("conversation_thread_id_required", "Conversation thread id is required.");
  }

  if (!isIsoDateTime(input.createdAt) || !isIsoDateTime(input.updatedAt)) {
    return reject("conversation_timestamp_invalid", "Conversation timestamps are invalid.");
  }

  const messageIds = normalizeIdList(input.messageIds ?? []);
  if (!messageIds.ok) {
    return reject(
      "conversation_message_ids_invalid",
      "Conversation message ids are invalid.",
    );
  }

  return {
    ok: true,
    conversation: {
      id,
      threadId,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      messageIds: messageIds.ids,
      metadata: input.metadata ?? {},
    },
  };
}

export function createHelarcMessage(input: CreateHelarcMessageInput): CreateHelarcMessageResult {
  const id = normalizeRequiredString(input.id);
  if (!id) {
    return reject("message_id_required", "Message id is required.");
  }

  const threadId = normalizeRequiredString(input.threadId);
  if (!threadId) {
    return reject("message_thread_id_required", "Message thread id is required.");
  }

  const conversationId = normalizeRequiredString(input.conversationId);
  if (!conversationId) {
    return reject("message_conversation_id_required", "Message conversation id is required.");
  }

  if (!isMessageRole(input.role)) {
    return reject("message_role_invalid", "Message role is invalid.");
  }

  const content = normalizeRequiredString(input.content);
  if (!content) {
    return reject("message_content_required", "Message content is required.");
  }

  if (!isIsoDateTime(input.createdAt)) {
    return reject("message_timestamp_invalid", "Message timestamp is invalid.");
  }

  const relatedRunIds = normalizeIdList(input.relatedRunIds ?? []);
  const relatedArtifactIds = normalizeIdList(input.relatedArtifactIds ?? []);
  if (!relatedRunIds.ok || !relatedArtifactIds.ok) {
    return reject("message_related_ids_invalid", "Message related ids are invalid.");
  }

  return {
    ok: true,
    message: {
      id,
      threadId,
      conversationId,
      role: input.role,
      content,
      createdAt: input.createdAt,
      relatedRunIds: relatedRunIds.ids,
      relatedArtifactIds: relatedArtifactIds.ids,
      metadata: input.metadata ?? {},
    },
  };
}

export function createHelarcPersistedRun(
  input: CreateHelarcPersistedRunInput,
): CreateHelarcPersistedRunResult {
  const id = normalizeRequiredString(input.id);
  if (!id) {
    return reject("run_id_required", "Run id is required.");
  }

  const taskId = normalizeRequiredString(input.taskId);
  if (!taskId) {
    return reject("run_task_id_required", "Run task id is required.");
  }

  const sessionId = normalizeRequiredString(input.sessionId);
  if (!sessionId) {
    return reject("run_session_id_required", "Run session id is required.");
  }

  const threadId = normalizeRequiredString(input.threadId);
  if (!threadId) {
    return reject("run_thread_id_required", "Run thread id is required.");
  }

  const triggeringMessageId = normalizeRequiredString(input.triggeringMessageId);
  if (!triggeringMessageId) {
    return reject("run_triggering_message_id_required", "Run triggering message id is required.");
  }

  if (!isRunTriggerMessageRole(input.triggerMessageRole)) {
    return reject("run_trigger_message_role_invalid", "Run trigger message role is invalid.");
  }

  const provider = normalizeProvider(input.provider ?? null);
  if (!provider.ok) {
    return provider;
  }

  const permissionPreset = input.permissionPreset ?? "ask_for_approval";
  if (!isPermissionPreset(permissionPreset)) {
    return reject("run_permission_preset_invalid", "Run permission preset is invalid.");
  }

  if (!isIsoDateTime(input.startedAt)) {
    return reject("run_timestamp_invalid", "Run start timestamp is invalid.");
  }

  return {
    ok: true,
    run: {
      id,
      taskId,
      sessionId,
      threadId,
      triggeringMessageId,
      triggerMessageRole: input.triggerMessageRole,
      provider: provider.provider,
      permissionPreset,
      startedAt: input.startedAt,
      updatedAt: input.startedAt,
      progressSequence: 0,
      lastProgress: null,
      terminal: null,
      artifactIds: [],
      metadata: input.metadata ?? {},
    },
  };
}

export function deriveHelarcPersistedRunStatus(run: HelarcPersistedRun): HelarcPersistedRunStatus {
  const terminal = run.terminal;
  if (terminal === null) return "inactive";
  if (terminal.platform.status !== "completed") return terminal.platform.status;
  const productStatus = terminal.product?.status ?? null;
  return productStatus === "rejected" || productStatus === "blocked" || productStatus === "failed"
    ? productStatus
    : "completed";
}

export function createHelarcArtifact(input: CreateHelarcArtifactInput): CreateHelarcArtifactResult {
  const id = normalizeRequiredString(input.id);
  if (!id) {
    return reject("artifact_id_required", "Artifact id is required.");
  }

  const threadId = normalizeRequiredString(input.threadId);
  if (!threadId) {
    return reject("artifact_thread_id_required", "Artifact thread id is required.");
  }

  if (!isArtifactKind(input.kind)) {
    return reject("artifact_kind_invalid", "Artifact kind is invalid.");
  }

  const title = normalizeRequiredString(input.title);
  if (!title) {
    return reject("artifact_title_required", "Artifact title is required.");
  }

  if (!isIsoDateTime(input.createdAt)) {
    return reject("artifact_timestamp_invalid", "Artifact timestamp is invalid.");
  }

  const payload = normalizeSafeValue(input.payload ?? null);
  if (!payload.ok) {
    return reject("thread_record_invalid", "Artifact payload must contain canonical safe data.");
  }

  return {
    ok: true,
    artifact: {
      id,
      threadId,
      runId: normalizeNullableString(input.runId ?? null),
      kind: input.kind,
      title,
      summary: normalizeNullableString(input.summary ?? null),
      createdAt: input.createdAt,
      payload: payload.value,
      metadata: input.metadata ?? {},
    },
  };
}

function normalizeHelarcRunRecord(input: HelarcPersistedRun): CreateHelarcPersistedRunResult {
  const base = createHelarcPersistedRun({
    id: input.id,
    taskId: input.taskId,
    sessionId: input.sessionId,
    threadId: input.threadId,
    triggeringMessageId: input.triggeringMessageId,
    triggerMessageRole: input.triggerMessageRole,
    provider: input.provider,
    permissionPreset: input.permissionPreset,
    startedAt: input.startedAt,
    metadata: input.metadata,
  });
  if (!base.ok) return base;
  if (!isIsoDateTime(input.updatedAt) || input.updatedAt < input.startedAt) {
    return reject("run_timestamp_invalid", "Run update timestamp is invalid.");
  }
  if (!Number.isSafeInteger(input.progressSequence) || input.progressSequence < 0) {
    return reject("run_progress_invalid", "Run progress sequence is invalid.");
  }
  const progress = normalizeProgressRecord(
    base.run,
    input.updatedAt,
    input.progressSequence,
    input.lastProgress,
  );
  if (!progress.ok) return progress;
  const terminal = normalizeTerminalRecord(base.run, input.updatedAt, input.terminal);
  if (!terminal.ok) return terminal;
  const artifactIds = normalizeIdList(input.artifactIds);
  if (!artifactIds.ok) {
    return reject("run_artifact_ids_invalid", "Run artifact ids are invalid.");
  }
  const metadata = normalizeSafeValue(input.metadata);
  if (!metadata.ok || !isSafeObject(metadata.value)) {
    return reject("run_metadata_invalid", "Run metadata must contain canonical safe data.");
  }
  return {
    ok: true,
    run: {
      ...base.run,
      updatedAt: input.updatedAt,
      progressSequence: input.progressSequence,
      lastProgress: progress.progress,
      terminal: terminal.terminal,
      artifactIds: artifactIds.ids,
      metadata: metadata.value,
    },
  };
}

function normalizeProgressRecord(
  run: HelarcPersistedRun,
  updatedAt: ISODateTimeString,
  sequence: number,
  progress: HelarcRunProgressRecord | null,
): { ok: true; progress: HelarcRunProgressRecord | null } |
  { ok: false; error: HelarcWorkContextError } {
  if ((sequence === 0) !== (progress === null)) {
    return reject("run_progress_invalid", "Run progress sequence and snapshot are inconsistent.");
  }
  if (progress === null) return { ok: true, progress: null };
  if (
    !isIsoDateTime(progress.recordedAt) || progress.recordedAt < run.startedAt ||
    progress.recordedAt > updatedAt ||
    !isHostProgressProjection(progress.platform) ||
    !isProductProgressProjection(progress.product) ||
    progress.platform.runId !== run.id || progress.platform.taskId !== run.taskId ||
    progress.platform.sessionId !== run.sessionId || progress.product.runId !== run.id
  ) {
    return reject("run_progress_invalid", "Run progress projection is invalid.");
  }
  const safe = normalizeSafeValue(progress);
  if (!safe.ok) {
    return reject("run_progress_invalid", "Run progress must contain canonical safe data.");
  }
  return { ok: true, progress };
}

function normalizeTerminalRecord(
  run: HelarcPersistedRun,
  updatedAt: ISODateTimeString,
  terminal: HelarcRunTerminalRecord | null,
): { ok: true; terminal: HelarcRunTerminalRecord | null } |
  { ok: false; error: HelarcWorkContextError } {
  if (terminal === null) return { ok: true, terminal: null };
  const platform = terminal.platform;
  if (
    platform === null || typeof platform !== "object" ||
    platform.runId !== run.id || platform.taskId !== run.taskId ||
    !isIsoDateTime(platform.completedAt) || platform.completedAt < run.startedAt ||
    platform.completedAt > updatedAt || !isHostTerminalProjection(platform) ||
    !isCompatibleProductTerminal(run, platform, terminal.product)
  ) {
    return reject("run_terminal_invalid", "Run terminal record is invalid.");
  }
  const safe = normalizeSafeValue(terminal);
  if (!safe.ok) {
    return reject("run_terminal_invalid", "Run terminal record must contain canonical safe data.");
  }
  return { ok: true, terminal };
}

export function normalizeHelarcThreadRecord(
  input: HelarcThreadRecord,
): NormalizeHelarcThreadRecordResult {
  const threadResult = createHelarcThread(input.thread);
  if (!threadResult.ok) {
    return threadResult;
  }

  const conversationResults = input.conversations.map(createHelarcConversation);
  const failedConversation = conversationResults.find((result) => !result.ok);
  if (failedConversation && !failedConversation.ok) {
    return failedConversation;
  }
  const conversations = conversationResults.map((result) => result.ok ? result.conversation : never());

  const messageResults = input.messages.map(createHelarcMessage);
  const failedMessage = messageResults.find((result) => !result.ok);
  if (failedMessage && !failedMessage.ok) {
    return failedMessage;
  }
  const messages = messageResults.map((result) => result.ok ? result.message : never());

  const runResults = input.runs.map(normalizeHelarcRunRecord);
  const failedRun = runResults.find((result) => !result.ok);
  if (failedRun && !failedRun.ok) {
    return failedRun;
  }
  const runs = runResults.map((result) => result.ok ? result.run : never());

  const artifactResults = input.artifacts.map(createHelarcArtifact);
  const failedArtifact = artifactResults.find((result) => !result.ok);
  if (failedArtifact && !failedArtifact.ok) {
    return failedArtifact;
  }
  const artifacts = artifactResults.map((result) => result.ok ? result.artifact : never());

  const relationship = validateThreadRecordRelationships(
    threadResult.thread,
    conversations,
    messages,
    runs,
    artifacts,
  );
  if (!relationship.ok) {
    return relationship;
  }

  return {
    ok: true,
    record: {
      thread: threadResult.thread,
      conversations,
      messages,
      runs,
      artifacts,
    },
  };
}

function validateThreadRecordRelationships(
  thread: HelarcThread,
  conversations: readonly HelarcConversation[],
  messages: readonly HelarcMessage[],
  runs: readonly HelarcPersistedRun[],
  artifacts: readonly HelarcArtifact[],
): { ok: true } | { ok: false; error: HelarcWorkContextError } {
  if (conversations.length !== 1 || conversations[0]?.id !== thread.activeConversationId) {
    return reject(
      "thread_record_invalid",
      "Thread record must contain exactly one active conversation.",
    );
  }

  const conversation = conversations[0];
  if (conversation.threadId !== thread.id) {
    return reject("thread_record_invalid", "Conversation must belong to the thread.");
  }

  const messageById = new Map(messages.map((message) => [message.id, message]));
  if (
    conversation.messageIds.length !== messages.length ||
    conversation.messageIds.some((id, index) => messages[index]?.id !== id)
  ) {
    return reject(
      "thread_record_invalid",
      "Conversation message ids must match message order.",
    );
  }

  for (const message of messages) {
    if (message.threadId !== thread.id || message.conversationId !== conversation.id) {
      return reject("thread_record_invalid", "Message must belong to the active conversation.");
    }
  }

  const runById = new Map(runs.map((run) => [run.id, run]));
  for (const run of runs) {
    const triggerMessage = messageById.get(run.triggeringMessageId);
    if (
      run.threadId !== thread.id ||
      !triggerMessage ||
      triggerMessage.role !== run.triggerMessageRole ||
      !isRunTriggerMessageRole(triggerMessage.role)
    ) {
      return reject(
        "thread_record_invalid",
        "Run must belong to the thread and reference a valid trigger message.",
      );
    }
  }

  const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  for (const artifact of artifacts) {
    if (artifact.threadId !== thread.id || (artifact.runId !== null && !runById.has(artifact.runId))) {
      return reject(
        "thread_record_invalid",
        "Artifact must belong to the thread and reference an existing run when run id is set.",
      );
    }
  }

  for (const message of messages) {
    if (
      message.relatedRunIds.some((runId) => !runById.has(runId)) ||
      message.relatedArtifactIds.some((artifactId) => !artifactById.has(artifactId))
    ) {
      return reject(
        "thread_record_invalid",
        "Message related ids must reference existing runs and artifacts.",
      );
    }
  }

  for (const run of runs) {
    if (run.artifactIds.some((artifactId) => !artifactById.has(artifactId))) {
      return reject(
        "thread_record_invalid",
        "Run artifact ids must reference existing artifacts.",
      );
    }
  }

  if (thread.latestRunId !== null && !runById.has(thread.latestRunId)) {
    return reject(
      "thread_record_invalid",
      "Thread latest Run id must reference an existing Run.",
    );
  }

  return { ok: true };
}

function normalizeWorkspace(
  workspace: HelarcThreadWorkspaceRef,
): { ok: true; workspace: HelarcThreadWorkspaceRef } | { ok: false; error: HelarcWorkContextError } {
  const displayName = normalizeRequiredString(workspace.displayName);
  const path = normalizeRequiredString(workspace.path);
  if (!displayName || !path) {
    return reject("thread_workspace_invalid", "Thread workspace reference is invalid.");
  }

  return {
    ok: true,
    workspace: {
      profileId: normalizeNullableString(workspace.profileId),
      displayName,
      path,
    },
  };
}

function normalizeProvider(
  provider: HelarcRunProviderContext | null,
): { ok: true; provider: HelarcRunProviderContext | null } | { ok: false; error: HelarcWorkContextError } {
  if (provider === null) {
    return { ok: true, provider: null };
  }

  const displayName = normalizeRequiredString(provider.displayName);
  const endpointLabel = normalizeRequiredString(provider.endpointLabel);
  const model = normalizeRequiredString(provider.model);
  if (
    !displayName ||
    !endpointLabel ||
    !model ||
    (provider.providerKind !== null && !isProviderKind(provider.providerKind))
  ) {
    return reject("run_provider_invalid", "Run provider context is invalid.");
  }

  return {
    ok: true,
    provider: {
      profileId: normalizeNullableString(provider.profileId),
      providerKind: provider.providerKind,
      displayName,
      endpointLabel,
      model,
    },
  };
}

function normalizeIdList(
  ids: readonly string[],
): { ok: true; ids: string[] } | { ok: false } {
  const normalized = ids.map((id) => id.trim());
  if (normalized.some((id) => id.length === 0) || new Set(normalized).size !== normalized.length) {
    return { ok: false };
  }

  return { ok: true, ids: normalized };
}

function normalizeRequiredString(value: string): string | null {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeNullableString(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function isThreadStatus(value: unknown): value is HelarcThreadStatus {
  return value === "open" || value === "closed" || value === "archived";
}

function isMessageRole(value: unknown): value is HelarcMessageRole {
  return value === "user" ||
    value === "assistant" ||
    value === "system" ||
    value === "tool" ||
    value === "product-event";
}

function isRunTriggerMessageRole(value: unknown): value is HelarcRunTriggerMessageRole {
  return value === "user" || value === "product-event" || value === "system";
}

function isHostProgressProjection(value: unknown): value is HostRunProjection {
  if (value === null || typeof value !== "object") return false;
  const projection = value as Partial<HostRunProjection>;
  return typeof projection.runId === "string" &&
    typeof projection.taskId === "string" &&
    typeof projection.sessionId === "string" &&
    Number.isSafeInteger(projection.sequence) &&
    (projection.sequence ?? -1) >= 0 &&
    projection.terminal === null &&
    projection.status !== "completed" &&
    projection.status !== "blocked" &&
    projection.status !== "failed" &&
    projection.status !== "cancelled";
}

function isProductProgressProjection(value: unknown): value is HelarcProductRunProjection {
  if (value === null || typeof value !== "object") return false;
  const projection = value as Partial<HelarcProductRunProjection>;
  return typeof projection.runId === "string" &&
    Number.isSafeInteger(projection.sequence) &&
    (projection.sequence ?? -1) >= 0 &&
    projection.result === null &&
    Array.isArray(projection.activity) &&
    projection.phase !== null && typeof projection.phase === "object";
}

function isCompatibleProductTerminal(
  run: HelarcPersistedRun,
  platform: HostTerminalRunProjection,
  product: HelarcProductResult | null,
): boolean {
  if (product === null) return true;
  if (
    product.status !== "completed" && product.status !== "rejected" &&
    product.status !== "blocked" && product.status !== "failed" &&
    product.status !== "cancelled"
  ) {
    return false;
  }
  const output = product.output;
  if (
    output === null || typeof output !== "object" || output.taskId !== run.taskId ||
    (output.workspaceId !== null && typeof output.workspaceId !== "string") ||
    (output.agentSummary !== null && typeof output.agentSummary !== "string") ||
    !isRuntimeResultStatus(output.runtimeStatus) ||
    !isPatchStatus(output.patchStatus) ||
    (output.appliedPath !== null && typeof output.appliedPath !== "string") ||
    !isEnforcementSummary(output.enforcement) || !Array.isArray(output.safeErrors) ||
    !output.safeErrors.every((error) =>
      error !== null && typeof error === "object" && hasText(error.code) && hasText(error.message)
    )
  ) {
    return false;
  }
  const expectedRuntimeStatus = platform.status === "completed" ? "succeeded" : platform.status;
  if (output.runtimeStatus !== expectedRuntimeStatus) return false;
  if (platform.status === "completed") return product.status !== "cancelled";
  return product.status === platform.status;
}

function isHostTerminalProjection(value: HostTerminalRunProjection): boolean {
  if (
    !isPlatformTerminalStatus(value.status) ||
    (value.code !== null && !hasText(value.code)) ||
    !isNullableNonNegativeInteger(value.durationMs) ||
    !isNullableNonNegativeInteger(value.iterations) ||
    !isNullableNonNegativeInteger(value.actions) ||
    !isNonNegativeInteger(value.itemCount) ||
    !isNonNegativeInteger(value.evidenceCount) ||
    !isNonNegativeInteger(value.artifactCount) ||
    !Array.isArray(value.errors) || !value.errors.every(isHostTerminalError) ||
    !isCancellationSummary(value.cancellation)
  ) {
    return false;
  }
  if (value.status === "completed") {
    return value.code === null && value.errors.length === 0 && value.cancellation === null;
  }
  if (value.status === "blocked") {
    return value.code === "runtime_no_safe_path" && value.errors.length === 0 &&
      value.cancellation === null;
  }
  if (value.status === "cancelled") {
    return value.code === "runtime_cancelled" && value.errors.length === 0 &&
      value.cancellation !== null;
  }
  return value.code !== null && value.errors.length > 0;
}

function isHostTerminalError(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const error = value as { owner?: unknown; code?: unknown; retryable?: unknown };
  return isRuntimeErrorOwner(error.owner) && hasText(error.code) &&
    typeof error.retryable === "boolean";
}

function isRuntimeErrorOwner(value: unknown): boolean {
  return value === "runtime" || value === "model" || value === "provider" ||
    value === "approval" || value === "permission" || value === "policy" ||
    value === "sandbox" || value === "tool" || value === "storage" ||
    value === "audit" || value === "telemetry";
}

function isCancellationSummary(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "object") return false;
  const cancellation = value as {
    requestId?: unknown;
    origin?: unknown;
    reasonCode?: unknown;
    requestedAt?: unknown;
  };
  return hasText(cancellation.requestId) &&
    (cancellation.origin === "user" || cancellation.origin === "host" ||
      cancellation.origin === "approval" || cancellation.origin === "parent_run" ||
      cancellation.origin === "runner") &&
    (cancellation.reasonCode === "user_requested" ||
      cancellation.reasonCode === "host_requested" ||
      cancellation.reasonCode === "host_shutdown" ||
      cancellation.reasonCode === "approval_cancelled" ||
      cancellation.reasonCode === "parent_run_cancelled" ||
      cancellation.reasonCode === "runner_shutdown") &&
    typeof cancellation.requestedAt === "string" && isIsoDateTime(cancellation.requestedAt);
}

function isRuntimeResultStatus(value: unknown): boolean {
  return value === "succeeded" || value === "blocked" || value === "failed" ||
    value === "cancelled";
}

function isPatchStatus(value: unknown): boolean {
  return value === null || value === "proposed" || value === "applied" ||
    value === "rejected" || value === "failed";
}

function isEnforcementSummary(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const enforcement = value as { selected?: unknown; status?: unknown; code?: unknown };
  return (enforcement.selected === "managed" || enforcement.selected === "external" ||
      enforcement.selected === "disabled") &&
    (enforcement.status === "not_exercised" || enforcement.status === "unisolated" ||
      enforcement.status === "enforced" || enforcement.status === "unavailable" ||
      enforcement.status === "denied" || enforcement.status === "interrupted" ||
      enforcement.status === "failed") &&
    (enforcement.code === null || typeof enforcement.code === "string");
}

function isPlatformTerminalStatus(
  value: unknown,
): value is HostTerminalRunProjection["status"] {
  return value === "completed" || value === "blocked" || value === "failed" || value === "cancelled";
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isNullableNonNegativeInteger(value: unknown): value is number | null {
  return value === null || isNonNegativeInteger(value);
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeSafeValue(
  value: unknown,
  ancestors: Set<object> = new Set(),
  depth = 0,
): { ok: true; value: HelarcSafeValue } | { ok: false } {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return { ok: true, value };
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? { ok: true, value } : { ok: false };
  }
  if (typeof value !== "object" || depth >= 64 || ancestors.has(value)) {
    return { ok: false };
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) {
    return { ok: false };
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: HelarcSafeValue[] = [];
      for (const candidate of value) {
        const normalized = normalizeSafeValue(candidate, ancestors, depth + 1);
        if (!normalized.ok) return { ok: false };
        items.push(normalized.value);
      }
      return { ok: true, value: items };
    }
    const record: Record<string, HelarcSafeValue> = {};
    for (const [key, candidate] of Object.entries(value)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        return { ok: false };
      }
      const normalized = normalizeSafeValue(candidate, ancestors, depth + 1);
      if (!normalized.ok) return { ok: false };
      record[key] = normalized.value;
    }
    return { ok: true, value: record };
  } finally {
    ancestors.delete(value);
  }
}

function isSafeObject(value: HelarcSafeValue): value is { readonly [key: string]: HelarcSafeValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isArtifactKind(value: unknown): value is HelarcArtifactKind {
  return value === "final-output" ||
    value === "patch-proposal" ||
    value === "applied-patch" ||
    value === "trace-projection" ||
    value === "tool-output-summary" ||
    value === "error-report";
}

function isProviderKind(value: unknown): value is HelarcProviderKind {
  return value === "openai-compatible" || value === "ollama";
}

function isPermissionPreset(value: unknown): value is HelarcRunPermissionPreset {
  return value === "ask_for_approval" ||
    value === "approve_for_me" ||
    value === "full_access";
}

function isIsoDateTime(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function isNullableIsoDateTime(value: string | null): boolean {
  return value === null || isIsoDateTime(value);
}

function never(): never {
  throw new Error("Unreachable invalid Helarc work context result.");
}

function reject(
  code: HelarcWorkContextErrorCode,
  message: string,
): { ok: false; error: HelarcWorkContextError } {
  return { ok: false, error: { code, message } };
}
