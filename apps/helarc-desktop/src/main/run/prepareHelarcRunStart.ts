import type { AgentTask } from "@agent-anything/agent-core";
import {
  createHelarcRunInput,
  createHelarcTask,
  selectHelarcProviderProfile,
  selectHelarcTaskTemplate,
  selectHelarcWorkspaceProfile,
  type HelarcProviderProfile,
  type HelarcProviderProfileErrorCode,
  type HelarcRunInput,
  type HelarcRunContractErrorCode,
  type HelarcRunPermissionPreset,
  type HelarcRunProviderRef,
  type HelarcRunWorkspaceRef,
  type HelarcTaskInput,
  type HelarcTaskInputErrorCode,
  type HelarcTaskTemplate,
  type HelarcTaskTemplateErrorCode,
  type HelarcWorkspaceProfile,
  type HelarcWorkspaceProfileErrorCode,
} from "@agent-anything/helarc";

export interface PrepareHelarcRunStartInput {
  runId: string;
  taskId: string;
  taskText: string;
  taskTemplateId?: string | null;
  workspaceProfileId: string;
  providerProfileId: string;
  workspaceProfiles: readonly HelarcWorkspaceProfile[];
  providerProfiles: readonly HelarcProviderProfile[];
  taskTemplates?: readonly HelarcTaskTemplate[];
  createdAt: string;
  permissionPreset?: HelarcRunPermissionPreset;
  metadata?: Record<string, unknown>;
}

export interface PreparedHelarcRunStart {
  run: HelarcRunInput;
  task: AgentTask<HelarcTaskInput>;
  workspace: HelarcRunWorkspaceRef;
  provider: HelarcRunProviderRef;
}

export type PrepareHelarcRunStartErrorCode =
  | HelarcProviderProfileErrorCode
  | HelarcRunContractErrorCode
  | HelarcTaskInputErrorCode
  | HelarcTaskTemplateErrorCode
  | HelarcWorkspaceProfileErrorCode;

export interface PrepareHelarcRunStartError {
  code: PrepareHelarcRunStartErrorCode;
  message: string;
}

export type PrepareHelarcRunStartResult =
  | { ok: true; prepared: PreparedHelarcRunStart }
  | { ok: false; error: PrepareHelarcRunStartError };

export function prepareHelarcRunStart(
  input: PrepareHelarcRunStartInput,
): PrepareHelarcRunStartResult {
  const templateResult = resolveTaskTemplateText(input);
  if (!templateResult.ok) {
    return templateResult;
  }

  const workspaceResult = selectHelarcWorkspaceProfile(
    input.workspaceProfiles,
    input.workspaceProfileId,
  );
  if (!workspaceResult.ok) {
    return reject(
      workspaceResult.error.code,
      workspaceResult.error.message,
    );
  }

  const providerResult = selectHelarcProviderProfile(
    input.providerProfiles,
    input.providerProfileId,
  );
  if (!providerResult.ok) {
    return reject(
      providerResult.error.code,
      providerResult.error.message,
    );
  }

  const taskTemplateId = templateResult.taskTemplateId;
  const runResult = createHelarcRunInput({
    runId: input.runId,
    taskText: templateResult.taskText,
    workspaceProfileId: workspaceResult.profile.id,
    providerProfileId: providerResult.activeProfile.id,
    taskTemplateId,
    permissionPreset: input.permissionPreset,
    createdAt: input.createdAt,
    metadata: input.metadata,
  });
  if (!runResult.ok) {
    return reject(runResult.error.code, runResult.error.message);
  }

  const taskResult = createHelarcTask({
    taskId: input.taskId,
    prompt: runResult.input.taskText,
    workspace: {
      id: workspaceResult.profile.id,
      name: workspaceResult.profile.displayName,
      rootRef: workspaceResult.profile.path,
    },
    createdAt: input.createdAt,
    metadata: {
      ...(input.metadata ?? {}),
      runId: runResult.input.runId,
      providerProfileId: providerResult.activeProfile.id,
      taskTemplateId,
    },
  });
  if (!taskResult.ok) {
    return reject(taskResult.error.code, taskResult.error.message);
  }

  return {
    ok: true,
    prepared: {
      run: runResult.input,
      task: taskResult.task,
      workspace: {
        profileId: workspaceResult.profile.id,
        displayName: workspaceResult.profile.displayName,
        path: workspaceResult.profile.path,
      },
      provider: {
        profileId: providerResult.activeProfile.id,
        providerKind: providerResult.activeProfile.providerKind,
        displayName: providerResult.activeProfile.displayName,
        endpointLabel: providerResult.activeProfile.endpointLabel,
        model: providerResult.activeProfile.model,
      },
    },
  };
}

function resolveTaskTemplateText(
  input: PrepareHelarcRunStartInput,
): { ok: true; taskText: string; taskTemplateId: string | null } | { ok: false; error: PrepareHelarcRunStartError } {
  const taskTemplateId = normalizeNullableString(input.taskTemplateId ?? null);
  if (!taskTemplateId) {
    return { ok: true, taskText: input.taskText, taskTemplateId: null };
  }

  const templateResult = selectHelarcTaskTemplate(
    input.taskTemplates ?? [],
    taskTemplateId,
  );
  if (!templateResult.ok) {
    return reject(templateResult.error.code, templateResult.error.message);
  }

  const taskText = input.taskText.trim().length > 0
    ? input.taskText
    : templateResult.taskText;
  return {
    ok: true,
    taskText,
    taskTemplateId: templateResult.template.id,
  };
}

function normalizeNullableString(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function reject(
  code: PrepareHelarcRunStartErrorCode,
  message: string,
): { ok: false; error: PrepareHelarcRunStartError } {
  return { ok: false, error: { code, message } };
}
