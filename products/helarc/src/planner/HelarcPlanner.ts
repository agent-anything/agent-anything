import type { PlannerInput, PlanStep } from "@agent-anything/agent-core";
import {
  CODE_AGENT_LIST_FILES_TOOL,
  CODE_AGENT_READ_FILE_TOOL,
  CODE_AGENT_RUN_COMMAND_TOOL,
  CODE_AGENT_SEARCH_FILES_TOOL,
} from "@agent-anything/code-agent";
import type { ProviderRequest, ProviderResponse } from "@agent-anything/providers";
import type { ToolCall } from "@agent-anything/tools";
import type { HelarcTaskInput } from "../task/index.js";

export const HELARC_PLANNER_CAPABILITY = "helarc.code-agent.plan";
export const HELARC_PLANNER_OUTPUT_MAX_LENGTH = 64_000;

export type HelarcChangeOperationKind = "create" | "update" | "delete";

export interface HelarcChangeIntent {
  operation: HelarcChangeOperationKind;
  path: string;
  content?: string;
}

export type HelarcAgentOutput =
  | { kind: "complete"; summary: string }
  | { kind: "propose"; summary: string; change: HelarcChangeIntent };

export type HelarcProviderStructuredOutput =
  | { action: "call_tool"; reason?: string; toolName: string; input: unknown; toolCallId?: string }
  | { action: "complete"; summary: string }
  | { action: "propose"; summary: string; change: HelarcChangeIntent }
  | { action: "stop"; reason: string };

export class HelarcPlannerParseError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HelarcPlannerParseError";
  }
}

export function buildHelarcProviderRequest(input: PlannerInput): ProviderRequest {
  const taskInput = input.task.input as Partial<HelarcTaskInput>;
  const taskPrompt = typeof taskInput.prompt === "string" ? taskInput.prompt : "";

  return {
    capability: HELARC_PLANNER_CAPABILITY,
    metadata: {
      taskId: input.task.id,
      taskKind: input.task.kind,
    },
    messages: [
      {
        role: "system",
        content: buildSystemPrompt(),
        metadata: {},
      },
      {
        role: "user",
        content: buildUserPrompt(taskPrompt, input),
        metadata: {},
      },
    ],
  };
}

export function parseHelarcProviderResponse(
  response: ProviderResponse,
  input: PlannerInput,
): PlanStep {
  if (response.status === "failed") {
    throw new HelarcPlannerParseError(
      response.error?.code ?? "provider_failed",
      response.error?.message ?? "Provider failed.",
    );
  }

  const structured = parseStructuredOutput(response.output);
  return structuredOutputToPlanStep(structured, input);
}

export function parseStructuredOutput(output: unknown): HelarcProviderStructuredOutput {
  const value = normalizeProviderOutput(output);
  if (!isRecord(value)) {
    throw new HelarcPlannerParseError("planner_output_invalid", "Provider output must be a JSON object.");
  }

  const action = readString(value, "action");
  switch (action) {
    case "call_tool":
      return parseCallToolOutput(value);
    case "complete":
      return {
        action,
        summary: readRequiredString(value, "summary", "planner_summary_required"),
      };
    case "propose":
      return {
        action,
        summary: readRequiredString(value, "summary", "planner_summary_required"),
        change: parseChangeIntent(value.change),
      };
    case "stop":
      return {
        action,
        reason: readRequiredString(value, "reason", "planner_stop_reason_required"),
      };
    default:
      throw new HelarcPlannerParseError("planner_action_invalid", "Provider output action is not supported.");
  }
}

function structuredOutputToPlanStep(
  output: HelarcProviderStructuredOutput,
  input: PlannerInput,
): PlanStep {
  const id = createPlanStepId(input, output.action);
  if (output.action === "call_tool") {
    return {
      id,
      kind: "callTool",
      reason: output.reason ?? "Helarc planner requested a tool call.",
      metadata: { source: "helarc-planner" },
      toolCall: {
        id: output.toolCallId ?? id,
        toolName: output.toolName,
        input: output.input,
        risk: output.toolName === CODE_AGENT_RUN_COMMAND_TOOL ? "risky" : "safe",
        metadata: {},
      } satisfies ToolCall,
    };
  }

  if (output.action === "stop") {
    return {
      id,
      kind: "stop",
      reason: output.reason,
      stopReason: output.reason,
      metadata: { source: "helarc-planner" },
    };
  }

  const finalOutput: HelarcAgentOutput = output.action === "complete"
    ? { kind: "complete", summary: output.summary }
    : { kind: "propose", summary: output.summary, change: output.change };

  return {
    id,
    kind: "final",
    reason: finalOutput.summary,
    finalOutput,
    metadata: { source: "helarc-planner" },
  };
}

