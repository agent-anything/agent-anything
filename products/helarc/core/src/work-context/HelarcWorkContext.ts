import type {
  HostRunProjection,
  HostTerminalRunProjection,
} from "@agent-anything/host/projection";

import type { WorkspaceSelection } from "@agent-anything/workspace/selection";
import type {
  HelarcProductResult,
} from "../composition/HelarcProductResult.js";
import type { HelarcProviderKind } from "../configuration/HelarcProviderProfile.js";
import type { HelarcRunPermissionPreset } from "../run/HelarcRun.js";
import type { HelarcProductRunProjection } from "../run/HelarcRunProjection.js";
import type {
  CreateHelarcArtifactInput,
  HelarcArtifact,
  HelarcArtifactContent,
  HelarcArtifactFreshness,
  HelarcArtifactIntegrity,
  HelarcArtifactKind,
  HelarcArtifactProducer,
  HelarcArtifactRecordRef,
  HelarcSafeValue,
} from "../artifacts/HelarcArtifact.js";
import type {
  HelarcCollaborationRecord,
  HelarcReviewRecord,
} from "./HelarcProductCommunication.js";
import {
  snapshotHelarcCollaborationRecord,
  snapshotHelarcReviewRecord,
} from "./HelarcProductCommunication.js";

export type HelarcThreadStatus = "open" | "closed" | "archived";

export type HelarcMessageRole =
  | "user"
  | "assistant"
  | "system"
  | "product";

export type HelarcRunTriggerMessageRole = Extract<
  HelarcMessageRole,
  "user" | "product" | "system"
>;

export type HelarcMessageSourceKind =
  | "user_input"
  | "agent_run"
  | "system"
  | "interaction"
  | "review"
  | "automation"
  | "product";

export interface HelarcMessageSource {
  readonly kind: HelarcMessageSourceKind;
  readonly owner: string;
  readonly refId: string | null;
}

export interface HelarcMessageCorrelation {
  readonly runId: string | null;
  readonly interactionRequestId: string | null;
  readonly reviewId: string | null;
}

export type HelarcPersistedRunStatus =
  | "inactive"
  | "completed"
  | "stopped"
  | "rejected"
  | "failed"
  | "cancelled";

export interface HelarcThreadWorkspaceRef {
  readonly profileId: string;
  readonly displayName: string;
  readonly path: string;
}

export interface HelarcThreadWorkspaceIdentity {
  readonly primary: HelarcThreadWorkspaceRef;
  readonly additional: readonly HelarcThreadWorkspaceRef[];
}

