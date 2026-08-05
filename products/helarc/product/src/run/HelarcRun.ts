
import type { HelarcPermissionPreset } from "../permission/HelarcPermissionPreset.js";
import type { HelarcProviderKind } from "../provider-profile/HelarcProviderProfile.js";

export type HelarcRunPermissionPreset = HelarcPermissionPreset;

export interface CreateHelarcRunInput {
  runId: string;
  taskText: string;
  workspaceProfileId: string;
  additionalWorkspaceProfileIds?: readonly string[];
  providerProfileId: string;
  taskTemplateId?: string | null;
  permissionPreset?: HelarcRunPermissionPreset;
  createdAt: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface HelarcRunInput {
  runId: string;
  taskText: string;
  workspaceProfileId: string;
  additionalWorkspaceProfileIds: readonly string[];
  providerProfileId: string;
  taskTemplateId: string | null;
  permissionPreset: HelarcRunPermissionPreset;
  createdAt: string;
  metadata: Readonly<Record<string, unknown>>;
}

export interface HelarcRunProviderRef {
  profileId: string;
  providerKind: HelarcProviderKind;
  displayName: string;
  endpointLabel: string;
  model: string;
}

export type HelarcRunContractErrorCode =
  | "run_id_required"
  | "run_task_text_required"
  | "run_workspace_profile_id_required"
  | "run_workspace_profile_ids_invalid"
  | "run_provider_profile_id_required"
  | "run_created_at_invalid"
  | "run_permission_preset_invalid";

export interface HelarcRunContractError {
  code: HelarcRunContractErrorCode;
  message: string;
}

export type CreateHelarcRunInputResult =
  | { ok: true; input: HelarcRunInput }
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

  const additionalWorkspaceProfileIds = normalizeAdditionalWorkspaceProfileIds(
    input.additionalWorkspaceProfileIds ?? [],
    workspaceProfileId,
  );
  if (additionalWorkspaceProfileIds === null) {
    return reject(
      "run_workspace_profile_ids_invalid",
      "Additional Workspace profile ids must be non-empty and unique.",
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
      additionalWorkspaceProfileIds,
      providerProfileId,
      taskTemplateId: normalizeNullableString(input.taskTemplateId ?? null),
      permissionPreset,
      createdAt: input.createdAt,
      metadata: input.metadata ?? {},
    },
  };
}

function normalizeAdditionalWorkspaceProfileIds(
  values: readonly string[],
  primaryProfileId: string,
): readonly string[] | null {
  if (!Array.isArray(values)) {
    return null;
  }
  const unique = new Set([primaryProfileId]);
  const result: string[] = [];
  for (const value of values) {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (normalized.length === 0 || unique.has(normalized)) {
      return null;
    }
    unique.add(normalized);
    result.push(normalized);
  }
  return Object.freeze(result);
}

function isPermissionPreset(value: unknown): value is HelarcRunPermissionPreset {
  return value === "ask_for_approval" ||
    value === "approve_for_me" ||
    value === "full_access";
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
