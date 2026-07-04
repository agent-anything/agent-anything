import type {
  HelarcRunEventViewModel,
  HelarcRunTerminalStatus,
  HelarcRunTerminalSummary,
} from "../run/index.js";
import type { HelarcActivityItem, HelarcPatchStatus, HelarcSessionOutput, HelarcSessionStatus } from "../session/index.js";

export type HelarcSessionHistoryStatus = Exclude<HelarcSessionStatus, "running">;

export interface HelarcSessionHistoryWorkspaceRef {
  profileId: string | null;
  displayName: string;
  path: string;
}

export interface HelarcSessionHistoryProviderRef {
  profileId: string | null;
  displayName: string;
  endpointLabel: string;
  model: string;
}

export type HelarcSessionHistoryPatchDecision =
  | "accepted"
  | "rejected"
  | "not_required"
  | "unknown";

export interface HelarcSessionHistoryPatchSummary {
  patchId: string | null;
  operation: "create" | "update" | "delete" | null;
  path: string | null;
  summary: string | null;
  decision: HelarcSessionHistoryPatchDecision;
  reason: string | null;
  status: HelarcPatchStatus | null;
}

export interface HelarcSessionHistoryRunRecord {
  runId: string;
  status: HelarcRunTerminalStatus;
  events: HelarcRunEventViewModel[];
  terminal: HelarcRunTerminalSummary;
}

export interface CreateHelarcSessionHistoryRecordInput {
  id: string;
  taskId: string;
  taskText: string;
  workspace: HelarcSessionHistoryWorkspaceRef;
  provider: HelarcSessionHistoryProviderRef;
  startedAt: string;
  endedAt: string;
  status: HelarcSessionHistoryStatus;
  activity: HelarcActivityItem[];
  output: HelarcSessionOutput;
  patch: HelarcSessionHistoryPatchSummary;
  run: HelarcSessionHistoryRunRecord;
}

export interface HelarcSessionHistoryRecord extends CreateHelarcSessionHistoryRecordInput {}

export type HelarcSessionHistoryRecordErrorCode =
  | "session_history_id_required"
  | "session_history_task_id_required"
  | "session_history_task_text_required"
  | "session_history_timestamp_invalid"
  | "session_history_status_invalid"
  | "session_history_workspace_invalid"
  | "session_history_provider_invalid"
  | "session_history_run_invalid";

export interface HelarcSessionHistoryRecordError {
  code: HelarcSessionHistoryRecordErrorCode;
  message: string;
}

export type CreateHelarcSessionHistoryRecordResult =
  | { ok: true; record: HelarcSessionHistoryRecord }
  | { ok: false; error: HelarcSessionHistoryRecordError };

export function createHelarcSessionHistoryRecord(
  input: CreateHelarcSessionHistoryRecordInput,
): CreateHelarcSessionHistoryRecordResult {
  const id = input.id.trim();
  if (id.length === 0) {
    return reject("session_history_id_required", "Session history id is required.");
  }

  const taskId = input.taskId.trim();
  if (taskId.length === 0) {
    return reject("session_history_task_id_required", "Session history task id is required.");
  }

  const taskText = input.taskText.trim();
  if (taskText.length === 0) {
    return reject("session_history_task_text_required", "Session history task text is required.");
  }

  if (!isIsoDateTime(input.startedAt) || !isIsoDateTime(input.endedAt)) {
    return reject("session_history_timestamp_invalid", "Session history timestamps are invalid.");
  }

  if (!isSessionStatus(input.status)) {
    return reject("session_history_status_invalid", "Session history status is invalid.");
  }

  const workspaceResult = normalizeWorkspace(input.workspace);
  if (!workspaceResult.ok) {
    return workspaceResult;
  }

  const providerResult = normalizeProvider(input.provider);
  if (!providerResult.ok) {
    return providerResult;
  }

  const runResult = normalizeRun(input.run);
  if (!runResult.ok) {
    return runResult;
  }

  return {
    ok: true,
    record: {
      id,
      taskId,
      taskText,
      workspace: workspaceResult.workspace,
      provider: providerResult.provider,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      status: input.status,
      activity: input.activity,
      output: input.output,
      patch: input.patch,
      run: runResult.run,
    },
  };
}

function normalizeWorkspace(
  workspace: HelarcSessionHistoryWorkspaceRef,
): { ok: true; workspace: HelarcSessionHistoryWorkspaceRef } | { ok: false; error: HelarcSessionHistoryRecordError } {
  const displayName = workspace.displayName.trim();
  const path = workspace.path.trim();
  if (displayName.length === 0 || path.length === 0) {
    return reject("session_history_workspace_invalid", "Session history workspace reference is invalid.");
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
  provider: HelarcSessionHistoryProviderRef,
): { ok: true; provider: HelarcSessionHistoryProviderRef } | { ok: false; error: HelarcSessionHistoryRecordError } {
  const displayName = provider.displayName.trim();
  const endpointLabel = provider.endpointLabel.trim();
  const model = provider.model.trim();
  if (displayName.length === 0 || endpointLabel.length === 0 || model.length === 0) {
    return reject("session_history_provider_invalid", "Session history provider reference is invalid.");
  }

  return {
    ok: true,
    provider: {
      profileId: normalizeNullableString(provider.profileId),
      displayName,
      endpointLabel,
      model,
    },
  };
}

function normalizeRun(
  run: HelarcSessionHistoryRunRecord,
): { ok: true; run: HelarcSessionHistoryRunRecord } | { ok: false; error: HelarcSessionHistoryRecordError } {
  const runId = run.runId.trim();
  if (
    runId.length === 0 ||
    !isRunTerminalStatus(run.status) ||
    run.terminal.status !== run.status ||
    run.terminal.eventCount !== run.events.length
  ) {
    return reject("session_history_run_invalid", "Session history run record is invalid.");
  }

  return {
    ok: true,
    run: {
      runId,
      status: run.status,
      events: [...run.events],
      terminal: run.terminal,
    },
  };
}

function normalizeNullableString(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function isIsoDateTime(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function isSessionStatus(value: unknown): value is HelarcSessionHistoryStatus {
  return value === "completed" ||
    value === "rejected" ||
    value === "failed" ||
    value === "blocked" ||
    value === "cancelled";
}

function isRunTerminalStatus(value: unknown): value is HelarcRunTerminalStatus {
  return value === "completed" ||
    value === "failed" ||
    value === "denied" ||
    value === "cancelled";
}

function reject(
  code: HelarcSessionHistoryRecordErrorCode,
  message: string,
): { ok: false; error: HelarcSessionHistoryRecordError } {
  return { ok: false, error: { code, message } };
}
