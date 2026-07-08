import type { PlannerInput, PlanStep } from "@agent-anything/agent-core";
import { CODE_AGENT_RUN_COMMAND_TOOL } from "@agent-anything/code-agent";
import type { ProviderRequest, ProviderResponse } from "@agent-anything/providers";
import type { Metadata } from "@agent-anything/shared";
import type { ToolCall } from "@agent-anything/tools";
import {
  buildHelarcPromptAssembly,
  HELARC_ACTION_CONTRACT_VERSION,
  HELARC_PROMPT_ARCHITECTURE_VERSION,
  HELARC_TOOL_CATALOG_VERSION,
} from "./HelarcPromptAssembly.js";
import { readHelarcToolCatalog } from "./HelarcToolCatalog.js";

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

export type HelarcPlannerParseErrorCode =
  | "provider_failed"
  | "planner_output_too_large"
  | "planner_output_not_json"
  | "planner_output_invalid"
  | "planner_action_invalid"
  | "planner_tool_name_required"
  | "planner_tool_input_required"
  | "planner_tool_input_invalid"
  | "planner_tool_name_unsupported"
  | "planner_summary_required"
  | "planner_change_required"
  | "planner_change_operation_required"
  | "planner_change_operation_invalid"
  | "planner_change_path_required"
  | "planner_change_content_required"
  | "planner_stop_reason_required";

export class HelarcPlannerParseError extends Error {
  constructor(
    readonly code: HelarcPlannerParseErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HelarcPlannerParseError";
  }
}

export function buildHelarcProviderRequest(input: PlannerInput): ProviderRequest {
  const promptAssembly = buildHelarcPromptAssembly({
    plannerInput: input,
  });

  return {
    capability: HELARC_PLANNER_CAPABILITY,
    metadata: {
      taskId: input.task.id,
      taskKind: input.task.kind,
      promptArchitectureVersion: promptAssembly.versions.promptArchitectureVersion,
      actionContractVersion: promptAssembly.versions.actionContractVersion,
      toolCatalogVersion: promptAssembly.versions.toolCatalogVersion,
      exposedToolNames: promptAssembly.exposedToolNames,
      promptSectionIds: promptAssembly.systemSections.map((section) => section.id),
    },
    messages: [
      {
        role: "system",
        content: promptAssembly.systemPrompt,
        metadata: {},
      },
      {
        role: "user",
        content: promptAssembly.userPrompt,
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
      "provider_failed",
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
  const metadata = createPlannerTraceMetadata(output, input);
  if (output.action === "call_tool") {
    assertToolNameSupported(output.toolName, input);

    return {
      id,
      kind: "callTool",
      reason: output.reason ?? "Helarc planner requested a tool call.",
      metadata,
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
      metadata,
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
    metadata,
  };
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
  const toolInput = readRequiredToolInput(value);
  return {
    action: "call_tool",
    toolName,
    input: toolInput,
    reason: readOptionalString(value, "reason"),
    toolCallId: readOptionalString(value, "toolCallId"),
  };
}

function assertToolNameSupported(toolName: string, input: PlannerInput): void {
  const catalog = readHelarcToolCatalog(input);
  if (catalog.tools.some((tool) => tool.name === toolName)) {
    return;
  }

  throw new HelarcPlannerParseError(
    "planner_tool_name_unsupported",
    "Tool is not exposed in the active tool catalog.",
  );
}

function createPlannerTraceMetadata(
  output: HelarcProviderStructuredOutput,
  input: PlannerInput,
): Metadata {
  const toolCatalog = readHelarcToolCatalog(input);
  const metadata: Metadata = {
    source: "helarc-planner",
    plannerAction: output.action,
    promptArchitectureVersion: HELARC_PROMPT_ARCHITECTURE_VERSION,
    actionContractVersion: HELARC_ACTION_CONTRACT_VERSION,
    toolCatalogVersion: HELARC_TOOL_CATALOG_VERSION,
    exposedToolNames: toolCatalog.tools.map((tool) => tool.name),
  };

  if (output.action === "call_tool") {
    metadata.requestedToolName = output.toolName;
  }

  if (output.action === "propose") {
    metadata.patchOperation = output.change.operation;
    metadata.patchPath = output.change.path;
  }

  return metadata;
}

function readRequiredToolInput(value: Record<string, unknown>): Record<string, unknown> {
  if (!Object.hasOwn(value, "input")) {
    throw new HelarcPlannerParseError("planner_tool_input_required", "input is required.");
  }

  const input = value.input;
  if (!isRecord(input)) {
    throw new HelarcPlannerParseError("planner_tool_input_invalid", "input must be a JSON object.");
  }

  return input;
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
  code: HelarcPlannerParseErrorCode,
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