export interface CreateHelarcThreadInput {
  id: string;
  revision: number;
  workspace: HelarcThreadWorkspaceIdentity;
  title: string;
  status?: HelarcThreadStatus;
  createdAt: string;
  updatedAt: string;
  latestRunId?: string | null;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface HelarcThread {
  id: string;
  revision: number;
  workspace: HelarcThreadWorkspaceIdentity;
  title: string;
  status: HelarcThreadStatus;
  createdAt: string;
  updatedAt: string;
  latestRunId: string | null;
  metadata: Readonly<Record<string, unknown>>;
}

export interface CreateHelarcMessageInput {
  id: string;
  threadId: string;
  sequence: number;
  role: HelarcMessageRole;
  content: string;
  source: HelarcMessageSource;
  correlation: HelarcMessageCorrelation;
  createdAt: string;
  relatedRunIds?: readonly string[];
  relatedArtifactIds?: readonly string[];
  metadata?: Readonly<Record<string, unknown>>;
}

export interface HelarcMessage {
  id: string;
  threadId: string;
  sequence: number;
  role: HelarcMessageRole;
  content: string;
  source: HelarcMessageSource;
  correlation: HelarcMessageCorrelation;
  createdAt: string;
  relatedRunIds: string[];
  relatedArtifactIds: string[];
  metadata: Readonly<Record<string, unknown>>;
}

export interface HelarcRunProviderContext {
  profileId: string | null;
  providerKind: HelarcProviderKind | null;
  displayName: string;
  endpointLabel: string;
  model: string;
}

export interface HelarcWorkspaceSelectionRef {
  readonly workspaceId: string;
  readonly profileId: string;
  readonly displayName: string;
}

export interface HelarcWorkspaceSelectionIdentity {
  readonly primary: HelarcWorkspaceSelectionRef;
  readonly additional: readonly HelarcWorkspaceSelectionRef[];
}

export interface CreateHelarcPersistedRunInput {
  id: string;
  taskId: string;
  sessionId: string;
  threadId: string;
  triggeringMessageId: string;
  triggerMessageRole: HelarcRunTriggerMessageRole;
  triggeringThreadRevision: number;
  workspace: HelarcWorkspaceSelectionIdentity;
  provider?: HelarcRunProviderContext | null;
  permissionPreset?: HelarcRunPermissionPreset;
  startedAt: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface HelarcRunProjectionRecord {
  readonly recordedAt: string;
  readonly host: HostRunProjection;
  readonly product: HelarcProductRunProjection;
}

export interface HelarcRunTerminalRecord {
  readonly host: HostTerminalRunProjection;
  readonly product: HelarcProductResult | null;
}

export interface HelarcPersistedRun {
  id: string;
  harnessRunId: string | null;
  taskId: string;
  sessionId: string;
  threadId: string;
  triggeringMessageId: string;
  triggerMessageRole: HelarcRunTriggerMessageRole;
  triggeringThreadRevision: number;
  workspace: HelarcWorkspaceSelectionIdentity;
  provider: HelarcRunProviderContext | null;
  permissionPreset: HelarcRunPermissionPreset;
  startedAt: string;
  updatedAt: string;
  projectionSequence: number;
  lastProjection: HelarcRunProjectionRecord | null;
  terminal: HelarcRunTerminalRecord | null;
  artifactIds: string[];
  metadata: Readonly<Record<string, unknown>>;
}

export interface HelarcThreadRecord {
  thread: HelarcThread;
  messages: HelarcMessage[];
  runs: HelarcPersistedRun[];
  artifacts: HelarcArtifact[];
  collaboration: HelarcCollaborationRecord[];
  reviews: HelarcReviewRecord[];
}

export type HelarcWorkContextErrorCode =
  | "thread_id_required"
  | "thread_workspace_invalid"
  | "thread_revision_invalid"
  | "thread_title_required"
  | "thread_status_invalid"
  | "thread_timestamp_invalid"
  | "thread_latest_run_id_invalid"
  | "message_id_required"
  | "message_thread_id_required"
  | "message_sequence_invalid"
  | "message_role_invalid"
  | "message_content_required"
  | "message_source_invalid"
  | "message_correlation_invalid"
  | "message_timestamp_invalid"
  | "message_related_ids_invalid"
  | "run_id_required"
  | "run_harness_id_invalid"
  | "run_task_id_required"
  | "run_session_id_required"
  | "run_thread_id_required"
  | "run_triggering_message_id_required"
  | "run_trigger_message_role_invalid"
  | "run_triggering_thread_revision_invalid"
  | "run_workspace_invalid"
  | "run_provider_invalid"
  | "run_permission_preset_invalid"
  | "run_timestamp_invalid"
  | "run_projection_invalid"
  | "run_terminal_invalid"
  | "run_metadata_invalid"
  | "run_artifact_ids_invalid"
  | "artifact_id_required"
  | "artifact_thread_id_required"
  | "artifact_kind_invalid"
  | "artifact_title_required"
  | "artifact_timestamp_invalid"
  | "artifact_contract_invalid"
  | "collaboration_record_invalid"
  | "review_record_invalid"
  | "thread_record_invalid";

export interface HelarcWorkContextError {
  code: HelarcWorkContextErrorCode;
  message: string;
}

export type CreateHelarcThreadResult =
  | { ok: true; thread: HelarcThread }
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

