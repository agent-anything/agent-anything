import type {
  AgentTask,
  ISODateTimeString,
  Metadata,
} from "@agent-anything/foundation";

export const HELARC_TASK_KIND = "helarc.code-task";
export const DEFAULT_HELARC_TASK_PROMPT_MAX_LENGTH = 8_000;

export interface HelarcTaskInput {
  prompt: string;
}

export interface CreateHelarcTaskInput {
  taskId: string;
  prompt: string;
  createdAt: ISODateTimeString;
  metadata?: Metadata;
  promptMaxLength?: number;
}

export type HelarcTaskInputErrorCode =
  | "task_prompt_required"
  | "task_prompt_too_long";

export interface HelarcTaskInputError {
  code: HelarcTaskInputErrorCode;
  message: string;
}

export type CreateHelarcTaskResult =
  | { ok: true; task: AgentTask<HelarcTaskInput> }
  | { ok: false; error: HelarcTaskInputError };

export function createHelarcTask(
  input: CreateHelarcTaskInput,
): CreateHelarcTaskResult {
  const promptResult = normalizePrompt(input.prompt, input.promptMaxLength);
  if (!promptResult.ok) {
    return promptResult;
  }

  const task: AgentTask<HelarcTaskInput> = {
    id: input.taskId,
    kind: HELARC_TASK_KIND,
    input: { prompt: promptResult.prompt },
    createdAt: input.createdAt,
    metadata: input.metadata ?? {},
  };

  return {
    ok: true,
    task,
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
