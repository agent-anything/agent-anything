import type {
  RunCancellationSummary,
  RunResultStatus,
} from "@agent-anything/agent-core";
import type { ISODateTimeString, Metadata } from "@agent-anything/shared";
import type { HelarcProviderKind } from "../provider-profile/index.js";
import type { HelarcPermissionPreset } from "../permission/index.js";

export type HelarcRunStatus =
  | "idle"
  | "starting"
  | "running"
  | "waiting_for_approval"
  | "cancelling"
  | "completed"
  | "failed"
  | "denied"
  | "cancelled";

export type HelarcRunTerminalStatus = Extract<
  HelarcRunStatus,
  "completed" | "failed" | "denied" | "cancelled"
>;

export type HelarcRunPermissionPreset = HelarcPermissionPreset;

export interface CreateHelarcRunInput {
  runId: string;
  taskText: string;
  workspaceProfileId: string;
  providerProfileId: string;
  taskTemplateId?: string | null;
  permissionPreset?: HelarcRunPermissionPreset;
  createdAt: ISODateTimeString;
  metadata?: Metadata;
}

export interface HelarcRunInput {
  runId: string;
  taskText: string;
  workspaceProfileId: string;
  providerProfileId: string;
  taskTemplateId: string | null;
  permissionPreset: HelarcRunPermissionPreset;
  createdAt: ISODateTimeString;
  metadata: Metadata;
}

export type HelarcRunEventKind =
  | "run.started"
  | "planning.started"
  | "provider.output"
  | "tool.proposed"
  | "tool.started"
  | "tool.completed"
  | "approval.requested"
  | "approval.resolved"
  | "runtime.output"
  | "retry.progress"
  | "run.completed"
  | "run.failed"
  | "run.cancelled";

export type HelarcRunEventSeverity = "info" | "warning" | "error";

export interface HelarcRunEventViewModel {
  id: string;
  sequence: number;
  timestamp: ISODateTimeString;
  kind: HelarcRunEventKind;
  title: string;
  detail: string | null;
  severity: HelarcRunEventSeverity;
  metadata: Metadata;
}

export interface HelarcRunWorkspaceRef {
  profileId: string;
  displayName: string;
  path: string;
}

export interface HelarcRunProviderRef {
  profileId: string;
  providerKind: HelarcProviderKind;
  displayName: string;
  endpointLabel: string;
  model: string;
}

export type HelarcRunApprovalRiskLevel = "low" | "medium" | "high";

export interface HelarcRunApprovalPrompt {
  requestId: string;
  actionLabel: string;
  toolName: string;
  riskLevel: HelarcRunApprovalRiskLevel;
  workspaceDisplayName: string | null;
  explanation: string;
  inputSummary: string | null;
  createdAt: ISODateTimeString;
}

export interface HelarcRunTerminalErrorSummary {
  code: string;
  message: string;
}

export interface CreateHelarcRunTerminalSummaryInput {
  status: HelarcRunTerminalStatus;
  runtimeStatus: RunResultStatus;
  runtimeCode?: string | null;
  cancellation: RunCancellationSummary | null;
  safeOutput: unknown;
  errorSummary?: readonly HelarcRunTerminalErrorSummary[];
  startedAt: ISODateTimeString;
  completedAt: ISODateTimeString;
  eventCount: number;
}

export interface HelarcRunTerminalSummary {
  status: HelarcRunTerminalStatus;
  runtimeStatus: RunResultStatus;
  runtimeCode: string | null;
  cancellation: RunCancellationSummary | null;
  safeOutput: unknown;
  errorSummary: HelarcRunTerminalErrorSummary[];
  startedAt: ISODateTimeString;
  completedAt: ISODateTimeString;
  eventCount: number;
}

export interface HelarcRunSnapshot {
  runId: string;
  status: HelarcRunStatus;
  task: {
    text: string;
    templateId: string | null;
  };
  workspace: HelarcRunWorkspaceRef | null;
  provider: HelarcRunProviderRef | null;
  events: HelarcRunEventViewModel[];
  pendingApproval: HelarcRunApprovalPrompt | null;
  cancellation: RunCancellationSummary | null;
  terminal: HelarcRunTerminalSummary | null;
  startedAt: ISODateTimeString | null;
  metadata: Metadata;
}

export type HelarcRunContractErrorCode =
  | "run_id_required"
  | "run_task_text_required"
  | "run_workspace_profile_id_required"
  | "run_provider_profile_id_required"
  | "run_created_at_invalid"
  | "run_permission_preset_invalid"
  | "run_terminal_status_invalid"
  | "run_terminal_timestamp_invalid"
  | "run_terminal_event_count_invalid"
  | "run_terminal_cancellation_invalid"
  | "run_terminal_error_summary_invalid";

export interface HelarcRunContractError {
  code: HelarcRunContractErrorCode;
  message: string;
}

export type CreateHelarcRunInputResult =
  | { ok: true; input: HelarcRunInput }
  | { ok: false; error: HelarcRunContractError };

export type CreateHelarcRunTerminalSummaryResult =
  | { ok: true; terminal: HelarcRunTerminalSummary }
  | { ok: false; error: HelarcRunContractError };