  if (!Number.isSafeInteger(input.revision) || input.revision < 0) {
    return reject("thread_revision_invalid", "Thread revision must be a non-negative safe integer.");
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

  const latestRunId = normalizeNullableString(input.latestRunId ?? null);
  if (input.latestRunId !== undefined && input.latestRunId !== null && latestRunId === null) {
    return reject("thread_latest_run_id_invalid", "Thread latest Run id is invalid.");
  }

  return {
    ok: true,
    thread: {
      id,
      revision: input.revision,
      workspace: workspace.workspace,
      title,
      status,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      latestRunId,
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

  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) {
    return reject("message_sequence_invalid", "Message sequence must be a positive safe integer.");
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

  const source = normalizeMessageSource(input.source);
  if (source === null) {
    return reject("message_source_invalid", "Message source is invalid.");
  }
  const correlation = normalizeMessageCorrelation(input.correlation);
  if (correlation === null) {
    return reject("message_correlation_invalid", "Message correlation is invalid.");
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
      sequence: input.sequence,
      role: input.role,
      content,
      source,
      correlation,
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

  if (!Number.isSafeInteger(input.triggeringThreadRevision) || input.triggeringThreadRevision < 0) {
    return reject(
      "run_triggering_thread_revision_invalid",
      "Run triggering Thread revision is invalid.",
    );
  }

  const workspace = normalizeWorkspaceSelection(input.workspace);
  if (!workspace.ok) {
    return workspace;
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
      harnessRunId: null,
      taskId,
      sessionId,
      threadId,
      triggeringMessageId,
      triggerMessageRole: input.triggerMessageRole,
      triggeringThreadRevision: input.triggeringThreadRevision,
      workspace: workspace.workspace,
      provider: provider.provider,
      permissionPreset,
      startedAt: input.startedAt,
      updatedAt: input.startedAt,
      projectionSequence: 0,
      lastProjection: null,
      terminal: null,
      artifactIds: [],
      metadata: input.metadata ?? {},
    },
  };
}

export function deriveHelarcPersistedRunStatus(run: HelarcPersistedRun): HelarcPersistedRunStatus {
  const terminal = run.terminal;
  if (terminal === null) return "inactive";
  if (terminal.host.status !== "completed") return terminal.host.status;
  const productStatus = terminal.product?.status ?? null;
  return productStatus === "rejected" || productStatus === "failed"
    ? productStatus
    : "completed";
}

export function projectHelarcWorkspaceSelectionIdentity(input: {
  readonly workspace: WorkspaceSelection;
  readonly threadWorkspace: HelarcThreadWorkspaceIdentity;
}): HelarcWorkspaceSelectionIdentity {
  if (
    input.workspace.additional.length !==
    input.threadWorkspace.additional.length
  ) {
    throw new TypeError(
      "Resolved Run Workspace does not match the Thread Workspace selection.",
    );
  }

  return Object.freeze({
    primary: projectHelarcWorkspaceSelectionRef(
      input.workspace.primary.id,
      input.workspace.primary.name,
      input.threadWorkspace.primary.profileId,
    ),
    additional: Object.freeze(input.workspace.additional.map(
      (workspace, index) => {
        const threadRef = input.threadWorkspace.additional[index];
        if (threadRef === undefined) {
          throw new TypeError(
            "Resolved additional Workspace has no matching Thread reference.",
          );
        }
        return projectHelarcWorkspaceSelectionRef(
          workspace.id,
          workspace.name,
          threadRef.profileId,
        );
      },
    )),
  });
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

  const runId = normalizeNullableString(input.runId);
  const summary = normalizeNullableString(input.summary);
  const producer = normalizeArtifactProducer(input.producer);
  const sourceRefs = normalizeArtifactRefs(input.sourceRefs, true);
  const effectRefs = normalizeArtifactRefs(input.effectRefs, false);
  const content = normalizeArtifactContent(input.content);
  const freshness = normalizeArtifactFreshness(input.freshness);
  const integrity = normalizeArtifactIntegrity(input.integrity);
  const limitations = normalizeTextList(input.limitations);
  if (
    (input.runId !== null && runId === null) ||
    (input.summary !== null && summary === null) || producer === null ||
    sourceRefs === null || effectRefs === null || content === null ||
    !isArtifactCompleteness(input.completeness) ||
    !isArtifactSensitivity(input.sensitivity) || freshness === null || integrity === null ||
    !isArtifactLifecycle(input.lifecycle) || !isArtifactPersistence(input.persistence) ||
    limitations === null
  ) {
    return reject("artifact_contract_invalid", "Artifact contract is invalid.");
  }

  return {
    ok: true,
    artifact: Object.freeze({
      id,
      threadId,
      runId,
      kind: input.kind,
      title,
      summary,
      producer,
      sourceRefs: sourceRefs as readonly [HelarcArtifactRecordRef, ...HelarcArtifactRecordRef[]],
      effectRefs,
      content,
      completeness: input.completeness,
      sensitivity: input.sensitivity,
      freshness,
      integrity,
      lifecycle: input.lifecycle,
      persistence: input.persistence,
      limitations,
      createdAt: input.createdAt,
    }),
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
    triggeringThreadRevision: input.triggeringThreadRevision,
    workspace: input.workspace,
    provider: input.provider,
    permissionPreset: input.permissionPreset,
    startedAt: input.startedAt,
    metadata: input.metadata,
  });
  if (!base.ok) return base;
  const harnessRunId = normalizeNullableString(input.harnessRunId);
  if (input.harnessRunId !== null && harnessRunId === null) {
    return reject("run_harness_id_invalid", "Harness Run id is invalid.");
  }
  const normalizedBase: HelarcPersistedRun = {
    ...base.run,
    harnessRunId,
  };
  if (!isIsoDateTime(input.updatedAt) || input.updatedAt < input.startedAt) {
    return reject("run_timestamp_invalid", "Run update timestamp is invalid.");
  }
  if (!Number.isSafeInteger(input.projectionSequence) || input.projectionSequence < 0) {
    return reject("run_projection_invalid", "Run projection sequence is invalid.");
  }
  const projection = normalizeProjectionRecord(
    normalizedBase,
    input.updatedAt,
    input.projectionSequence,
    input.lastProjection,
  );
  if (!projection.ok) return projection;
  const terminal = normalizeTerminalRecord(normalizedBase, input.updatedAt, input.terminal);
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
      ...normalizedBase,
      updatedAt: input.updatedAt,
      projectionSequence: input.projectionSequence,
      lastProjection: projection.projection,
      terminal: terminal.terminal,
      artifactIds: artifactIds.ids,
      metadata: metadata.value,
    },
  };
}

function normalizeProjectionRecord(
  run: HelarcPersistedRun,
  updatedAt: string,
  sequence: number,
  projection: HelarcRunProjectionRecord | null,
): { ok: true; projection: HelarcRunProjectionRecord | null } |
  { ok: false; error: HelarcWorkContextError } {
  if ((sequence === 0) !== (projection === null)) {
    return reject("run_projection_invalid", "Run projection sequence and snapshot are inconsistent.");
  }
  if (projection === null) return { ok: true, projection: null };
  if (
    !isIsoDateTime(projection.recordedAt) || projection.recordedAt < run.startedAt ||
    projection.recordedAt > updatedAt ||
    !isHostRunProjection(projection.host) ||
    !isProductRunProjection(projection.product) ||
    run.harnessRunId === null || projection.host.runId !== run.harnessRunId ||
    projection.host.taskId !== run.taskId ||
    projection.host.sessionId !== run.sessionId || projection.product.runId !== run.id
  ) {
    return reject("run_projection_invalid", "Run projection is invalid.");
  }
  const safe = normalizeSafeValue(projection);
  if (!safe.ok) {
    return reject("run_projection_invalid", "Run projection must contain canonical safe data.");
  }
  return { ok: true, projection };
}

function normalizeTerminalRecord(
  run: HelarcPersistedRun,
  updatedAt: string,
  terminal: HelarcRunTerminalRecord | null,
): { ok: true; terminal: HelarcRunTerminalRecord | null } |
  { ok: false; error: HelarcWorkContextError } {
  if (terminal === null) return { ok: true, terminal: null };
  const host = terminal.host;
  if (
    host === null || typeof host !== "object" ||
    run.harnessRunId === null || host.runId !== run.harnessRunId ||
    host.taskId !== run.taskId ||
    !isIsoDateTime(host.completedAt) || host.completedAt < run.startedAt ||
    host.completedAt > updatedAt || !isHostTerminalProjection(host) ||
    !isCompatibleProductTerminal(run, host, terminal.product)
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
  if (
    !hasExactKeys(input, ["thread", "messages", "runs", "artifacts", "collaboration", "reviews"]) ||
    !Array.isArray(input.messages) || !Array.isArray(input.runs) ||
    !Array.isArray(input.artifacts) || !Array.isArray(input.collaboration) ||
    !Array.isArray(input.reviews)
  ) {
    return reject("thread_record_invalid", "Thread record shape is invalid.");
  }
  const threadResult = createHelarcThread(input.thread);
  if (!threadResult.ok) {
    return threadResult;
  }

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

  const collaboration = input.collaboration.map(snapshotHelarcCollaborationRecord);
  if (collaboration.some((record) => record === null)) {
    return reject("collaboration_record_invalid", "Collaboration record is invalid.");
  }
  const reviews = input.reviews.map(snapshotHelarcReviewRecord);
  if (reviews.some((record) => record === null)) {
    return reject("review_record_invalid", "Review record is invalid.");
  }

  const relationship = validateThreadRecordRelationships(
    threadResult.thread,
    messages,
    runs,
    artifacts,
    collaboration as HelarcCollaborationRecord[],
    reviews as HelarcReviewRecord[],
  );
  if (!relationship.ok) {
    return relationship;
  }

  return {
    ok: true,
    record: {
      thread: threadResult.thread,
      messages,
      runs,
      artifacts,
      collaboration: collaboration as HelarcCollaborationRecord[],
      reviews: reviews as HelarcReviewRecord[],
    },
  };
}

function validateThreadRecordRelationships(
  thread: HelarcThread,
  messages: readonly HelarcMessage[],
  runs: readonly HelarcPersistedRun[],
  artifacts: readonly HelarcArtifact[],
  collaboration: readonly HelarcCollaborationRecord[],
  reviews: readonly HelarcReviewRecord[],
): { ok: true } | { ok: false; error: HelarcWorkContextError } {
  const messageById = new Map(messages.map((message) => [message.id, message]));
  for (const [index, message] of messages.entries()) {
    if (message.threadId !== thread.id || message.sequence !== index + 1) {
      return reject("thread_record_invalid", "Messages must belong directly to the Thread in exact sequence.");
    }
  }

  const runById = new Map(runs.map((run) => [run.id, run]));
  for (const run of runs) {
    const triggerMessage = messageById.get(run.triggeringMessageId);
    if (
      run.threadId !== thread.id ||
      run.triggeringThreadRevision >= thread.revision ||
      !triggerMessage ||
      triggerMessage.sequence > run.triggeringThreadRevision + 1 ||
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

  for (const record of collaboration) {
    if (record.threadId !== thread.id || !runById.has(record.runId)) {
      return reject(
        "thread_record_invalid",
        "Collaboration record must belong to the Thread and reference an existing Run.",
      );
    }
  }

  for (const review of reviews) {
    if (
      review.threadId !== thread.id ||
      (review.runId !== null && !runById.has(review.runId)) ||
      (review.kind === "engineering_review" && review.reportArtifactRef !== null &&
        !artifactById.has(review.reportArtifactRef.id))
    ) {
      return reject(
        "thread_record_invalid",
        "Review record must belong to the Thread and reference existing owned records.",
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
  workspace: HelarcThreadWorkspaceIdentity,
): { ok: true; workspace: HelarcThreadWorkspaceIdentity } |
  { ok: false; error: HelarcWorkContextError } {
  if (
    workspace === null ||
    typeof workspace !== "object" ||
    !Array.isArray(workspace.additional)
  ) {
    return reject("thread_workspace_invalid", "Thread workspace reference is invalid.");
  }

  const primary = normalizeThreadWorkspaceRef(workspace.primary);
  if (primary === null) {
    return reject("thread_workspace_invalid", "Thread primary Workspace reference is invalid.");
  }
  const additional: HelarcThreadWorkspaceRef[] = [];
  const profileIds = new Set([primary.profileId]);
  for (const candidate of workspace.additional) {
    const normalized = normalizeThreadWorkspaceRef(candidate);
    if (normalized === null || profileIds.has(normalized.profileId)) {
      return reject(
        "thread_workspace_invalid",
        "Thread additional Workspace references are invalid or duplicated.",
      );
    }
    profileIds.add(normalized.profileId);
    additional.push(normalized);
  }

  return {
    ok: true,
    workspace: {
      primary,
      additional,
    },
  };
}

function normalizeThreadWorkspaceRef(
  workspace: HelarcThreadWorkspaceRef,
): HelarcThreadWorkspaceRef | null {
  if (workspace === null || typeof workspace !== "object") {
    return null;
  }
  const profileId = normalizeRequiredString(workspace.profileId);
  const displayName = normalizeRequiredString(workspace.displayName);
  const path = normalizeRequiredString(workspace.path);
  return profileId && displayName && path
    ? { profileId, displayName, path }
    : null;
}

function normalizeWorkspaceSelection(
  workspace: HelarcWorkspaceSelectionIdentity,
): { ok: true; workspace: HelarcWorkspaceSelectionIdentity } |
  { ok: false; error: HelarcWorkContextError } {
  if (
    workspace === null ||
    typeof workspace !== "object" ||
    !Array.isArray(workspace.additional)
  ) {
    return reject("run_workspace_invalid", "Run Workspace context is invalid.");
  }
  const primary = normalizeWorkspaceSelectionRef(workspace.primary);
  if (primary === null) {
    return reject("run_workspace_invalid", "Run primary Workspace context is invalid.");
  }
  const additional: HelarcWorkspaceSelectionRef[] = [];
  const workspaceIds = new Set([primary.workspaceId]);
  const profileIds = new Set([primary.profileId]);
  for (const candidate of workspace.additional) {
    const normalized = normalizeWorkspaceSelectionRef(candidate);
    if (
      normalized === null ||
      workspaceIds.has(normalized.workspaceId) ||
      profileIds.has(normalized.profileId)
    ) {
      return reject(
        "run_workspace_invalid",
        "Run additional Workspace contexts are invalid or duplicated.",
      );
    }
    workspaceIds.add(normalized.workspaceId);
    profileIds.add(normalized.profileId);
    additional.push(normalized);
  }
  return {
    ok: true,
    workspace: {
      primary,
      additional,
    },
  };
}

function normalizeWorkspaceSelectionRef(
  workspace: HelarcWorkspaceSelectionRef,
): HelarcWorkspaceSelectionRef | null {
  if (workspace === null || typeof workspace !== "object") {
    return null;
  }
  const workspaceId = normalizeRequiredString(workspace.workspaceId);
  const profileId = normalizeRequiredString(workspace.profileId);
  const displayName = normalizeRequiredString(workspace.displayName);
  return workspaceId && profileId && displayName
    ? { workspaceId, profileId, displayName }
    : null;
}

function projectHelarcWorkspaceSelectionRef(
  workspaceId: string,
  displayName: string,
  profileId: string,
): HelarcWorkspaceSelectionRef {
  const normalized = normalizeWorkspaceSelectionRef({
    workspaceId,
    profileId,
    displayName,
  });
  if (normalized === null) {
    throw new TypeError("Resolved Run Workspace identity is invalid.");
  }
  return Object.freeze(normalized);
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
    value === "product";
}

function isRunTriggerMessageRole(value: unknown): value is HelarcRunTriggerMessageRole {
  return value === "user" || value === "product" || value === "system";
}

function normalizeMessageSource(value: HelarcMessageSource): HelarcMessageSource | null {
  if (
    value === null || typeof value !== "object" ||
    !isMessageSourceKind(value.kind) || !normalizeRequiredString(value.owner) ||
    (value.refId !== null && !normalizeRequiredString(value.refId))
  ) {
    return null;
  }
  return Object.freeze({
    kind: value.kind,
    owner: value.owner.trim(),
    refId: normalizeNullableString(value.refId),
  });
}

function normalizeMessageCorrelation(
  value: HelarcMessageCorrelation,
): HelarcMessageCorrelation | null {
  if (value === null || typeof value !== "object") return null;
  const runId = normalizeNullableString(value.runId);
  const interactionRequestId = normalizeNullableString(value.interactionRequestId);
  const reviewId = normalizeNullableString(value.reviewId);
  if (
    (value.runId !== null && runId === null) ||
    (value.interactionRequestId !== null && interactionRequestId === null) ||
    (value.reviewId !== null && reviewId === null)
  ) {
    return null;
  }
  return Object.freeze({ runId, interactionRequestId, reviewId });
}

function isMessageSourceKind(value: unknown): value is HelarcMessageSourceKind {
  return value === "user_input" || value === "agent_run" || value === "system" ||
    value === "interaction" || value === "review" || value === "automation" ||
    value === "product";
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isHostRunProjection(value: unknown): value is HostRunProjection {
  if (value === null || typeof value !== "object") return false;
  const projection = value as Partial<HostRunProjection>;
  return typeof projection.runId === "string" &&
    typeof projection.taskId === "string" &&
    typeof projection.sessionId === "string" &&
    Number.isSafeInteger(projection.sequence) &&
    (projection.sequence ?? -1) >= 0 &&
    projection.terminal === null &&
    projection.status !== "completed" &&
    projection.status !== "stopped" &&
    projection.status !== "failed" &&
    projection.status !== "cancelled";
}

function isProductRunProjection(value: unknown): value is HelarcProductRunProjection {
  if (value === null || typeof value !== "object") return false;
  const projection = value as Partial<HelarcProductRunProjection>;
  return typeof projection.runId === "string" &&
    Number.isSafeInteger(projection.sequence) &&
    (projection.sequence ?? -1) >= 0 &&
    projection.result === null &&
    isModelQualificationSafeProjection(projection.qualification) &&
    Array.isArray(projection.activity) &&
    projection.phase !== null && typeof projection.phase === "object";
}

function isCompatibleProductTerminal(
  run: HelarcPersistedRun,
  host: HostTerminalRunProjection,
  product: HelarcProductResult | null,
): boolean {
  if (product === null) return true;
  if (
    product.status !== "completed" && product.status !== "stopped" && product.status !== "rejected" &&
    product.status !== "failed" &&
    product.status !== "cancelled"
  ) {
    return false;
  }
  const output = product.output;
  if (
    !isModelQualificationSafeProjection(product.qualification) ||
    output === null || typeof output !== "object" || output.taskId !== run.taskId ||
    output.workspace === null || typeof output.workspace !== "object" ||
    !hasText(output.workspace.primaryId) || !Array.isArray(output.workspace.additionalIds) ||
    !output.workspace.additionalIds.every(hasText) ||
    (output.agentSummary !== null && typeof output.agentSummary !== "string") ||
    !isRuntimeResultStatus(output.runtimeStatus) ||
    !isEnforcementSummary(output.enforcement) || !Array.isArray(output.safeErrors) ||
    !output.safeErrors.every((error) =>
      error !== null && typeof error === "object" && hasText(error.code) && hasText(error.message)
    )
  ) {
    return false;
  }
  const expectedRuntimeStatus = host.status === "completed" ? "succeeded" : host.status;
  if (output.runtimeStatus !== expectedRuntimeStatus) return false;
  if (host.status === "completed") return product.status !== "cancelled";
  return product.status === host.status;
}

function isModelQualificationSafeProjection(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const projection = value as import("../model-qualification/index.js")
    .HelarcModelQualificationSafeProjection;
  return (
    projection.status === "qualified" || projection.status === "experimental" ||
    projection.status === "blocked"
  ) && (
    projection.policy === "require_qualified" ||
    projection.policy === "allow_experimental"
  ) && typeof projection.providerKind === "string" &&
    typeof projection.modelId === "string" &&
    typeof projection.experimentalUseSelected === "boolean" &&
    Array.isArray(projection.scopes) && Array.isArray(projection.reasons) &&
    projection.toolGuidance !== null &&
    typeof projection.toolGuidance === "object";
}

function isHostTerminalProjection(value: HostTerminalRunProjection): boolean {
  if (
    !isHostTerminalStatus(value.status) ||
    !hasText(value.code) ||
    !isNullableNonNegativeInteger(value.durationMs) ||
    !isNonNegativeInteger(value.itemCount) ||
    !isNonNegativeInteger(value.evidenceCount) ||
    !isNonNegativeInteger(value.artifactCount) ||
    !isHostTerminalFailure(value.failure) ||
    value.source === null || typeof value.source !== "object" ||
    !hasText(value.source.owner) || !hasText(value.source.kind) || !hasText(value.source.id) ||
    !Array.isArray(value.causalLinks) ||
    !isNonNegativeInteger(value.omittedCausalLinkCount) ||
    !isCancellationSummary(value.cancellation)
  ) {
    return false;
  }
  if (value.status === "completed") {
    return value.code === "completion_accepted" && value.failure === null &&
      value.cancellation === null;
  }
  if (value.status === "stopped") {
    return value.code === "stop_accepted" && value.failure === null && value.cancellation === null;
  }
  if (value.status === "cancelled") {
    return value.code === "runtime_cancelled" && value.failure === null &&
      value.cancellation !== null;
  }
  return value.code !== null && value.failure !== null;
}

function isHostTerminalFailure(value: unknown): boolean {
  if (value === null) return true;
  if (value === null || typeof value !== "object") return false;
  const failure = value as { kind?: unknown; code?: unknown; retryable?: unknown };
  return isRunFailureKind(failure.kind) && hasText(failure.code) &&
    (failure.retryable === null || typeof failure.retryable === "boolean");
}

function isRunFailureKind(value: unknown): boolean {
  return value === "runtime" || value === "model" || value === "provider" ||
    value === "approval" || value === "permission" || value === "policy" ||
    value === "action_execution" || value === "sandbox" || value === "tool" ||
    value === "context" || value === "audit" || value === "telemetry";
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
  return value === "succeeded" || value === "stopped" || value === "blocked" || value === "failed" ||
    value === "cancelled";
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

function isHostTerminalStatus(
  value: unknown,
): value is HostTerminalRunProjection["status"] {
  return value === "completed" || value === "stopped" || value === "blocked" || value === "failed" || value === "cancelled";
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

function normalizeArtifactProducer(value: HelarcArtifactProducer): HelarcArtifactProducer | null {
  if (
    !hasExactKeys(value, ["kind", "owner", "refId"]) ||
    !isArtifactProducerKind(value.kind) || !hasText(value.owner) || !hasText(value.refId)
  ) {
    return null;
  }
  return Object.freeze({ kind: value.kind, owner: value.owner.trim(), refId: value.refId.trim() });
}

function normalizeArtifactRefs(
  values: readonly HelarcArtifactRecordRef[],
  required: boolean,
): readonly HelarcArtifactRecordRef[] | null {
  if (!Array.isArray(values) || (required && values.length === 0)) return null;
  const refs: HelarcArtifactRecordRef[] = [];
  const identities = new Set<string>();
  for (const value of values) {
    if (
      !hasExactKeys(value, ["owner", "kind", "id", "revision"]) ||
      !hasText(value.owner) || !hasText(value.kind) || !hasText(value.id) ||
      (value.revision !== null && !hasText(value.revision))
    ) {
      return null;
    }
    const ref = Object.freeze({
      owner: value.owner.trim(),
      kind: value.kind.trim(),
      id: value.id.trim(),
      revision: value.revision?.trim() ?? null,
    });
    const identity = `${ref.owner}\u0000${ref.kind}\u0000${ref.id}\u0000${ref.revision ?? ""}`;
    if (identities.has(identity)) return null;
    identities.add(identity);
    refs.push(ref);
  }
  return Object.freeze(refs);
}

function normalizeArtifactContent(value: HelarcArtifactContent): HelarcArtifactContent | null {
  if (value?.kind === "inline") {
    if (!hasExactKeys(value, ["kind", "mediaType", "value"]) || !hasText(value.mediaType)) {
      return null;
    }
    const content = normalizeSafeValue(value.value);
    return content.ok
      ? Object.freeze({ kind: "inline", mediaType: value.mediaType.trim(), value: content.value })
      : null;
  }
  if (value?.kind === "reference") {
    if (
      !hasExactKeys(value, ["kind", "mediaType", "uri", "digest"]) ||
      !hasText(value.mediaType) || !hasText(value.uri) ||
      (value.digest !== null && !hasText(value.digest))
    ) {
      return null;
    }
    return Object.freeze({
      kind: "reference",
      mediaType: value.mediaType.trim(),
      uri: value.uri.trim(),
      digest: value.digest?.trim() ?? null,
    });
  }
  return null;
}

function normalizeArtifactFreshness(value: HelarcArtifactFreshness): HelarcArtifactFreshness | null {
  if (value?.status === "current") {
    return hasExactKeys(value, ["status", "observedAt", "sourceRevision"]) &&
      isIsoDateTime(value.observedAt) &&
      (value.sourceRevision === null || hasText(value.sourceRevision))
      ? Object.freeze({ ...value, sourceRevision: value.sourceRevision?.trim() ?? null })
      : null;
  }
  if (value?.status === "stale") {
    return hasExactKeys(value, ["status", "observedAt", "sourceRevision", "reason"]) &&
      isIsoDateTime(value.observedAt) && hasText(value.reason) &&
      (value.sourceRevision === null || hasText(value.sourceRevision))
      ? Object.freeze({
          ...value,
          sourceRevision: value.sourceRevision?.trim() ?? null,
          reason: value.reason.trim(),
        })
      : null;
  }
  if (value?.status === "unknown") {
    return hasExactKeys(value, ["status", "observedAt"]) &&
      (value.observedAt === null || isIsoDateTime(value.observedAt))
      ? Object.freeze({ ...value })
      : null;
  }
  return null;
}

function normalizeArtifactIntegrity(value: HelarcArtifactIntegrity): HelarcArtifactIntegrity | null {
  if (value?.status === "verified") {
    return hasExactKeys(value, ["status", "algorithm", "digest"]) &&
      hasText(value.algorithm) && hasText(value.digest)
      ? Object.freeze({ ...value, algorithm: value.algorithm.trim(), digest: value.digest.trim() })
      : null;
  }
  if (value?.status === "unverified") {
    return hasExactKeys(value, ["status"]) ? Object.freeze({ status: "unverified" }) : null;
  }
  if (value?.status === "failed") {
    return hasExactKeys(value, ["status", "reason"]) && hasText(value.reason)
      ? Object.freeze({ status: "failed", reason: value.reason.trim() })
      : null;
  }
  return null;
}

function normalizeTextList(values: readonly string[]): readonly string[] | null {
  if (!Array.isArray(values)) return null;
  const normalized = values.map((value) => value.trim());
  return normalized.some((value) => value.length === 0) ||
    new Set(normalized).size !== normalized.length
    ? null
    : Object.freeze(normalized);
}

function isArtifactKind(value: unknown): value is HelarcArtifactKind {
  return value === "final-output" ||
    value === "proposal-revision" ||
    value === "applied-change" ||
    value === "trace-projection" ||
    value === "tool-output-summary" ||
    value === "evidence-bundle" ||
    value === "verification-report" ||
    value === "evaluation-report" ||
    value === "engineering-review" ||
    value === "error-report";
}

function isArtifactProducerKind(value: unknown): value is HelarcArtifactProducer["kind"] {
  return value === "agent" || value === "product" || value === "tool" ||
    value === "operation" || value === "verification" || value === "evaluation" ||
    value === "review" || value === "user";
}

function isArtifactCompleteness(value: unknown): value is HelarcArtifact["completeness"] {
  return value === "complete" || value === "partial" || value === "unknown";
}

function isArtifactSensitivity(value: unknown): value is HelarcArtifact["sensitivity"] {
  return value === "public" || value === "private" || value === "secret" || value === "restricted";
}

function isArtifactLifecycle(value: unknown): value is HelarcArtifact["lifecycle"] {
  return value === "draft" || value === "final" || value === "superseded" || value === "withdrawn";
}

function isArtifactPersistence(value: unknown): value is HelarcArtifact["persistence"] {
  return value === "thread_record" || value === "external_reference";
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
