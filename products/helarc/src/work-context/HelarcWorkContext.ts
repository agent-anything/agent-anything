import type { RuntimeStatus } from "@agent-anything/agent-core";
import type { ISODateTimeString, Metadata } from "@agent-anything/shared";
import type { HelarcProviderKind } from "../provider-profile/index.js";
import type { HelarcRunPermissionPreset } from "../run/index.js";

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

export type HelarcWorkContextRunStatus =
  | "starting"
  | "running"
  | "waiting_for_permission"
  | "cancelling"
  | "completed"
  | "failed"
  | "denied"
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

export interface HelarcThreadLatestRunSummary {
  runId: string;
  status: HelarcWorkContextRunStatus;
  startedAt: ISODateTimeString;
  completedAt: ISODateTimeString | null;
}

export interface CreateHelarcThreadInput {
  id: string;
  workspace: HelarcThreadWorkspaceRef;
  title: string;
  status?: HelarcThreadStatus;
  createdAt: ISODateTimeString;
  updatedAt: ISODateTimeString;
  activeConversationId: string;
  latestRun?: HelarcThreadLatestRunSummary | null;
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
  latestRun: HelarcThreadLatestRunSummary | null;
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

export interface HelarcRunRuntimeSummary {
  status: RuntimeStatus | null;
  code: string | null;
  summary: string | null;
}

export interface HelarcRunErrorSummary {
  code: string;
  message: string;
}

export interface CreateHelarcRunInput {
  id: string;
  threadId: string;
  triggeringMessageId: string;
  triggerMessageRole: HelarcRunTriggerMessageRole;
  status: HelarcWorkContextRunStatus;
  provider?: HelarcRunProviderContext | null;
  permissionPreset?: HelarcRunPermissionPreset;
  startedAt: ISODateTimeString;
  completedAt?: ISODateTimeString | null;
  runtime?: HelarcRunRuntimeSummary | null;
  errors?: readonly HelarcRunErrorSummary[];
  artifactIds?: readonly string[];
  metadata?: Metadata;
}

export interface HelarcRun {
  id: string;
  threadId: string;
  triggeringMessageId: string;
  triggerMessageRole: HelarcRunTriggerMessageRole;
  status: HelarcWorkContextRunStatus;
  provider: HelarcRunProviderContext | null;
  permissionPreset: HelarcRunPermissionPreset;
  startedAt: ISODateTimeString;
  completedAt: ISODateTimeString | null;
  runtime: HelarcRunRuntimeSummary | null;
  errors: HelarcRunErrorSummary[];
  artifactIds: string[];
  metadata: Metadata;
}

export interface CreateHelarcArtifactInput {
  id: string;
  threadId: string;
  runId?: string | null;
  kind: HelarcArtifactKind;
  title: string;
  summary?: string | null;
  createdAt: ISODateTimeString;
  payload?: unknown;
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
  payload: unknown;
  metadata: Metadata;
}

export interface HelarcThreadRecord {
  thread: HelarcThread;
  conversations: HelarcConversation[];
  messages: HelarcMessage[];
  runs: HelarcRun[];
  artifacts: HelarcArtifact[];
}

export type HelarcWorkContextErrorCode =
  | "thread_id_required"
  | "thread_workspace_invalid"
  | "thread_title_required"
  | "thread_status_invalid"
  | "thread_timestamp_invalid"
  | "thread_active_conversation_id_required"
  | "thread_latest_run_invalid"
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
  | "run_thread_id_required"
  | "run_triggering_message_id_required"
  | "run_trigger_message_role_invalid"
  | "run_status_invalid"
  | "run_provider_invalid"
  | "run_permission_preset_invalid"
  | "run_timestamp_invalid"
  | "run_runtime_invalid"
  | "run_errors_invalid"
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

export type CreateHelarcRunResult =
  | { ok: true; run: HelarcRun }
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