export function createHelarcRunInput(
  input: CreateHelarcRunInput,
): CreateHelarcRunInputResult {
  const runId = input.runId.trim();
  if (runId.length === 0) {
    return reject("run_id_required", "Run id is required.");
  }

  const taskText = input.taskText.trim();
  if (taskText.length === 0) {
    return reject("run_task_text_required", "Run task text is required.");
  }

  const workspaceProfileId = input.workspaceProfileId.trim();
  if (workspaceProfileId.length === 0) {
    return reject(
      "run_workspace_profile_id_required",
      "Run workspace profile id is required.",
    );
  }

  const providerProfileId = input.providerProfileId.trim();
  if (providerProfileId.length === 0) {
    return reject(
      "run_provider_profile_id_required",
      "Run provider profile id is required.",
    );
  }

  if (!isIsoDateTime(input.createdAt)) {
    return reject("run_created_at_invalid", "Run created timestamp is invalid.");
  }

  const permissionPreset = input.permissionPreset ?? "ask_for_approval";
  if (!isPermissionPreset(permissionPreset)) {
    return reject(
      "run_permission_preset_invalid",
      "Run permission preset is invalid.",
    );
  }

  return {
    ok: true,
    input: {
      runId,
      taskText,
      workspaceProfileId,
      providerProfileId,
      taskTemplateId: normalizeNullableString(input.taskTemplateId ?? null),
      permissionPreset,
      createdAt: input.createdAt,
      metadata: input.metadata ?? {},
    },
  };
}

export function createHelarcRunTerminalSummary(
  input: CreateHelarcRunTerminalSummaryInput,
): CreateHelarcRunTerminalSummaryResult {
  if (!isTerminalStatus(input.status)) {
    return reject("run_terminal_status_invalid", "Run terminal status is invalid.");
  }

  if (!isIsoDateTime(input.startedAt) || !isIsoDateTime(input.completedAt)) {
    return reject(
      "run_terminal_timestamp_invalid",
      "Run terminal timestamps are invalid.",
    );
  }

  if (!Number.isInteger(input.eventCount) || input.eventCount < 0) {
    return reject(
      "run_terminal_event_count_invalid",
      "Run terminal event count must be a non-negative integer.",
    );
  }

  if (!isValidTerminalCancellation(input)) {
    return reject(
      "run_terminal_cancellation_invalid",
      "Run terminal cancellation does not match its runtime status.",
    );
  }

  const errors = input.errorSummary ?? [];
  if (!errors.every(isValidErrorSummary)) {
    return reject(
      "run_terminal_error_summary_invalid",
      "Run terminal error summary is invalid.",
    );
  }

  return {
    ok: true,
    terminal: {
      status: input.status,
      runtimeStatus: input.runtimeStatus,
      runtimeCode: normalizeNullableString(input.runtimeCode ?? null),
      cancellation: input.cancellation === null
        ? null
        : Object.freeze({ ...input.cancellation }),
      safeOutput: input.safeOutput,
      errorSummary: errors.map((error) => ({
        code: error.code.trim(),
        message: error.message.trim(),
      })),
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      eventCount: input.eventCount,
    },
  };
}

export function createIdleHelarcRunSnapshot(
  metadata: Metadata = {},
): HelarcRunSnapshot {
  return {
    runId: "",
    status: "idle",
    task: {
      text: "",
      templateId: null,
    },
    workspace: null,
    provider: null,
    events: [],
    pendingApproval: null,
      cancellation: null,
      terminal: null,
    startedAt: null,
    metadata,
  };
}

function isValidTerminalCancellation(
  input: CreateHelarcRunTerminalSummaryInput,
): boolean {
  if (
    input.cancellation !== null &&
    !isRunCancellationSummary(input.cancellation)
  ) {
    return false;
  }
  if (input.status === "cancelled") {
    return input.runtimeStatus === "cancelled" && input.cancellation !== null;
  }
  if (input.runtimeStatus === "cancelled") {
    return false;
  }
  if (input.cancellation !== null && input.runtimeStatus !== "failed") {
    return false;
  }
  return true;
}

function isRunCancellationSummary(value: unknown): value is RunCancellationSummary {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const summary = value as Partial<RunCancellationSummary>;
  return typeof summary.requestId === "string" &&
    summary.requestId.trim().length > 0 &&
    ["user", "host", "approval", "parent_run", "runner"].includes(
      summary.origin ?? "",
    ) &&
    [
      "user_requested",
      "host_requested",
      "host_shutdown",
      "approval_cancelled",
      "parent_run_cancelled",
      "runner_shutdown",
    ].includes(summary.reasonCode ?? "") &&
    typeof summary.requestedAt === "string" &&
    isIsoDateTime(summary.requestedAt);
}

function isPermissionPreset(value: unknown): value is HelarcRunPermissionPreset {
  return value === "ask_for_approval" ||
    value === "approve_for_me" ||
    value === "full_access";
}

function isTerminalStatus(value: unknown): value is HelarcRunTerminalStatus {
  return value === "completed" ||
    value === "failed" ||
    value === "denied" ||
    value === "cancelled";
}

function isValidErrorSummary(value: HelarcRunTerminalErrorSummary): boolean {
  return value.code.trim().length > 0 && value.message.trim().length > 0;
}

function isIsoDateTime(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function normalizeNullableString(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function reject(
  code: HelarcRunContractErrorCode,
  message: string,
): { ok: false; error: HelarcRunContractError } {
  return { ok: false, error: { code, message } };
}