function buildSystemPrompt(): string {
  return [
    "You are Helarc, a careful code agent planner.",
    "Return only JSON. Do not wrap it in markdown.",
    "Use one of these actions: call_tool, complete, propose, stop.",
    "For call_tool, return action, toolName, input, and optional reason.",
    `Default Phase9 tools are read-only: ${CODE_AGENT_LIST_FILES_TOOL}, ${CODE_AGENT_READ_FILE_TOOL}, ${CODE_AGENT_SEARCH_FILES_TOOL}.`,
    "Do not call shell, write, patch, or long-running process tools unless the host explicitly enables them.",
    "For complete, return action and summary.",
    "For propose, return action, summary, and one change with operation create/update/delete, path, and content when needed.",
    "For stop, return action and reason.",
    "Never include workspace root paths, credentials, approval decisions, original content hashes, or patch ids.",
  ].join("\n");
}

function buildUserPrompt(taskPrompt: string, input: PlannerInput): string {
  return [
    "Task:",
    taskPrompt,
    "",
    "Context messages:",
    JSON.stringify(input.context.messages),
    "",
    "Observations:",
    JSON.stringify(input.context.observations),
    "",
    "Evidence refs:",
    JSON.stringify(input.context.evidenceRefs),
  ].join("\n");
}

function normalizeProviderOutput(output: unknown): unknown {
  if (typeof output === "string") {
    if (output.length > HELARC_PLANNER_OUTPUT_MAX_LENGTH) {
      throw new HelarcPlannerParseError("planner_output_too_large", "Provider output is too large.");
    }

    try {
      return JSON.parse(output) as unknown;
    } catch {
      throw new HelarcPlannerParseError("planner_output_not_json", "Provider output must be valid JSON.");
    }
  }

  return output;
}

function parseCallToolOutput(value: Record<string, unknown>): HelarcProviderStructuredOutput {
  const toolName = readRequiredString(value, "toolName", "planner_tool_name_required");
  return {
    action: "call_tool",
    toolName,
    input: value.input ?? {},
    reason: readOptionalString(value, "reason"),
    toolCallId: readOptionalString(value, "toolCallId"),
  };
}

function parseChangeIntent(value: unknown): HelarcChangeIntent {
  if (!isRecord(value)) {
    throw new HelarcPlannerParseError("planner_change_required", "Proposed output requires a change object.");
  }

  const operation = readRequiredString(value, "operation", "planner_change_operation_required");
  if (operation !== "create" && operation !== "update" && operation !== "delete") {
    throw new HelarcPlannerParseError("planner_change_operation_invalid", "Change operation is not supported.");
  }

  const path = readRequiredString(value, "path", "planner_change_path_required");
  const content = readRawOptionalString(value, "content");
  if ((operation === "create" || operation === "update") && content === undefined) {
    throw new HelarcPlannerParseError("planner_change_content_required", "Create and update changes require content.");
  }

  return content === undefined
    ? { operation, path }
    : { operation, path, content };
}

function readString(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function readOptionalString(value: Record<string, unknown>, key: string): string | undefined {
  const field = readString(value, key)?.trim();
  return field && field.length > 0 ? field : undefined;
}

function readRawOptionalString(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function readRequiredString(
  value: Record<string, unknown>,
  key: string,
  code: string,
): string {
  const field = readOptionalString(value, key);
  if (!field) {
    throw new HelarcPlannerParseError(code, `${key} is required.`);
  }

  return field;
}

function createPlanStepId(input: PlannerInput, suffix: string): string {
  return `${input.task.id}-${suffix}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