  const latestRunResult = normalizeLatestRun(input.latestRun ?? null);
  if (!latestRunResult.ok) {
    return latestRunResult;
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
      latestRun: latestRunResult.latestRun,
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

export function createHelarcRun(input: CreateHelarcRunInput): CreateHelarcRunResult {
  const id = normalizeRequiredString(input.id);
  if (!id) {
    return reject("run_id_required", "Run id is required.");
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

  if (!isWorkContextRunStatus(input.status)) {
    return reject("run_status_invalid", "Run status is invalid.");
  }

  const provider = normalizeProvider(input.provider ?? null);
  if (!provider.ok) {
    return provider;
  }

  const permissionPreset = input.permissionPreset ?? "ask";
  if (!isPermissionPreset(permissionPreset)) {
    return reject("run_permission_preset_invalid", "Run permission preset is invalid.");
  }

  if (!isIsoDateTime(input.startedAt) || !isNullableIsoDateTime(input.completedAt ?? null)) {
    return reject("run_timestamp_invalid", "Run timestamps are invalid.");
  }

  const runtime = normalizeRuntime(input.runtime ?? null);
  if (!runtime.ok) {
    return runtime;
  }

  const errors = normalizeErrors(input.errors ?? []);
  if (!errors.ok) {
    return errors;
  }

  const artifactIds = normalizeIdList(input.artifactIds ?? []);
  if (!artifactIds.ok) {
    return reject("run_artifact_ids_invalid", "Run artifact ids are invalid.");
  }

  return {
    ok: true,
    run: {
      id,
      threadId,
      triggeringMessageId,
      triggerMessageRole: input.triggerMessageRole,
      status: input.status,
      provider: provider.provider,
      permissionPreset,
      startedAt: input.startedAt,
      completedAt: input.completedAt ?? null,
      runtime: runtime.runtime,
      errors: errors.errors,
      artifactIds: artifactIds.ids,
      metadata: input.metadata ?? {},
    },
  };
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
      payload: input.payload ?? null,
      metadata: input.metadata ?? {},
    },
  };
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

  const runResults = input.runs.map(createHelarcRun);
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
  runs: readonly HelarcRun[],
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

  if (thread.latestRun && !runById.has(thread.latestRun.runId)) {
    return reject(
      "thread_record_invalid",
      "Thread latest run summary must reference an existing run.",
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

function normalizeLatestRun(
  latestRun: HelarcThreadLatestRunSummary | null,
): { ok: true; latestRun: HelarcThreadLatestRunSummary | null } | { ok: false; error: HelarcWorkContextError } {
  if (latestRun === null) {
    return { ok: true, latestRun: null };
  }

  const runId = normalizeRequiredString(latestRun.runId);
  if (
    !runId ||
    !isWorkContextRunStatus(latestRun.status) ||
    !isIsoDateTime(latestRun.startedAt) ||
    !isNullableIsoDateTime(latestRun.completedAt)
  ) {
    return reject("thread_latest_run_invalid", "Thread latest run summary is invalid.");
  }

  return {
    ok: true,
    latestRun: {
      runId,
      status: latestRun.status,
      startedAt: latestRun.startedAt,
      completedAt: latestRun.completedAt,
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

function normalizeRuntime(
  runtime: HelarcRunRuntimeSummary | null,
): { ok: true; runtime: HelarcRunRuntimeSummary | null } | { ok: false; error: HelarcWorkContextError } {
  if (runtime === null) {
    return { ok: true, runtime: null };
  }

  if (runtime.status !== null && !isRuntimeStatus(runtime.status)) {
    return reject("run_runtime_invalid", "Run runtime summary is invalid.");
  }

  return {
    ok: true,
    runtime: {
      status: runtime.status,
      code: normalizeNullableString(runtime.code),
      summary: normalizeNullableString(runtime.summary),
    },
  };
}

function normalizeErrors(
  errors: readonly HelarcRunErrorSummary[],
): { ok: true; errors: HelarcRunErrorSummary[] } | { ok: false; error: HelarcWorkContextError } {
  const normalized: HelarcRunErrorSummary[] = [];
  for (const error of errors) {
    const code = normalizeRequiredString(error.code);
    const message = normalizeRequiredString(error.message);
    if (!code || !message) {
      return reject("run_errors_invalid", "Run errors are invalid.");
    }

    normalized.push({ code, message });
  }

  return { ok: true, errors: normalized };
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

function isWorkContextRunStatus(value: unknown): value is HelarcWorkContextRunStatus {
  return value === "starting" ||
    value === "running" ||
    value === "waiting_for_permission" ||
    value === "cancelling" ||
    value === "completed" ||
    value === "failed" ||
    value === "denied" ||
    value === "cancelled";
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
  return value === "trusted" || value === "ask" || value === "deny";
}

function isRuntimeStatus(value: unknown): value is RuntimeStatus {
  return value === "succeeded" ||
    value === "failed" ||
    value === "blocked" ||
    value === "cancelled";
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
