import {
  createHelarcTask,
  runHelarcReadOnlySession,
  type HelarcActivityItem,
  type HelarcSessionOutput,
  type HelarcTaskInputError,
} from "@agent-anything/helarc";
import type { Provider } from "@agent-anything/providers";
import { basename, isAbsolute, normalize } from "node:path";
import type { HelarcProviderConfigError } from "./provider/resolveHelarcProviderConfig.js";

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
  | { configured: true; error: null }
  | { configured: false; error: HelarcMainError };

export type HelarcMainSnapshotStatus =
  | "idle"
  | "workspace_selected"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled";

export interface HelarcMainSnapshot {
  status: HelarcMainSnapshotStatus;
  workspace: HelarcWorkspaceSnapshot | null;
  provider: HelarcProviderSnapshot;
  acceptedTask: HelarcAcceptedTaskSnapshot | null;
  activity: HelarcActivityItem[];
  output: HelarcSessionOutput | null;
  error: HelarcMainError | null;
}

export type HelarcMainErrorCode =
  | "provider_config_missing"
  | "provider_not_available"
  | "workspace_not_selected"
  | "workspace_path_required"
  | "workspace_path_not_absolute"
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

export interface HelarcMainControllerInput {
  provider?: Provider | null;
  providerConfigError?: HelarcProviderConfigError | null;
}

export class HelarcMainController {
  private selectedWorkspace: HelarcWorkspaceSnapshot | null = null;
  private acceptedTask: HelarcAcceptedTaskSnapshot | null = null;
  private activity: HelarcActivityItem[] = [];
  private output: HelarcSessionOutput | null = null;
  private lastError: HelarcMainError | null = null;
  private readonly provider: HelarcProviderSnapshot;
  private readonly providerInstance: Provider | null;
  private status: HelarcMainSnapshotStatus = "idle";
  private nextTaskNumber = 1;

  constructor(input: HelarcMainControllerInput = {}) {
    this.providerInstance = input.provider ?? null;
    this.provider = input.providerConfigError
      ? {
          configured: false,
          error: {
            code: "provider_config_missing",
            message: input.providerConfigError.message,
          },
        }
      : { configured: true, error: null };
  }

  getSnapshot(): HelarcMainSnapshot {
    return {
      status: this.status,
      workspace: this.selectedWorkspace,
      provider: this.provider,
      acceptedTask: this.acceptedTask,
      activity: this.activity,
      output: this.output,
      error: this.lastError,
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

    this.selectedWorkspace = {
      id: "workspace",
      name: basename(normalizedPath) || normalizedPath,
      path: normalizedPath,
    };
    this.status = "workspace_selected";
    this.acceptedTask = null;
    this.activity = [];
    this.output = null;
    this.lastError = null;
    return this.getSnapshot();
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

    if (!this.selectedWorkspace) {
      const error = this.setError("workspace_not_selected", "Choose a workspace before starting a task.");
      return { ok: false, error, snapshot: this.getSnapshot() };
    }

    const taskId = `helarc-task-${this.nextTaskNumber}`;
    const taskResult = createHelarcTask({
      taskId,
      prompt: input.taskText,
      createdAt: new Date().toISOString(),
      workspace: {
        id: this.selectedWorkspace.id,
        name: this.selectedWorkspace.name,
        rootRef: this.selectedWorkspace.path,
      },
    });

    if (!taskResult.ok) {
      const error = this.setError(taskResult.error.code, taskResult.error.message);
      return { ok: false, error, snapshot: this.getSnapshot() };
    }

    this.nextTaskNumber += 1;
    this.acceptedTask = {
      id: taskResult.task.id,
      prompt: taskResult.task.input.prompt,
    };
    this.status = "running";
    this.activity = [];
    this.output = null;
    this.lastError = null;

    const sessionResult = await runHelarcReadOnlySession({
      task: taskResult.task,
      provider: this.providerInstance,
    });

    this.status = sessionResult.status;
    this.activity = sessionResult.activity;
    this.output = sessionResult.output;

    if (sessionResult.status === "failed") {
      const firstError = sessionResult.output.safeErrors[0] ?? {
        code: "provider_not_available",
        message: "Helarc session failed.",
      };
      this.lastError = {
        code: firstError.code as HelarcMainErrorCode,
        message: firstError.message,
      };
      return { ok: false, error: this.lastError, snapshot: this.getSnapshot() };
    }

    return {
      ok: true,
      taskId: taskResult.task.id,
      snapshot: this.getSnapshot(),
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
}
