import type { AgentTask } from "@agent-anything/agent-core/task";
import {
  selectHelarcProviderProfile,
  selectHelarcWorkspaceProfile,
  type HelarcProviderProfile,
  type HelarcProviderProfileErrorCode,
  type HelarcWorkspaceProfile,
  type HelarcWorkspaceProfileErrorCode,
} from "@agent-anything/helarc/configuration";
import {
  createHelarcRunInput,
  type HelarcRunInput,
  type HelarcRunContractErrorCode,
  type HelarcRunPermissionPreset,
  type HelarcRunProviderRef,
} from "@agent-anything/helarc/run";
import type {
  HelarcThreadWorkspaceIdentity,
} from "@agent-anything/helarc/work-context";
import {
  createHelarcTask,
  type HelarcTaskInput,
  type HelarcTaskInputErrorCode,
} from "@agent-anything/helarc/task";

export interface PrepareHelarcRunStartInput {
  runId: string;
  taskId: string;
  taskText: string;
  workspaceProfileId: string;
  additionalWorkspaceProfileIds?: readonly string[];
  providerProfileId: string;
  workspaceProfiles: readonly HelarcWorkspaceProfile[];
  providerProfiles: readonly HelarcProviderProfile[];
  createdAt: string;
  permissionPreset?: HelarcRunPermissionPreset;
  metadata?: Record<string, unknown>;
}

export interface PreparedHelarcRunStart {
  run: HelarcRunInput;
  task: AgentTask<HelarcTaskInput>;
  workspace: HelarcThreadWorkspaceIdentity;
  provider: HelarcRunProviderRef;
}

export type PrepareHelarcRunStartErrorCode =
  | HelarcProviderProfileErrorCode
  | HelarcRunContractErrorCode
  | HelarcTaskInputErrorCode
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
  const additionalWorkspaceResults = (
    input.additionalWorkspaceProfileIds ?? []
  ).map((profileId) =>
    selectHelarcWorkspaceProfile(input.workspaceProfiles, profileId)
  );
  const failedAdditionalWorkspace = additionalWorkspaceResults.find(
    (result) => !result.ok,
  );
  if (failedAdditionalWorkspace && !failedAdditionalWorkspace.ok) {
    return reject(
      failedAdditionalWorkspace.error.code,
      failedAdditionalWorkspace.error.message,
    );
  }
  const additionalWorkspaceProfiles = additionalWorkspaceResults.map(
    (result) => {
      if (!result.ok) {
        throw new Error("Unreachable invalid additional Workspace result.");
      }
      return result.profile;
    },
  );

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

  const runResult = createHelarcRunInput({
    runId: input.runId,
    taskText: input.taskText,
    workspaceProfileId: workspaceResult.profile.id,
    additionalWorkspaceProfileIds: additionalWorkspaceProfiles.map(
      (profile) => profile.id,
    ),
    providerProfileId: providerResult.activeProfile.id,
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
    createdAt: input.createdAt,
    metadata: {
      ...(input.metadata ?? {}),
      runId: runResult.input.runId,
      providerProfileId: providerResult.activeProfile.id,
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
        primary: toThreadWorkspaceRef(workspaceResult.profile),
        additional: additionalWorkspaceProfiles.map(toThreadWorkspaceRef),
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

function toThreadWorkspaceRef(
  profile: HelarcWorkspaceProfile,
): HelarcThreadWorkspaceIdentity["primary"] {
  return {
    profileId: profile.id,
    displayName: profile.displayName,
    path: profile.path,
  };
}

function reject(
  code: PrepareHelarcRunStartErrorCode,
  message: string,
): { ok: false; error: PrepareHelarcRunStartError } {
  return { ok: false, error: { code, message } };
}
