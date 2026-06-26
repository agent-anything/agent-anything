import { createHelarcTask, type HelarcTaskInputError } from "@agent-anything/helarc";
import { basename, isAbsolute, normalize } from "node:path";

export interface HelarcWorkspaceSnapshot {
  id: string;
  name: string;
  path: string;
}

export interface HelarcAcceptedTaskSnapshot {
  id: string;
  prompt: string;
}

export type HelarcMainSnapshotStatus = "idle" | "workspace_selected";

export interface HelarcMainSnapshot {
  status: HelarcMainSnapshotStatus;
  workspace: HelarcWorkspaceSnapshot | null;
  acceptedTask: HelarcAcceptedTaskSnapshot | null;
  error: HelarcMainError | null;
}

export type HelarcMainErrorCode =
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

export class HelarcMainController {
  private selectedWorkspace: HelarcWorkspaceSnapshot | null = null;
  private acceptedTask: HelarcAcceptedTaskSnapshot | null = null;
  private lastError: HelarcMainError | null = null;
  private nextTaskNumber = 1;

  getSnapshot(): HelarcMainSnapshot {
    return {
      status: this.selectedWorkspace ? "workspace_selected" : "idle",
      workspace: this.selectedWorkspace,
      acceptedTask: this.acceptedTask,
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
    this.acceptedTask = null;
    this.lastError = null;
    return this.getSnapshot();
  }

  startSession(input: StartHelarcSessionInput): StartHelarcSessionResult {
    if (!this.selectedWorkspace) {
      const error = this.setError("workspace_not_selected", "Choose a workspace before starting a task.");
      return { ok: false, error, snapshot: this.getSnapshot() };
    }

    const taskId = `helarc-task-${this.nextTaskNumber}`;
    const result = createHelarcTask({
      taskId,
      prompt: input.taskText,
      createdAt: new Date().toISOString(),
      workspace: {
        id: this.selectedWorkspace.id,
        name: this.selectedWorkspace.name,
        rootRef: this.selectedWorkspace.path,
      },
    });

    if (!result.ok) {
      const error = this.setError(result.error.code, result.error.message);
      return { ok: false, error, snapshot: this.getSnapshot() };
    }

    this.nextTaskNumber += 1;
    this.acceptedTask = {
      id: result.task.id,
      prompt: result.task.input.prompt,
    };
    this.lastError = null;

    return {
      ok: true,
      taskId: result.task.id,
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
