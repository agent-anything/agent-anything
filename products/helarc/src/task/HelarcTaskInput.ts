import type { AgentTask, TaskWorkspaceScope } from "@agent-anything/agent-core";
import type { WorkspaceContext } from "@agent-anything/governance";
import type { ISODateTimeString, Metadata } from "@agent-anything/shared";

export const HELARC_TASK_KIND = "helarc.code-task";
export const HELARC_WORKSPACE_ROOT_NAME = "workspace";
export const DEFAULT_HELARC_TASK_PROMPT_MAX_LENGTH = 8_000;

export interface HelarcTaskInput {
  prompt: string;
}

export interface TrustedHelarcWorkspaceSelection {
  id: string;
  name: string;
  rootRef: string;
  metadata?: Metadata;
}

export interface CreateHelarcTaskInput {
  taskId: string;
  prompt: string;
  workspace: TrustedHelarcWorkspaceSelection;
  createdAt: ISODateTimeString;
  metadata?: Metadata;
  promptMaxLength?: number;
}

export type HelarcTaskInputErrorCode =
  | "task_prompt_required"
  | "task_prompt_too_long"
  | "workspace_id_required"
  | "workspace_name_required"
  | "workspace_root_required";

export interface HelarcTaskInputError {
  code: HelarcTaskInputErrorCode;
  message: string;
}

export type CreateHelarcTaskResult =
  | { ok: true; task: AgentTask<HelarcTaskInput>; workspaceScope: TaskWorkspaceScope }
  | { ok: false; error: HelarcTaskInputError };

export function createHelarcTask(
  input: CreateHelarcTaskInput,
): CreateHelarcTaskResult {
  const promptResult = normalizePrompt(input.prompt, input.promptMaxLength);
  if (!promptResult.ok) {
    return promptResult;
  }

  const workspaceResult = createTrustedHelarcWorkspaceScope(input.workspace);
  if (!workspaceResult.ok) {
    return workspaceResult;
  }

  const task: AgentTask<HelarcTaskInput> = {
    id: input.taskId,
    kind: HELARC_TASK_KIND,
    input: { prompt: promptResult.prompt },
    createdAt: input.createdAt,
    metadata: input.metadata ?? {},
    workspaceScope: workspaceResult.workspaceScope,
  };

  return {
    ok: true,
    task,
    workspaceScope: workspaceResult.workspaceScope,
  };
}

export function createTrustedHelarcWorkspaceScope(
  workspace: TrustedHelarcWorkspaceSelection,
):
  | { ok: true; workspaceScope: TaskWorkspaceScope; workspaceContext: WorkspaceContext }
  | { ok: false; error: HelarcTaskInputError } {
  const id = workspace.id.trim();
  if (id.length === 0) {
    return reject("workspace_id_required", "Workspace id is required.");
  }

  const name = workspace.name.trim();
  if (name.length === 0) {
    return reject("workspace_name_required", "Workspace name is required.");
  }

  const rootRef = workspace.rootRef.trim();
  if (rootRef.length === 0) {
    return reject("workspace_root_required", "Workspace root is required.");
  }

  const workspaceContext: WorkspaceContext = {
    id,
    name,
    rootRef,
    trustState: "trusted",
    source: "helarc-desktop",
    policyRefs: [],
    metadata: workspace.metadata ?? {},
  };

  return {
    ok: true,
    workspaceContext,
    workspaceScope: {
      roots: {
        [HELARC_WORKSPACE_ROOT_NAME]: workspaceContext,
      },
      defaultRootName: HELARC_WORKSPACE_ROOT_NAME,
    },
  };
}

function normalizePrompt(
  prompt: string,
  maxLength = DEFAULT_HELARC_TASK_PROMPT_MAX_LENGTH,
): { ok: true; prompt: string } | { ok: false; error: HelarcTaskInputError } {
  const normalized = prompt.trim();
  if (normalized.length === 0) {
    return reject("task_prompt_required", "Task prompt is required.");
  }

  if (normalized.length > maxLength) {
    return reject("task_prompt_too_long", "Task prompt is too long.");
  }

  return { ok: true, prompt: normalized };
}

function reject(
  code: HelarcTaskInputErrorCode,
  message: string,
): { ok: false; error: HelarcTaskInputError } {
  return { ok: false, error: { code, message } };
}
